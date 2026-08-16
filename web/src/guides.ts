import { createTranslator, type Locale } from './i18n/translations';

export function buildPmConnectionGuide(locale: Locale, serviceOrigin: string): string {
  const t = createTranslator(locale);
  return `# ${t('connection.pmTitle')}

- ${t('connection.service')}：${serviceOrigin}
- ${t('connection.pmRole')}

${t('connection.pmSteps')}

\`\`\`bash
./bootstrap.sh --yes --workspace <allowed-workspace> --project <default-project> --pm-agent <codex|custom>
.biao/doctor
.biao/start
.biao/pm-start --once
.biao/pm plan create <plan-id> --project <project-path> --title "<title>"
\`\`\`

## ${t('connection.mcpSectionTitle')}

${t('connection.mcpConfigIntro')}

\`\`\`json
{
  "mcpServers": {
    "biao": {
      "command": "biao-mcp",
      "args": [],
      "env": { "BIAO_URL": "${serviceOrigin}", "BIAO_API_TOKEN": "<token>" }
    }
  }
}
\`\`\`

${t('connection.mcpTokenHint')}

${t('connection.pmMcpHint')}

${t('connection.security')}`;
}

export function buildWorkerConnectionGuide(
  locale: Locale,
  serviceOrigin: string,
  plan: { planId: string; projectPath: string },
): string {
  const t = createTranslator(locale);
  const projectPath = shellSingleQuote(plan.projectPath);
  const planId = shellSingleQuote(plan.planId);
  return `# ${t('projectList.copyGuideTitle')}

- ${t('connection.service')}：${serviceOrigin}
- ${t('projectList.copyGuidePlanId')}：${plan.planId}
- ${t('projectList.copyGuideProjectPath')}：${plan.projectPath}

## ${t('connection.mcpSectionTitle')}

${t('connection.mcpConfigIntro')}

\`\`\`json
{
  "mcpServers": {
    "biao": {
      "command": "biao-mcp",
      "args": [],
      "env": { "BIAO_URL": "${serviceOrigin}", "BIAO_API_TOKEN": "<token>" }
    }
  }
}
\`\`\`

${t('connection.mcpTokenHint')}

${t('connection.mcpToolsHint')}

## ${t('connection.cliSectionTitle')}

\`\`\`bash
# 第 1 步：一条命令完成注册 + 自动绑定项目 + Worker Token 落盘。
# 无需再到网页控制台重复添加绑定；输出会打印 binding_id，供第 2 步使用。
# --wake-mode background_executor 匹配"由本机 Supervisor 直接执行"的 Worker。
biao-agent-join \\
  --agent-id <unique-agent-id> \\
  --agent-type codex \\
  --capabilities code,docs,review,acceptance \\
  --project-scope ${projectPath} \\
  --wake-mode background_executor

# 第 2 步：为共享 Supervisor 登记执行 slot，并用第 1 步输出的 binding_id 联动（绑定道与执行 slot 精确配对）。
.biao/supervisor-config worker add \\
  --id <unique-agent-id> \\
  --kind codex \\
  --project ${projectPath} \\
  --types code,docs,review,acceptance \\
  --binding-id <第1步输出的binding_id>
.biao/supervisor --plans ${planId}
\`\`\`

${t('connection.workerAlternatives')}

\`\`\`bash
# 单 Worker 兼容入口：只按项目目录筛选，不提供 Plan 级隔离。
BIAO_AGENT_ID=<unique-agent-id> \\
BIAO_PREFERRED_PROJECT=${projectPath} \\
.biao/worker-codex
\`\`\`

${t('projectList.copyGuideInstructions', { project_path: plan.projectPath })}
${t('connection.security')}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
