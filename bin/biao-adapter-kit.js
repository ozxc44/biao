#!/usr/bin/env node

import('../scripts/adapter-kit.mjs').catch((error) => {
  console.error(`[biao-adapter-kit] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
