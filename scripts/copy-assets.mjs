import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = resolve(packageRoot, 'dist', 'db');

await mkdir(targetDir, { recursive: true });
await copyFile(
  resolve(packageRoot, 'src', 'db', 'schema.sql'),
  resolve(targetDir, 'schema.sql'),
);
