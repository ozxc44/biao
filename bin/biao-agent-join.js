#!/usr/bin/env node

import { main } from '../scripts/agent-join.mjs';

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`[biao-agent-join] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
