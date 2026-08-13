/**
 * Biao API 数据层
 * 同源部署（biao serve 同时提供 API 和前端），直接用相对路径。
 * 所有响应包装为 { ok, data, error }。
 */

export interface TaskCounts {
  pending: number;
  running: number;
  done: number;
  failed: number;
}

export interface PlanSummary {
  plan_id: string;
  title: string;
  status: string;
  project_path: string;
  task_count: number;
}

export interface AgentInfo {
  agent_id: string;
  agent_type: string;
  status: string;
  current_task: string;
  /** current_task 的真实任务状态；用于把已结束的旧指针折叠到历史。 */
  current_task_status?: string;
  last_heartbeat: number;
}

export interface StatusAttention {
  failed: number;
  rejected: number;
  needs_pm_decision: number;
  stale_running_agents: number;
}

export interface StatusHistory {
  resolved_failed: number;
  resolved_rejected: number;
  stale_agents: number;
}

export interface StatusData {
  tasks: TaskCounts;
  reviews?: {
    pending: number;
    accepted: number;
    rejected: number;
  };
  /** 当前需要处理的异常；旧 tasks/reviews 字段仍保留原始审计总数。 */
  attention?: StatusAttention;
  /** 已闭环失败/拒绝与历史 Agent 的独立统计。 */
  history?: StatusHistory;
  ownership_conflicts: number;
  plans: PlanSummary[];
  agents: AgentInfo[];
  agent_groups?: {
    current: AgentInfo[];
    history: AgentInfo[];
  };
  hint?: {
    /** 稳定语义码；前端据此做本地化，message 仅作旧服务回退。 */
    code?: string;
    message?: string;
  } | null;
}

export interface TaskSummary {
  task_id: string;
  title: string;
  type: string;
  phase: string;
  assignee: string;
  priority: number;
  ownership_files: string[];
  depends_on: string[];
  claimed_by?: string;
  claimed_at?: number;
  expire_at?: number;
  done_at?: number;
  status?: string;
  retries?: number;
  max_retries?: number;
  pm_review_status?: 'pending' | 'accepted' | 'rejected' | '' | string;
  /** 新版服务端的简写字段；与 pm_review_status 等价。 */
  review_status?: 'pending' | 'accepted' | 'rejected' | '' | string;
  pm_reviewed_by?: string;
  pm_reviewed_at?: number;
  pm_review_comment?: string;
  pm_reject_reason?: string;
  pm_fix_instructions?: string;
  failure_reason?: string;
  blocked_reason?: string;
  blocked_at?: number;
  /**
   * 自动修复闭环字段。它们不改写原始 status/PM Review：
   * failed/rejected 仍是可审计事实，resolved 只表示后续修复已独立验收。
   */
  fix_for?: string;
  repair_root_task_id?: string;
  resolution_status?: 'required' | 'repairing' | 'resolved' | 'needs_pm_decision' | string;
  resolution_action?: 'repair' | 'reverify' | 'inspect' | string;
  resolution_task_id?: string;
  resolution_task_ids?: string[] | string;
  resolved_by_task?: string;
  resolution_generation?: number;
  resolution_attempts?: number;
  result_summary?: string;
  result?: unknown;
  verify?: unknown[];
  verify_results?: unknown[];
}

export interface PlanData {
  plan_id: string;
  title: string;
  status: string;
  project_path: string;
  task_count: number;
  created_at: number;
  phases: string[];
  tasks: {
    pending: TaskSummary[];
    running: TaskSummary[];
    done: TaskSummary[];
    failed: TaskSummary[];
    blocked?: TaskSummary[];
    cancelled?: TaskSummary[];
    superseded?: TaskSummary[];
  };
}

interface ApiResponse<T> {
  ok: boolean;
  data: T | null;
  error?: { code: string; message: string };
}

export interface HumanSessionData {
  authenticated: boolean;
  mode: 'local_owner' | 'auth_disabled' | string;
  local_session_available: boolean;
}

function clearLegacyBrowserToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem('biao_api_token');
  } catch {
    // 浏览器禁用 sessionStorage 时无需影响本机 Owner 会话。
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, credentials: init?.credentials ?? 'same-origin' });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as ApiResponse<unknown>;
      detail = body.error?.message ?? '';
    } catch {
      // 非 JSON 错误响应保留 HTTP 状态即可。
    }
    throw new Error(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}: ${url}`);
  }
  const body = (await res.json()) as ApiResponse<T>;
  if (!body.ok) {
    throw new Error(body.error ? `${body.error.code}: ${body.error.message}` : `API error: ${url}`);
  }
  return body.data as T;
}

async function publicSessionRequest(url: string, init?: RequestInit): Promise<HumanSessionData> {
  const res = await fetch(url, { ...init, credentials: 'same-origin' });
  const body = (await res.json()) as ApiResponse<HumanSessionData>;
  if (!res.ok || !body.ok || !body.data) {
    throw new Error(body.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status}: ${url}`);
  }
  return body.data;
}

/** 人类 PM 的 HttpOnly 本机 Owner 会话；Agent Bearer Token 永远不进入此流程。 */
export function fetchHumanSession(): Promise<HumanSessionData> {
  return publicSessionRequest('/auth/session');
}

export async function beginLocalOwnerSession(): Promise<HumanSessionData> {
  const session = await publicSessionRequest('/auth/local-session', { method: 'POST' });
  // 迁移旧页面：成功建立 HttpOnly 会话后，主动删掉旧版留在 sessionStorage 的 Token。
  clearLegacyBrowserToken();
  return session;
}

export function endLocalOwnerSession(): Promise<HumanSessionData> {
  return publicSessionRequest('/auth/local-session', { method: 'DELETE' });
}

/** GET /status → 全局任务计数、plan 列表、agent 列表 */
export async function fetchStatus(): Promise<StatusData> {
  return request<StatusData>('/status');
}

/** GET /plan/:id → plan 详情 + 按状态分桶的任务列表 */
export async function fetchPlan(planId: string): Promise<PlanData> {
  return request<PlanData>(`/plan/${encodeURIComponent(planId)}`);
}

export interface CreatePlanRequest {
  plan_id: string;
  title?: string;
  project_path: string;
}

export interface CreatePlanResult {
  plan_id: string;
  plan_dir: string;
  submitted: boolean;
  task_count: number;
}

/** POST /plan/create → 创建新项目 */
export async function createPlan(req: CreatePlanRequest): Promise<CreatePlanResult> {
  return request<CreatePlanResult>('/plan/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

export interface VerifyResult {
  cmd?: string;
  passed?: boolean;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  [key: string]: unknown;
}

export interface TaskReviewInfo {
  task_id: string;
  title: string;
  status: string;
  claimed_by: string;
  done_at: string | number;
  pm_review_status: string;
  result_md: string;
  result_json: Record<string, unknown>;
  changed_files: string[];
  verify_results: VerifyResult[];
  plan_md_violations: unknown[];
}

export interface ReviewTaskRequest {
  verdict: 'accept' | 'reject';
  comment?: string;
  reject_reason?: string;
  fix_instructions?: string;
  reviewed_by: string;
}

export interface ReviewTaskResult {
  task_id: string;
  review_status: string;
  fix_task_id?: string;
}

export async function fetchTaskReview(taskId: string): Promise<TaskReviewInfo> {
  return request<TaskReviewInfo>(`/task/${encodeURIComponent(taskId)}/review`);
}

export async function reviewTask(taskId: string, review: ReviewTaskRequest): Promise<ReviewTaskResult> {
  return request<ReviewTaskResult>(`/task/${encodeURIComponent(taskId)}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(review),
  });
}

export async function resetTask(taskId: string, force: boolean): Promise<{ task_id: string; status: string }> {
  return request<{ task_id: string; status: string }>(`/task/${encodeURIComponent(taskId)}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force, reset_by: 'pm-web' }),
  });
}

export async function cancelTask(taskId: string): Promise<{ task_id: string; status: string }> {
  return request<{ task_id: string; status: string }>(`/task/${encodeURIComponent(taskId)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

/* ---------------- SSE 实时事件推送 ---------------- */

/** Biao 事件（SSE 推送，替换 5 秒轮询） */
export interface BiaoEvent {
  type: 'task_claimed' | 'task_completed' | string;
  task_id: string;
  agent_id: string;
  result_status?: string;
  ts: number;
}

const EVENT_STREAM_URL = '/events/stream';
const EVENT_RECONNECT_INITIAL_MS = 5_000;
const EVENT_RECONNECT_MAX_MS = 60_000;
const EVENT_FALLBACK_POLL_MS = 60_000;

/**
 * 订阅实时事件流（SSE）。本机 Owner Cookie 走 same-origin fetch 流；没有 fetch
 * 能力时再降级浏览器 EventSource。标签页进入后台会暂停连接，
 * 断线采用有上限的指数退避，避免网络故障时形成忙循环。
 * @returns unsubscribe 清理函数（关闭连接、定时器和 visibility listener）
 */
export function subscribeToEvents(
  onUpdate: (event: BiaoEvent) => void,
  onError?: () => void,
): () => void {
  let stopped = false;
  let reconnectDelay = EVENT_RECONNECT_INITIAL_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pollingTimer: ReturnType<typeof setInterval> | undefined;
  let fetchController: AbortController | undefined;
  let es: EventSource | undefined;

  const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

  const clearReconnect = () => {
    if (reconnectTimer === undefined) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };

  const stopPolling = () => {
    if (pollingTimer === undefined) return;
    clearInterval(pollingTimer);
    pollingTimer = undefined;
  };

  const startPolling = () => {
    if (stopped || !isVisible() || pollingTimer !== undefined) return;
    pollingTimer = setInterval(() => {
      onUpdate({ type: 'poll', task_id: '', agent_id: '', ts: Date.now() });
    }, EVENT_FALLBACK_POLL_MS);
  };

  const dispatchData = (dataLines: string[]) => {
    if (dataLines.length === 0) return;
    try {
      const event = JSON.parse(dataLines.join('\n')) as BiaoEvent;
      reconnectDelay = EVENT_RECONNECT_INITIAL_MS;
      onUpdate(event);
    } catch {
      // 忽略损坏或非 JSON 的消息，保持流继续消费。
    }
  };

  const consumeFetchStream = async (controller: AbortController) => {
    try {
      const res = await fetch(EVENT_STREAM_URL, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
        },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${EVENT_STREAM_URL}`);
      if (!res.body) throw new Error('SSE response body is unavailable');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let dataLines: string[] = [];

      while (!stopped && !controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) throw new Error('SSE stream ended');
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);

          if (line === '') {
            dispatchData(dataLines);
            dataLines = [];
          } else if (line.startsWith('data:')) {
            const data = line.slice(5);
            dataLines.push(data.startsWith(' ') ? data.slice(1) : data);
          }
          newline = buffer.indexOf('\n');
        }
      }
    } catch {
      if (!stopped && !controller.signal.aborted) {
        onError?.();
        scheduleReconnect();
      }
    } finally {
      if (fetchController === controller) fetchController = undefined;
    }
  };

  const startSessionStream = () => {
    if (stopped || !isVisible() || fetchController) return;
    const controller = new AbortController();
    fetchController = controller;
    void consumeFetchStream(controller);
  };

  function scheduleReconnect() {
    if (stopped || !isVisible() || reconnectTimer !== undefined) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, EVENT_RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      startSessionStream();
    }, delay);
  }

  const startEventSource = () => {
    if (stopped || !isVisible() || es || typeof EventSource === 'undefined') return;
    const source = new EventSource(EVENT_STREAM_URL);
    es = source;
    source.onmessage = (event: MessageEvent) => dispatchData([event.data]);
    source.onerror = () => {
      if (!stopped) onError?.();
      // 原生 EventSource 自带有节制的重连；不叠加轮询或额外定时器。
    };
  };

  const pause = () => {
    clearReconnect();
    stopPolling();
    const controller = fetchController;
    fetchController = undefined;
    controller?.abort();
    es?.close();
    es = undefined;
  };

  const resume = () => {
    if (stopped || !isVisible()) return;
    if (typeof fetch === 'function') startSessionStream();
    else if (typeof EventSource !== 'undefined') startEventSource();
    else startPolling();
  };

  const handleVisibilityChange = () => {
    if (isVisible()) resume();
    else pause();
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
  resume();

  return () => {
    stopped = true;
    pause();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  };
}
