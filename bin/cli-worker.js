#!/usr/bin/env node
import { printWorkerHelpIfRequested } from './worker-help.js';

if (!printWorkerHelpIfRequested('custom')) {
  import('../dist/worker/cli.js')
    .then(({ main }) => main())
    .catch((error) => {
      console.error('[cli-worker] 错误：', error);
      process.exitCode = 1;
    });
}
