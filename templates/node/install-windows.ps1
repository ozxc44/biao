# biao-node Windows 安装器（Phase 3 · R1C-004 最小产物）
#
# 覆盖 §10.2 Windows 产物要求（全部 PowerShell，不要求 Bash）：
#   Install/Uninstall/Start/Stop/Drain 命令、Credential Manager 适配器、
#   事件日志源注册、幂等安装、失败回滚。
#
# 占位符替换说明（分发包安装前由打包脚本替换，替换后不得再残留任何占位符）：
#   __BIAO_NODE_INSTALL_DIR__  安装目录（bin、templates、node-credential 落位处）
#   __NODE_BIN__               node.exe 绝对路径
#   __BIAO_NODE_JS__           bin/biao-node.js 绝对路径
#   __BIAO_NODE_CONFIG__       biao-node.config.json 绝对路径
#   __BIAO_NODE_STATE_DIR__    节点状态/日志目录
#   __BIAO_NODE_SERVICE_NAME__ Windows 服务名（默认 BiaoNode）
#   __BIAO_NODE_CREDENTIAL_TARGET__ Credential Manager 目标名
#   __BIAO_NODE_EVENT_LOG_SOURCE__  事件日志源名
#
# 用法（管理员 PowerShell）：
#   .\install-windows.ps1 -Command Install  -OwnerToken (Read-Host -AsSecureString)
#   .\install-windows.ps1 -Command Drain
#   .\install-windows.ps1 -Command Stop
#   .\install-windows.ps1 -Command Upgrade -UpgradeSource C:\stage\biao-node-new
#   .\install-windows.ps1 -Command Uninstall
# 先完成 biao-node enroll（登记 + 生成配置），再运行本安装器。
#
# Upgrade（22.5-04，就地升级，幂等）：
#   停止服务（drain 语义）→ 备份配置/凭据 → 替换二进制 → 恢复 → 启动。
#   升级包目录（-UpgradeSource）整树覆盖安装目录；任一步失败保留备份可回滚。

#Requires -RunAsAdministrator
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Uninstall', 'Start', 'Stop', 'Drain', 'Status', 'Upgrade')]
    [string]$Command,

    # 过渡期 owner 引导 token：SecureString 传入，只进 Credential Manager。
    [securestring]$OwnerToken,

    # Upgrade 专用：新版本目录（其内容整树覆盖 $InstallDir）。
    [string]$UpgradeSource = '',

    [string]$ServiceName = '__BIAO_NODE_SERVICE_NAME__',
    [string]$InstallDir = '__BIAO_NODE_INSTALL_DIR__',
    [string]$NodeBin = '__NODE_BIN__',
    [string]$BiaoNodeJs = '__BIAO_NODE_JS__',
    [string]$ConfigPath = '__BIAO_NODE_CONFIG__',
    [string]$StateDir = '__BIAO_NODE_STATE_DIR__',
    [string]$CredentialTarget = '__BIAO_NODE_CREDENTIAL_TARGET__',
    [string]$EventLogSource = '__BIAO_NODE_EVENT_LOG_SOURCE__'
)

$ErrorActionPreference = 'Stop'

$ServiceHostScript = Join-Path $InstallDir 'biao-node-service.ps1'
$DrainTimeoutSeconds = 120

function Write-BiaoEvent {
    param([string]$Message, [System.Diagnostics.EventLogEntryType]$Type = 'Information')
    if (-not [System.Diagnostics.EventLog]::SourceExists($EventLogSource)) {
        New-EventLog -LogName 'Application' -Source $EventLogSource
    }
    Write-EventLog -LogName 'Application' -Source $EventLogSource -EntryType $Type -EventId 1001 -Message $Message
}

function Assert-NoPlaceholderLeftover {
    # 幂等门禁：安装前确认宿主脚本已完成占位符替换（含服务名等参数默认值）
    foreach ($file in @($ServiceHostScript, $PSCommandPath)) {
        if (-not (Test-Path $file)) { continue }
        $content = Get-Content -Raw -Path $file
        if ($content -match '__[A-Z][A-Z0-9_]*__') {
            throw "文件 $file 仍残留未替换占位符 $($Matches[0])；请先用打包脚本渲染模板。"
        }
    }
}

function Save-BiaoNodeOwnerToken {
    param([securestring]$Token)
    Add-Type -AssemblyName 'Windows.Runtime' -ErrorAction SilentlyContinue
    $null = [Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials.PasswordVault, ContentType = WindowsRuntime]
    $vault = New-Object Windows.Security.Credentials.PasswordVault
    $plain = (New-Object System.Management.Automation.PSCredential('biao-node', $Token)).GetNetworkCredential().Password
    $cred = New-Object Windows.Security.Credentials.PasswordCredential($CredentialTarget, 'biao-node', $plain)
    $vault.Add($cred)
}

function Get-BiaoNodeService {
    Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
}

# ── Upgrade 备份/恢复（22.5-04）────────────────────────────────────

function Backup-BiaoNodeConfig {
    # 配置备份：enroll 产物整文件快照（升级包可能携带默认配置覆盖实配）。
    param([string]$BackupDir)
    if (Test-Path $ConfigPath) {
        Copy-Item -Path $ConfigPath -Destination (Join-Path $BackupDir 'biao-node.config.json') -Force
        Write-Output "配置已备份：$ConfigPath -> $BackupDir"
    } else {
        Write-Output "未找到配置 $ConfigPath（跳过配置备份）。"
    }
}

function Backup-BiaoNodeCredential {
    # 凭据备份：从 Credential Manager（PasswordVault）导出为 DPAPI 加密文件
    # （ConvertFrom-SecureString 无密钥形态，仅同一 Windows 用户上下文可逆；
    #  服务以其它账户运行时凭据恢复为尽力而为，主恢复路径是控制面 re-enroll）。
    param([string]$BackupDir)
    Add-Type -AssemblyName 'Windows.Runtime' -ErrorAction SilentlyContinue
    try {
        $null = [Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials.PasswordVault, ContentType = WindowsRuntime]
        $vault = New-Object Windows.Security.Credentials.PasswordVault
        $cred = $vault.Retrieve($CredentialTarget, 'biao-node')
        $cred.RetrievePassword()
        $sec = ConvertTo-SecureString $cred.Password -AsPlainText -Force
        $sec | ConvertFrom-SecureString | Set-Content -Path (Join-Path $BackupDir 'biao-node.credential.dpapi') -Encoding UTF8
        Write-Output "凭据已备份（DPAPI 加密）：$CredentialTarget -> $BackupDir"
    } catch {
        Write-Output "Credential Manager 中无可备份的 biao-node 凭据（跳过凭据备份）。"
    }
}

function Restore-BiaoNodeConfig {
    # 恢复配置/凭据：替换二进制之后，用升级前实配覆盖升级包默认配置；
    #  凭据存在加密备份时回写 Credential Manager（幂等：Add 覆盖式重写）。
    param([string]$BackupDir)
    $configBackup = Join-Path $BackupDir 'biao-node.config.json'
    if (Test-Path $configBackup) {
        Copy-Item -Path $configBackup -Destination $ConfigPath -Force
        Write-Output "配置已恢复：$configBackup -> $ConfigPath"
    }
    $credBackup = Join-Path $BackupDir 'biao-node.credential.dpapi'
    if (Test-Path $credBackup) {
        try {
            $sec = Get-Content -Raw -Path $credBackup | ConvertTo-SecureString
            Save-BiaoNodeOwnerToken -Token $sec
            Write-Output "凭据已恢复：$credBackup -> $CredentialTarget"
        } catch {
            Write-Output "凭据恢复失败（保留备份于 $credBackup；可用控制面 re-enroll 重新登记）。"
        }
    }
}

switch ($Command) {
    'Install' {
        Assert-NoPlaceholderLeftover
        if (-not (Test-Path $ConfigPath)) {
            throw "找不到配置 $ConfigPath；请先运行：node $BiaoNodeJs enroll --ticket-file <票据文件> ..."
        }
        if (Get-BiaoNodeService) {
            Write-Output "服务 $ServiceName 已存在（幂等安装）：跳过创建，仅刷新凭据/事件源。"
        } else {
            if ($OwnerToken) { Save-BiaoNodeOwnerToken -Token $OwnerToken }
            New-Item -ItemType Directory -Force -Path (Join-Path $StateDir 'control') | Out-Null

            # 服务注册：sc.exe 创建 + 宿主脚本。PowerShell 非原生 SCM 可执行体，
            # 生产用 NSSM/WinSW 包装时把本脚本的 drain 语义作为 Program 即可。
            $binPath = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $ServiceHostScript
            sc.exe create $ServiceName binpath= $binPath start= delayed-auto | Out-Null
            if ($LASTEXITCODE -ne 0) {
                # 失败回滚：不留半安装状态
                sc.exe delete $ServiceName | Out-Null
                throw "sc.exe create 失败（code=$LASTEXITCODE），已回滚。生产环境建议用 NSSM/WinSW 注册同一宿主脚本。"
            }
            sc.exe failure $ServiceName reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
            sc.exe description $ServiceName 'Biao 分布式节点守护进程（biao-node）；停止即优雅 drain' | Out-Null
        }
        # 事件日志源注册（幂等）
        if (-not [System.Diagnostics.EventLog]::SourceExists($EventLogSource)) {
            New-EventLog -LogName 'Application' -Source $EventLogSource
        }
        Write-BiaoEvent "biao-node 安装完成：service=$ServiceName config=$ConfigPath"
        Write-Output '安装完成。启动：.\install-windows.ps1 -Command Start'
    }

    'Start' {
        $svc = Get-BiaoNodeService
        if (-not $svc) { throw "服务 $ServiceName 不存在。" }
        Start-Service -Name $ServiceName
        Write-Output "服务 $ServiceName 已启动。"
    }

    'Drain' {
        # 排空：向状态目录投递控制文件，daemon 停止 claim 并等待 attempts 收口
        $drainFile = Join-Path $StateDir 'control/drain.json'
        New-Item -ItemType Directory -Force -Path (Split-Path $drainFile) | Out-Null
        $payload = @{
            requested_at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            reason       = 'install-windows.ps1 Drain'
            timeout_ms   = ($DrainTimeoutSeconds - 10) * 1000
            action       = 'cancel'
        } | ConvertTo-Json -Compress
        Set-Content -Path $drainFile -Value $payload -Encoding UTF8
        Write-Output "已投递 drain 请求：$drainFile（等待 running attempts 收口）"
    }

    'Stop' {
        $svc = Get-BiaoNodeService
        if (-not $svc) { Write-Output "服务 $ServiceName 不存在，无需停止。"; break }
        # 先投递 drain 控制文件再停服务：宿主脚本收到停止即等待 daemon 收口
        & $PSCommandPath -Command Drain
        Stop-Service -Name $ServiceName -Force:$false
        Write-Output "服务 $ServiceName 已停止（drain 语义）。"
    }

    'Uninstall' {
        $svc = Get-BiaoNodeService
        if ($svc) {
            & $PSCommandPath -Command Stop
            sc.exe delete $ServiceName | Out-Null
        }
        # 卸载前远端 revoke 由控制面执行（runbook §卸载）；本地清理凭据：
        Add-Type -AssemblyName 'Windows.Runtime' -ErrorAction SilentlyContinue
        try {
            $null = [Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials.PasswordVault, ContentType = WindowsRuntime]
            $vault = New-Object Windows.Security.Credentials.PasswordVault
            $vault.Remove($vault.Retrieve($CredentialTarget, 'biao-node'))
        } catch {
            Write-Output 'Credential Manager 中无可清理的 biao-node 凭据。'
        }
        # 残留工作区清单输出（§10.2）：状态目录与各 session 的未收口 attempt
        $sessions = Join-Path $StateDir 'state/sessions'
        if (Test-Path $sessions) {
            Write-Output '残留 session 工作区清单（卸载后需人工确认）：'
            Get-ChildItem $sessions | ForEach-Object { Write-Output "  $($_.FullName)" }
        }
        Write-BiaoEvent "biao-node 卸载完成：service=$ServiceName"
    }

    'Upgrade' {
        # 22.5-04：就地升级 = 停止服务 → 备份配置/凭据 → 替换二进制 → 恢复 → 启动。
        # 幂等：无升级包立即失败（不动服务）；服务不存在跳过停止/启动；
        # 重复执行产生新的时间戳备份目录，替换/恢复均为覆盖式收敛。
        if (-not $UpgradeSource) {
            throw "Upgrade 需要 -UpgradeSource 指向新版本目录。"
        }
        if (-not (Test-Path $UpgradeSource)) {
            throw "升级包目录不存在：$UpgradeSource"
        }

        # 步骤 1：停止服务（drain 语义；记录升级前运行态用于步骤 5 恢复）
        $svc = Get-BiaoNodeService
        $wasRunning = $false
        if ($svc) {
            $wasRunning = ($svc.Status -eq 'Running')
            & $PSCommandPath -Command Stop
        } else {
            Write-Output "服务 $ServiceName 不存在，跳过停止（仅替换文件）。"
        }

        # 步骤 2：备份配置与凭据（先于任何文件替换，失败可整体回滚）
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backupDir = Join-Path (Join-Path $StateDir 'upgrade-backups') $stamp
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        Backup-BiaoNodeConfig -BackupDir $backupDir
        Backup-BiaoNodeCredential -BackupDir $backupDir

        # 步骤 3：替换二进制（升级包整树覆盖安装目录）
        try {
            Get-ChildItem -Path $UpgradeSource | Copy-Item -Destination $InstallDir -Recurse -Force
            Write-Output "二进制已替换：$UpgradeSource -> $InstallDir"
        } catch {
            Restore-BiaoNodeConfig -BackupDir $backupDir
            throw "二进制替换失败（配置已从备份恢复，备份保留于 $backupDir）：$($_.Exception.Message)"
        }

        # 步骤 4：恢复配置/凭据（升级包默认配置被升级前实配覆盖）
        Restore-BiaoNodeConfig -BackupDir $backupDir

        # 步骤 5：启动服务（仅当升级前在运行；幂等）
        if ($wasRunning) {
            & $PSCommandPath -Command Start
        } else {
            Write-Output "服务升级前未运行，不自动启动。"
        }
        Write-BiaoEvent "biao-node 升级完成：service=$ServiceName source=$UpgradeSource backup=$backupDir"
        Write-Output "升级完成（备份：$backupDir）。"
    }

    'Status' {
        $svc = Get-BiaoNodeService
        if ($svc) {
            Write-Output "服务：$($svc.Status)"
        } else {
            Write-Output "服务 $ServiceName 未安装。"
        }
        $statusFile = Join-Path $StateDir 'state/status.json'
        if (Test-Path $statusFile) {
            $status = Get-Content -Raw $statusFile | ConvertFrom-Json
            Write-Output "phase=$($status.phase) pid=$($status.pid) 心跳=$($status.heartbeat.sent) slots=$($status.slots.in_use)/$($status.slots.capacity)"
        } else {
            Write-Output 'daemon 无状态文件（未运行过）。'
        }
    }
}
