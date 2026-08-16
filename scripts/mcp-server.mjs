#!/usr/bin/env node

import('../dist/mcp/stdio.js')
  .then(({ startMcpStdio }) => startMcpStdio())
  .catch(() => {
    console.error('[biao-mcp] startup failed');
    process.exitCode = 1;
  });
