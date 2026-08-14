#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

const [capturePath] = process.argv.slice(2);
const wake = JSON.parse(readFileSync(0, 'utf8'));
const planId = wake.planIds?.[0];
if (!capturePath || !planId) process.exit(2);

const request = async (path, init = {}) => {
  const response = await fetch(`${wake.biaoUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok === false) {
    throw new Error(`${path} failed: ${payload?.error?.code ?? response.status}`);
  }
  return payload.data;
};

const intake = await request(`/intake?consumer=${encodeURIComponent(wake.consumer)}&plan_id=${encodeURIComponent(planId)}`);
const review = intake.items.find((item) => item.kind === 'review_requested');
if (!review?.task_id || !review?.event_id) throw new Error('review_requested not found');

await request(`/task/${encodeURIComponent(review.task_id)}/review`, {
  method: 'POST',
  body: JSON.stringify({
    verdict: 'accept',
    comment: 'isolated PM pool E2E accepted verified repair',
    reviewed_by: 'pm-pool-e2e',
  }),
});
await request('/intake/ack', {
  method: 'POST',
  body: JSON.stringify({ consumer: wake.consumer, event_id: review.event_id }),
});

writeFileSync(capturePath, JSON.stringify({
  target: process.env.BIAO_PM_TARGET,
  wake,
  taskId: review.task_id,
}), 'utf8');
