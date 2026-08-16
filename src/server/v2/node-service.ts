/**
 * V2 NodeService 最小实现（Phase 1）
 *
 * 组合车道 A 的 SqliteStore + 车道 C 的 credentials，
 * 实现 domain-interfaces.ts 的 NodeService 子集。
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { SqliteStore } from '../../db/sqlite-store.js';
import type { NodeRow, NodeSessionRow, NodeProjectBindingRow } from '../../types/v2-identity.js';
import {
  issueNodeCredential,
  verifyNodeCredential,
  type IssueCredentialOptions,
} from './credentials.js';
import type {
  NodeService,
  V2Node,
  V2NodeCreateInput,
  V2NodeHeartbeatInput,
  V2RequestMeta,
  V2ActorContext,
  V2PageRequest,
  V2Page,
  V2CorrelationId,
} from './domain-interfaces.js';
import type { ApiResponse, ProjectAgentBinding } from '../../types/index.js';

/** 服务端公告的协议版本（与 src/node/protocol.ts NODE_PROTOCOL_VERSION_* 对齐）。 */
const SERVER_PROTOCOL_VERSION = 2;

/** enrollment ticket 环境变量名。 */
const ENROLLMENT_TICKET_ENV = 'BIAO_V2_ENROLLMENT_TICKET';

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ApiResponse<never> {
  return { ok: false, data: null, error: { code, message } };
}

function rowToNode(row: NodeRow): V2Node {
  return {
    node_id: row.node_id,
    status: row.status as V2Node['status'],
    credential_generation: row.credential_generation,
    slots: row.max_concurrent_tasks,
    last_heartbeat_at: row.last_seen_at,
    revision: row.updated_at,
    updated_at: row.updated_at,
  };
}

export interface NodeServiceOptions {
  credentialOptions?: IssueCredentialOptions;
}

export function createNodeService(store: SqliteStore, options: NodeServiceOptions = {}): NodeService {
  const credOpts = options.credentialOptions ?? {};

  function ensureNode(nodeId: string): NodeRow | ApiResponse<never> {
    const row = store.getNode(nodeId);
    if (!row) return fail('NOT_FOUND', `节点 ${nodeId} 不存在`);
    return row;
  }

  /** 校验 enrollment ticket（timing-safe）。
   * - env 未配置 → 允许 enroll（向后兼容，不强制 ticket）
   * - env 已配置 → 必须提供正确 ticket（timing-safe 比较）
   */
  function validateEnrollmentTicket(submitted: string): ApiResponse<never> | null {
    const expected = process.env[ENROLLMENT_TICKET_ENV]?.trim();
    if (!expected) {
      return null; // 未配置 → 允许 enroll（向后兼容）
    }
    if (!submitted || typeof submitted !== 'string') {
      return fail('INVALID_TICKET', 'enrollment ticket 缺失');
    }
    const expectedBuf = Buffer.from(expected, 'utf8');
    const submittedBuf = Buffer.from(submitted, 'utf8');
    if (expectedBuf.length !== submittedBuf.length || !timingSafeEqual(expectedBuf, submittedBuf)) {
      return fail('INVALID_TICKET', 'enrollment ticket 无效');
    }
    return null;
  }

  return {
    async enroll(input, meta) {
      const now = Date.now();
      const existing = store.getNode(input.node_id);

      const ticketError = validateEnrollmentTicket(input.enrollment_ticket);
      if (ticketError) return ticketError;

      if (existing && existing.status !== 'enrolling') {
        // re-enroll: increment credential_generation
        const newGen = existing.credential_generation + 1;
        store.updateNode(input.node_id, {
          credential_generation: newGen,
          status: 'online',
          updated_at: now,
        });
        const credential = issueNodeCredential(input.node_id, newGen, credOpts);
        return ok({ node_credential: credential, credential_generation: newGen });
      }

      // First enroll
      const generation = 1;
      const row: NodeRow = {
        node_id: input.node_id,
        display_name: input.node_id,
        os: '',
        arch: '',
        node_version: '',
        protocol_version: 'v2',
        status: 'online',
        capabilities: '[]',
        labels: '[]',
        max_concurrent_tasks: 4,
        memory_mb: null,
        disk_free_mb: null,
        last_seen_at: now,
        credential_generation: generation,
        clock_skew_ms: null,
        server_cert_not_after: '',
        trust_anchor_generation: 0,
        signing_key_generation: 0,
        accepted_control_plane_signing_key_generations: '[]',
        terminal_state_at: null,
        terminal_state_reason: '',
        ttl_expires_at: null,
        created_at: now,
        updated_at: now,
      };

      if (existing) {
        store.updateNode(input.node_id, {
          status: 'online',
          credential_generation: generation,
          last_seen_at: now,
          updated_at: now,
        });
      } else {
        store.insertNode(row);
      }

      const credential = issueNodeCredential(input.node_id, generation, credOpts);
      return ok({ node_credential: credential, credential_generation: generation });
    },

    async register(input, meta) {
      const now = Date.now();
      const existing = store.getNode(input.node_id);

      if (!existing) {
        return fail('NOT_FOUND', `节点 ${input.node_id} 未 enroll，请先调用 enroll`);
      }

      // 协议版本校验：fail-closed，不匹配直接 409
      const regInput = input as V2NodeCreateInput & { protocol_version?: number };
      if (typeof regInput.protocol_version === 'number') {
        if (regInput.protocol_version < SERVER_PROTOCOL_VERSION) {
          return fail('PROTOCOL_BELOW_MIN', `节点协议版本 ${regInput.protocol_version} 低于服务端最小版本 ${SERVER_PROTOCOL_VERSION}`);
        }
        if (regInput.protocol_version > SERVER_PROTOCOL_VERSION) {
          return fail('PROTOCOL_ABOVE_MAX', `节点协议版本 ${regInput.protocol_version} 高于服务端最大版本 ${SERVER_PROTOCOL_VERSION}`);
        }
      }

      // Fence old session: get current session and mark fenced
      const currentSession = store.getCurrentNodeSession(input.node_id);
      const newGen = (currentSession?.node_session_generation ?? 0) + 1;
      const sessionId = `sess-${randomUUID().slice(0, 12)}`;

      if (currentSession) {
        store.updateNodeSession(currentSession.session_id, {
          status: 'fenced',
          fenced_at: now,
        });
      }

      store.insertNodeSession({
        session_id: sessionId,
        node_id: input.node_id,
        node_session_generation: newGen,
        credential_generation: existing.credential_generation,
        status: 'active',
        started_at: now,
        last_seen_at: now,
        fenced_at: null,
      });

      store.updateNode(input.node_id, {
        max_concurrent_tasks: input.slots,
        labels: JSON.stringify(input.labels ?? []),
        status: 'online',
        last_seen_at: now,
        updated_at: now,
      });

      return ok(rowToNode({ ...existing, max_concurrent_tasks: input.slots, status: 'online', last_seen_at: now, updated_at: now }));
    },

    async heartbeat(nodeId, input, meta) {
      const now = Date.now();
      const node = store.getNode(nodeId);
      if (!node) return fail('NOT_FOUND', `节点 ${nodeId} 不存在`);

      store.updateNode(nodeId, {
        last_seen_at: now,
        clock_skew_ms: input.clock_skew_ms,
        updated_at: now,
      });

      return ok({ status: node.status as V2Node['status'], config_revision: 0 });
    },

    async drain(nodeId, meta) {
      const now = Date.now();
      const node = store.getNode(nodeId);
      if (!node) return fail('NOT_FOUND', `节点 ${nodeId} 不存在`);

      store.updateNode(nodeId, { status: 'draining', updated_at: now });
      return ok(rowToNode({ ...node, status: 'draining', updated_at: now }));
    },

    async offline(nodeId, input, meta) {
      const now = Date.now();
      const node = store.getNode(nodeId);
      if (!node) return fail('NOT_FOUND', `节点 ${nodeId} 不存在`);

      store.updateNode(nodeId, {
        status: 'offline',
        terminal_state_at: now,
        terminal_state_reason: input.reason,
        updated_at: now,
      });

      return ok({ node_id: nodeId, offline: true });
    },

    async revoke(nodeId, input, meta) {
      const now = Date.now();
      const node = store.getNode(nodeId);
      if (!node) return fail('NOT_FOUND', `节点 ${nodeId} 不存在`);

      // Increment credential_generation to fence all existing credentials
      const newGen = node.credential_generation + 1;
      store.updateNode(nodeId, {
        credential_generation: newGen,
        status: 'quarantined',
        terminal_state_at: now,
        terminal_state_reason: input.reason,
        updated_at: now,
      });

      // Fence all active sessions
      const sessions = store.listNodeSessions(nodeId, 'active');
      for (const sess of sessions) {
        store.updateNodeSession(sess.session_id, { status: 'fenced', fenced_at: now });
      }

      return ok({ node_id: nodeId, revoked: true });
    },

    async authorizeProject(nodeId, projectId, meta) {
      const now = Date.now();
      const node = store.getNode(nodeId);
      if (!node) return fail('NOT_FOUND', `节点 ${nodeId} 不存在`);

      const project = store.getProject(projectId);
      if (!project) return fail('NOT_FOUND', `项目 ${projectId} 不存在`);

      const existing = store.getNodeProjectBinding(nodeId, projectId);
      if (existing) {
        // Already bound, increment authorization_revision
        const newRev = existing.authorization_revision + 1;
        store.updateNodeProjectBinding(existing.binding_id, {
          authorization_status: 'authorized',
          authorized_by: meta.actor.actor_id,
          authorized_at: now,
          authorization_revision: newRev,
          updated_at: now,
        });
        return ok({
          binding_id: existing.binding_id,
          project_scope: projectId,
          agent_id: nodeId,
          status: 'authorized',
          wake_mode: 'background_executor',
          policy: 'automatic',
        } as unknown as ProjectAgentBinding);
      }

      const bindingId = `npb-${randomUUID().slice(0, 12)}`;
      store.insertNodeProjectBinding({
        binding_id: bindingId,
        node_id: nodeId,
        project_id: projectId,
        local_cache_root: '',
        checkout_mode: 'worktree',
        repository_fingerprint: project.repository_fingerprint,
        last_fetch_sha: '',
        health: 'ready',
        last_checked_at: now,
        authorization_status: 'authorized',
        authorized_by: meta.actor.actor_id,
        authorized_at: now,
        authorization_revision: 1,
        applied_policy_revision: 0,
        write_credential_status: 'eligible',
        created_at: now,
        updated_at: now,
      });

      return ok({
        binding_id: bindingId,
        project_scope: projectId,
        agent_id: nodeId,
        status: 'authorized',
        wake_mode: 'background_executor',
        policy: 'automatic',
      } as unknown as ProjectAgentBinding);
    },

    async revokeProjectAuthorization(nodeId, projectId, meta) {
      const now = Date.now();
      const binding = store.getNodeProjectBinding(nodeId, projectId);
      if (!binding) return fail('NOT_FOUND', `节点 ${nodeId} 未绑定项目 ${projectId}`);

      store.updateNodeProjectBinding(binding.binding_id, {
        authorization_status: 'revoked',
        write_credential_status: 'suspended',
        updated_at: now,
      });

      return ok({ revoked: true });
    },

    async listNodes(page, meta) {
      const all = store.listNodes();
      const limit = Math.min(page.limit ?? 50, 500);
      const cursor = page.cursor;
      let startIdx = 0;
      if (cursor) {
        const idx = all.findIndex((r) => r.node_id === cursor);
        if (idx >= 0) startIdx = idx + 1;
      }
      const slice = all.slice(startIdx, startIdx + limit);
      const nextCursor = slice.length === limit ? slice[slice.length - 1].node_id : null;
      return ok({ items: slice.map(rowToNode), next_cursor: nextCursor });
    },

    async appendExecutionReceipt(projectId, input, meta) {
      return fail('NOT_IMPLEMENTED', 'Phase 2+ 范围');
    },

    async listExecutionReceipts(projectId, options, meta) {
      return fail('NOT_IMPLEMENTED', 'Phase 2+ 范围');
    },
  };
}

/**
 * §22.4 独立导出：心跳 stale 检测（供 alert-scheduler 调用，只消费导出接口不改其文件）。
 * 心跳超阈值（默认 3 个周期）→ node 自动 offline + running attempt 进 pending_recovery；
 * 连续多次 stale → quarantine + session fencing。
 */
export function checkStaleNodes(store: SqliteStore, staleThresholdMs?: number): { processed: number; offlined: number; quarantined: number } {
  const threshold = staleThresholdMs ?? 180_000; // 默认 3 分钟（3 个 60s 周期）
  const now = Date.now();
  const nodes = store.listNodes();
  let processed = 0;
  let offlined = 0;
  let quarantined = 0;

  for (const node of nodes) {
    // 只检查在线节点
    if (node.status !== 'online' && node.status !== 'draining') continue;
    const lastSeen = node.last_seen_at;
    if (!lastSeen || now - lastSeen < threshold) continue;

    processed++;
    const staleDuration = now - lastSeen;

    // 连续多次 stale → quarantine（stale 超过 2 倍阈值）
    if (staleDuration > threshold * 2) {
      const newGen = node.credential_generation + 1;
      store.updateNode(node.node_id, {
        credential_generation: newGen,
        status: 'quarantined',
        terminal_state_at: now,
        terminal_state_reason: `stale_timeout_quarantine: last_seen ${Math.round(staleDuration / 1000)}s ago`,
        updated_at: now,
      });
      // fence all active sessions
      const sessions = store.listNodeSessions(node.node_id, 'active');
      for (const sess of sessions) {
        store.updateNodeSession(sess.session_id, { status: 'fenced', fenced_at: now });
      }
      quarantined++;
    } else {
      // 单次 stale → offline
      store.updateNode(node.node_id, {
        status: 'offline',
        terminal_state_at: now,
        terminal_state_reason: `stale_timeout: last_seen ${Math.round(staleDuration / 1000)}s ago`,
        updated_at: now,
      });
      offlined++;
    }

    // 该 node 的 running attempt 进 pending_recovery
    const runningAttempts = store.listTaskAttemptsByNode(node.node_id, 'executing');
    for (const attempt of runningAttempts) {
      store.updateTaskAttempt(attempt.attempt_id, {
        status: 'pending_recovery',
        failure_reason: 'node_stale_timeout',
        updated_at: now,
        completed_at: now,
      });
      // 释放 task 回 pending
      const task = store.getTaskByAttemptId(attempt.attempt_id);
      if (task) {
        store.updateTaskFields(task.task_id, {
          status: 'pending',
          active_attempt_id: '',
          updated_at: new Date(now).toISOString(),
        });
      }
    }
  }

  return { processed, offlined, quarantined };
}
