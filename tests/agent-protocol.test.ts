/**
 * AGENTS.md/CLAUDE.md 协议块注入回归：
 * - 缺省文件创建、既有内容零改动、幂等、旧版本整块替换；
 * - BIAO_AGENT_PROTOCOL=0 停用；
 * - 注入内容含 BIAO_QUESTION 语义与 PM 禁忌（新 harness 零配置接入的契约）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_PROTOCOL_VERSION,
  applyAgentProtocolBlock,
  buildAgentProtocolBlock,
  ensureAgentProtocolBlock,
} from '../scripts/agent-protocol.mjs';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.BIAO_AGENT_PROTOCOL;
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biao-agent-protocol-'));
  tempDirs.push(dir);
  return dir;
}

describe('agent-protocol 注入', () => {
  it('缺省时创建 AGENTS.md 与 CLAUDE.md，内容含任务书规则与 BIAO_QUESTION 契约', () => {
    const project = makeProject();
    const result = ensureAgentProtocolBlock(project);
    expect(result.skipped).toBe(false);
    expect(result.files.map((entry) => `${entry.file}:${entry.changed}`)).toEqual(['AGENTS.md:true', 'CLAUDE.md:true']);

    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const content = readFileSync(join(project, name), 'utf8');
      expect(content).toContain(`biao:agent-protocol:v${AGENT_PROTOCOL_VERSION} BEGIN`);
      expect(content).toContain('biao:agent-protocol END');
      expect(content).toContain('BIAO_QUESTION: {"body":"<问题>","checkpoint":"<当前进度>"}');
      expect(content).toContain('done 不等于完成');
      expect(content).toContain('不代替 PM');
    }
  });

  it('已有内容零改动、幂等：二次调用不再变更', () => {
    const project = makeProject();
    writeFileSync(join(project, 'AGENTS.md'), '# 项目说明\n\n已有内容一字不动。\n');
    const first = ensureAgentProtocolBlock(project);
    expect(first.files.find((entry) => entry.file === 'AGENTS.md')?.changed).toBe(true);
    const afterFirst = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    expect(afterFirst.startsWith('# 项目说明\n\n已有内容一字不动。\n')).toBe(true);
    expect(afterFirst).toContain('biao:agent-protocol:');

    const second = ensureAgentProtocolBlock(project);
    expect(second.files.find((entry) => entry.file === 'AGENTS.md')?.changed).toBe(false);
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe(afterFirst);
  });

  it('旧版本块整块替换为当前版本，块外内容保留', () => {
    const legacy = '<!-- biao:agent-protocol:v0 BEGIN -->\n旧协议内容\n<!-- biao:agent-protocol END -->\n';
    const next = applyAgentProtocolBlock(`# Header\n\n${legacy}\n# Tail\n`);
    expect(next).not.toContain('旧协议内容');
    expect(next).toContain(`biao:agent-protocol:v${AGENT_PROTOCOL_VERSION} BEGIN`);
    expect(next.startsWith('# Header\n\n')).toBe(true);
    expect(next.endsWith('# Tail\n')).toBe(true);
    // 只剩一个块：不会因替换引入重复。
    expect(next.match(/biao:agent-protocol END/g)).toHaveLength(1);
  });

  it('BIAO_AGENT_PROTOCOL=0 时整体跳过，不创建文件', () => {
    process.env.BIAO_AGENT_PROTOCOL = '0';
    const project = makeProject();
    const result = ensureAgentProtocolBlock(project);
    expect(result.skipped).toBe(true);
    expect(() => readFileSync(join(project, 'AGENTS.md'), 'utf8')).toThrow();
  });

  it('块文本是模块唯一事实源：buildAgentProtocolBlock 与文件写入门面一致', () => {
    const block = buildAgentProtocolBlock();
    expect(block.startsWith(`<!-- biao:agent-protocol:v${AGENT_PROTOCOL_VERSION} BEGIN`)).toBe(true);
    expect(block.trimEnd().endsWith('<!-- biao:agent-protocol END -->')).toBe(true);
    expect(applyAgentProtocolBlock('', block)).toBe(block);
  });
});
