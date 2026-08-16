/**
 * biao-node 节点凭据文件存取（Phase 3 · §10.2）
 *
 * §10.2：安装后换取节点长期凭据，Enrollment Token 立即失效；凭据文件是
 * *nix 平台的 owner-only credential file 适配（Linux 模板同款语义；
 * macOS 生产形态为 Keychain、Windows 为 Credential Manager，见
 * templates/node/ 与 runbook）。
 *
 * 要求：
 * - 写入原子（临时文件 + rename），并 chmod 0600；父目录 mkdir 0700；
 * - 读取前校验权限位：group/other 读位必须为 0（fail-closed，宁可拒绝
 *   启动也不带着世界可读的凭据去注册）；
 * - Windows 无 POSIX 权限位，chmod 近似 no-op，权限校验跳过（由模板的
 *   Credential Manager 路线承担，见 install-windows.ps1）；
 * - 文件内容不含密钥环材料，只含 bvn2_ token 与登记元数据。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { platform } from 'node:os';

/** 凭据文件的最小权限：owner 读写，group/other 无任何位。 */
export const CREDENTIAL_FILE_MODE = 0o600;

export interface StoredNodeCredential {
  node_id: string;
  /** bvn2_ 前缀的 Node credential（HMAC 签名 token，不含密钥材料）。 */
  credential: string;
  /** enroll 返回的 credential_generation（fencing 判据）。 */
  credential_generation: number;
  /** enroll 时的控制面地址，防止凭据被拿去连错服务端。 */
  biao_url: string;
  enrolled_at: number;
}

const isWindows = platform() === 'win32';

function assertNoControlChars(value: string, field: string): void {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`biao-node 凭据 ${field} 含控制字符`);
}

/** 原子写入凭据文件并收紧权限。 */
export function writeNodeCredential(path: string, credential: StoredNodeCredential): void {
  assertNoControlChars(credential.credential, 'token');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.credential.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(credential, null, 2)}\n`, { mode: CREDENTIAL_FILE_MODE, flag: 'wx' });
  chmodSync(tmp, CREDENTIAL_FILE_MODE);
  renameSync(tmp, path);
  if (!isWindows) chmodSync(path, CREDENTIAL_FILE_MODE);
}

/** 权限位校验：group/other 不得有任何位（POSIX 平台）。 */
export function assertCredentialFilePermissions(path: string): void {
  if (isWindows) return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o177) !== 0) {
    throw new Error(
      `节点凭据文件 ${path} 权限过宽（当前 ${mode.toString(8)}）：group/other 不得有任何权限位。` +
        `修复：chmod 600 ${path}`,
    );
  }
}

/**
 * 读取并校验凭据文件：存在性 → 权限位 → JSON 结构 → 必填字段。
 * 任何一步失败都抛出带修复指引的中文错误（daemon fail-fast，退出码 2）。
 */
export function readNodeCredential(path: string): StoredNodeCredential {
  if (!existsSync(path)) {
    throw new Error(`节点凭据文件不存在：${path}。请先运行 biao-node enroll 完成登记。`);
  }
  assertCredentialFilePermissions(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`节点凭据文件不是合法 JSON：${path}。请重新运行 biao-node enroll。`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`节点凭据文件结构非法：${path}`);
  }
  const record = parsed as Record<string, unknown>;
  const { node_id, credential, credential_generation, biao_url, enrolled_at } = record;
  if (typeof node_id !== 'string' || !node_id) throw new Error(`节点凭据文件缺 node_id：${path}`);
  if (typeof credential !== 'string' || !credential.startsWith('bvn2_')) {
    throw new Error(`节点凭据文件中的 token 不是 bvn2_ 前缀的 V2 Node credential：${path}`);
  }
  if (typeof credential_generation !== 'number' || !Number.isInteger(credential_generation) || credential_generation < 1) {
    throw new Error(`节点凭据文件的 credential_generation 非法：${path}`);
  }
  assertNoControlChars(credential, 'token');
  return {
    node_id,
    credential,
    credential_generation,
    biao_url: typeof biao_url === 'string' ? biao_url : '',
    enrolled_at: typeof enrolled_at === 'number' ? enrolled_at : 0,
  };
}
