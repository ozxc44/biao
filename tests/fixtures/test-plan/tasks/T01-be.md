---
task_id: test-m0-plan-01-be
title: 后端测试任务
type: code
phase: impl
assignee: auto
ownership:
  files:
    - apps/server/**
priority: 5
timeout_seconds: 60
verify:
  - cmd: echo hello
    expect_exit: 0
---

# 后端测试任务

测试用，body 内容。
