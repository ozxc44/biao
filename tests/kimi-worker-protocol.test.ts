import { describe, expect, it } from 'vitest';
import { parseKimiOutput } from '../src/worker/kimi.js';

describe('Kimi stream-json protocol', () => {
  it('parses v0.29 type/part text and exposes an embedded BIAO question', () => {
    const stdout = [
      JSON.stringify({ type: 'assistant', part: { type: 'text', text: '正在检查约束。' } }),
      JSON.stringify({
        type: 'assistant',
        part: {
          type: 'text',
          text: 'BIAO_QUESTION: {"body":"需要扩权吗？","checkpoint":"测试已完成"}',
        },
      }),
    ].join('\n');

    expect(parseKimiOutput(stdout)).toEqual({
      changedFiles: [],
      text: [
        '正在检查约束。',
        'BIAO_QUESTION: {"body":"需要扩权吗？","checkpoint":"测试已完成"}',
      ].join('\n'),
    });
  });

  it('extracts Write and Edit paths from v0.29 type/part tool_use events', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        part: { type: 'tool_use', name: 'Write', input: { path: 'src/new.ts', content: 'x' } },
      }),
      JSON.stringify({
        type: 'assistant',
        part: { type: 'tool_use', name: 'Edit', input: { file_path: 'src/existing.ts' } },
      }),
      JSON.stringify({ type: 'assistant', part: { type: 'text', text: '完成' } }),
    ].join('\n');

    expect(parseKimiOutput(stdout)).toEqual({
      changedFiles: ['src/new.ts', 'src/existing.ts'],
      text: '完成',
    });
  });

  it('parses the v0.29 role/tool_calls envelope emitted by the installed CLI', () => {
    const stdout = [
      JSON.stringify({
        role: 'assistant',
        tool_calls: [{
          type: 'function',
          function: { name: 'Write', arguments: '{"path":"src/current.ts","content":"x"}' },
        }],
      }),
      JSON.stringify({ role: 'assistant', content: '最终结果' }),
    ].join('\n');

    expect(parseKimiOutput(stdout)).toEqual({
      changedFiles: ['src/current.ts'],
      text: '最终结果',
    });
  });

  it('extracts paths from the observed type/tool_use part.state.input envelope', () => {
    const stdout = JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_observed',
      part: {
        type: 'tool',
        tool: 'write',
        state: {
          input: {
            file_path: 'apps/api/src/agent-runs/proposal-rollback-move.test.ts',
            content: 'test',
          },
        },
      },
    });

    expect(parseKimiOutput(stdout)).toEqual({
      changedFiles: ['apps/api/src/agent-runs/proposal-rollback-move.test.ts'],
      text: '',
    });
  });

  it('keeps the legacy role/content text and tool_use array compatible', () => {
    const stdout = JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'text', text: '旧格式结果' },
        { type: 'tool_use', input: { file_path: 'src/legacy.ts' } },
      ],
    });

    expect(parseKimiOutput(stdout)).toEqual({
      changedFiles: ['src/legacy.ts'],
      text: '旧格式结果',
    });
  });
});
