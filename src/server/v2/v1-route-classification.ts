/**
 * V1 路由显式分类（22.2-13/14）
 *
 * 四类：legacy lifecycle / PM transport / maintenance / read-only。
 * 未分类的 mutation 路由构建期失败（生成式门禁测试）。
 */

/** V1 路由分类枚举。 */
export type V1RouteCategory =
  | 'legacy_lifecycle'   // claim/report/renew/ownership 等 Worker 数据面
  | 'pm_transport'       // plan create/submit/supersede、question create/answer
  | 'maintenance'        // reconcile/watchdog/restore 等运维路由
  | 'read_only';         // getStatus/getTasks/getPlan 等只读路由

/** V1 路由分类条目。 */
export interface V1RouteClassification {
  path: string;
  method: string;
  category: V1RouteCategory;
  isMutation: boolean;
  description: string;
}

/**
 * V1 路由分类表。
 * 所有 mutation 路由必须显式分类，否则构建期门禁测试失败。
 */
export const V1_ROUTE_CLASSIFICATIONS: readonly V1RouteClassification[] = [
  // ── legacy_lifecycle（Worker 数据面） ──
  { path: '/claim', method: 'POST', category: 'legacy_lifecycle', isMutation: true, description: '认领任务' },
  { path: '/report', method: 'POST', category: 'legacy_lifecycle', isMutation: true, description: '报告结果' },
  { path: '/lease/renew', method: 'POST', category: 'legacy_lifecycle', isMutation: true, description: '续租' },
  { path: '/ownership/declare', method: 'POST', category: 'legacy_lifecycle', isMutation: true, description: '声明所有权' },
  { path: '/ownership/release', method: 'POST', category: 'legacy_lifecycle', isMutation: true, description: '释放所有权' },

  // ── pm_transport（Plan/Question mutation） ──
  { path: '/plan/create', method: 'POST', category: 'pm_transport', isMutation: true, description: '创建 Plan' },
  { path: '/plan/submit', method: 'POST', category: 'pm_transport', isMutation: true, description: '提交 Plan' },
  { path: '/plan/supersede', method: 'POST', category: 'pm_transport', isMutation: true, description: '替换 Plan' },
  { path: '/question/create', method: 'POST', category: 'pm_transport', isMutation: true, description: '创建问题' },
  { path: '/question/answer', method: 'POST', category: 'pm_transport', isMutation: true, description: '回答问题' },

  // ── maintenance（运维路由） ──
  { path: '/reconcile', method: 'POST', category: 'maintenance', isMutation: true, description: '对账' },
  { path: '/watchdog', method: 'POST', category: 'maintenance', isMutation: true, description: '巡检' },
  { path: '/restore', method: 'POST', category: 'maintenance', isMutation: true, description: '恢复' },
  { path: '/pm/review', method: 'POST', category: 'maintenance', isMutation: true, description: 'PM 验收' },
  { path: '/pm/ack', method: 'POST', category: 'maintenance', isMutation: true, description: 'PM 确认' },
  { path: '/pm/answer', method: 'POST', category: 'maintenance', isMutation: true, description: 'PM 回答' },

  // ── read_only（只读路由） ──
  { path: '/status', method: 'GET', category: 'read_only', isMutation: false, description: '状态查询' },
  { path: '/tasks', method: 'GET', category: 'read_only', isMutation: false, description: '任务列表' },
  { path: '/plan', method: 'GET', category: 'read_only', isMutation: false, description: 'Plan 查询' },
  { path: '/events', method: 'GET', category: 'read_only', isMutation: false, description: '事件列表' },
  { path: '/questions', method: 'GET', category: 'read_only', isMutation: false, description: '问题列表' },
  { path: '/conflicts', method: 'GET', category: 'read_only', isMutation: false, description: '冲突列表' },
  { path: '/ownership', method: 'GET', category: 'read_only', isMutation: false, description: '所有权查询' },
];

/** 获取指定路径的分类。 */
export function classifyV1Route(path: string, method: string): V1RouteClassification | null {
  const normalized = path.replace(/^\/api(?=\/)/, '');
  return V1_ROUTE_CLASSIFICATIONS.find(
    (r) => r.path === normalized && r.method === method.toUpperCase(),
  ) ?? null;
}

/** 检查是否为已分类的 mutation 路由。 */
export function isClassifiedMutationRoute(path: string, method: string): boolean {
  const classification = classifyV1Route(path, method);
  return classification !== null && classification.isMutation;
}

/** 获取所有未分类的 mutation 路由（构建期门禁用）。 */
export function getUnclassifiedMutationRoutes(
  registeredPaths: Array<{ path: string; method: string }>,
): Array<{ path: string; method: string }> {
  return registeredPaths.filter(({ path, method }) => {
    const classification = classifyV1Route(path, method);
    // 未分类 = 不在分类表中
    return classification === null;
  });
}
