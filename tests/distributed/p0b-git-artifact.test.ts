/**
 * Phase 0b 测试：Git Bare Remote + Artifact Store fixture
 *
 * 验收演示：
 * 1. bare remote 上完成一次真实 push + CAS 断言
 * 2. artifact fixture 拒绝一次路径穿越与一次超大文件
 * 3. manifest 校验通过/失败
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  createBareRemote,
  cloneBare,
  commitAndPush,
  defaultBranchSha,
  assertCasUpdated,
  lsRemoteSha,
  cleanupGitFixtures,
} from './fixtures/git-fixture.js';
import {
  createArtifactStore,
  uploadArtifact,
  downloadArtifact,
  rejectPathTraversal,
  validateManifest,
  sha256hex,
  RESULT_MAX_BYTES,
  cleanupArtifactFixtures,
} from './fixtures/artifact-store-fixture.js';

afterEach(() => {
  cleanupGitFixtures();
  cleanupArtifactFixtures();
});

// ──────────────── Git Bare Remote ────────────────

describe('Git Bare Remote fixture', () => {
  it('创建 bare 仓库并验证为空', () => {
    const bare = createBareRemote();
    const sha = defaultBranchSha(bare);
    expect(sha).toBeNull();
  });

  it('push 后默认分支 CAS 断言通过', () => {
    const bare = createBareRemote();
    const beforeSha = defaultBranchSha(bare);

    const clone = cloneBare(bare);
    const pushedSha = commitAndPush(clone, 'hello.txt', 'hello world', '初始提交');

    const afterSha = defaultBranchSha(bare);
    expect(pushedSha).toMatch(/^[a-f0-9]{40}$/);
    assertCasUpdated(bare, beforeSha, afterSha);
    expect(afterSha).toBe(pushedSha);
  });

  it('第二次 push 后 SHA 变化（CAS 语义）', () => {
    const bare = createBareRemote();
    const clone = cloneBare(bare);

    const sha1 = commitAndPush(clone, 'a.txt', 'first', '第一次');
    const sha2 = commitAndPush(clone, 'b.txt', 'second', '第二次');

    expect(sha1).not.toBe(sha2);
    const currentSha = defaultBranchSha(bare);
    expect(currentSha).toBe(sha2);
    assertCasUpdated(bare, sha1, currentSha);
  });

  it('lsRemoteSha 返回正确的 SHA', () => {
    const bare = createBareRemote();
    const clone = cloneBare(bare);
    const sha = commitAndPush(clone, 'test.txt', 'content', 'test');

    const remoteSha = lsRemoteSha(bare.path, `refs/heads/${bare.defaultBranch}`);
    expect(remoteSha).toBe(sha);
  });

  it('lsRemoteSha 不存在的 ref 返回 null', () => {
    const bare = createBareRemote();
    const sha = lsRemoteSha(bare.path, 'refs/heads/nonexistent');
    expect(sha).toBeNull();
  });
});

// ──────────────── Artifact Store ────────────────

describe('Artifact Store fixture', () => {
  it('上传并下载内容，SHA 匹配', () => {
    const store = createArtifactStore();
    const content = Buffer.from('test artifact content');

    const result = uploadArtifact(store, content, 'result.md');
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sha256).toBe(sha256hex(content));
    expect(result.sizeBytes).toBe(content.length);

    const downloaded = downloadArtifact(store, result.sha256);
    expect(downloaded).toEqual(content);
  });

  it('相同内容幂等上传（CAS）', () => {
    const store = createArtifactStore();
    const content = Buffer.from('same content');

    const r1 = uploadArtifact(store, content, 'result.md');
    const r2 = uploadArtifact(store, content, 'result.json');

    expect(r1.sha256).toBe(r2.sha256);
    expect(r1.storedPath).toBe(r2.storedPath);
  });

  it('拒绝超大文件（§9.3）', () => {
    const store = createArtifactStore();
    const oversized = Buffer.alloc(RESULT_MAX_BYTES + 1, 0x42);

    expect(() => uploadArtifact(store, oversized, 'result.md')).toThrow(/超限/);
  });

  it('自定义大小上限也生效', () => {
    const store = createArtifactStore();
    const content = Buffer.alloc(1001, 0x42);

    expect(() => uploadArtifact(store, content, 'log.txt', { maxBytes: 1000 })).toThrow(/超限/);
  });

  it('拒绝路径穿越（§9.3）', () => {
    const store = createArtifactStore();

    expect(() => rejectPathTraversal(store, '../../../etc/passwd')).toThrow(/路径穿越拒绝/);
    expect(() => rejectPathTraversal(store, 'subdir/../../outside')).toThrow(/路径穿越拒绝/);
  });

  it('正常路径不被拒绝', () => {
    const store = createArtifactStore();
    // 不应抛出
    rejectPathTraversal(store, 'prefix/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    rejectPathTraversal(store, 'ab/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
  });

  it('下载不存在的 artifact 抛出错误', () => {
    const store = createArtifactStore();
    expect(() => downloadArtifact(store, '0'.repeat(64))).toThrow(/不存在/);
  });

  it('manifest 校验：全部存在时返回 true', () => {
    const store = createArtifactStore();
    const c1 = Buffer.from('artifact 1');
    const c2 = Buffer.from('artifact 2');
    const r1 = uploadArtifact(store, c1, 'result.md');
    const r2 = uploadArtifact(store, c2, 'log.txt');

    const valid = validateManifest(store, {
      artifacts: [
        { sha256: r1.sha256, sizeBytes: r1.sizeBytes, kind: 'result.md' },
        { sha256: r2.sha256, sizeBytes: r2.sizeBytes, kind: 'log.txt' },
      ],
      totalBytes: r1.sizeBytes + r2.sizeBytes,
    });
    expect(valid).toBe(true);
  });

  it('manifest 校验：缺少 artifact 时返回 false', () => {
    const store = createArtifactStore();

    const valid = validateManifest(store, {
      artifacts: [
        { sha256: '0'.repeat(64), sizeBytes: 100, kind: 'result.md' },
      ],
      totalBytes: 100,
    });
    expect(valid).toBe(false);
  });

  it('manifest 校验：size 不匹配时返回 false', () => {
    const store = createArtifactStore();
    const content = Buffer.from('test');
    const r = uploadArtifact(store, content, 'result.md');

    const valid = validateManifest(store, {
      artifacts: [
        { sha256: r.sha256, sizeBytes: r.sizeBytes + 1, kind: 'result.md' },
      ],
      totalBytes: r.sizeBytes + 1,
    });
    expect(valid).toBe(false);
  });
});
