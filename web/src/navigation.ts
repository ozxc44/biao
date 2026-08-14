const PLAN_QUERY_KEY = 'plan';

export function selectedPlanFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(PLAN_QUERY_KEY)?.trim() ?? '';
  return value || null;
}

export function planSelectionUrl(currentUrl: string, planId: string | null): string {
  const url = new URL(currentUrl);
  if (planId) url.searchParams.set(PLAN_QUERY_KEY, planId);
  else url.searchParams.delete(PLAN_QUERY_KEY);
  return `${url.pathname}${url.search}${url.hash}`;
}
