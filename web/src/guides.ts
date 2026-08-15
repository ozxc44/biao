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

\`\`\`bash
# 推荐：登记一个 Worker slot，由共享 Supervisor 只处理当前 Plan。
.biao/supervisor-config worker add \\
  --id <unique-agent-id> \\
  --kind codex \\
  --project ${projectPath} \\
  --types code,docs,review,acceptance
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
