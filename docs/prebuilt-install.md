# 预构建 npm tarball 布局

tarball 只用于本地或受控私有分发。本页覆盖安装、状态目录、升级与安全边界；入门路径见 [README](../README.md) 的「已安装 npm tarball」。

## 安装

在一个专用运行目录中安装包，并通过稳定的公共命令 `biao-bootstrap` 配置预构建运行时；请把路径替换为实际的受信任制品和工作区：

```bash
mkdir -p /path/to/biao-runtime
cd /path/to/biao-runtime
npm init -y
npm install /absolute/path/to/vtp-biao-0.1.0.tgz

./node_modules/.bin/biao-bootstrap --yes \
  --workspace /path/to/workspace \
  --project /path/to/workspace/my-project \
  --pm-agent codex

./.biao/doctor
./.biao/start
```

## 状态与代码分离

预构建布局把两类内容明确分开：`node_modules/@vtp/biao` 只保存可替换的只读代码与网页静态资源；调用命令的当前目录下 `.biao/` 保存 `config.env`、Agent Token、SQLite/数据以及启动器。启动器从外置 `.biao/config.env` 读取配置，再通过写死并安全引用的 packageRoot 绝对路径执行已安装代码，不会把 `node_modules` 当作可变数据目录。因此重新安装或升级 npm 包不会顺带删除运行状态。

bootstrap 会校验服务、CLI、Worker、SQLite schema 与网页静态资源，并跳过开发依赖安装和重复构建。

## 把状态放到其它位置

需要把状态放在其它位置时使用显式 `--runtime-dir /absolute/biao-state`。预构建布局会拒绝 packageRoot 内或任意 `node_modules` 内的 runtime-dir，避免包升级时丢失数据。

## 升级

先在同一个消费目录安装新版 tarball，再从该目录刷新启动器；已有配置、Token 和数据会原样保留，启动器改为指向新版 packageRoot：

```bash
cd /path/to/biao-runtime
npm install /absolute/path/to/vtp-biao-new.tgz
./node_modules/.bin/biao-bootstrap \
  --workspace /path/to/workspace \
  --project /path/to/workspace/my-project \
  --upgrade
```

## 安全边界

- 不要裸解压 tarball，因为它不包含生产依赖；任一必需入口缺失时 bootstrap 会立即停止，不会生成表面成功、实际不可启动的配置。
- 生成的 `.biao/` 已被 Git 忽略，不会把本机路径或 Token 提交到仓库。
- Token 安全、本机 Owner 会话与 Worker 接入边界见 [README](../README.md) 的「安全与部署」与 [Worker 接入契约](worker-integration.md)。
