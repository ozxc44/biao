const labels = {
  codex: 'Codex',
  kimi: 'Kimi',
  custom: 'Custom CLI',
};

export function printWorkerHelpIfRequested(kind) {
  const args = process.argv.slice(2);
  if (!args.includes('--help') && !args.includes('-h')) return false;

  const command = kind === 'codex' ? 'codex-worker' : kind === 'kimi' ? 'kimi-worker' : 'biao-worker';
  console.log(`用法：${command} [--help]

${labels[kind] ?? kind} Worker 接入 Biao 后会：
  1. 使用 BIAO_PREFERRED_PROJECT 只领取目标项目，并在修改前遵守平台 ownership。
  2. 完成任务后由运行层提交 report、changed_files 与逐项 verify_results。
  3. 缺少 PM 决策时不询问当前人类；最终消息只输出一行：
     BIAO_QUESTION: {"body":"需要 PM 决定的问题","checkpoint":"已完成内容与恢复点"}
  4. 平台持久化 Question 并释放旧 claim/ownership；PM 答复后，Worker 必须用新的 claim token 重新领取。

推荐使用 .biao/supervisor 统一管理多个 Worker slot；单 Worker bootstrap 入口默认队列空闲后退出。
常用环境变量：BIAO_URL、BIAO_API_TOKEN、BIAO_AGENT_ID、BIAO_PREFERRED_PROJECT${kind === 'custom' ? '、BIAO_EXEC_CMD' : ''}。`);
  return true;
}
