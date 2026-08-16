# biao-node Windows Service 宿主脚本（Phase 3 · R1C-004 最小产物）
#
# 职责（不要求 Bash，全部 PowerShell 原生）：
#   1. 从 Windows Credential Manager（PasswordVault）读取过渡期 owner
#      token，注入子进程环境变量——token 不落盘、不进命令行；
#   2. 以子进程方式启动 node bin/biao-node.js run，并把生命周期事件写入
#      Windows 事件日志（Event Log 源由 install-windows.ps1 注册）；
#   3. 服务停止请求 = 优雅 drain：向状态目录投递 control/drain.json 控制文件
#      （跨平台通道，不依赖 POSIX 信号），等待进程收口退出；超时才强停。
#
# 占位符替换说明（由 install-windows.ps1 替换，替换后不得再残留任何占位符）：
#   __NODE_BIN__                    node.exe 绝对路径
#   __BIAO_NODE_JS__                bin/biao-node.js 绝对路径
#   __BIAO_NODE_CONFIG__            biao-node.config.json 绝对路径
#   __BIAO_NODE_STATE_DIR__         节点状态/日志目录
#   __BIAO_NODE_CREDENTIAL_TARGET__ Credential Manager 目标名（如 BiaoNode/http://control-plane:7331）
#   __BIAO_NODE_EVENT_LOG_SOURCE__  事件日志源名（如 BiaoNode）
#   __BIAO_NODE_SERVICE_NAME__      Windows 服务名（如 BiaoNode）
#
# 说明：本脚本是“服务宿主循环”。sc.exe 直接托管 PowerShell 不实现完整 SCM
# 协议，生产部署用服务包装器（如 NSSM/WinSW）以本脚本为 Program 时，
# 停止语义同样走 drain 控制文件；详见 docs/runbooks/biao-node.md。

#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$NodeBin = '__NODE_BIN__'
$BiaoNodeJs = '__BIAO_NODE_JS__'
$ConfigPath = '__BIAO_NODE_CONFIG__'
$StateDir = '__BIAO_NODE_STATE_DIR__'
$CredentialTarget = '__BIAO_NODE_CREDENTIAL_TARGET__'
$EventLogSource = '__BIAO_NODE_EVENT_LOG_SOURCE__'
$ServiceName = '__BIAO_NODE_SERVICE_NAME__'
$DrainTimeoutSeconds = 120   # 必须大于 biao-node 配置的 drain_timeout_ms/1000

# ---- 事件日志 ----

function Write-BiaoEvent {
    param([string]$Message, [System.Diagnostics.EventLogEntryType]$Type = 'Information')
    if (-not [System.Diagnostics.EventLog]::SourceExists($EventLogSource)) {
        # 正常由 install-windows.ps1 注册；服务宿主自愈一次（幂等）
        New-EventLog -LogName 'Application' -Source $EventLogSource -ErrorAction SilentlyContinue
    }
    Write-EventLog -LogName 'Application' -Source $EventLogSource -EntryType $Type -EventId 1000 -Message $Message
}

# ---- Credential Manager 存取（R1C-004：token 不落盘） ----

function Get-BiaoNodeOwnerToken {
    # PasswordVault 即“凭据管理器”的 WinRT 面；凭据按 RESOURCE/TARGET 归档。
    try {
        Add-Type -AssemblyName 'Windows.Runtime' -ErrorAction SilentlyContinue
        $null = [Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials.PasswordVault, ContentType = WindowsRuntime]
        $vault = New-Object Windows.Security.Credentials.PasswordVault
        $cred = $vault.Retrieve($CredentialTarget, 'biao-node')
        $cred.RetrievePassword()
        return $cred.Password
    } catch {
        return $null
    }
}

# ---- 主循环 ----

Write-BiaoEvent "biao-node 服务宿主启动：service=$ServiceName config=$ConfigPath"

$env:BIAO_NODE_OWNER_TOKEN = Get-BiaoNodeOwnerToken
if (-not $env:BIAO_NODE_OWNER_TOKEN) {
    # 没有 owner token 也能启动（服务端关闭鉴权/已完成 bvn2 鉴权切换的部署），
    # 但要留事件痕迹，避免静默 401 循环。
    Write-BiaoEvent "Credential Manager 中未找到 $CredentialTarget（biao-node 用户）；将以无 owner 引导 token 启动" 'Warning'
}

New-Item -ItemType Directory -Force -Path (Join-Path $StateDir 'control') | Out-Null

$daemonArgs = @($BiaoNodeJs, 'run', '--config', $ConfigPath)
$daemon = Start-Process -FilePath $NodeBin -ArgumentList $daemonArgs -WorkingDirectory $StateDir -PassThru -NoNewWindow

$global:StopRequested = $false
Register-EngineEvent -SourceIdentifier ConsoleCancelging -Action { } -ErrorAction SilentlyContinue | Out-Null

function Request-BiaoNodeDrain {
    # 服务停止 = 投递 drain 控制文件（daemon 主循环 pollControlDir 消费），
    # 由 daemon 显式选择 cancel/wait 并等待 attempts 收口。
    $drainFile = Join-Path $StateDir 'control/drain.json'
    $payload = @{
        requested_at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        reason       = 'Windows Service 停止请求'
        timeout_ms   = ($DrainTimeoutSeconds - 10) * 1000
        action       = 'cancel'
    } | ConvertTo-Json -Compress
    Set-Content -Path $drainFile -Value $payload -Encoding UTF8
}

# 宿主被停止（包装器先关闭 stdin/发 Ctrl+Break）时触发 drain
$null = Register-ObjectEvent -InputObject $daemon -EventName Exited -Action { $global:StopRequested = $true }

try {
    while (-not $daemon.HasExited) {
        Start-Sleep -Milliseconds 500
    }
} catch {
    Request-BiaoNodeDrain
}

if (-not $daemon.HasExited) {
    Request-BiaoNodeDrain
    $exited = $daemon.WaitForExit(($DrainTimeoutSeconds * 1000))
    if (-not $exited) {
        Write-BiaoEvent "drain 超时（${DrainTimeoutSeconds}s），强制结束进程树" 'Error'
        Stop-Process -Id $daemon.Id -Force -ErrorAction SilentlyContinue
    }
}

Write-BiaoEvent "biao-node 服务宿主退出：exit=$($daemon.ExitCode)"
exit $daemon.ExitCode
