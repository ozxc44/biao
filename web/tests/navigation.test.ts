import { describe, expect, it } from 'vitest';
import { planSelectionUrl, selectedPlanFromSearch } from '../src/navigation';

describe('project URL navigation', () => {
  it('restores the selected plan from a refresh URL', () => {
    expect(selectedPlanFromSearch('?plan=office%2Fannotations')).toBe('office/annotations');
    expect(selectedPlanFromSearch('?plan=%20%20')).toBeNull();
  });

  it('adds and removes only the plan query while preserving the current page', () => {
    expect(planSelectionUrl('http://localhost:7331/?lang=zh#top', 'plan-a')).toBe('/?lang=zh&plan=plan-a#top');
    expect(planSelectionUrl('http://localhost:7331/?lang=zh&plan=plan-a#top', null)).toBe('/?lang=zh#top');
  });
});
