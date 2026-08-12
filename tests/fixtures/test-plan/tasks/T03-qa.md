---
task_id: test-m0-plan-03-qa
title: 验收任务
type: acceptance
phase: qa
depends_on:
  - test-m0-plan-01-be
  - test-m0-plan-02-fe
assignee: auto
priority: 8
acceptance_for:
  - test-m0-plan-01-be
  - test-m0-plan-02-fe
verify: []
---

# 验收任务

测试 acceptance DAG 节点。
