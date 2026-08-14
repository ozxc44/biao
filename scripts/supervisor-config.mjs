#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, parse, resolve } from 'node:path';

const SLOT_VARIABLES = {
  worker: 'BIAO_WORKER_SLOTS',
  pm: 'BIAO_PM_SLOTS',
};
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SCOPE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

function usage() {
  return `Biao Supervisor slot 配置（本机 Owner 专用）

用法：
  biao-supervisor-config --config /absolute/runtime/config.env [--dry-run] worker add \\
    --id <agent-id> --kind <codex|kimi|custom|cli> --project <absolute-path> --types <a,b> \\
    [--command <command>] [--model <model>] [--agent-type <type>]
  biao-supervisor-config --config /absolute/runtime/config.env worker remove --id <agent-id>
  biao-supervisor-config --config /absolute/runtime/config.env worker list

  biao-supervisor-config --config /absolute/runtime/config.env [--dry-run] pm add \\
    --id <slot-id> --consumer <consumer> --command <command> \\
    [--target <target>] [--plans <a,b>] [--kinds <a,b>]
  biao-supervisor-config --config /absolute/runtime/config.env pm remove --id <slot-id>
  biao-supervisor-config --config /absolute/runtime/config.env pm list

list 只输出 slot JSON；本工具不会打印 config.env 中的其他配置或凭据。`;
}

function fail(message) {
  console.error(`[biao-supervisor-config] ${message}`);
  process.exitCode = 2;
}

function assertConfigPath(requestedPath) {
  if (!isAbsolute(requestedPath)) throw new Error('--config 必须是绝对路径');
  let metadata;
  try {
    metadata = lstatSync(requestedPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('--config 不存在');
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('--config 必须是普通文件且不能是符号链接');
  }
  if (basename(requestedPath) !== 'config.env') {
    throw new Error('--config 必须指向 bootstrap 生成的 config.env');
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('config.env 必须是 owner-only（权限不得宽于 600）');
  }
  if (typeof process.geteuid === 'function' && metadata.uid !== process.geteuid()) {
    throw new Error('config.env 必须归当前 Owner 所有');
  }
  return resolve(requestedPath);
}

function readOwnerConfig(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error('config.env 必须是 owner-only 普通文件');
    }
    if (typeof process.geteuid === 'function' && metadata.uid !== process.geteuid()) {
      throw new Error('config.env 必须归当前 Owner 所有');
    }
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error('--config 不能是符号链接');
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicWriteOwnerConfig(path, content) {
  // 在同目录创建 owner-only 临时文件后原子替换；不会短暂产生可读的凭据副本。
  const parent = dirname(path);
  let temporaryPath;
  let fd;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
      try {
        fd = openSync(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        temporaryPath = undefined;
      }
    }
    if (fd === undefined || temporaryPath === undefined) {
      throw new Error('无法创建安全的临时配置文件');
    }
    writeFileSync(fd, content, 'utf8');
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, path);
    temporaryPath = undefined;
    const parentFd = openSync(parent, constants.O_RDONLY);
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (temporaryPath !== undefined) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

function decodeGeneratedShellValue(raw) {
  let value = '';
  let cursor = 0;
  while (cursor < raw.length) {
    if (raw[cursor] === "'") {
      const end = raw.indexOf("'", cursor + 1);
      if (end < 0) throw new Error('slot 配置不是完整的单引号 shell 值');
      value += raw.slice(cursor + 1, end);
      cursor = end + 1;
      continue;
    }
    if (raw.startsWith(`"'"`, cursor)) {
      value += "'";
      cursor += 3;
      continue;
    }
    throw new Error('slot 配置必须使用 bootstrap 的安全单引号格式');
  }
  return value;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function variableMatch(content, variable) {
  const pattern = new RegExp(`^${variable}=([^\\r\\n]*)(\\r?\\n|$)`, 'gm');
  const matches = [...content.matchAll(pattern)];
  if (matches.length > 1) throw new Error(`${variable} 只能定义一次`);
  return matches[0];
}

function readSlots(content, role) {
  const variable = SLOT_VARIABLES[role];
  const match = variableMatch(content, variable);
  if (!match) return [];
  let decoded;
  try {
    decoded = decodeGeneratedShellValue(match[1]);
  } catch (error) {
    throw new Error(`${variable} 必须是安全引用的 JSON 数组：${error instanceof Error ? error.message : String(error)}`);
  }
  // Supervisor 本身把显式空变量视为“尚未配置任何 slot”；配置 CLI 保持相同语义。
  if (!decoded.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (error) {
    throw new Error(`${variable} 必须是安全引用的 JSON 数组：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${variable} 必须是 JSON 数组`);
  validateSlots(role, parsed);
  return parsed;
}

function replaceSlots(content, role, slots) {
  const variable = SLOT_VARIABLES[role];
  const line = `${variable}=${shellQuote(JSON.stringify(slots))}`;
  const match = variableMatch(content, variable);
  if (!match) {
    const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
    return `${content}${separator}${line}\n`;
  }
  const start = match.index;
  const end = start + match[0].length;
  return `${content.slice(0, start)}${line}${match[2]}${content.slice(end)}`;
}

function parseOptions(args, allowed) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !allowed.has(name)) throw new Error(`未知参数：${name ?? '(缺失)'}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} 需要一个值`);
    if (options.has(name)) throw new Error(`${name} 不能重复`);
    options.set(name, value);
  }
  return options;
}

function required(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

function safeId(value, label) {
  if (!SAFE_ID.test(value)) throw new Error(`${label} 非法`);
  return value;
}

function oneLine(value, label, maximum = 8_192) {
  if (!value || value.length > maximum || /[\u0000\r\n]/.test(value)) {
    throw new Error(`${label} 必须是单行非空值（最长 ${maximum}）`);
  }
  return value;
}

function commaList(value, label, pattern = SAFE_SCOPE) {
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => !pattern.test(entry))) {
    throw new Error(`${label} 必须是逗号分隔的安全标识列表`);
  }
  return [...new Set(entries)];
}

function validateSlots(role, slots) {
  const ids = new Set();
  const consumers = new Set();
  for (const [index, slot] of slots.entries()) {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
      throw new Error(`第 ${index + 1} 个 ${role} slot 必须是对象`);
    }
    const id = role === 'worker' ? slot.agentId : slot.id;
    if (typeof id !== 'string' || !SAFE_ID.test(id)) {
      throw new Error(`第 ${index + 1} 个 ${role} slot 的 id 非法`);
    }
    if (ids.has(id)) throw new Error(`${role} slot id 重复：${id}`);
    ids.add(id);
    if (role === 'pm') {
      if (typeof slot.consumer !== 'string' || !SAFE_ID.test(slot.consumer)) {
        throw new Error(`PM slot ${id} 的 consumer 非法`);
      }
      if (consumers.has(slot.consumer)) throw new Error(`PM slot consumer 重复：${slot.consumer}`);
      consumers.add(slot.consumer);
    }
  }
}

function buildWorkerSlot(args) {
  const options = parseOptions(args, new Set([
    '--id', '--kind', '--project', '--types', '--command', '--model', '--agent-type',
  ]));
  const agentId = safeId(required(options, '--id'), 'Worker id');
  const kind = required(options, '--kind');
  if (!['codex', 'kimi', 'custom', 'cli'].includes(kind)) {
    throw new Error('--kind 必须是 codex、kimi、custom 或 cli');
  }
  const project = required(options, '--project');
  if (!isAbsolute(project) || resolve(project) === parse(resolve(project)).root || /[\u0000\r\n]/.test(project)) {
    throw new Error('--project 必须是非根目录的绝对路径');
  }
  const slot = {
    kind,
    agentId,
    project,
    types: commaList(required(options, '--types'), '--types'),
  };
  const command = options.get('--command');
  const model = options.get('--model');
  const agentType = options.get('--agent-type');
  if (command !== undefined) {
    if (!['custom', 'cli'].includes(kind)) throw new Error('--command 仅适用于 custom/cli Worker');
    slot.command = oneLine(command.trim(), '--command');
  }
  if (['custom', 'cli'].includes(kind) && !slot.command) {
    throw new Error('custom/cli Worker 必须显式提供 --command，不能把缺少执行器的 slot 写入共用 Supervisor');
  }
  if (model !== undefined) {
    if (kind === 'kimi') slot.kimiModel = oneLine(model.trim(), '--model', 512);
    else if (['custom', 'cli'].includes(kind)) slot.model = oneLine(model.trim(), '--model', 512);
    else throw new Error('--model 当前仅适用于 kimi/custom/cli Worker');
  }
  if (agentType !== undefined) slot.agentType = safeId(agentType.trim(), '--agent-type');
  return slot;
}

function buildPmSlot(args) {
  const options = parseOptions(args, new Set([
    '--id', '--consumer', '--command', '--target', '--plans', '--kinds',
  ]));
  const slot = {
    id: safeId(required(options, '--id'), 'PM id'),
    consumer: safeId(required(options, '--consumer'), 'PM consumer'),
    command: oneLine(required(options, '--command'), '--command'),
  };
  const target = options.get('--target');
  const plans = options.get('--plans');
  const kinds = options.get('--kinds');
  if (target !== undefined) slot.target = oneLine(target.trim(), '--target', 512);
  if (plans !== undefined) slot.plans = commaList(plans, '--plans', SAFE_ID);
  if (kinds !== undefined) slot.kinds = commaList(kinds, '--kinds');
  return slot;
}

function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log(usage());
    return;
  }
  const configIndexes = rawArgs.flatMap((arg, index) => arg === '--config' ? [index] : []);
  if (configIndexes.length !== 1) throw new Error('必须且只能提供一次 --config <绝对路径>');
  const configIndex = configIndexes[0];
  const requestedPath = rawArgs[configIndex + 1];
  if (!requestedPath || requestedPath.startsWith('--')) throw new Error('--config 需要一个绝对路径');
  const dryRunIndexes = rawArgs.flatMap((arg, index) => arg === '--dry-run' ? [index] : []);
  if (dryRunIndexes.length > 1) throw new Error('--dry-run 不能重复');
  const dryRun = dryRunIndexes.length === 1;
  const dryRunIndex = dryRunIndexes[0];
  const args = rawArgs.filter((_, index) => (
    index !== configIndex && index !== configIndex + 1 && index !== dryRunIndex
  ));
  const [role, action, ...actionArgs] = args;
  if (!['worker', 'pm'].includes(role ?? '')) throw new Error('角色必须是 worker 或 pm');
  if (!['add', 'remove', 'list'].includes(action ?? '')) throw new Error('操作必须是 add、remove 或 list');

  const configPath = assertConfigPath(requestedPath);
  const content = readOwnerConfig(configPath);
  const slots = readSlots(content, role);

  if (action === 'list') {
    if (dryRun) throw new Error('list 不需要 --dry-run');
    if (actionArgs.length > 0) throw new Error('list 不接受其他参数');
    console.log(JSON.stringify(slots, null, 2));
    return;
  }

  if (action === 'add') {
    const slot = role === 'worker' ? buildWorkerSlot(actionArgs) : buildPmSlot(actionArgs);
    const idField = role === 'worker' ? 'agentId' : 'id';
    if (slots.some((existing) => existing[idField] === slot[idField])) {
      throw new Error(`${role} slot id 已存在；请先 remove，再 add`);
    }
    if (role === 'pm' && slots.some((existing) => existing.consumer === slot.consumer)) {
      throw new Error('PM consumer 已被其他 slot 使用');
    }
    const next = [...slots, slot];
    validateSlots(role, next);
    if (dryRun) {
      console.log(JSON.stringify(next, null, 2));
      return;
    }
    atomicWriteOwnerConfig(configPath, replaceSlots(content, role, next));
    console.log(`${role} slot 已添加：${slot[idField]}`);
    return;
  }

  const options = parseOptions(actionArgs, new Set(['--id']));
  const id = safeId(required(options, '--id'), `${role} id`);
  const idField = role === 'worker' ? 'agentId' : 'id';
  const next = slots.filter((slot) => slot[idField] !== id);
  if (next.length === slots.length) throw new Error(`${role} slot 不存在`);
  if (dryRun) {
    console.log(JSON.stringify(next, null, 2));
    return;
  }
  atomicWriteOwnerConfig(configPath, replaceSlots(content, role, next));
  console.log(`${role} slot 已移除：${id}`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
