---
plan_id: test-m0-plan
title: M0 测试规划
status: draft
created_at: 2026-08-11
project_path: /tmp/biao-test
default_assignee: auto
default_priority: 5
phases:
  - id: impl
    name: 实现
    description: 测试实现
  - id: qa
    name: 验收
    description: 验收
    depends_on: [impl]
global_constraints:
  - 测试约束
---

# M0 测试规划

测试 plan submit + claim + report 的完整链路。
