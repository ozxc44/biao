#!/usr/bin/env node

import('../dist/mcp/stdio.js').then((module) => module.startMcpStdio()).catch((error) => {
  console.error(`[biao-mcp] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
