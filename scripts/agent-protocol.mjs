/**
 * Biao AGENTS.md/CLAUDE.md 协议块注入器（零配置 harness 接入）。
 *
 * swarm-protocol 的核心洞察：把协作协议放进 harness 自动读取的入口文件
 * （AGENTS.md / CLAUDE.md），任何新 harness（Kimi/Qwen/自定义 CLI）无需适配层
 * 就知道 Biao 任务书的执行规则。本模块是唯一事实源：
 * - bootstrap 建立工作区时对 workspace 根注入；
 * - supervisor 启动时对每个 slot 的 project 目录注入；
 * 幂等：已有块按版本整块替换，块外内容一字不动。BIAO_AGENT_PROTOCOL=0 可停用。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AGENT_PROTOCOL_VERSION = 1;
export const PROTOCOL_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'];

const BLOCK_BEGIN = `<!-- biao:agent-protocol:v${AGENT_PROTOCOL_VERSION} BEGIN（Biao 自动注入，勿手改本块；设 BIAO_AGENT_PROTOCOL=0 可停用注入） -->`;
const BLOCK_END = '<!-- biao:agent-protocol END -->';

export function buildAgentProtocolBlock() {
  return `${BLOCK_BEGIN}
## Biao 协作协议

本仓库的任务可能由 Biao 平台（局域网多机多 harness 调度）派发。若你的会话收到 Biao 任务书（goal / 任务正文），按以下规则执行；否则忽略本块。

1. 任务书是唯一事实源：按 goal 的验收标准交付；只修改任务书授权的文件（ownership 边界），不改 secrets/.env，不改 plans/ 目录下的计划文件。
2. done 不等于完成：把执行结果与证据（改动文件、验证输出）交给调度层上报即可；最终是否算完成由独立 PM Review 验收决定。
3. 产品决策缺失时，不要询问当前用户，输出恰好一行：
   BIAO_QUESTION: {"body":"<问题>","checkpoint":"<当前进度>"}
   然后以现有信息收尾本次交付，等待调度层转发 PM 答复后继续。
4. 不代替 PM：不 ack 门铃、不验收任务、不答复其他任务的 Question。
5. 细节见本机 .biao/ 安装（PM_AGENT.md）与 Biao 仓库 docs/worker-integration.md。
${BLOCK_END}
`;
}

/** 匹配任意历史版本的注入块（整块替换，支持后续 v2/v3 升级）。 */
const ANY_BLOCK_PATTERN = /<!-- biao:agent-protocol[^\n>]*BEGIN[^\n>]*-->[\s\S]*?<!-- biao:agent-protocol END -->\n?/;

export function applyAgentProtocolBlock(content, block = buildAgentProtocolBlock()) {
  if (ANY_BLOCK_PATTERN.test(content)) {
    return content.replace(ANY_BLOCK_PATTERN, block);
  }
  const body = content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
  return `${body.length > 0 ? body : ''}${block}`;
}

/**
 * 向 projectPath 注入协议块（AGENTS.md 与 CLAUDE.md，缺省即创建）。
 * 返回每个文件的变更状态；BIAO_AGENT_PROTOCOL=0 时整体跳过。
 * 任何读写失败只标记 error，绝不抛出——协议注入是增强路径，不是交付闸门。
 */
export function ensureAgentProtocolBlock(projectPath) {
  if (process.env.BIAO_AGENT_PROTOCOL === '0') {
    return { skipped: true, files: PROTOCOL_FILE_NAMES.map((name) => ({ file: name, changed: false, skipped: true })) };
  }
  const block = buildAgentProtocolBlock();
  return {
    skipped: false,
    files: PROTOCOL_FILE_NAMES.map((name) => {
      const file = join(projectPath, name);
      let before = '';
      try {
        before = readFileSync(file, 'utf8');
      } catch {
        before = '';
      }
      const next = applyAgentProtocolBlock(before, block);
      if (next === before) return { file: name, changed: false };
      try {
        writeFileSync(file, next, 'utf8');
        return { file: name, changed: true };
      } catch (error) {
        return { file: name, changed: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  };
}
