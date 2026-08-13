import type { BoardGroupKey } from '../view-model';
import type { ResolutionAction, ResolutionStatus } from '../resolution';
import type { Locale, TFunction, TranslationKey } from './translations';
import { createTranslator } from './translations';

const STATUS_KEYS = new Set<TranslationKey>([
  'status.idle',
  'status.busy',
  'status.online',
  'status.stale',
  'status.offline',
  'status.pending',
  'status.submitted',
  'status.completed',
  'status.running',
  'status.done',
  'status.failed',
  'status.blocked',
  'status.cancelled',
  'status.superseded',
  'status.accepted',
  'status.rejected',
  'status.review_pending',
]);

export function getStatusLabel(status: string, t: TFunction): string {
  const key = `status.${status}` as TranslationKey;
  if (STATUS_KEYS.has(key)) return t(key);
  return status || t('status.unknown');
}

export function getGroupLabel(group: BoardGroupKey, t: TFunction): string {
  if (group === 'rejected') return t('group.rejected');
  if (group === 'failed') return t('group.failed');
  return t(`status.${group}` as TranslationKey);
}

export function getStatusLabelByLocale(status: string, locale: Locale): string {
  const t = createTranslator(locale);
  return getStatusLabel(status, t);
}

/**
 * 闭环状态与任务 status 分开翻译：它绝不把失败/拒绝覆盖成普通“成功”。
 */
export function getResolutionLabel(
  status: ResolutionStatus,
  action: ResolutionAction | null,
  t: TFunction,
): string {
  if (status === 'repairing' && action === 'reverify') return t('resolution.repairingReverify');
  if (status === 'resolved' && action === 'reverify') return t('resolution.resolvedReverify');
  if (status === 'required') return t('resolution.required');
  if (status === 'repairing') return t('resolution.repairing');
  if (status === 'resolved') return t('resolution.resolved');
  return t('resolution.needsPmDecision');
}

export function getResolutionActionLabel(action: ResolutionAction | null, t: TFunction): string {
  if (action === 'reverify') return t('resolution.actionReverify');
  if (action === 'inspect') return t('resolution.actionInspect');
  return t('resolution.actionRepair');
}
