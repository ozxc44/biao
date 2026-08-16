/**
 * Phase 0a-2 生成式门禁：SERVICE_MAP 台账与 service.ts 同步
 *
 * src/server/v2/SERVICE_MAP.md 是旧 service.ts（V1 facade）按七个领域服务搬迁的
 * 台账。本测试保证台账不腐烂：
 * 1. service.ts 每一个导出函数都必须出现在台账某服务的表格里（无遗漏）；
 * 2. 每个函数只归属一个服务（无重复归属）；
 * 3. 台账头部的统计表数字与各服务小节实际行数一致（无漂移）。
 *
 * 在 service.ts 新增/改名导出函数而忘记更新台账时，这里直接红。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const servicePath = join(here, '../../src/server/service.ts');
const mapPath = join(here, '../../src/server/v2/SERVICE_MAP.md');

const serviceSource = readFileSync(servicePath, 'utf8');
const mapSource = readFileSync(mapPath, 'utf8');

/** service.ts 直接导出的（async）function 名。 */
function exportedFunctions(): string[] {
  return [...serviceSource.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
}

/** 解析台账：服务小节 → 函数清单；以及头部统计表。 */
function parseServiceMap(): {
  sections: Map<string, string[]>;
  declaredCounts: Map<string, number>;
} {
  const sections = new Map<string, string[]>();
  const declaredCounts = new Map<string, number>();
  let currentService: string | null = null;

  for (const rawLine of mapSource.split('\n')) {
    const heading = rawLine.match(/^## ([A-Za-z]+Service)/);
    if (heading) {
      currentService = heading[1];
      if (!sections.has(currentService)) sections.set(currentService, []);
      continue;
    }
    // 头部统计表行：| ProjectService | 14 | ...
    const stat = rawLine.match(/^\| ([A-Za-z]+Service) \| (\d+)/);
    if (stat) {
      declaredCounts.set(stat[1], Number(stat[2]));
      continue;
    }
    // 服务小节的函数行：| `fn` | ...
    const row = rawLine.match(/^\| `(\w+)` \|/);
    if (row && currentService) {
      sections.get(currentService)!.push(row[1]);
    }
  }
  return { sections, declaredCounts };
}

describe('Phase 0a-2 SERVICE_MAP 台账同步门禁', () => {
  const functions = exportedFunctions();
  const { sections, declaredCounts } = parseServiceMap();

  it('台账覆盖 service.ts 全部导出函数，且无遗漏、无重复归属', () => {
    expect(functions.length).toBeGreaterThan(0);

    const assignment = new Map<string, string>();
    for (const [service, fns] of sections) {
      for (const fn of fns) {
        expect(
          assignment.has(fn),
          `${fn} 在台账中重复归属：${assignment.get(fn)} 与 ${service}`,
        ).toBe(false);
        assignment.set(fn, service);
      }
    }

    const missing = functions.filter((fn) => !assignment.has(fn));
    expect(
      missing,
      `以下 service.ts 导出函数未归类进 SERVICE_MAP：${missing.join(', ')}`,
    ).toEqual([]);

    // 台账里也不应出现 service.ts 已不存在的函数（改名后遗留的死条目）。
    const stale = [...assignment.keys()].filter((fn) => !functions.includes(fn));
    expect(stale, `台账包含 service.ts 已不存在的函数：${stale.join(', ')}`).toEqual([]);
  });

  it('台账统计表数字与各服务小节实际行数一致', () => {
    expect(declaredCounts.size).toBe(7);
    for (const [service, declared] of declaredCounts) {
      const actual = sections.get(service)?.length ?? 0;
      expect(
        actual,
        `SERVICE_MAP 统计表声明 ${service} 有 ${declared} 个函数，小节实际 ${actual} 行`,
      ).toBe(declared);
    }
  });

  it('七个领域服务在台账中都有小节', () => {
    for (const service of [
      'ProjectService', 'NodeService', 'AttemptService', 'DeliveryService',
      'MergeService', 'IncidentService', 'ReconcileService',
    ]) {
      expect(sections.has(service), `SERVICE_MAP 缺少 ${service} 小节`).toBe(true);
    }
  });
});
