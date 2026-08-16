/**
 * biao-node 服务模板登记与渲染（Phase 3 · §10.2 三平台产物）
 *
 * templates/node/ 下的模板使用 `__大写下划线__` 占位符；本模块是占位符
 * 的唯一登记处（模板与 install 脚本的一致性由 p3 静态校验测试守护）：
 * - renderTemplate 替换全部占位符；出现未知占位符或漏替换直接抛错，
 *   防止半渲染产物被装进服务定义；
 * - listTemplatePlaceholders 供测试比对“模板声明的键 ⊆ 登记表”以及
 *   “install-windows.ps1 覆盖 service ps1 所需的全部键”。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 占位符 → 中文说明（新增模板字段必须先在这里登记）。 */
export const NODE_TEMPLATE_PLACEHOLDERS: Record<string, string> = {
  NODE_BIN: 'Node.js 运行时绝对路径（如 /usr/local/bin/node、C:\\Program Files\\nodejs\\node.exe）',
  BIAO_NODE_JS: 'bin/biao-node.js 入口绝对路径',
  BIAO_NODE_CONFIG: 'biao-node.config.json 绝对路径',
  BIAO_NODE_STATE_DIR: '节点状态/日志目录（daemon 可写）',
  BIAO_NODE_CACHE_DIR: '本地缓存根（cache_root，Phase 4 Git workspace 使用）',
  BIAO_NODE_USER: '服务运行用户（*nix）',
  BIAO_NODE_GROUP: '服务运行组（systemd）',
  BIAO_NODE_ENV_FILE: 'systemd EnvironmentFile 绝对路径（0600，只放过渡期 owner token 等非持久机密）',
  BIAO_NODE_INSTALL_DIR: 'Windows 安装目录',
  BIAO_NODE_SERVICE_NAME: 'Windows 服务名（默认 BiaoNode）',
  BIAO_NODE_CREDENTIAL_TARGET: 'Windows Credential Manager 目标名（如 BiaoNode/biao_url）',
  BIAO_NODE_EVENT_LOG_SOURCE: 'Windows 事件日志源名（如 BiaoNode）',
};

/** templates/node 目录下的产物清单（静态校验测试逐个存在性断言）。 */
export const NODE_TEMPLATE_FILES = [
  'biao-node.launchd.plist',
  'biao-node.service',
  'biao-node-service.ps1',
  'install-windows.ps1',
] as const;

export type NodeTemplateName = (typeof NODE_TEMPLATE_FILES)[number];

const PLACEHOLDER_PATTERN = /__([A-Z][A-Z0-9_]*)__/g;

/** 提取一段模板内容里出现的全部占位符键（去重、保持出现顺序）。 */
export function listTemplatePlaceholders(content: string): string[] {
  const keys: string[] = [];
  for (const match of content.matchAll(PLACEHOLDER_PATTERN)) {
    if (!keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

/**
 * 渲染模板：替换全部已登记占位符。
 * - values 里出现未登记键 → 抛错（登记表是唯一事实源）；
 * - 渲染后仍残留 `__XXX__` → 抛错（漏替换）。
 */
export function renderTemplate(content: string, values: Record<string, string>): string {
  for (const key of Object.keys(values)) {
    if (!(key in NODE_TEMPLATE_PLACEHOLDERS)) {
      throw new Error(`模板变量 ${key} 未在 NODE_TEMPLATE_PLACEHOLDERS 登记，请先补登记再使用`);
    }
  }
  let rendered = content;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`__${key}__`, value);
  }
  const leftover = listTemplatePlaceholders(rendered);
  if (leftover.length > 0) {
    throw new Error(`模板渲染后仍残留未替换占位符：${leftover.join(', ')}（漏传 values 或模板键拼写错误）`);
  }
  return rendered;
}

/** 读取 templates/node 下指定模板内容（相对模板根目录解析）。 */
export function readNodeTemplate(templatesRoot: string, name: NodeTemplateName): string {
  return readFileSync(join(templatesRoot, name), 'utf8');
}
