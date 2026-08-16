export type DagTaskFact = {
  task_id: string;
  type?: string;
  status: string;
  depends_on?: string[];
  ownership_files?: string[];
  pm_review_status?: string;
  resolution_status?: string;
  resolution_task_id?: string;
  resolved_by_task?: string;
  fix_for?: string;
  repair_root_task_id?: string;
  block_reason?: string;
  blocked_reason?: string;
};

export type ActiveOwnershipFact = {
  path: string;
  task_id: string;
  agent_id?: string;
};

export type DagTaskCategory =
  | 'runnable_now'
  | 'dependency_waiting'
  | 'ownership_waiting'
  | 'review_waiting'
  | 'running'
  | 'blocked'
  | 'terminal';

export type DagAnalysisWarning = {
  code: 'LOW_INITIAL_PARALLELISM';
  message: string;
  root_task_count: number;
  first_wave_width: number;
};

export type DagAnalysis = {
  schema_version: 1;
  task_count: number;
  root_task_count: number;
  counts: Record<DagTaskCategory, number>;
  task_ids: Record<DagTaskCategory, string[]>;
  first_wave_width: number;
  projected_waves: string[][];
  later_fan_out: { max_width: number; wave: number | null; task_ids: string[] };
  critical_path: { length: number; task_ids: string[] };
  top_blockers: Array<{ task_id: string; blocked_tasks: number; blocked_task_ids: string[] }>;
  recommended_worker_slots: number;
  invalid_dependencies: Array<{ task_id: string; dependency_id: string }>;
};

const CATEGORIES: DagTaskCategory[] = [
  'runnable_now',
  'dependency_waiting',
  'ownership_waiting',
  'review_waiting',
  'running',
  'blocked',
  'terminal',
];

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function globMatch(pattern: string, path: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(path);
}

function globsOverlap(left: string, right: string): boolean {
  if (left === right || globMatch(left, right) || globMatch(right, left)) return true;
  const staticDirectory = (value: string): string => {
    const wildcardAt = value.search(/[?*]/);
    const prefix = wildcardAt === -1 ? value : value.slice(0, wildcardAt);
    const slashAt = prefix.lastIndexOf('/');
    return slashAt === -1 ? '' : prefix.slice(0, slashAt + 1);
  };
  const leftDirectory = staticDirectory(left);
  const rightDirectory = staticDirectory(right);
  if (!leftDirectory || !rightDirectory) return leftDirectory === rightDirectory;
  return leftDirectory.startsWith(rightDirectory) || rightDirectory.startsWith(leftDirectory);
}

/** 与服务端 claim/checkDependencies 使用同一完成口径。 */
export function isDagDependencySatisfied(dependency: DagTaskFact, dependentType?: string): boolean {
  if (dependency.resolution_status) return dependency.resolution_status === 'resolved';
  if (dependency.status !== 'done') return false;
  return dependentType === 'acceptance' || dependency.pm_review_status === 'accepted';
}

function isSuccessfulTerminal(task: DagTaskFact): boolean {
  if (task.resolution_status) return task.resolution_status === 'resolved';
  return task.status === 'done' && task.pm_review_status === 'accepted';
}

function isAbandonedTerminal(task: DagTaskFact): boolean {
  return task.status === 'cancelled' || task.status === 'superseded' || task.resolution_status === 'cancelled';
}

function ownershipConflict(task: DagTaskFact, ownership: readonly ActiveOwnershipFact[]): boolean {
  return (task.ownership_files ?? []).some((declaredPath) => ownership.some((active) => (
    active.task_id !== task.task_id && globsOverlap(declaredPath, active.path)
  )));
}

function classifyTask(
  task: DagTaskFact,
  byId: ReadonlyMap<string, DagTaskFact>,
  ownership: readonly ActiveOwnershipFact[],
): DagTaskCategory {
  if (isSuccessfulTerminal(task) || isAbandonedTerminal(task)) return 'terminal';
  if (task.status === 'done') return 'review_waiting';
  if (task.status === 'running') return 'running';

  const blockedReason = task.block_reason ?? task.blocked_reason;
  if (task.status === 'blocked') {
    if (blockedReason === 'waiting_file_release') return 'ownership_waiting';
    if (blockedReason === 'waiting_dependency') return 'dependency_waiting';
    return 'blocked';
  }
  if (task.status !== 'pending') return 'blocked';

  const hasUnsatisfiedDependency = (task.depends_on ?? []).some((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return !dependency || !isDagDependencySatisfied(dependency, task.type);
  });
  if (hasUnsatisfiedDependency) return 'dependency_waiting';
  if (ownershipConflict(task, ownership)) return 'ownership_waiting';
  return 'runnable_now';
}

function longestPathFrom(
  taskId: string,
  children: ReadonlyMap<string, string[]>,
  memo: Map<string, string[]>,
  visiting: Set<string>,
): string[] {
  const existing = memo.get(taskId);
  if (existing) return existing;
  if (visiting.has(taskId)) return [taskId];
  visiting.add(taskId);
  const candidates = (children.get(taskId) ?? []).map((childId) => (
    [taskId, ...longestPathFrom(childId, children, memo, visiting)]
  ));
  visiting.delete(taskId);
  const best = candidates.sort((left, right) => (
    right.length - left.length || left.join('\u0000').localeCompare(right.join('\u0000'))
  ))[0] ?? [taskId];
  memo.set(taskId, best);
  return best;
}

/**
 * 只读取调用方传入的 task/review/ownership 快照，不访问文件、网络或时钟。
 * 输入相同即输出相同，供 CLI、测试和未来 UI 复用。
 */
export function analyzeDag(
  tasks: readonly DagTaskFact[],
  ownership: readonly ActiveOwnershipFact[] = [],
): DagAnalysis {
  const orderedTasks = [...tasks].sort((left, right) => left.task_id.localeCompare(right.task_id));
  const byId = new Map(orderedTasks.map((task) => [task.task_id, task]));
  const invalidDependencies = orderedTasks.flatMap((task) => (
    (task.depends_on ?? [])
      .filter((dependencyId) => !byId.has(dependencyId))
      .map((dependencyId) => ({ task_id: task.task_id, dependency_id: dependencyId }))
  ));

  const taskIds: Record<DagTaskCategory, string[]> = {
    runnable_now: [],
    dependency_waiting: [],
    ownership_waiting: [],
    review_waiting: [],
    running: [],
    blocked: [],
    terminal: [],
  };
  const categoryById = new Map<string, DagTaskCategory>();
  for (const task of orderedTasks) {
    const category = classifyTask(task, byId, ownership);
    categoryById.set(task.task_id, category);
    taskIds[category].push(task.task_id);
  }
  const counts = Object.fromEntries(CATEGORIES.map((category) => [category, taskIds[category].length])) as Record<DagTaskCategory, number>;

  const remainingIds = new Set(orderedTasks
    .filter((task) => !isSuccessfulTerminal(task) && !isAbandonedTerminal(task))
    .map((task) => task.task_id));
  const unresolvedDependencies = new Map<string, string[]>();
  const unresolvedChildren = new Map<string, string[]>();
  for (const task of orderedTasks) {
    if (!remainingIds.has(task.task_id)) continue;
    const dependencies = (task.depends_on ?? []).filter((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return dependency && remainingIds.has(dependencyId) && !isDagDependencySatisfied(dependency, task.type);
    });
    unresolvedDependencies.set(task.task_id, sorted(dependencies));
    for (const dependencyId of dependencies) {
      const children = unresolvedChildren.get(dependencyId) ?? [];
      children.push(task.task_id);
      unresolvedChildren.set(dependencyId, sorted(children));
    }
  }

  const waveMemo = new Map<string, number>();
  const waveVisiting = new Set<string>();
  const waveFor = (taskId: string): number => {
    const known = waveMemo.get(taskId);
    if (known !== undefined) return known;
    if (waveVisiting.has(taskId)) return 1;
    waveVisiting.add(taskId);
    const dependencies = unresolvedDependencies.get(taskId) ?? [];
    const wave = dependencies.length === 0 ? 1 : Math.max(...dependencies.map(waveFor)) + 1;
    waveVisiting.delete(taskId);
    waveMemo.set(taskId, wave);
    return wave;
  };
  const waves = new Map<number, string[]>();
  for (const taskId of remainingIds) {
    const wave = waveFor(taskId);
    waves.set(wave, sorted([...(waves.get(wave) ?? []), taskId]));
  }
  const projectedWaves = [...waves.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, ids]) => ids);
  const laterCandidates = projectedWaves.slice(1).map((ids, index) => ({
    max_width: ids.length,
    wave: index + 2,
    task_ids: ids,
  }));
  const laterFanOut = laterCandidates.sort((left, right) => (
    right.max_width - left.max_width || left.wave - right.wave
  ))[0] ?? { max_width: 0, wave: null, task_ids: [] };

  const pathMemo = new Map<string, string[]>();
  const paths = [...remainingIds].map((taskId) => (
    longestPathFrom(taskId, unresolvedChildren, pathMemo, new Set())
  ));
  const criticalTaskIds = paths.sort((left, right) => (
    right.length - left.length || left.join('\u0000').localeCompare(right.join('\u0000'))
  ))[0] ?? [];

  const topBlockers = [...remainingIds].map((taskId) => {
    const descendants = new Set<string>();
    const queue = [...(unresolvedChildren.get(taskId) ?? [])];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (descendants.has(current)) continue;
      descendants.add(current);
      queue.push(...(unresolvedChildren.get(current) ?? []));
    }
    return { task_id: taskId, blocked_tasks: descendants.size, blocked_task_ids: sorted(descendants) };
  }).filter((item) => item.blocked_tasks > 0).sort((left, right) => (
    right.blocked_tasks - left.blocked_tasks || left.task_id.localeCompare(right.task_id)
  )).slice(0, 5);

  const executionWidthByWave = projectedWaves.map((ids) => ids.filter((taskId) => {
    const category = categoryById.get(taskId);
    return category === 'runnable_now' || category === 'dependency_waiting' ||
      category === 'ownership_waiting' || category === 'running';
  }).length);
  const recommendedWorkerSlots = Math.max(
    counts.runnable_now,
    ...executionWidthByWave.slice(1),
    0,
  );

  return {
    schema_version: 1,
    task_count: orderedTasks.length,
    root_task_count: orderedTasks.filter((task) => (
      !task.fix_for && (!task.repair_root_task_id || task.repair_root_task_id === task.task_id)
    )).length,
    counts,
    task_ids: taskIds,
    first_wave_width: counts.runnable_now,
    projected_waves: projectedWaves,
    later_fan_out: laterFanOut,
    critical_path: { length: criticalTaskIds.length, task_ids: criticalTaskIds },
    top_blockers: topBlockers,
    recommended_worker_slots: recommendedWorkerSlots,
    invalid_dependencies: invalidDependencies,
  };
}

export function parallelismWarnings(analysis: DagAnalysis): DagAnalysisWarning[] {
  if (analysis.root_task_count < 8 || analysis.first_wave_width >= 3) return [];
  return [{
    code: 'LOW_INITIAL_PARALLELISM',
    message: `计划包含 ${analysis.root_task_count} 个根任务，但首波仅 ${analysis.first_wave_width} 个可并行；请检查是否存在可移除的串行依赖。`,
    root_task_count: analysis.root_task_count,
    first_wave_width: analysis.first_wave_width,
  }];
}
