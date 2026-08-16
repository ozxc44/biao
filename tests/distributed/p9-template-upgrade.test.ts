/**
 * Phase 9 失败优先测试：Windows 模板 Upgrade 命令静态校验（22.5-04）。
 *
 * templates/node/install-windows.ps1 必须提供就地升级动作：
 * 停止服务 → 备份配置/凭据 → 替换二进制 → 恢复 → 启动，且幂等。
 * 本文件只做静态断言（顺序、存在性）；p3-node-daemon.test.ts 在跑、不改，
 * Windows 侧无法真机执行，顺序契约由文本位置（index 先后）守护。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TEMPLATE_PATH = join(REPO_ROOT, 'templates/node/install-windows.ps1');
const template = readFileSync(TEMPLATE_PATH, 'utf8');

/** 截取 switch 内 'Upgrade' { ... } 分支正文（到下一个同级 case 或文件尾）。 */
function upgradeBlock(): string {
  const start = template.indexOf("'Upgrade' {");
  expect(start, "模板必须包含 'Upgrade' { 分支").toBeGreaterThanOrEqual(0);
  const nextCase = template.indexOf("\n    '", start + 1);
  return template.slice(start, nextCase === -1 ? undefined : nextCase);
}

describe('22.5-04: install-windows.ps1 Upgrade 命令', () => {
  it('Upgrade 键存在：ValidateSet 已登记且 switch 有对应分支', () => {
    // 参数门禁：ValidateSet 必须放行 Upgrade（否则 -Command Upgrade 直接报错）
    const validateSet = /ValidateSet\(([^)]*)\)/.exec(template)?.[1] ?? '';
    expect(validateSet).toContain("'Upgrade'");
    // switch 分支存在
    expect(upgradeBlock()).not.toBe('');
    // 用法注释同步提及（运维入口可发现）
    expect(template).toMatch(/-Command Upgrade/);
  });

  it('升级包参数：-UpgradeSource 已声明且缺省/不存在时 fail-fast', () => {
    expect(template).toMatch(/\[string\]\$UpgradeSource/);
    const block = upgradeBlock();
    // 幂等/安全：没有升级包不动服务（先于 Stop 校验）
    const sourceGuard = block.indexOf('-UpgradeSource');
    const stopStep = block.indexOf('-Command Stop');
    expect(sourceGuard).toBeGreaterThanOrEqual(0);
    expect(stopStep).toBeGreaterThan(sourceGuard);
    expect(block).toContain('升级包目录不存在');
  });

  it('步骤顺序：stop 先于 start（且只在升级前运行时才启动）', () => {
    const block = upgradeBlock();
    const stopIndex = block.indexOf('-Command Stop');
    const startIndex = block.indexOf('-Command Start');
    expect(stopIndex, 'Upgrade 分支必须调用 Stop').toBeGreaterThanOrEqual(0);
    expect(startIndex, 'Upgrade 分支必须调用 Start').toBeGreaterThan(stopIndex);
    // 幂等：记录升级前运行态，未运行不自动拉起
    expect(block).toContain('wasRunning');
  });

  it('步骤顺序：凭据备份先于二进制替换（配置备份同样先于替换）', () => {
    const block = upgradeBlock();
    const configBackup = block.indexOf('Backup-BiaoNodeConfig -BackupDir');
    const credentialBackup = block.indexOf('Backup-BiaoNodeCredential -BackupDir');
    const replaceBinary = block.indexOf('Copy-Item -Destination $InstallDir -Recurse -Force');
    expect(credentialBackup, '必须调用凭据备份').toBeGreaterThanOrEqual(0);
    expect(configBackup, '必须调用配置备份').toBeGreaterThanOrEqual(0);
    expect(replaceBinary, '必须有二进制替换步骤').toBeGreaterThan(credentialBackup);
    expect(replaceBinary).toBeGreaterThan(configBackup);
    // 替换发生在备份之后、恢复之前
    const restoreStep = block.indexOf('Restore-BiaoNodeConfig -BackupDir');
    expect(restoreStep).toBeGreaterThan(replaceBinary);
  });

  it('备份/恢复 helper 已定义：凭据经 DPAPI 加密落盘，不留明文', () => {
    // 函数定义存在（switch 之外的定义区）
    expect(template).toMatch(/function Backup-BiaoNodeConfig/);
    expect(template).toMatch(/function Backup-BiaoNodeCredential/);
    expect(template).toMatch(/function Restore-BiaoNodeConfig/);
    // 凭据备份必须走 ConvertFrom-SecureString（DPAPI），明文只存在于内存
    const credFn = /function Backup-BiaoNodeCredential[\s\S]*?\n}\s*\n/.exec(template)?.[0] ?? '';
    expect(credFn).toContain('ConvertFrom-SecureString');
    expect(credFn).not.toContain('| Set-Content -Path $credFile');
    // Credential Manager 适配与既有 Install/Uninstall 同源（PasswordVault）
    expect(credFn).toContain('PasswordVault');
  });

  it('模板占位符纪律：新增内容未引入未登记占位符', () => {
    // 与 p3 静态校验同款规则：不得出现 __UPPERCASE__ 形态的残留/新占位符
    // （UpgradeSource 是普通参数，不需要登记）。
    const placeholders = template.match(/__([A-Z][A-Z0-9_]*)__/g) ?? [];
    const registered = new Set([
      '__BIAO_NODE_INSTALL_DIR__',
      '__NODE_BIN__',
      '__BIAO_NODE_JS__',
      '__BIAO_NODE_CONFIG__',
      '__BIAO_NODE_STATE_DIR__',
      '__BIAO_NODE_SERVICE_NAME__',
      '__BIAO_NODE_CREDENTIAL_TARGET__',
      '__BIAO_NODE_EVENT_LOG_SOURCE__',
    ]);
    for (const p of placeholders) {
      expect(registered.has(p), `未登记占位符 ${p}`).toBe(true);
    }
  });
});
