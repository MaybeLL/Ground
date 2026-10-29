# 代码 Workspace 与路线执行

适用于用户选择新代码 Workspace，或已存在 `code-workspace` 实例/路线的开发与恢复。这里的 Workspace 是一个 Issue 的运行实例；`workspace new/read/publish` 是契约编辑工作区，两者不能互换。新 Issue 创建新实例，长期配置可以复用；路线在实例内部并行，每条路线同一时刻只有一个开发执行者。

先按共享准备协议选择数据库和身份，通过 helper 查询 `code-workspace --help` 及所需子命令帮助。该能力包含在 `0.2.41` 及后续发行中；命令缺失时说明所需版本，不改走旧入口接管目录。所有下列命令通过共享 helper 调用，示例省略调用前缀。

```text
数据库：长期配置版本 ──> Issue 的实例 ──> 路线 / DevRun ──> 执行记录
                         │                │
数据根/                  │                │
├── cache/repos/<repo>/   │ 共享 Git 对象   │
├── workspaces/<实例>/ <──┘                │
│   ├── baselines/<alias>/  固定提交，只读   │
│   └── development/<路线>/ <──────────────┘
└── runtime/               身份、锁、恢复记录

当前路线容器
├── /workspace             当前路线开发目录，可写
└── /baselines/<alias>     相关仓库固定代码，只读
```

## 创建与准入

1. 核对 Issue ID/Version、唯一目标 Repository 和相关仓库。配置 JSON 只含 `name`、`repositories`；每项为 `repository_id`、`alias`、`revision`（`{"branch":"main"}` 或 `{"commit":"sha1:..."}`）。配置必须包含目标仓库，不把凭据写进配置。
2. 保存配置或选定已有版本，再创建、准备实例：

```text
code-workspace config-save CONFIG_ID --expected-version 0 --file context.json
code-workspace create --configuration CONFIG_ID --version N --issue ISSUE_ID --issue-version N
code-workspace prepare INSTANCE_ID
code-workspace show INSTANCE_ID
code-workspace route-prepare INSTANCE_ID --issue-slug order-change --operation-id ROUTE_ID
code-workspace route-show ROUTE_ID
code-workspace route-bind ROUTE_ID --development-mode container --operation-id RUN_ID
```

ID 使用 UUIDv7；输出才是实例/路径/版本的依据。写操作由 helper 补身份及幂等 ID；跨调用恢复时显式保留原 ID 和原输入。`prepare` 使用实例身份恢复，不接受 operation ID。创建后按仓库懒刷新缓存并固定提交，已有实例不追随分支；`--allow-cached` 仅在接受新鲜度未知时显式使用，缺对象不能绕过。

macOS/Linux 数据根统一默认 `~/.grounds`；可指定 `GROUNDS_DATA_HOME` 或命令支持的 `--data-root`，同一实例必须一致，不能靠更改参数搬迁。数据库配置仍由 `GROUNDS_CONFIG` 或 `--config` 选择。

3. 从 `route-show` 返回的路线 `path` 执行下列预检。此入口不返回旧 journal 的 `local_worktree`，也不为同一路线再调用 `devrun plan/start`：

```text
preflight observe --phase start --dev-run RUN_ID --refresh
preflight assess --observation OBSERVATION_ID --file assessment.json
devrun admit --dev-run RUN_ID --preflight ASSESSMENT_ID --refresh
```

评估须检查当前实际输入；准备成功不是准入。需要同步时按开发流程的 `devrun sync-status/sync/sync-complete` 协议处理，完成后重新观察与准入；不直接 checkout/reset 路线或更新其他分支。

## 运行、提交与恢复

Repo 环境与 Issue 的目标仓库绑定；Workspace 提供相关代码上下文。环境版本通过 `environment-save` 保存，`environment-check` 验证固定版本，显式 `environment-set-default` 推广；具体 JSON 和 CAS 参数从对应帮助读取。保存、检查、推广是三件事，修改默认版本不影响已启动执行。需要构建时先 `build-material-capture` 固定已提交材料，再 `image-prepare`；当前只支持本地固定基础镜像的受限离线 classic 构建，不能承诺联网安装、BuildKit 或通用凭据注入。

`start.json` 示例：`{"image":"sha256:<本地镜像ID>","mode":"development","argv":["sh","-lc","项目测试与开发命令"]}`。也可选择已保存的 `environment_revision_id` 或 `environment_default:true`，三者只能选一。

```text
code-workspace execution-start ROUTE_ID --file start.json --operation-id EXECUTION_ID
code-workspace execution-serve ROUTE_ID EXECUTION_ID
code-workspace execution-show ROUTE_ID EXECUTION_ID --refresh
code-workspace execution-stop ROUTE_ID EXECUTION_ID
```

`execution-serve` 是持续运行的宿主前台控制器，在独立终端/进程运行；完成或取消后核对最终结果和退出码。容器使用 `grounds-git` 委托暂存/提交；只读 Git 投影允许查看历史，不能直接写共享 refs。默认只读诊断模式不会授予开发写权限。当前网络是禁网或路线私有 PostgreSQL 网络；只跑容器测试不等于完整 Agent 隔离，也不证明在线模型可达。

停止并确认后，在路线目录按[开发候选](workflows/develop.md)的 `candidate template/submit` 和[Git 归档协议](candidate-archive.md)捕获已提交成果。Candidate 固定提交和保护归档是成果真源；工作目录存在、测试退出码、归档成功都不等于独立验证通过。

| 观察到的状态 | 接续方式 |
| --- | --- |
| prepare 中断或缺对象 | 原实例重试 prepare；修复来源后仍恢复原提交，不切到最新配置 |
| execution-start 回复丢失 | 原 ID 查询/重试只回放；先核对并 stop 原执行，再用新 ID 启动，不假定会重新派发 |
| 受管 Git 请求未决或控制器终止 | 原路线/执行执行 serve 接手固定请求；未解决前不得解除占用或另起开发者 |
| 代码目录已回收，需要继续某个 Candidate | restore 原实例到新实例，prepare、route-prepare/bind 后重新准入 |
| 清理中断 | 原操作 ID、原版本和原计划摘要重试；新 ID 不能接管未决清理 |

```text
code-workspace restore OLD_INSTANCE_ID --candidate CANDIDATE_ID --context original
code-workspace prepare NEW_INSTANCE_ID
code-workspace route-prepare NEW_INSTANCE_ID --issue-slug continuation
```

恢复沿用原固定上下文，开发路线从 Candidate 源提交开始；不复活已结束实例，也不继承旧准入。

## 回收与验证交接

`devrun context/show/reconcile` 可读取已绑定路线的本机状态；`available` 不代表允许执行。`devrun cleanup --preview` 对这些路线仅提供保留选项，回收统一走下面的 Workspace 生命周期入口。旧版本出现 missing 时先用 `route-show` 核对固定路径。

已停止、成果保全的实例可 `end`，默认保留代码 7 天。实际回收先 `cleanup-preview`，核对阻塞项、当前生命周期版本和计划摘要，再按已有清理授权执行 `cleanup`；Candidate 尚未验收通过不妨碍已归档代码保全，但未提交/未跟踪/ignored 文件仍会阻止回收。不能自行删除这些文件来让门禁通过。`--early` 只越过保留时间，不越过保全检查。

代码、服务容器/网络、数据卷分开回收；`service-cleanup` 保留卷和共享镜像。数据卷须走公开 preview/export/restore/retire/assess/delete 证据链，读取计划不构成删除授权，数据恢复检查也不等于已接入活动路线。不要手工改 runtime journal、Git 指针或占用文件。

验证继续使用[独立验证协议](workflows/verify.md)。协调者从匹配且持有归档对象的 clone 物化精确 Candidate，不把开发路线目录或整个多仓库 Workspace 交给盲验者。只交付对应角色允许的固定材料；运行记录和盲验/对照门禁不改变。工作目录回收后仍可从保护归档重建审阅树。


## Grounds 内部开发配方（需要 CLI 0.2.42，使用前核对 help）

`recipe-save RECIPE_ID --repository REPO --expected-version N --directory INPUTS --file REQUEST.json` 保存内部不可变版本，REQUEST 只含 `name`、`dockerfile`、`files` 显式清单。源目录不要求Git，保存后不跟踪原文件；`recipe-show REVISION_ID` 返回文件字节与摘要，读取后可在新的临时目录编辑并保存新版本。禁止向配方、参数或日志写入凭据。

`recipe-prepare REVISION_ID --file PREPARE.json --operation-id OP` 明确执行本机联网BuildKit构建。输入为 `{build_args:{},target:{environment_id,expected_version,configuration:{name,postgres?}}}`。只用公开依赖、本机原生平台；不传SSH/secret/socket或宿主脚本。构建成功登记环境但不切默认，沿用后续environment-check和显式推广。

通过 helper 调用 `environment-check`、`recipe-prepare` 或 `image-prepare` 时，非零退出仍可能带有 `ok: true` 的结构化记录：这表示命令返回了记录，不表示检查或构建成功。必须同时检查退出码和记录的状态；保留返回的 `operation_id`，按原操作恢复或查询，不要自动新建操作。前台 `execution-serve` 原样透传输出和退出码。

原operation只接续结果，不重新构建；新operation才调用Docker，可能命中Docker层缓存。结果未知时保留原operation及输入，使用`recipe-preparation-show OP`查询；不能换ID绕过。构建ready但登记冲突时，显式用既有environment-save引用返回的image/preparation_id及新的预期版本，不能覆盖其他人更新。`recipe-preparation-cancel`只申请协作取消；`recipe-preparation-cleanup`只清理终态且字节未修改的构建上下文，保留镜像和日志。

这些命令的业务写入使用同一helper身份/幂等协议。已安装CLI未包含时，不把开发树帮助当作发行能力，不自动替换稳定宿主CLI。旧build-material-capture/image-prepare仍是固定Git材料和离线classic路径，不改变其语义。
