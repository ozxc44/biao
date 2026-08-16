/**
 * Redis key 命名规范
 * 对应 docs/biao/04-redis-key-design.md
 * 所有 key 以 biao:v1: 为前缀
 */

const PREFIX = 'biao:v1';

export const keys = {
  stream: {
    tasks: `${PREFIX}:stream:tasks`,
    events: `${PREFIX}:stream:events`,
  },
  hash: {
    task: (taskId: string) => `${PREFIX}:hash:task:${taskId}`,
    plan: (planId: string) => `${PREFIX}:hash:plan:${planId}`,
    fileOwnership: `${PREFIX}:hash:file_ownership`,
    agent: (agentId: string) => `${PREFIX}:hash:agent:${agentId}`,
    /** claim 请求的短期单飞 reservation；防相同 request 并发穿过 replay 窗口。 */
    claimReservation: (agentId: string) => `${PREFIX}:hash:claim_reservation:${agentId}`,
    /** 单个 Question 的状态机真相源（question_id → 全字段） */
    question: (questionId: string) => `${PREFIX}:hash:question:${questionId}`,
  },
  zset: {
    /**
     * 正在执行的 Redis/SQLite 状态写入口。member 是不可猜的 request owner，score 是
     * 许可过期毫秒，但 score 只用于诊断续期是否中断。只有 owner 在 handler
     * settle 后的 finally 才能释放；restore 不会根据过期时间推断 writer 已停止。
     */
    maintenanceMutationPermits: `${PREFIX}:zset:maintenance_mutation_permits`,
    status: {
      pending: `${PREFIX}:zset:status:pending`,
      running: `${PREFIX}:zset:status:running`,
      blocked: `${PREFIX}:zset:status:blocked`,
      done: `${PREFIX}:zset:status:done`,
      failed: `${PREFIX}:zset:status:failed`,
      cancelled: `${PREFIX}:zset:status:cancelled`,
      superseded: `${PREFIX}:zset:status:superseded`,
    },
  },
  string: {
    lease: (taskId: string) => `${PREFIX}:string:lease:task:${taskId}`,
    /** PM review 的短临界区锁；避免并发 accept/reject 改写同一份不可变审计。 */
    pmReviewLock: (taskId: string) => `${PREFIX}:string:lock:pm_review:${taskId}`,
    /** Plan 批量 supersede 的短锁；与逐 task PM review 锁组合，避免预览应用时被验收改写。 */
    planSupersedeLock: (planId: string) => `${PREFIX}:string:lock:plan_supersede:${planId}`,
    /** SQLite → Redis 恢复的全局独占维护锁；值是 owner token，只能 owner 续期/释放。 */
    dbRestoreLock: `${PREFIX}:string:lock:db_restore`,
    /**
     * restore 的 durable 发布屏障。值为 owner JSON；成功后 owner-CAS 清除，失败/响应
     * 不确定时保留，所有 writer fail closed，避免半投影成为 live。
     */
    dbRestoreBarrier: `${PREFIX}:string:barrier:db_restore`,
  },
  pattern: {
    /** restore 维护检查只扫描 task lease，不把其它普通 string key 误判为活跃 Worker。 */
    taskLeases: `${PREFIX}:string:lease:task:*`,
  },
  set: {
    ownerByAgent: (agentId: string) => `${PREFIX}:set:owner_by_agent:${agentId}`,
  },
  list: {
    ownershipConflicts: `${PREFIX}:list:ownership_conflicts`,
  },
  /** consumer ack：按 consumer 维度记录已确认的事件 event_id，实现独立、幂等、持久的 ack */
  ack: {
    /** 某 consumer 已确认事件 id 的集合（SET，幂等 SADD） */
    consumerAcked: (consumer: string) => `${PREFIX}:set:ack:${consumer}`,
    /**
     * 某 consumer 已完成索引的 stream 游标（精确 stream id）。
     * 首次为空时必须历史回放；此后只从该游标后的新增尾部构建 pending 索引。
     */
    consumerCursor: (consumer: string) => `${PREFIX}:string:ack_cursor:${consumer}`,
    /**
     * 某 consumer 的未确认 PM 事件顺序索引（ZSET；所有 member 统一 score=0，
     * member 自带固定宽度的 stream-id 排序前缀，确保同毫秒 sequence 也严格有序）。
     */
    consumerPending: (consumer: string) => `${PREFIX}:zset:intake_pending:${consumer}`,
    /**
     * pending event_id → 最小事件投影 + 原始 stream id（HASH）。
     * ack 后删除，Redis stream 历史本身永远不删。
     */
    consumerPendingPayload: (consumer: string) => `${PREFIX}:hash:intake_pending:${consumer}`,
    /** 全局 consumer 名称注册表（审计：曾 ack 过的 consumer 列表） */
    consumers: `${PREFIX}:set:consumers`,
  },
  /** PM Review 待办的状态索引与一次性门铃去重。
   *
   * `done` 是任务交付状态而非 PM 验收状态。此索引把“尚未 review 的 done”保存为
   * 持续事实：事件被 ack 后，PM intake 仍可展示该待办；但 doorbell 本身只发一次。
   */
  reviewRequested: {
    /** 已为当前 task review 轮次发出过 review_requested 的 task_id（SET，幂等）。 */
    fired: `${PREFIX}:set:review_requested_fired`,
    /** task_id → review_requested event_id，用于 ack 后持续状态与 Supervisor 去重保持同一键。 */
    eventByTask: `${PREFIX}:hash:review_requested_event_by_task`,
    /** 所有 done 且 pm_review_status 为空的 task（ZSET，score=done_at）。 */
    pending: `${PREFIX}:zset:review_requested_pending`,
    /** 历史 event / done 状态已一次性建索引的标志，避免每轮轮询重扫全量历史。 */
    legacyIndexesReady: `${PREFIX}:string:review_requested_legacy_indexes_ready`,
  },
  /** acceptance_ready 去重：记录已发出 acceptance_ready 的 acceptance task，避免同一状态转换重复写事件 */
  acceptanceReady: {
    /** 已发出过 acceptance_ready 的 acceptance task_id 集合（SET，幂等） */
    fired: `${PREFIX}:set:acceptance_ready_fired`,
  },
  /**
   * 运行态异常补偿的耐久候选投影。
   *
   * 正常共享 Supervisor 只读取 pending，工作量与当前异常链数量相关，不再与历史
   * done/failed 总量相关。所有可能需要补偿的状态转换必须在同一 Redis 原子边界内
   * ZADD；backfillReady 缺失时才从历史状态安全回建一次。
   */
  runtimeReconcile: {
    pending: `${PREFIX}:zset:runtime_reconcile_pending`,
    backfillReady: `${PREFIX}:string:runtime_reconcile_backfill_ready:v1`,
  },
  /**
   * Plan/status 的物化统计投影。
   *
   * `/plans` 和 `/status` 是低频信息、但会被 PM/Supervisor 长期轮询。它们不能为了
   * 统计已闭合历史而每轮扫描全部 task hash。升级时 ready 缺失只允许一次全量
   * backfill；之后状态转换把对应 plan 放入 dirtyPlans，读取端只重建 dirty/当前 plan。
   */
  planStatusProjection: {
    ready: `${PREFIX}:string:plan_status_projection_ready:v1`,
    /** 首次 backfill 单写者锁；防并发首读用旧快照覆盖已刷新的 aggregate。 */
    backfillLock: `${PREFIX}:string:lock:plan_status_projection_backfill:v1`,
    /** 计划注册表；避免 SCAN MATCH plan 在万级 task keyspace 上仍遍历全库。 */
    planIds: `${PREFIX}:set:plan_status_projection_plans:v1`,
    /** Agent 注册表；避免 `/status` 的 MATCH 扫描穿过全部 task key。 */
    agentIds: `${PREFIX}:set:plan_status_projection_agents:v1`,
    /** 空注册表也需要 durable ready，不能用 Redis 不存在的空 SET 表示完成。 */
    agentIdsReady: `${PREFIX}:string:plan_status_projection_agents_ready:v1`,
    dirtyPlans: `${PREFIX}:set:plan_status_projection_dirty:v1`,
    revisionByPlan: `${PREFIX}:hash:plan_status_projection_revision:v1`,
    taskIdsByPlan: (planId: string) => `${PREFIX}:set:plan_status_projection_tasks:${planId}`,
    aggregateByPlan: (planId: string) => `${PREFIX}:hash:plan_status_projection:${planId}`,
  },
  /** PM intake 当前仍需人工注意的 failed 候选；resolved/repairing 历史不常驻轮询。 */
  intakeActionableFailed: {
    pending: `${PREFIX}:zset:intake_actionable_failed:v1`,
    ready: `${PREFIX}:string:intake_actionable_failed_ready:v1`,
    backfillLock: `${PREFIX}:string:lock:intake_actionable_failed_backfill:v1`,
  },
  /** 按 task_id 索引其当前 open Question（O(1) 查"该任务是否有未回答提问"） */
  question: {
    openByTask: (taskId: string) => `${PREFIX}:string:question_open:${taskId}`,
    /** openByTask 的原子创建辅助元数据；避免并发提问时需在 Lua 中猜测动态 hash key。 */
    openMetaByTask: (taskId: string) => `${PREFIX}:hash:question_open_meta:${taskId}`,
  },
} as const;

/** 把 Biao 服务地址规整成稳定哈希片段（用于锁 key，避免特殊字符）
 *  注意：此函数仅用于 key 生成，不做安全用途。 */
export function stableHash(input: string): string {
  // 简单确定性哈希（djb2），避免引入 crypto 依赖到 key 层
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

/** 默认 PM consumer 名称（旧 plan / 未声明 pm_consumer 时回退到此值，保证兼容） */
export const DEFAULT_PM_CONSUMER = 'pm';

/** consumer 名称校验：只允许安全的标识符（字母/数字/点/下划线/连字符，1~128 字符）。
 *  用于 PM consumer 路由与 ack，避免特殊字符污染 Redis key。 */
export function isValidConsumerName(consumer: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(consumer);
}

/** pending 索引的 score：高优先级更大，同优先级越旧越大（配合 ZREVRANGE）。 */
export function pendingScore(priority: number, ts: number): number {
  return priority * 1e13 - ts;
}

/** running 索引的 score：expire_at，便于惰性回收扫描 */
export function runningScore(expireAt: number): number {
  return expireAt;
}

// ──────────────── V2 namespace（§20.4：与 V1 不混用） ────────────────

const V2_PREFIX = 'biao:v2';

export const v2Keys = {
  /** §20.4: V2 namespace 前缀，与 V1 `biao:v1:` 严格隔离 */
  prefix: V2_PREFIX,
  /** node session 会话状态 */
  nodeSession: (nodeId: string, sessionId: string) =>
    `${V2_PREFIX}:node:${nodeId}:session:${sessionId}`,
  /** node 当前活跃 session 指针 */
  nodeActiveSession: (nodeId: string) =>
    `${V2_PREFIX}:node:${nodeId}:active_session`,
  /** attempt token（短期 claim 凭据） */
  attemptToken: (attemptId: string) =>
    `${V2_PREFIX}:attempt:${attemptId}:token`,
  /** ownership snapshot 快照 */
  ownershipSnapshot: (snapshotId: string) =>
    `${V2_PREFIX}:ownership_snapshot:${snapshotId}`,
  /** project 的当前 ownership snapshot 指针 */
  projectOwnership: (projectId: string) =>
    `${V2_PREFIX}:project:${projectId}:ownership`,
  /** node 心跳 TTL */
  nodeHeartbeat: (nodeId: string) =>
    `${V2_PREFIX}:node:${nodeId}:heartbeat`,
} as const;
