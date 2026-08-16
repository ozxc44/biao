/**
 * V2 Git Provider 能力接口（Phase 4）
 *
 * 对应 docs/distributed-multi-node-development-plan.md §6.1（真相源=Git 本身）：
 * 控制面只通过 Git 能力接口与远端交互，无 GitHub API 依赖。实现必须：
 * - 每次调用带超时与输出上限（防恶意大输出 / 挂死）；
 * - 不经 shell 拼接（参数数组直传），路径与 ref 由调用方校验后传入；
 * - 显式关闭会改变工作树真相的配置（§19.2：core.autocrlf 等）。
 *
 * 最小能力集（§6.4/§6.5 顺序所需）：clone / fetch / push / lsRemote /
 * readRef / writeRef / diffStat / mergeBase；finalize 长尾命令以受控扩展
 * 方法提供（checkout / commitAll / statusPorcelain / hashObject 等），
 * 保持"接口在 provider、命令细节在适配器"的边界。
 */

/** 单个远端 ref（ls-remote 输出行）。 */
export interface GitRemoteRef {
  ref: string;
  sha: string;
}

/** diff --numstat 单行（binary 文件两列为 '-'）。 */
export interface GitDiffStatEntry {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** provider 失败类别：调用方按类别映射状态机终态。 */
export type GitProviderErrorKind =
  | 'timeout'
  | 'output-limit'
  | 'not-found'
  | 'push-forbidden'
  | 'push-rejected'
  | 'merge-conflict'
  | 'remote-unreachable'
  | 'exit-nonzero';

/** 所有 provider 异常的统一形状（不含命令原文以外的敏感信息）。 */
export class GitProviderError extends Error {
  readonly kind: GitProviderErrorKind;
  readonly args: readonly string[];
  readonly stderr: string;

  constructor(kind: GitProviderErrorKind, args: readonly string[], stderr: string, message?: string) {
    super(message ?? `git ${kind}: ${args.join(' ')}${stderr ? ` — ${stderr.slice(0, 400)}` : ''}`);
    this.name = 'GitProviderError';
    this.kind = kind;
    this.args = args;
    this.stderr = stderr;
  }
}

export interface GitCloneOptions {
  /** 只取单分支（默认全量）。 */
  branch?: string;
  /** 不检出工作树（服务端 diff 复核用，只需对象库）。 */
  noCheckout?: boolean;
}

export interface GitPushOptions {
  /** §6.5：task branch 与 marker 一起原子推送。 */
  atomic?: boolean;
}

export interface GitProvider {
  /** 克隆远端到本地目录（目录必须不存在或为空）。 */
  clone(remoteUrl: string, dir: string, options?: GitCloneOptions): Promise<void>;

  /** fetch（默认 --prune，§6.4 步骤 2）。 */
  fetch(dir: string, options?: { prune?: boolean }): Promise<void>;

  /**
   * push 一组 refspec；非 fast-forward / ref 已存在等拒绝以 push-rejected 抛出。
   * 22.3-10：适配器在 push 前对每个 refspec 的目标 ref 做 ref ACL 校验
   * （规则来自 projects.ref_acl_json → parseRefAcl），拒绝以
   * kind='push-forbidden' 抛出（message 携带命中的 ACL 规则原因），
   * 不触达远端。
   */
  push(dir: string, refspecs: readonly string[], options?: GitPushOptions): Promise<void>;

  /** 删除远端 ref（branch cleanup 专用，等价 push :ref）。 */
  deleteRemoteRef(remoteUrl: string, ref: string): Promise<void>;

  /** 列远端 ref；refFilter 为空时列全部。 */
  lsRemote(remoteUrl: string, refFilter?: string): Promise<GitRemoteRef[]>;

  /** 解析本地 ref → sha；不存在返回 null。 */
  readRef(dir: string, ref: string): Promise<string | null>;

  /** 写本地 ref（update-ref，分支创建走这里）。 */
  writeRef(dir: string, ref: string, sha: string): Promise<void>;

  /** git diff --numstat <base> <head>（对象级，无需工作树干净）。 */
  diffStat(dir: string, baseSha: string, headSha: string): Promise<GitDiffStatEntry[]>;

  /** git diff --name-only <base> <head>。 */
  diffNameOnly(dir: string, baseSha: string, headSha: string): Promise<string[]>;

  /**
   * mergeBase：a、b 的最近公共祖先；任一不可达 / 无共同祖先返回 null
   * （调用方据此判 base unreachable / remote mismatch）。
   */
  mergeBase(dir: string, aSha: string, bSha: string): Promise<string | null>;

  // ── finalize 长尾（受控扩展，语义在适配器单测锁定） ──

  /** 在 baseSha 处创建分支并检出（幂等：分支已存在且指向 baseSha 时只检出）。 */
  checkoutNewBranch(dir: string, branchRef: string, baseSha: string): Promise<void>;

  /** git status --porcelain（相对路径列表，含未跟踪）。 */
  statusPorcelain(dir: string): Promise<string[]>;

  /**
   * add -A + commit，返回新 head sha。exclude 为不得入库的本地文件
   * （§6.5 marker 等本机私有文件）。工作树无变更且分支已存在时返回当前 head。
   */
  commitAll(
    dir: string,
    message: string,
    options?: { exclude?: readonly string[]; author?: string },
  ): Promise<string>;

  /** git hash-object -w（marker canonical JSON 落对象库，返回 blob sha）。 */
  hashObject(dir: string, content: string): Promise<string>;

  /** 当前 HEAD sha；空仓库返回 null。 */
  headSha(dir: string): Promise<string | null>;

  /**
   * 读远端 ref 指向的 blob 对象（服务端 marker 验签）。
   * marker 以 ref 形式可达（refs/biao/attempt-markers/**），实现负责
   * fetch 单 ref + cat-file，返回 ref 实际指向的 sha 与内容。
   */
  readBlob(remoteUrl: string, ref: string): Promise<{ sha: string; content: string }>;

  // ── Phase 5 merge queue 扩展 ──

  /**
   * 在本地仓库执行 merge --no-ff。
   * 成功返回 merge commit sha；冲突时抛出 kind='merge-conflict'，
   * stderr 包含冲突文件清单（调用方解析后落审计）。
   */
  merge(dir: string, ref: string, options?: { noFf?: boolean; message?: string }): Promise<string>;

  /** 在本地仓库执行 merge --abort（清理冲突状态）。 */
  mergeAbort(dir: string): Promise<void>;
}
