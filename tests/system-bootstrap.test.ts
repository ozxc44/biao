import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

const roots: string[] = [];
const script = join(import.meta.dirname, '..', 'bootstrap.sh');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

function fakeEnvironment(opts: {
  node?: boolean;
  nodeVersion?: string;
  redis?: boolean;
  redisCli?: boolean;
  redisServer?: boolean;
  redisUp?: boolean;
  os?: 'Darwin' | 'Linux';
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'biao-system-bootstrap-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'commands.log');
  executable(join(bin, 'uname'), `echo ${opts.os ?? 'Darwin'}`);
  if (opts.node) {
    const version = opts.nodeVersion ?? '20.19.0';
    const major = version.split('.')[0];
    executable(join(bin, 'node'), `if [ "\${1:-}" = "-p" ]; then
  case "\${2:-}" in
    *Number*) echo '${major}' ;;
    *) echo '${version}' ;;
  esac
else
  exit 0
fi`);
  }
  if (opts.node) executable(join(bin, 'npm'), 'exit 0');
  if (opts.redis || opts.redisCli) {
    executable(join(bin, 'redis-cli'), opts.redisUp === false ? 'exit 1' : 'echo PONG');
  }
  if (opts.redis || opts.redisServer) {
    executable(join(bin, 'redis-server'), 'exit 0');
  }
  executable(
    join(bin, 'brew'),
    `echo "brew $*" >> '${log}'
if [ "\${1:-}" = "install" ] && [ "\${2:-}" = "node" ]; then
  printf '#!/bin/sh\\nif [ "\${1:-}" = "-p" ]; then echo 20.19.0; fi\\n' > '${join(bin, 'node')}'
  printf '#!/bin/sh\\nexit 0\\n' > '${join(bin, 'npm')}'
  chmod +x '${join(bin, 'node')}' '${join(bin, 'npm')}'
fi
if [ "\${1:-}" = "install" ] && [ "\${2:-}" = "redis" ]; then
  printf '#!/bin/sh\\necho PONG\\n' > '${join(bin, 'redis-cli')}'
  printf '#!/bin/sh\\nexit 0\\n' > '${join(bin, 'redis-server')}'
  chmod +x '${join(bin, 'redis-cli')}' '${join(bin, 'redis-server')}'
fi`,
  );
  if (opts.os === 'Linux') {
    executable(join(bin, 'id'), 'echo 0');
    executable(
      join(bin, 'apt-get'),
      `echo "apt-get $*" >> '${log}'
if [ "\${1:-}" = "install" ]; then
  printf '#!/bin/sh\nif [ "\${1:-}" = "-p" ]; then echo 20.19.0; fi\n' > '${join(bin, 'node')}'
  printf '#!/bin/sh\nexit 0\n' > '${join(bin, 'npm')}'
  printf '#!/bin/sh\necho PONG\n' > '${join(bin, 'redis-cli')}'
  printf '#!/bin/sh\nexit 0\n' > '${join(bin, 'redis-server')}'
  chmod +x '${join(bin, 'node')}' '${join(bin, 'npm')}' '${join(bin, 'redis-cli')}' '${join(bin, 'redis-server')}'
fi`,
    );
  }
  return {
    root,
    log,
    env: { ...process.env, PATH: `${bin}${delimiter}/usr/bin:/bin`, BIAO_BOOTSTRAP_SYSTEM_ONLY: '1' },
  };
}

describe('无 Node/Redis 时的仓库首入口', () => {
  it('缺少 Node 和 Redis 时 --help 仍直接显示用法并零退出', () => {
    const fake = fakeEnvironment();
    const result = spawnSync('/bin/sh', [script, '--help'], { env: fake.env, encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Biao 开箱配置');
    expect(result.stdout).toContain('--workspace <path>');
    expect(`${result.stdout}${result.stderr}`).not.toContain('[missing]');
    expect(() => readFileSync(fake.log, 'utf8')).toThrow();
  });

  it('依赖齐全时只检测，不执行系统安装', () => {
    const fake = fakeEnvironment({ node: true, redis: true, redisUp: true });
    const output = execFileSync('/bin/sh', [script], { env: fake.env, encoding: 'utf8' });
    expect(output).toContain('[ok] Node.js 20.19+');
    expect(output).toContain('[ok] Redis 可连接');
    expect(() => readFileSync(fake.log, 'utf8')).toThrow();
  });

  it('--check 是公开的严格只读入口，依赖齐全也不进入 Node bootstrap', () => {
    const fake = fakeEnvironment({ node: true, redis: true, redisUp: true });
    const result = spawnSync('/bin/sh', [script, '--check', '--workspace', '/must-not-be-written'], {
      env: { ...fake.env, BIAO_BOOTSTRAP_SYSTEM_ONLY: '0' },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('只读检查通过');
    expect(() => readFileSync(fake.log, 'utf8')).toThrow();
  });

  it('--check 即使同时给 --yes 也不安装缺失依赖', () => {
    const fake = fakeEnvironment();
    const result = spawnSync('/bin/sh', [script, '--check', '--yes'], {
      env: { ...fake.env, BIAO_BOOTSTRAP_SYSTEM_ONLY: '0' },
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain('只读检查未通过');
    expect(() => readFileSync(fake.log, 'utf8')).toThrow();
  });

  it('系统检测和安装子进程不继承 bootstrap 或运行时 API Token', () => {
    const fake = fakeEnvironment({ node: true, redis: true, redisUp: true });
    const probe = join(fake.root, 'secret-leak.log');
    const bin = join(fake.root, 'bin');
    executable(join(bin, 'node'), `if [ -n "\${BIAO_BOOTSTRAP_TOKEN-}\${BIAO_API_TOKEN-}" ]; then echo leaked >> '${probe}'; fi
if [ "\${1:-}" = "-p" ]; then echo 20.19.0; else exit 0; fi`);
    executable(join(bin, 'redis-cli'), `if [ -n "\${BIAO_BOOTSTRAP_TOKEN-}\${BIAO_API_TOKEN-}" ]; then echo leaked >> '${probe}'; fi
echo PONG`);

    const result = spawnSync('/bin/sh', [script], {
      env: {
        ...fake.env,
        BIAO_BOOTSTRAP_TOKEN: 'bootstrap-secret',
        BIAO_API_TOKEN: 'runtime-secret',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(probe)).toBe(false);
    expect(`${result.stdout}${result.stderr}`).not.toContain('bootstrap-secret');
    expect(`${result.stdout}${result.stderr}`).not.toContain('runtime-secret');
  });

  it('Redis 连通性输出不回显 URI 的用户、密码或 query', () => {
    const fake = fakeEnvironment({ node: true, redis: true, redisUp: true });
    const redisUrl = 'rediss://private-user:private-pass@secret.example:6380/7?query-secret=yes';
    const result = spawnSync('/bin/sh', [script], {
      env: { ...fake.env, BIAO_REDIS_URL: redisUrl },
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).not.toContain(redisUrl);
    expect(output).not.toContain('private-user');
    expect(output).not.toContain('private-pass');
    expect(output).not.toContain('query-secret');
  });

  it.each(['Darwin', 'Linux'] as const)(
    '远程 Redis 在 %s 只要求安全客户端探测，不安装本机 redis-server',
    (os) => {
      const fake = fakeEnvironment({ os, node: true, redisCli: true, redisUp: true });
      const result = spawnSync('/bin/sh', [script, '--yes', '--redis-url', 'redis://remote.example:6379/4'], {
        env: fake.env,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[ok] Redis 可连接');
      expect(() => readFileSync(fake.log, 'utf8')).toThrow();
    },
  );

  it.each(['redis://localhost', 'redis://127.0.0.1'])(
    '无显式端口的本机 Redis URL %s 仍安装/要求本机服务端',
    (redisUrl) => {
      const fake = fakeEnvironment({ node: true, redisCli: true, redisUp: true });
      const output = execFileSync('/bin/sh', [script, '--yes', '--redis-url', redisUrl], {
        env: fake.env,
        encoding: 'utf8',
      });
      expect(output).toContain('[installed] Redis');
      expect(readFileSync(fake.log, 'utf8')).toContain('brew install redis');
    },
  );

  it.each(['Darwin', 'Linux'] as const)(
    '远程 Redis 在 %s 缺探测客户端时也不安装本机 Redis 服务端',
    (os) => {
      const fake = fakeEnvironment({ os, node: true });
      const redisUrl = 'redis://private-user:private-pass@remote.example:6379/4';
      const result = spawnSync('/bin/sh', [script, '--yes', '--redis-url', redisUrl], {
        env: fake.env,
        encoding: 'utf8',
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain('redis-cli');
      expect(output).not.toContain('private-user');
      expect(output).not.toContain('private-pass');
      expect(() => readFileSync(fake.log, 'utf8')).toThrow();
    },
  );

  it('依赖缺失且没有 --yes 时停止并给出明确安装指令', () => {
    const fake = fakeEnvironment();
    const result = spawnSync('/bin/sh', [script], { env: fake.env, encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain('重新运行并加 --yes');
    expect(() => readFileSync(fake.log, 'utf8')).toThrow();
  });

  it('Node 20.18 低于构建链最低版本时判定为缺失', () => {
    const fake = fakeEnvironment({ node: true, nodeVersion: '20.18.0', redis: true, redisUp: true });
    const result = spawnSync('/bin/sh', [script], { env: fake.env, encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain('Node.js 20.19+');
  });

  it('macOS 使用 Homebrew 安装缺失依赖并在安装后复检', () => {
    const fake = fakeEnvironment();
    const output = execFileSync('/bin/sh', [script, '--yes'], { env: fake.env, encoding: 'utf8' });
    expect(output).toContain('[installed] Node.js 20.19+');
    expect(output).toContain('[installed] Redis');
    expect(readFileSync(fake.log, 'utf8')).toContain('brew install node');
    expect(readFileSync(fake.log, 'utf8')).toContain('brew install redis');
  });

  it('Linux 使用 apt 安装缺失依赖并在安装后复检', () => {
    const fake = fakeEnvironment({ os: 'Linux' });
    const output = execFileSync('/bin/sh', [script, '--yes'], { env: fake.env, encoding: 'utf8' });
    expect(output).toContain('[installed] Node.js 20.19+');
    expect(output).toContain('[installed] Redis');
    expect(readFileSync(fake.log, 'utf8')).toContain('apt-get install -y nodejs npm');
    expect(readFileSync(fake.log, 'utf8')).toContain('apt-get install -y redis-server redis-tools');
  });
});
