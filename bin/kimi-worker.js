#!/usr/bin/env node
import { printWorkerHelpIfRequested } from './worker-help.js';

if (!printWorkerHelpIfRequested('kimi')) {
  import('../dist/worker/kimi.js')
    .then(({ main }) => main())
    .catch((error) => {
      console.error('[kimi-worker] 错误：', error);
      process.exitCode = 1;
    });
}
