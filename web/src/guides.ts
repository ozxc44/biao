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

## ${t('connection.otherEntriesTitle')}

${t('connection.otherEntriesPointer')}

${t('projectList.copyGuideInstructions', { project_path: plan.projectPath })}
${t('connection.security')}`;
}
