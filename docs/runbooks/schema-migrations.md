# SQLite Schema 迁移 Runbook

## 适用范围与原则

Biao 的 SQLite schema 从 `001_baseline` 起只向前迁移。`schema_migrations` 固定为：

| 列 | 类型 | 含义 |
| --- | --- | --- |
| `version` | `TEXT PRIMARY KEY` | 三位以上、零填充的版本号，例如 `001` |
| `applied_at` | `TEXT NOT NULL` | 服务端应用迁移的 ISO 8601 时间 |
| `checksum` | `TEXT NOT NULL` | 版本号与不可变迁移材料的完整 SHA-256 |

规则如下：

- 每次启动先校验所有已知历史 checksum，再在一个 SQLite 事务内应用全部待执行迁移；任一 DDL、数据写入或迁移记录失败会整体回滚。
- 已发布迁移不可修改。schema 有任何变化都新增 `NNN_description.ts`，不改写 `001_baseline`。
- `001` 是不可变的 V1 基线版本；migration head 是有序注册表的最后一个版本，会随 `002`、`003+` 持续前移。基线版本与当前 head 不是同一个概念，运维和测试都应读取实际 head，不得假定它固定为某个版本。
- 不提供 `down` migration，不自动删除新表、新列、Delivery、Artifact 或 Audit 数据。
- Redis/SQLite 双写顺序、恢复投影和运行时写入语义不在 schema migration 中改变。
- 测试和演练必须使用显式临时路径或备份副本，禁止拿仓库或安装目录中的 `.biao/data` 当 fixture。

## 日常启动

`SqliteStore` 打开数据库后调用版本化 runner。空库会按注册顺序应用 `001` 以及其后的全部迁移，直到当前 head；没有 `schema_migrations` 的旧 V1 库会保留现有行、补齐旧版隐式列，再从 `001` 继续迁移到当前 head。重复启动只校验已有 checksum，不会重放任何已记录版本。

查看版本和校验记录：

```sql
SELECT version, applied_at, checksum
FROM schema_migrations
ORDER BY version;
```

checksum 不一致时启动会失败。不要手改 `schema_migrations.checksum`；应恢复与数据库记录匹配的发布包，或从升级前备份恢复。

## 升级前门禁

1. 安排维护窗口，停止 Biao、Supervisor 和所有 Worker，确认没有 SQLite/Redis 双写仍在进行。
2. 明确记录源库的绝对路径、当前二进制版本和目标发布版本。不要依赖模糊的工作区根目录或 glob。
3. 构建目标版本：

   ```bash
   npm run build:server
   ```

4. 选择一个不存在的输出路径，在一致备份副本上演练。脚本只读打开源库，使用 SQLite backup API 生成临时副本，只迁移副本；通过门禁后才原子发布输出文件。

   ```bash
   node scripts/migrate-sqlite.mjs \
     --source /absolute/path/biao.sqlite \
     --output /absolute/path/biao.sqlite.head-rehearsal
   ```

5. 保存脚本输出。成功报告必须同时满足：

   - `integrityBefore` 和 `integrityAfter` 都是 `ok`；
   - V1 既有表的 `countsBefore` 与 `countsAfter` 完全相同；
   - `appliedVersions` 与该源库尚未记录的注册表后缀一致（旧库首次纳管会从 `001` 一直应用到当前 head；已处于 head 的库重复演练可为空）；
   - 输出副本中 `schema_migrations` 的 checksum 与目标发布一致。

输出路径已存在时脚本拒绝覆盖。迁移、checksum、integrity 或计数门禁任一失败时，临时输出会删除，源库不会执行 DDL。

## 切换与验证

演练通过后仍保持写入停止。保留原数据库及其 WAL sidecar；推荐让迁移副本成为新路径，而不是在原库上再次运行升级。若必须复用原路径，需把主文件、`-wal` 和 `-shm` 作为同一组归档，再把演练输出移入原路径，且不得覆盖已有备份。

启动新二进制后验证：

1. 日志没有 checksum 或 migration 错误；
2. `SELECT version, applied_at, checksum FROM schema_migrations` 与演练一致；
3. `PRAGMA integrity_check` 返回 `ok`；
4. plans、tasks、questions、agent registrations 的行数与演练报告一致；
5. 执行 V1 冒烟流程，确认 Redis/SQLite 双写后的状态与迁移前语义一致。

只有上述证据完整后才能结束维护窗口。演练输出、原库备份、计数和 integrity 结果应与发布记录一起保存。

## 失败恢复

### 演练失败

- 保持服务停止；不要尝试修补源库或迁移记录。
- 保留错误日志和演练前计数；输出文件不存在是预期行为。
- 修复目标迁移或磁盘/权限问题后，换一个全新的输出路径重新演练。

### 新二进制启动迁移失败

- 事务会回滚本次 runner 的 DDL、数据写入和迁移记录；不要反复手工执行片段 SQL。
- 先复制并保留当前失败库，再用升级前原库备份恢复服务。
- checksum 冲突必须恢复匹配的发布包或备份，禁止通过 `UPDATE schema_migrations` 强行放行。

### 应用层需要回退

SQLite 不做自动逆迁移。只有确认旧二进制对新增表/列保持兼容时，才允许在保持当前数据库不变的前提下回退二进制；旧二进制应忽略它不认识的更高版本和附加表。若兼容性未被测试证明，则停止写入并恢复升级前数据库备份。升级后已经产生的新业务或审计数据不得通过删表、删列或逆迁移抹除，必须先制定显式的数据保全方案。

## 新增后续迁移

1. 在 `src/db/migrations/` 新建递增版本文件，导出 `version`、`checksumMaterial` 和 `up(db)`。
2. 把迁移追加到 `src/db/migrate.ts` 的有序注册表；版本必须严格递增且不可复用。
3. 先写失败测试，至少覆盖空库、真实旧 fixture、重复执行、中断回滚、checksum 冲突和备份副本演练。
4. 只为 `001` 固定 V1 基线快照与 checksum；当前迁移集合、head、schema、迁移前后行数和 `integrity_check` 应从默认有序注册表的实际结果精确核对。新增 `003+` 时不得再次把迁移总数或 head 硬编码进基线测试。
5. 运行目标测试、V1 全量测试和 server build，再按本 runbook 在备份副本上演练。
