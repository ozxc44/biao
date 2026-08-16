/**
 * P12 §10：SSE 实时事件订阅 hook。
 *
 * 订阅 `/events/stream`（通过 api.ts 的 subscribeToEvents），收到事件后按
 * filter 决定是否触发 onEvent/refresh。任务状态变更、新 PM 门铃、冲突都推
 * 送到 Redis events stream → 前端无需手动刷新。
 *
 * 使用：
 *   const refreshRevision = useEventStream({
 *     filter: (event) => event.type !== 'poll',   // 忽略后台 fallback 轮询
 *   });
 *   // 把 refreshRevision 传给视图，作为 useEffect 依赖触发重载
 */

import { useEffect, useRef, useState } from 'react';
import { subscribeToEvents, type BiaoEvent } from '../api';

export interface UseEventStreamOptions {
  /** 是否启用订阅（默认 true）。登录页/未认证时可不订阅。 */
  enabled?: boolean;
  /** 事件过滤器：返回 false 的事件不触发刷新（默认全部触发）。 */
  filter?: (event: BiaoEvent) => boolean;
  /** 事件回调：每次通过过滤的事件到达时调用（可用于精确刷新特定资源）。 */
  onEvent?: (event: BiaoEvent) => void;
}

/**
 * 订阅事件流并维护一个单调递增的 revision。
 * revision 变化即“有需要刷新的事件到达”，可作为视图 useEffect 的依赖。
 */
export function useEventStream(options: UseEventStreamOptions = {}): number {
  const { enabled = true, filter, onEvent } = options;
  const [revision, setRevision] = useState(0);
  const onEventRef = useRef(onEvent);
  const filterRef = useRef(filter);
  onEventRef.current = onEvent;
  filterRef.current = filter;

  useEffect(() => {
    if (!enabled) return;
    return subscribeToEvents((event) => {
      if (filterRef.current && !filterRef.current(event)) return;
      onEventRef.current?.(event);
      setRevision((value) => value + 1);
    });
  }, [enabled]);

  return revision;
}

/** 忽略后台 fallback 轮询事件的默认过滤器（poll 不是真实业务事件）。 */
export function ignorePollEvents(event: BiaoEvent): boolean {
  return event.type !== 'poll';
}
