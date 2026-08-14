#!/usr/bin/env node

import { main } from '../scripts/worker-agent.mjs';

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`[biao-worker-agent] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 4;
}
