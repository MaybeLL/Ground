# Grounds 本项目开发镜像

本目录保留用于构建项目工具链镜像的显式脚本，不是 Agent 执行协调器。旧 `code-workspace` 路线、Repo 环境默认、内部配方/镜像准备及其受管容器验收已按 D149 退役，不能再通过这些命令登记或启动镜像。新托管执行与 devcontainer 集成待 P4。

## 构建工具链镜像

需要 Docker/Colima。首次构建需要访问 Debian、公开 npm registry 和 Playwright 下载源；只在明确需要构建时执行：

```sh
python3 scripts/dev-environment/build.py --tag grounds-self-dev:local
docker image inspect grounds-self-dev:local --format '{{.Id}}'
```

构建脚本只发送 Dockerfile、工具和指纹脚本、CLI package/lock、原生 addon 与 vendored 源码，不发送整个仓库、Git 历史、账本或用户配置。Node 22 基础镜像固定 registry digest，依赖通过 `npm ci` 安装；OS 包未逐包锁版本，不承诺重建字节一致。

镜像含 Node/npm、Git、Python、C/C++/make、OpenSSL、进程工具、无头 Chromium、CLI 依赖和 Linux 原生 addon。构建脚本按宿主 UID/GID 添加用户；跨用户或平台使用须重新构建。退役过程不启动 Docker，也不自动清理已有容器、卷或镜像。

## 镜像内工具

`grounds-dev` 假定当前源码位于 `/workspace`，由调用者准备独立的可写开发目录与适当的资源/网络隔离。它不分配工作目录、不管理容器、不提供业务准入或独立验收保证；不要挂载宿主 Docker socket、真实账本或凭据来绕过这些边界。

- `grounds-dev build`：重新编译 native 源码并构建 CLI。
- `grounds-dev smoke`：构建后运行 work 代码交付、work 存储、runtime 存储聚焦测试及根脚本测试。
- `grounds-dev test`：CLI 串行完整文件队列及根脚本测试。
- `grounds-dev COMMAND ...`：在准备好的环境运行指定命令。

旧 TUI 和 Python plugin 测试均不再安装或运行。条件测试的跳过不是验收通过；macOS 原生行为、真实 MySQL/PostgreSQL、Docker 集成与发行验证仍需对应的独立环境。

依赖从镜像复制到当前源码目录，避免跨任务共享可变 node_modules。`dependency-fingerprint.mjs` 仅忽略 manifest/lockfile 的发行版本字段，依赖版本、来源、完整性和安装脚本等仍参与比较。源码或发行版本号改变可复用依赖；真实安装输入改变则拒绝并要求重建镜像。该指纹不证明任意源码均可构建。

未知或旧 node_modules 不覆盖、不删除；使用新目录或先保留并移走原目录。HOME、TMPDIR 与 npm 缓存位于 `node_modules/.grounds-dev/`；Linux `/private/tmp` 指向该临时目录。目录清理须由调用者先确认需要保留的内容。
