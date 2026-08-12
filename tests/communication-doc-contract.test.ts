import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '..', '..', '..');
const communicationDocPath = join(repositoryRoot, 'docs', 'biao', '15-pm-worker-communication.md');
const communicationDoc = readFileSync(communicationDocPath, 'utf8');

describe('PM/Worker 通信定稿语义', () => {
  it('只引用当前 Question API 与 CLI', () => {
    expect(communicationDoc).toContain('`POST /question`');
    expect(communicationDoc).toContain('`GET /questions`');
    expect(communicationDoc).toContain('`GET /question/:question_id`');
    expect(communicationDoc).toContain('`POST /question/:question_id/answer`');
    expect(communicationDoc).toContain('`biao question ask`');
    expect(communicationDoc).toContain('`biao question list`');
    expect(communicationDoc).toContain('`biao question get`');
    expect(communicationDoc).toContain('`biao question answer`');

    for (const legacyContract of [
      'biao questions',
      'biao reply',
      '/task/:id/question',
      '/task/:id/pm-reply',
      'POST /reply',
    ]) {
      expect(communicationDoc).not.toContain(legacyContract);
    }
  });

  it('固定 Question 释放旧权属并由 Worker fresh claim 恢复', () => {
    expect(communicationDoc).toContain('释放 claim/ownership');
    expect(communicationDoc).toContain('旧 claim token 失效');
    expect(communicationDoc).toContain('重新进入 `pending`');
    expect(communicationDoc).toContain('新的 claim token');
    expect(communicationDoc).toContain('checkpoint');
  });

  it('固定独立验收门，不再描述软门', () => {
    expect(communicationDoc).toContain('`done` 只是交付状态');
    expect(communicationDoc).toContain('`pm_review_status=accepted`');
    expect(communicationDoc).toContain('独立 Agent');
    expect(communicationDoc).not.toContain('软门');
  });
});
