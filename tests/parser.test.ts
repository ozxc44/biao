/**
 * 测试 1：plan 解析 + DAG 循环检测
 * 对应 docs/biao/02-planning-md-standard.md, 03-task-dependency-and-phase.md
 */

import { describe, it, expect } from 'vitest';
import {
  parsePlanDir,
  detectCycle,
  validateAcceptanceFor,
  validateAcceptanceVerify,
  validatePhases,
} from '../src/plan/parser.js';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, 'fixtures');

describe('plan parser', () => {
  it('解析正常 plan 目录', () => {
    const { plan, tasks } = parsePlanDir(join(FIXTURES, 'test-plan'));
    expect(plan.plan_id).toBe('test-m0-plan');
    expect(plan.project_path).toBe('/tmp/biao-test');
    expect(plan.phases).toHaveLength(2);
    expect(tasks).toHaveLength(3);
    expect(tasks[0].fm.task_id).toBe('test-m0-plan-01-be');
    expect(tasks[0].fm.type).toBe('code');
    expect(tasks[0].fm.ownership?.files).toContain('apps/server/**');
    expect(tasks[0].body).toContain('后端测试任务');
  });

  it('解析含 frontmatter 和 body 分离', () => {
    const { tasks } = parsePlanDir(join(FIXTURES, 'test-plan'));
    const t3 = tasks.find((t) => t.fm.task_id === 'test-m0-plan-03-qa');
    expect(t3?.fm.type).toBe('acceptance');
    expect(t3?.fm.acceptance_for).toContain('test-m0-plan-01-be');
    expect(t3?.fm.depends_on).toHaveLength(2);
  });
});

describe('DAG 循环检测', () => {
  it('正常 plan 无环', () => {
    const { tasks } = parsePlanDir(join(FIXTURES, 'test-plan'));
    const cycle = detectCycle(tasks.map((t) => t.fm));
    expect(cycle).toBeNull();
  });

  it('循环 plan 检出环', () => {
    const { tasks } = parsePlanDir(join(FIXTURES, 'cycle-plan'));
    const cycle = detectCycle(tasks.map((t) => t.fm));
    expect(cycle).not.toBeNull();
    expect(cycle).toContain('cycle-A');
    expect(cycle).toContain('cycle-B');
  });

  it('依赖不存在的任务报错', () => {
    expect(() =>
      detectCycle([{ task_id: 'X', title: 'x', type: 'code', phase: 'p', depends_on: ['nonexistent'] }]),
    ).toThrow(/依赖不存在/);
  });
});

describe('acceptance_for 校验', () => {
  it('正常 acceptance_for 通过', () => {
    const { tasks } = parsePlanDir(join(FIXTURES, 'test-plan'));
    expect(() => validateAcceptanceFor(tasks.map((t) => t.fm))).not.toThrow();
  });

  it('acceptance_for 引用不存在任务报错', () => {
    expect(() =>
      validateAcceptanceFor([
        { task_id: 'A', title: 'a', type: 'acceptance', phase: 'p', acceptance_for: ['nonexistent'] },
      ]),
    ).toThrow(/acceptance_for/);
  });
});

describe('acceptance verify 校验', () => {
  it('acceptance 缺少 verify 时拒绝', () => {
    expect(() => validateAcceptanceVerify([
      {
        task_id: 'A',
        title: 'a',
        type: 'acceptance',
        phase: 'qa',
        assignee: 'auto',
        acceptance_for: ['source'],
        verify: [],
      },
    ])).toThrow(/verify/);
  });

  it('acceptance 的结构化 verify 通过，普通任务仍允许空 verify', () => {
    expect(() => validateAcceptanceVerify([
      {
        task_id: 'A',
        title: 'a',
        type: 'acceptance',
        phase: 'qa',
        assignee: 'auto',
        acceptance_for: ['source'],
        verify: [{ cmd: 'npm test', expect_exit: 0, scope: '.' }],
      },
      {
        task_id: 'B',
        title: 'b',
        type: 'code',
        phase: 'impl',
        assignee: 'auto',
        verify: [],
      },
    ])).not.toThrow();
  });
});

describe('phase 校验', () => {
  it('正常 phase 通过', () => {
    const { plan, tasks } = parsePlanDir(join(FIXTURES, 'test-plan'));
    expect(() => validatePhases(plan, tasks.map((t) => t.fm))).not.toThrow();
  });
});
