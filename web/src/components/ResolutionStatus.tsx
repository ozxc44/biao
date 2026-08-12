import type { TaskSummary } from '../api';
import { useI18n } from '../i18n/I18nContext';
import { getResolutionLabel } from '../i18n/status';
import { getResolutionPresentation } from '../resolution';

/**
 * 低噪声闭环标记：原始 failed/rejected 仍由任务列和审计原因呈现，
 * 该标记只说明后续 repair/reverify 的当前结果。
 */
export function ResolutionStatus({
  task,
  className = '',
}: {
  task: TaskSummary;
  className?: string;
}) {
  const { t } = useI18n();
  const resolution = getResolutionPresentation(task);
  if (!resolution) return null;

  const label = getResolutionLabel(resolution.status, resolution.action, t);
  return (
    <span
      className={`resolution-status resolution-${resolution.tone} ${className}`.trim()}
      title={label}
    >
      {label}
    </span>
  );
}
