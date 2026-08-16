/**
 * generic-git 适配器（Phase 4）
 *
 * §6.1：真相源是 Git 本身，无 GitHub/GitLab API 依赖；本地路径 / SSH /
 * file:// remote 一律走 git CLI。安全约束（§19.2 + Phase 4 约束）：
 * - execFile 参数数组直传，不经 shell，杜绝 refspec/路径注入；
 * - 每条命令带超时（默认 30s）与输出上限（默认 2 MiB，超限即杀）；
 * - 全局 `-c core.autocrlf=false -c core.quotepath=false -c gc.auto=0`
 *   （§19.2：不让本机 line-ending 配置改写工作树真相；quotepath=false
 *   保证非 ASCII 路径以原始形态输出，diff 门禁不被转义绕过）；
 * - GIT_TERMINAL_PROMPT=0：凭据缺失时立即失败而不是挂住等待输入；
 * - 破坏性命令面收窄到 deleteRemoteRef（branch cleanup 专用）。
 */

import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRefAcl, type ProjectRefAcl } from './ref-acl.js';
import {
  GitProviderError,
  type GitCloneOptions,
  type GitDiffStatEntry,
  type GitProvider,
  type GitPushOptions,
  type GitRemoteRef,
} from './provider.js';

export interface GenericGitOptions {
  /** git 可执行文件（默认 git）。 */
  binary?: string;
  /** 单命令超时毫秒（默认 30_000）。 */
  timeoutMs?: number;
  /** 单命令 stdout+stderr 合计上限字节（默认 2 MiB）。 */
  maxOutputBytes?: number;
  /**
   * push 面 ref ACL（22.3-10）：配置后 push / deleteRemoteRef 前对每个
   * refspec 的目标 ref 逐条校验，拒绝即抛 kind='push-forbidden'，不触达远端。
   * 规则来源与 projects.ref_acl_json（parseRefAcl）一致；也可传函数按仓库
   * 上下文解析（返回 null = 该次不启用）。未配置 = 该 provider 实例不启用
   * push ACL（Node push 通道应配置默认规则集：createDefaultRefAcl）。
   */
  pushAcl?: ProjectRefAcl | ((context: { dir: string | null; remoteUrl?: string }) => ProjectRefAcl | null);
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024;

/** §19.2：显式压掉会改写工作树真相 / 输出编码 / 触发后台 GC 的全局配置。 */
const GLOBAL_CONFIG_ARGS = [
  '-c', 'core.autocrlf=false',
  '-c', 'core.quotepath=false',
  '-c', 'gc.auto=0',
] as const;

/** 去掉 quotepath=false 仍可能出现的 C 风格引号包裹（控制字符路径）。 */
function unquotePath(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (_, g: string) => (
      /^[0-7]{3}$/.test(g) ? String.fromCharCode(parseInt(g, 8)) : g
    ));
  }
  return raw;
}

/**
 * 从 push refspec 提取 ACL 校验对象（目标 ref）：
 * - `[+]src:dst` → dst（删除形态 `:dst` 同样落到 dst）；
 * - `ref`（无冒号，同名推送）→ ref 本身；
 * - 空目标（`src:`）返回 null，交给 git 本身报错。
 */
export function refspecDestinationRef(refspec: string): string | null {
  let spec = refspec.trim();
  if (spec.startsWith('+')) spec = spec.slice(1);
  const colon = spec.indexOf(':');
  const dst = (colon >= 0 ? spec.slice(colon + 1) : spec).trim();
  return dst.length > 0 ? dst : null;
}

export class GenericGitProvider implements GitProvider {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly pushAcl: GenericGitOptions['pushAcl'];

  constructor(options: GenericGitOptions = {}) {
    this.binary = options.binary ?? 'git';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    this.pushAcl = options.pushAcl;
  }

  /**
   * 22.3-10：push 前置 ref ACL 校验。逐 refspec 取目标 ref 过
   * checkRefAcl（deny > allow > 默认拒绝），任一拒绝即抛
   * kind='push-forbidden' 且 message 带命中的 ACL 规则原因——fail-closed，
   * 不发起任何 git 命令，远端零触达。
   */
  private assertPushAllowed(context: { dir: string | null; remoteUrl?: string }, refspecs: readonly string[]): void {
    if (!this.pushAcl) return;
    const acl = typeof this.pushAcl === 'function' ? this.pushAcl(context) : this.pushAcl;
    if (!acl) return;
    for (const refspec of refspecs) {
      const dstRef = refspecDestinationRef(refspec);
      if (!dstRef) continue;
      const decision = checkRefAcl(dstRef, acl);
      if (!decision.allowed) {
        throw new GitProviderError(
          'push-forbidden',
          ['push', refspec],
          '',
          `ref ACL 拒绝 push ${dstRef}：${decision.reason}`,
        );
      }
    }
  }

  /** 受控执行：超时/输出上限/退出码统一映射 GitProviderError。 */
  private async run(dir: string | null, args: readonly string[]): Promise<string> {
    const fullArgs = [...GLOBAL_CONFIG_ARGS, ...args];
    return await new Promise<string>((resolve, reject) => {
      execFile(
        this.binary,
        fullArgs,
        {
          cwd: dir ?? undefined,
          timeout: this.timeoutMs,
          maxBuffer: this.maxOutputBytes,
          encoding: 'utf8',
          killSignal: 'SIGKILL',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
        (err, stdout, stderr) => {
          if (err) {
            const message = String((err as Error).message ?? '');
            if (message.includes('maxBuffer')) {
              reject(new GitProviderError('output-limit', fullArgs, String(stderr ?? ''), `git 输出超限（>${this.maxOutputBytes} 字节）`));
              return;
            }
            if ((err as { killed?: boolean }).killed && message.includes('timeout')) {
              reject(new GitProviderError('timeout', fullArgs, String(stderr ?? ''), `git 超时（>${this.timeoutMs}ms）`));
              return;
            }
            const code = (err as { code?: number | string }).code;
            const stderrText = String(stderr ?? '');
            const rejected = /rejected|non-fast-forward|fetch first|atomic transaction failed|pre-receive|deny/i.test(stderrText);
            const unreachable = /Could not read from remote|Connection refused|Connection timed out|Network is unreachable|No route to host|Could not resolve host|fatal: unable to access|fatal: Could not read from remote/i.test(stderrText);
            const kind = rejected ? 'push-rejected' : unreachable ? 'remote-unreachable' : code === 128 && /does not exist|unknown revision|bad object/i.test(stderrText) ? 'not-found' : 'exit-nonzero';
            reject(new GitProviderError(kind, fullArgs, stderrText, `git 退出码 ${String(code)}: ${message.slice(0, 200)}`));
            return;
          }
          resolve(String(stdout ?? ''));
        },
      );
    });
  }

  async clone(remoteUrl: string, dir: string, options: GitCloneOptions = {}): Promise<void> {
    const args = ['clone', '--no-tags'];
    if (options.noCheckout) args.push('--no-checkout');
    if (options.branch) args.push('--branch', options.branch);
    args.push('--', remoteUrl, dir);
    await this.run(null, args);
  }

  async fetch(dir: string, options: { prune?: boolean } = {}): Promise<void> {
    const args = ['fetch', '--no-tags'];
    if (options.prune !== false) args.push('--prune');
    args.push('origin');
    await this.run(dir, args);
  }

  async push(dir: string, refspecs: readonly string[], options: GitPushOptions = {}): Promise<void> {
    // 22.3-10：ACL 先于一切 git 调用（拒绝 = 远端零触达）。workspace
    // finalize 的 Node push 走同一入口，因此自动受 ACL 控制。
    this.assertPushAllowed({ dir }, refspecs);
    const args = ['push'];
    if (options.atomic) args.push('--atomic');
    args.push('origin', ...refspecs);
    await this.run(dir, args);
  }

  async deleteRemoteRef(remoteUrl: string, ref: string): Promise<void> {
    // push 需要仓库上下文；用一次性空仓库承载删除 refspec。
    // 删除也是 push（:ref）——同样受 ref ACL 约束（branch cleanup 只删
    // attempt 分支/marker，默认规则集放行）。
    const refspec = `:${ref}`;
    this.assertPushAllowed({ dir: null, remoteUrl }, [refspec]);
    await this.withTempRepo(async (tmp) => {
      await this.run(tmp, ['push', '--', remoteUrl, refspec]);
    });
  }

  async lsRemote(remoteUrl: string, refFilter?: string): Promise<GitRemoteRef[]> {
    const args = ['ls-remote', '--', remoteUrl];
    if (refFilter) args.push(refFilter);
    const out = await this.run(null, args);
    const refs: GitRemoteRef[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [sha, ref] = trimmed.split('\t');
      if (!sha || !ref) continue;
      refs.push({ sha, ref });
    }
    return refs;
  }

  async readRef(dir: string, ref: string): Promise<string | null> {
    try {
      const out = await this.run(dir, ['rev-parse', '--verify', '--quiet', ref]);
      return out.trim() || null;
    } catch (err) {
      if (err instanceof GitProviderError && (err.kind === 'not-found' || err.kind === 'exit-nonzero')) {
        return null;
      }
      throw err;
    }
  }

  async writeRef(dir: string, ref: string, sha: string): Promise<void> {
    await this.run(dir, ['update-ref', ref, sha]);
  }

  async diffStat(dir: string, baseSha: string, headSha: string): Promise<GitDiffStatEntry[]> {
    const out = await this.run(dir, ['diff', '--numstat', `${baseSha}..${headSha}`]);
    const entries: GitDiffStatEntry[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [add, del, ...rest] = line.split('\t');
      if (rest.length === 0) continue;
      const binary = add === '-' || del === '-';
      entries.push({
        path: unquotePath(rest.join('\t')),
        additions: binary ? 0 : Number(add) || 0,
        deletions: binary ? 0 : Number(del) || 0,
        binary,
      });
    }
    return entries;
  }

  async diffNameOnly(dir: string, baseSha: string, headSha: string): Promise<string[]> {
    const out = await this.run(dir, ['diff', '--name-only', `${baseSha}..${headSha}`]);
    return out.split('\n').map((l) => unquotePath(l)).filter((l) => l.length > 0);
  }

  async mergeBase(dir: string, aSha: string, bSha: string): Promise<string | null> {
    try {
      const out = await this.run(dir, ['merge-base', aSha, bSha]);
      return out.trim() || null;
    } catch (err) {
      // 无共同祖先（exit 1）或对象不可达（exit 128）都归并为"不可达"。
      if (err instanceof GitProviderError && (err.kind === 'exit-nonzero' || err.kind === 'not-found')) {
        return null;
      }
      throw err;
    }
  }

  async checkoutNewBranch(dir: string, branchRef: string, baseSha: string): Promise<void> {
    const existing = await this.readRef(dir, branchRef);
    const branchName = branchRef.replace(/^refs\/heads\//, '');
    if (existing === baseSha) {
      await this.run(dir, ['checkout', '--quiet', branchName]);
      return;
    }
    if (existing !== null) {
      throw new GitProviderError('exit-nonzero', ['checkout', branchRef], '', `分支已存在且指向 ${existing}，预期 ${baseSha}`);
    }
    await this.run(dir, ['checkout', '--quiet', '-b', branchName, baseSha]);
  }

  async statusPorcelain(dir: string): Promise<string[]> {
    const out = await this.run(dir, ['status', '--porcelain']);
    const paths: string[] = [];
    for (const line of out.split('\n')) {
      if (line.length <= 3) continue;
      // "XY <path>" 或 "XY <orig> -> <path>"（重命名取目标路径）。
      const body = line.slice(3);
      const arrow = body.indexOf(' -> ');
      paths.push(unquotePath(arrow >= 0 ? body.slice(arrow + 4) : body));
    }
    return paths;
  }

  async commitAll(
    dir: string,
    message: string,
    options: { exclude?: readonly string[]; author?: string } = {},
  ): Promise<string> {
    // 排除机制：仓库本地 .git/info/exclude（prepare 写入）让 `add -A` 天然跳过
    // 本机私有文件；显式排除 pathspec 会触发 git 的 "ignored path" 报错，不能用。
    // 这里在 add 之后 fail-closed 校验：排除文件若被暂存（exclude 行被人为删除）
    // 直接拒绝 commit，而不是把 marker 泄进 task branch。
    await this.run(dir, ['add', '-A']);
    if (options.exclude?.length) {
      const stagedOut = await this.run(dir, ['diff', '--cached', '--name-only']);
      const staged = stagedOut.split('\n').map((l) => unquotePath(l)).filter(Boolean);
      const leaked = options.exclude.filter((p) => staged.includes(p));
      if (leaked.length > 0) {
        throw new GitProviderError('exit-nonzero', ['add', ...leaked], '', `排除文件被暂存，拒绝 commit：${leaked.join(', ')}`);
      }
    }
    const author = options.author ?? 'biao-node';
    try {
      await this.run(dir, [
        '-c', `user.name=${author}`,
        '-c', 'user.email=biao-node@biao.invalid',
        'commit', '-m', message,
      ]);
    } catch (err) {
      if (
        err instanceof GitProviderError
        && err.kind === 'exit-nonzero'
        && /nothing to commit|no changes added/i.test(err.stderr)
      ) {
        const head = await this.headSha(dir);
        if (head) return head;
      }
      throw err;
    }
    const sha = await this.headSha(dir);
    if (!sha) throw new GitProviderError('exit-nonzero', ['commit'], '', 'commit 后 HEAD 仍为空');
    return sha;
  }

  async hashObject(dir: string, content: string): Promise<string> {
    // -w 需要仓库；内容经 stdin 传入，避免出现在参数列表里。
    const out = await this.runWithStdin(dir, ['hash-object', '-w', '--stdin'], content);
    return out.trim();
  }

  async headSha(dir: string): Promise<string | null> {
    return await this.readRef(dir, 'HEAD');
  }

  async readBlob(remoteUrl: string, ref: string): Promise<{ sha: string; content: string }> {
    // blob 以 ref 形式可达（refs/biao/attempt-markers/**）；用一次性 bare 仓库
    // fetch 单个 ref 后 cat-file，避免全量克隆。
    let sha = '';
    let content = '';
    await this.withTempRepo(async (tmp) => {
      await this.run(tmp, ['fetch', '--no-tags', '--', remoteUrl, ref]);
      const out = await this.run(tmp, ['rev-parse', '--verify', 'FETCH_HEAD']);
      sha = out.trim();
      content = await this.run(tmp, ['cat-file', '-p', sha]);
    });
    return { sha, content };
  }

  async merge(dir: string, ref: string, options?: { noFf?: boolean; message?: string }): Promise<string> {
    const args = ['merge'];
    if (options?.noFf !== false) args.push('--no-ff');
    if (options?.message) args.push('-m', options.message);
    args.push(ref);
    // merge commit 需要提交者身份：干净克隆没有全局 user.*，缺身份时 git merge
    // 以 exit-nonzero 失败，干净合并会被误判。与 commit() 的身份约定保持一致。
    const fullArgs = [
      '-c', 'user.name=biao-merge-bot',
      '-c', 'user.email=biao-merge@biao.invalid',
      ...args,
    ];
    try {
      await this.run(dir, fullArgs);
    } catch (err) {
      if (err instanceof GitProviderError && err.kind === 'exit-nonzero') {
        // 检查是否是 merge conflict
        const status = await this.run(dir, ['status', '--porcelain']).catch(() => '');
        const isConflict = /^(UU|AA|DU|UD|AU|UA)\s/m.test(status);
        if (isConflict) {
          // abort merge to clean up state
          await this.run(dir, ['merge', '--abort']).catch(() => {});
          throw new GitProviderError('merge-conflict', args, err.stderr + '\nCONFLICT_FILES:\n' + status, 'merge conflict');
        }
      }
      throw err;
    }
    const head = await this.headSha(dir);
    return head ?? '';
  }

  async mergeAbort(dir: string): Promise<void> {
    await this.run(dir, ['merge', '--abort']);
  }

  /** stdin 版执行（hash-object 专用）。 */
  private async runWithStdin(dir: string, args: readonly string[], input: string): Promise<string> {
    const fullArgs = [...GLOBAL_CONFIG_ARGS, ...args];
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(this.binary, fullArgs, {
        cwd: dir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      let stdout = '';
      let stderr = '';
      let killed = false;
      const limit = this.maxOutputBytes;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > limit) {
          killed = true;
          child.kill('SIGKILL');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > limit) {
          killed = true;
          child.kill('SIGKILL');
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new GitProviderError('exit-nonzero', fullArgs, stderr, err.message));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed || code !== 0) {
          reject(new GitProviderError(
            killed ? (stdout.length > limit || stderr.length > limit ? 'output-limit' : 'timeout') : 'exit-nonzero',
            fullArgs,
            stderr,
          ));
          return;
        }
        resolve(stdout);
      });
      child.stdin.end(input, 'utf8');
    });
  }

  /** 一次性空仓库（push 删除 / 远端 blob 读取的仓库上下文）。 */
  private async withTempRepo(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'biao-git-ctx-'));
    try {
      await this.run(dir, ['init', '--quiet', '--bare', '.']);
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
