# Artifact Store 运维手册

> Phase 2 交付 · 对应 docs/distributed-multi-node-development-plan.md §9

## 1. 概述

Artifact Store 是 Biao 分布式控制面的中央制品存储，采用内容寻址（SHA-256）架构。
Worker 节点通过 API 上传制品，PM/Reviewer 通过 API 读取——服务端不依赖 Worker 本地文件即可完成 Review。

### 存储布局

```
<biao-data>/artifacts/
└── sha256/
    ├── ab/
    │   └── abcdef1234567890...  (64位hex)
    ├── cd/
    │   └── cdef1234567890ab...
    └── tmp/
        └── <upload_id>/
            ├── chunk-000000
            └── chunk-000001
```

- `sha256/<prefix>/<digest>`：已确认的不可变 blob
- `tmp/<upload_id>/`：上传中的临时分片（TTL 后自动清理）

## 2. 上传协议（三段式）

### 2.1 状态机

```
initiate → uploading → complete → (blob 落盘, status=complete)
                ↓                    ↓
           expired(TTL)         rejected(篡改)
```

### 2.2 流程

1. **initiate** (`POST /v2/artifacts/initiate`)
   - 声明 `sha256`、`size_bytes`、`kind`
   - 服务端校验大小上限（result-md: 2MiB, log: 50MiB）
   - 返回 `artifact_id` + `upload_id`

2. **upload** (`PUT /v2/artifacts/:artifact_id/content`)
   - 流式/分片上传，乱序可收
   - 服务端累计校验不超声明大小

3. **complete** (`POST /v2/artifacts/:artifact_id/complete`)
   - 服务端重算 SHA-256
   - 摘要不符 → rejected，不残留 blob
   - 摘要一致 → 落盘到内容寻址目录，status=complete
   - 幂等：同 sha256 重传直接返回已存在

### 2.3 安全限制（§9.3）

| kind | 上限 |
|------|------|
| result-md | 2 MiB |
| result-json | 2 MiB |
| patch | 2 MiB |
| agent-log | 50 MiB |
| verify-log | 50 MiB |
| recovery-bundle | 100 MiB |

额外限制：
- 拒绝路径穿越（`..`）
- 拒绝符号链接（服务端不解析）
- 跨项目/跨任务引用被拒绝

## 3. GC 策略（引用计数双扫描）

### 3.1 原理

- `artifact_blobs` 表维护 `ref_count`（引用计数）
- `artifacts` 表的每条记录引用一个 blob
- 只有 `ref_count=0` 且过保留期的 blob 才可删除

### 3.2 两轮 GC

**第一轮：标记**
```bash
# 调用 gcMarkZeroRef() 或等效 API
# 对 ref_count=0 的 blob 写入 .gc-mark 文件
```

**第二轮：清除**
```bash
# 调用 gcSweep() 或等效 API
# 删除有 .gc-mark 标记且无引用的 blob
# 同时删除 artifact_blobs 表记录
```

### 3.3 临时上传清理

- `initiate` 后未 `complete` 的会话默认 TTL 24 小时
- 后台 GC 删除超过 TTL 的临时目录
- 大文件活跃分块通过续期延长，上限 72 小时

## 4. 备份与恢复

### 4.1 备份口径

| 组件 | 备份方式 | 一致性 |
|------|---------|--------|
| blobs 目录 | `rsync` 增量同步 | 按 sha256 命名，天然去重 |
| SQLite 元数据 | `.backup` 或 `VACUUM INTO` | 与 blobs 同一 restore_point_id |

### 4.2 备份步骤

```bash
# 1. 创建 SQLite 一致性快照
sqlite3 data/biao.db ".backup '/backup/biao-$(date +%Y%m%d).db'"

# 2. rsync blobs 目录
rsync -av --delete \
  data/artifacts/ /backup/artifacts/

# 3. 记录 restore_point_id 到备份清单
echo "restore_point_id=rp-$(date +%Y%m%d%H%M)" >> /backup/manifest.txt
```

### 4.3 恢复演练步骤

1. 进入维护屏障（停止新 claim）
2. 还原 SQLite 快照到临时实例
3. 还原 blobs 目录到临时根
4. 执行 `integrity_check`
5. 抽样 10 个 artifact，验证：
   - `artifacts` 表记录存在
   - `artifact_blobs` 表 `ref_count` 正确
   - blob 文件存在且 sha256 匹配
6. 通过 API 尝试读取抽样 artifact
7. 验证无未解释偏差
8. 退出维护屏障

### 4.4 恢复注意事项

- blobs 按内容寻址，增量备份只传新文件
- SQLite 恢复后需重建 `artifact_blobs.ref_count`（从 `artifacts` 表统计）
- 临时上传目录（`tmp/`）无需备份，恢复后由 GC 自然清理

## 5. 监控指标

| 指标 | 说明 |
|------|------|
| `artifact_upload_duration` | 上传耗时 |
| `artifact_upload_failure` | 上传失败（篡改/超限） |
| `artifact_total_bytes` | 总存储字节 |
| `artifact_blob_count` | blob 数量 |
| `artifact_zero_ref_count` | 零引用 blob 数量 |
| `artifact_temp_session_count` | 活跃临时会话数 |
| `artifact_gc_marked` | GC 标记数 |
| `artifact_gc_swept` | GC 清除数 |

## 6. 故障排查

### 上传失败

```
Error: SHA-256 不符：声明 abc..., 实际 def...
```
原因：客户端声明的 sha256 与实际内容不匹配。
处理：检查客户端计算逻辑，重新上传正确内容。

### 超限拒绝

```
Error: Artifact 超限：xxx > 2097152 bytes（kind=result-md）
```
原因：文件超过 kind 对应的上限。
处理：确认 kind 是否正确，或拆分大文件。

### 跨引用拒绝

```
Error: 跨项目引用拒绝：artifact 属于 proj-A，请求者 proj-B
```
原因：尝试读取不属于当前项目的 artifact。
处理：确认 project_id 是否正确。

### blob 文件缺失

```
Error: blob 文件缺失：sha256hash
```
原因：元数据存在但 blob 文件丢失（备份未同步或误删）。
处理：从备份恢复 blob，或标记 artifact 为 rejected。
