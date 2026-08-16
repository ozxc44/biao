/**
 * §7.3 Git Diff 二次门禁 / §6.5 finalize 门禁共用的 ownership glob 匹配。
 *
 * write_globs 语义（与 ownership_snapshots.files / Phase 1 in-memory 快照对齐）：
 * - `*` 单独一项 = 全量放行（Phase 1 兼容）；
 * - `**` 跨目录段匹配（`apps/api/src/**`）；
 * - `*`/`?` 只在单段内匹配（`*.docx`、`file?.ts`）；
 * - 无通配符 = 精确路径；
 * - 匹配以 POSIX 相对路径（`a/b/c.ts`）为基准，diff 输出天然满足。
 *
 * 注意：fail-closed——glob 列表为空视为无授权（任何文件都越界）。
 */

/**
 * glob → RegExp（锚定全文）。
 * `**` 跨目录段；前导 `**／` 模式同时允许根级匹配（与 gitignore 语义一致）。
 */
export function globToRegExp(pattern: string): RegExp {
  if (pattern === '*') return /.*/;
  let source = '';
  let i = 0;
  const leadingDoubleStar = pattern.startsWith('**/');
  if (leadingDoubleStar) {
    source += '(?:.*/)?';
    i = 3;
  }
  for (; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i++;
        // 吃掉紧随的 `/`，使 `src/**` 也命中 `src` 下的任意层级（含直接子文件）。
        if (pattern[i + 1] === '/') i++;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      continue;
    }
    source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** 单个文件是否落在授权 glob 集合内。 */
export function fileWithinOwnership(path: string, writeGlobs: readonly string[]): boolean {
  if (writeGlobs.length === 0) return false;
  return writeGlobs.some((pattern) => globToRegExp(pattern).test(path));
}

/** 返回越界文件（保持 diff 顺序，供状态机与审计记录）。 */
export function findOwnershipViolations(paths: readonly string[], writeGlobs: readonly string[]): string[] {
  return paths.filter((p) => !fileWithinOwnership(p, writeGlobs));
}
