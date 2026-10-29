# Grounds 本项目开发环境

长期维护镜像和 Repo 环境版本；每个需求创建自己的 Workspace，不能把验收实例当作所有需求共用的目录。领域与生命周期以[总设计](../../GROUNDS_DESIGN.md#84-本机环境与路线执行)为准。

## Grounds 内部配方入口（CLI 0.2.42）

本轮新增 `code-workspace recipe-save/show` 和 `recipe-prepare`：将 Dockerfile 与显式选择的支持文件保存为 Grounds 内部不可变版本，再显式联网构建并登记 Repo 环境。项目目录只用于首次取材，后续构建读取账本里的固定字节。请求格式、冲突恢复及限制见[内部配方验收记录](../../docs/validation/internal-development-image-2026-10-27.md)。仍使用 0.2.41 时没有这些新命令，下面的脚本仍是旧版本的引导入口。

显式测试也支持 `GROUNDS_SELF_DEV_RECIPE_SOURCE` 指向配方取材目录，替代 `GROUNDS_SELF_DEV_IMAGE`：先通过公开 CLI 保存配方、准备镜像，再用既有应用服务检查和执行。临时账本不替代正式项目配置。

## 镜像构建

需要 Docker/Colima。首次镜像引导需要访问 Debian、公开 npm registry 和 Playwright 下载源；这是显式宿主构建步骤，不是 Grounds 0.2.41 的离线 `image-prepare` 能力。

```sh
# 从仓库根目录运行；Docker 使用当前配置的引擎。
python3 scripts/dev-environment/build.py --tag grounds-self-dev:0.2.41
docker image inspect grounds-self-dev:0.2.41 --format '{{.Id}}'
```

构建脚本只发送 Dockerfile、工具与指纹脚本、两份 package/lock、原生 addon 和 vendored 源码，不发送整个仓库、Git 历史、账本或用户配置。Node22基础镜像固定 registry digest，依赖通过 `npm ci` 安装；最终执行使用本地 `sha256:...` 镜像 ID。OS 包未逐包锁版本，因此不承诺重建字节一致。

镜像含 Node/npm、Git、Python、C/C++/make、OpenSSL、进程工具、无头 Chromium、CLI/TUI 各自的依赖及 Linux 原生 addon。构建脚本按当前宿主UID/GID添加用户记录；跨用户或平台使用时重新构建。业务容器无需联网安装工具。

## 注册与执行

通过 Grounds Skill helper 的预检和身份协议调用公开命令：

```text
code-workspace environment-save ENVIRONMENT_ID --repository REPOSITORY_ID --expected-version 0 --file environment.json
```

`environment.json` 只含 `name` 和固定 `image`。保存版本不等于默认推广：正式路线准入后，可 `environment-check`，检查通过再 `environment-set-default`。临时测试账本中的检查不能拿来推广正式账本默认。

新需求走配置 → 新实例 → prepare → route-prepare/bind → preflight/admit。随后使用保存的 revision 创建执行输入：

```json
{
  "environment_revision_id": "保存结果中的 revision_id",
  "mode": "development",
  "argv": ["grounds-dev", "smoke"]
}
```

```text
code-workspace execution-start ROUTE_ID --file start.json
code-workspace execution-serve ROUTE_ID EXECUTION_ID
```

宿主已发布 Grounds 管理执行；容器内 `grounds` 指向当前 Workspace 构建的源码 CLI，仅用于测试。执行不挂载 Docker socket、宿主账本和凭据。当前受管容器固定1核/512MiB/64进程，工具入口设置GOMAXPROCS=1限制Go工具线程并行度，rootfs只读、开发目录可写、无服务时禁网。

## 日常命令

- `grounds-dev build`：重新编译当前native源码、CLI构建、TUI类型检查与构建。
- `grounds-dev smoke`：上述构建，Workspace/运行存储聚焦测试、Plugin测试和TUI单元测试。
- `grounds-dev test`：CLI串行完整文件队列，再跑Plugin/TUI；条件测试仍按原协议跳过，不等于发行验收。
- `grounds-dev COMMAND ...`：在准备好的同一环境运行指定命令，例如 `grounds-dev node --version`。

依赖从镜像复制到当前路线，避免跨需求共享可变 node_modules；首次准备有磁盘成本，之后同一路线复用。镜像兼容与缓存标记共用 `dependency-fingerprint.mjs` 的结构化指纹：仅忽略package.json根version、lockfile根version及packages[""].version，JSON排版/键顺序不影响结果；其他字段（依赖版本、来源、完整性、安装脚本等）继续参与比较。仅修改源码或发行版本号可复用镜像；真实安装输入变化则拒绝，应重建并保存新的环境版本。指纹只说明该配方的依赖清单兼容，不证明任意源码均可构建。旧镜像需重建一次以安装新检查器，旧的原始lockfile摘要标记不会自动升级。未知或旧 node_modules 不覆盖、不删除；用新Workspace，或先保留并移走原目录。

HOME、TMPDIR和npm缓存位于根 `node_modules/.grounds-dev/`，受现有ignore规则管理；Linux的`/private/tmp`也指向此路线临时目录，兼容项目原有测试路径。忽略目录是开发中间产物，仍会阻止Workspace保全回收；应按生命周期流程确认需要保留的内容，不绕过回收检查。

当前64进程限制下默认Chromium多进程启动不稳定；简单DOM探针使用`chromium.launch({headless:true,args:["--single-process","--no-zygote"]})`通过，此模式不替代完整浏览器验收。

macOS原生行为、Docker生命周期/故障注入、外部MySQL/PostgreSQL及正式配套发行在单独环境验收。当前开发容器不具有管理宿主Docker的能力；不要通过挂载socket把这一边界取消。

## 显式受管容器验收

`typescript/test/self-development-environment-docker.test.ts` 仅在设置 `GROUNDS_SELF_DEV_IMAGE` 时启用。准备干净Git源码导出，将其路径放到 `GROUNDS_SELF_DEV_SOURCE`；`GROUNDS_SELF_DEV_LOG_DIR` 必须指向日志保存目录。使用Colima时将测试进程的TMPDIR显式放到共享的用户目录（例如先创建 `$HOME/tmp/grounds-tests`），不要假定系统临时目录也可挂载。测试使用独立临时账本和Git夹具，验证环境检查/默认选择、真实受管开发执行、禁网、只读rootfs、构建及smoke，最后停止测试容器。

这证明固定源码与镜像的受管执行兼容，不创建正式业务Issue，也不把临时默认选择当成正式Repo默认。具体本机版本与验证结论见[本机搭建记录](../../docs/validation/grounds-self-development-environment-2026-10-27.md)。
