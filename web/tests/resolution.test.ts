import { describe, expect, it } from 'vitest';
import { createTranslator } from '../src/i18n/translations';
import { getResolutionActionLabel, getResolutionLabel } from '../src/i18n/status';
import {
  getResolutionPresentation,
  isEffectivelyAccepted,
  normalizeResolutionTaskIds,
  summarizeResolutions,
} from '../src/resolution';

describe('resolution presentation', () => {
  it('recognizes only the durable resolution states and maps them to stable tones', () => {
    expect(getResolutionPresentation({ resolution_status: 'repairing', resolution_action: 'repair' }))
      .toMatchObject({ status: 'repairing', action: 'repair', tone: 'blue' });
    expect(getResolutionPresentation({ resolution_status: 'resolved', resolution_action: 'repair' }))
      .toMatchObject({ status: 'resolved', tone: 'green' });
    expect(getResolutionPresentation({ resolution_status: 'legacy_custom_status' })).toBeNull();
  });

  it('does not rewrite failed or rejected audit state when a repair has closed the loop', () => {
    const source = { resolution_status: 'resolved', pm_review_status: 'rejected' } as const;
    expect(isEffectivelyAccepted(source)).toBe(true);
    expect(source.pm_review_status).toBe('rejected');
  });

  it('counts only explicit resolution statuses and accepts both old and new repair history projections', () => {
    expect(summarizeResolutions([
      { resolution_status: 'required' },
      { resolution_status: 'repairing' },
      { resolution_status: 'resolved' },
      { resolution_status: 'needs_pm_decision' },
      { resolution_status: 'other' },
    ])).toEqual({ required: 1, repairing: 1, resolved: 1, needsPmDecision: 1 });
    expect(normalizeResolutionTaskIds(['repair-1', '', 'repair-2'])).toEqual(['repair-1', 'repair-2']);
    expect(normalizeResolutionTaskIds('repair-1, repair-2,,')).toEqual(['repair-1', 'repair-2']);
  });
});

describe('resolution i18n', () => {
  it('uses concise Chinese and English labels without overwriting the original task state', () => {
    const zh = createTranslator('zh-CN');
    const en = createTranslator('en-US');
    expect(getResolutionLabel('repairing', 'repair', zh)).toBe('修复处理中');
    expect(getResolutionLabel('resolved', 'repair', en)).toBe('Closed by accepted repair');
    expect(getResolutionLabel('needs_pm_decision', 'inspect', zh)).toBe('需要 PM 决策');
    expect(getResolutionActionLabel('reverify', en)).toBe('Reverify');
  });
});
