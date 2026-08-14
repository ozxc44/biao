#!/usr/bin/env node

import('../scripts/supervisor-config.mjs').catch((error) => {
  console.error(`[biao-supervisor-config] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
