/**
 * 方案 E：Web 控制台远程人类登录的一次性 enrollment（bhe2）。
 *
 * 对应 docs/runbooks/remote-console-auth.md：NAS/远程部署无法使用 loopback-only
 * 的本机 Owner 会话，Owner 预登记一个人类身份（subject + role + project_id），
 * 生成一次性 enrollment_code 交给使用者，使用者在远程控制台输入 code 换取
 * bvh2 Cookie 会话（POST /auth/human-session）。
 *
 * - 只存 code 的 sha256（code_hash 唯一索引），明文仅创建响应返回一次；
 * - 一次性语义：used_at IS NULL = 未用；消费成功原子置 used_at（> 0），
 *   重复消费由 UPDATE ... WHERE used_at IS NULL 的 changes=0 拒绝；
 * - 时效：expires_at 毫秒时间戳，过期后 consume 拒绝（ENROLLMENT_EXPIRED）。
 */
import type Database from 'better-sqlite3';

export const version = '014';

const schemaSql = `
CREATE TABLE IF NOT EXISTS human_enrollments (
  enrollment_id TEXT PRIMARY KEY,
  -- sha256(enrollment_code) hex；明文不落库（创建响应仅返回一次）
  code_hash TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'project_admin', 'reviewer', 'auditor')),
  -- 空串 = 平台级（owner 角色）；否则绑定单一 project（与 human_sessions 对齐）
  project_id TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- 一次性：NULL = 未使用；使用后为 >0 的毫秒时间戳
  used_at INTEGER CHECK (used_at IS NULL OR used_at > 0),
  used_by_ip TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_human_enrollments_subject
  ON human_enrollments(subject, created_at);
`;

export const checksumMaterial = schemaSql;

export function up(db: Database.Database): void {
  db.exec(schemaSql);
}
