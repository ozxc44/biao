# Supervisor 定时唤起示例

Biao **不会自动安装任何系统计划任务**。需要常驻或定时唤起时，可自行配置；生产推荐优先使用 `.biao/start` 托管的常驻 Supervisor（自带崩溃重启与留守模式），只有不运行常驻进程的部署才需要下面的定时器。

## cron（Linux / macOS）

```bash
# 每 5 分钟一次性共享检查
*/5 * * * * cd /path/to/biao && ./.biao/supervisor --consumer pm --once >> /tmp/biao-sup.log 2>&1
```

## launchd（macOS）

`~/Library/LaunchAgents/com.biao.supervisor.plist`，每 5 分钟一次：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.biao.supervisor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/biao/scripts/supervisor.mjs</string>
    <string>--consumer</string><string>pm</string>
    <string>--once</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
</dict></plist>
```

## 注意事项

- `--once` 模式只做一轮共享检查；无门铃时不启动任何 PM Agent、不消耗模型 token。
- 同一台机器、同一个 Biao 服务地址默认只允许一个 Supervisor 实例（本机锁文件）。
- 配置 `BIAO_PM_AGENT_CMD` 或 PM slot 后，同一个 `--once` 唤起也会按需唤醒一次 PM Agent。
