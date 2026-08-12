#!/usr/bin/env node
import { printWorkerHelpIfRequested } from './worker-help.js';

if (!printWorkerHelpIfRequested('codex')) {
  import('../dist/worker/codex.js')
    .then(({ main }) => main())
    .catch((error) => {
      console.error('[codex-worker] 错误：', error);
      process.exitCode = 1;
    });
}
