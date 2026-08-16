/**
 * Phase 6：Human Identity 与 RBAC 数据层。
 *
 * 对应 docs/distributed-multi-node-development-plan.md §13.1（身份分层）、
 * §13.2（威胁模型：跨项目读取 = project membership + Artifact/Task API 授权）、
 * §20.1（project_memberships 在新表清单中列出，Human Identity 阶段启用）。
 *
 * - project_memberships：项目粒度 Human 角色授予（§21 Phase 6 "project membership"）。
 *   唯一键 (project_id, subject)：同一主体在同一项目最多一条当前授予；
 *   撤销走 status='revoked'（append 语义，不删行），撤销即对全部派生会话生效。
 * - human_sessions：Owner 签发的 bvh2 会话登记表。token 内嵌 jti/key_version，
 *   撤销 = status='revoked'（R1C-013：revoke 立即 fencing，不等待自然过期）。
 * - v2_credential_keys / v2_credential_state：紧急撤销（revoke-all-sessions）的
 *   durable 支撑——控制面按 key_version 前滚并落库新签发密钥，min_key_version
 *   是验签水位线：低于该版本的全部 bvn2/bva2/bvh2 立即失效（UNKNOWN_KEY_VERSION），
 *   新签发继续用最高版本（复用 Phase 1 轮换机制，§13.2 "节点凭据泄露"防护）。
 */
import type Database from 'better-sqlite3';

export const version = '009';

const schemaSql = `
-- ──────────────── §13.1/§21 Phase 6 project_memberships ────────────────
CREATE TABLE IF NOT EXISTS project_memberships (
  membership_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'project_admin', 'reviewer', 'auditor')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  granted_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT NOT NULL DEFAULT ''
);

-- §13.2 跨项目读取：授权按 (project_id, subject) 判定，撤销幂等（重复撤销保持 revoked）
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_memberships_project_subject
  ON project_memberships(project_id, subject);

CREATE INDEX IF NOT EXISTS idx_project_memberships_subject
  ON project_memberships(subject, status);

-- ──────────────── §13.1 Human Identity：human_sessions（bvh2） ────────────────
CREATE TABLE IF NOT EXISTS human_sessions (
  session_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'project_admin', 'reviewer', 'auditor')),
  -- 空串 = 平台级（owner 角色）；否则绑定单一 project
  project_id TEXT NOT NULL DEFAULT '',
  token_jti TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT NOT NULL DEFAULT '',
  revoke_reason TEXT NOT NULL DEFAULT ''
);

-- 会话吊销列表按 jti 与 session 双向可查（token 只携带 jti + sid）
CREATE INDEX IF NOT EXISTS idx_human_sessions_jti
  ON human_sessions(token_jti);
CREATE INDEX IF NOT EXISTS idx_human_sessions_subject
  ON human_sessions(subject, status);

-- ──────────────── §13.2/§21 Phase 6 紧急撤销 durable 支撑 ────────────────
-- revoke-all-sessions 落库的新签发密钥（版本 > env 密钥环最高版本）。
-- MVP 阶段密钥材料随 SQLite 文件权限保护；迁 Secret Provider 事项见
-- docs/runbooks/security-phase6.md（§密钥与 token 生命周期）。
CREATE TABLE IF NOT EXISTS v2_credential_keys (
  key_version INTEGER PRIMARY KEY,
  material_hex TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT ''
);

-- 单行水位：低于 min_key_version 的全部凭据立即失效（重启后仍生效）
CREATE TABLE IF NOT EXISTS v2_credential_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  min_key_version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO v2_credential_state (id, min_key_version, updated_at) VALUES (1, 0, 0);
`;

export const checksumMaterial = schemaSql;

export function up(db: Database.Database): void {
  db.exec(schemaSql);
}
