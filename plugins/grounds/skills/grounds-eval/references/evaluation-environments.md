<a id="scripted-qa-environments"></a>

# 脚本化 QA 环境

Grounds 保存版本化定义、验证证据、实验绑定和执行记录；分发 helper 通过统一 `env up/run/down` 执行 Docker 准备和完整 Codex 任务。当前适配标识是 `grounds-env/1/docker`；旧 macOS adapter 记录保留历史读取，不再新执行。需要隐藏 Grader 或限制材料的评测不能使用可信 host。Python 路径仍是只读 QA；Coding 私有 Grader 使用核心统一 Docker 执行接口。此源码整合尚未发行或完成独立验收。

CLI 0.2.26 起要求 SQL schema 19（此前版本为 18）。已有库只在明确授权后用 `grounds db migrate` 升级到已安装 CLI 当前 schema。SQLite/MySQL 使用相同 records/blob 契约，不将用户库迁移作为测试。

<a id="repository-materials"></a>

## 本地仓库材料（无需 GraphKB）

仓库配方直接消费显式本地 Git 工作树的内容快照。先用 `grounds_eval_repositories.py --doc-repo PATH [--code-repo PATH ...] [--include-untracked] --out NEW_DIRECTORY` 导出；tracked 未提交修改/删除包含在内，新文档需显式纳入 non-ignored untracked 文件。输出保存实际 HEAD、工作树摘要与文件 manifest，不 clone/fetch，也不经过 GraphKB catalog。快照目录须位于仓库之外，私有问题/标准不能混入材料。

生成定义使用 `grounds_eval_environment.py template --source repositories --mode doc-only`；可选模式为 `doc-only`、`doc-code`、`code`。省略 source 时，doc-only、doc-code、code 默认固定仓库配方；kb-only 只绑定只读查询端点，不下载仓库。kb-code 须以自定义、已验证的单仓库固定材料配方声明，旧下载模板不再支持。参数使用快照输出的 `parameters.json`；宿主设置 `GROUNDS_PREPARE_REPOSITORIES` 指向其 `bindings.json`。binding 是 `sha256:…` 到快照绝对目录的私有对象，不传入实验参数或答题会话。监督器校验内容后仅暂存定义允许的角色，脚本不获原仓库访问。此配方禁止 KB、被测 Skills、写工作空间及下载网络。

沿下文发布、验证、绑定和运行协议执行；failure 参数保留 `repository_snapshot`，另加 `simulate_failure: true`。answer/grade 配置显式 `enable_kb: false`、`required_skills: []`，不带 GraphKB 字段。原 QA runner 继续承担采集、独立评分、恢复与报告；doc 改动后使用新摘要、验证与 Experiment。快照导出上限为单文件 32 MiB、总量 256 MiB、至多 50,000 文件；实际单次环境固定输入与结果归档各限 16 MiB，超限明确失败；链接、LFS pointer、子模块、特殊文件和检测到的漂移拒绝准备。知识覆盖诊断与修复策略使用 [知识完善入口](../../grounds-knowledge-improve/SKILL.md)，不放进本 helper 或核心 eval。

<a id="define-and-validate"></a>

## 定义与验证

按 Skill 设置 `GROUNDS_SKILL_ROOT`。生成定义，检查脚本和所选 Docker 运行声明，再发布：

```sh
python3 "$GROUNDS_SKILL_ROOT/scripts/grounds_eval_environment.py" template \
  --source repositories --mode doc-only > environment.json
grounds eval environment publish --file environment.json --json > published.json
python3 -c 'import json; print(json.dumps(json.load(open("published.json"))["data"]["payload"]))' > definition-record.json
```

执行定义的 `backend` 使用 `docker`，`network_hosts` 必须是 `[]`；实际网络由运行声明的 `requirements.network` 决定。旧 host allowlist 不能被解释为 Docker 域名隔离。固定材料优先用上述仓库快照；一次准备最多选一个仓库。其他来源通过已授权、受角色约束的只读查询工具提供。旧 GraphKB 下载和宿主 HTTPS 凭据 proxy 不属于当前统一适配支持路径。

协调者先准备单独、干净、固定提交的 QA runner 仓库，仅包含 `.grounds/environments/<name>.yaml`、Dockerfile 及显式列出的非敏感构建输入。不得直接绑定包含私有 Grader、其他题目或未选材料的完整开发仓库。helper 检查 HEAD、干净状态、完整树与 `build_inputs` 精确一致；环境本身保留输入树，不自动删文件伪造盲验。设置 `GROUNDS_EVAL_ENVIRONMENT_TASK` 指向私有绑定 JSON：

```json
{"workspace":"/absolute/qa-runner","definition":"qa","input_commit":"sha1:FIXED_COMMIT","branch":"grounds/qa/ROUTE_ID","build_inputs":[".grounds/environments/qa.yaml","Dockerfile"]}
```

该宿主绑定不进入实验语义配置；实际环境 receipt 固定输入提交、定义 digest、镜像与运行。镜像须安装 Python 3、Git、固定版本 Codex 及所需工具；完整 Agent、broker 与工具子进程在容器中运行。材料经角色校验后作为只读 `/inputs` 固定输入传入；输出经显式 `/output` 单文件收集。answer 不得获得 Grader；grade 只获得冻结评分包及其校验文件。

模型凭据先由操作者向统一环境显式登记 Repository/环境/ref 范围 grant，再由声明引用；helper 不自动授权或读取宿主 HOME。API 模式可在绑定中用 `credential_env` 将变量名映射到 `/credentials/...` 私有文件。ChatGPT 文件登录使用容器内已授权 `/credentials/...` 路径；不复制用户缓存到 runner 或固定材料。刷新仍由原认证组件负责，拒绝/过期停止，不自动重复模型调用。

`failure-parameters.json` 使用相同参数加 `"simulate_failure": true`。`grade` 成功参数是 `{}`，失败为 `{"simulate_failure":true}`。自定义脚本须提供安全可复现失败输入，在新目录验证：

```sh
python3 "$GROUNDS_SKILL_ROOT/scripts/grounds_eval_environment.py" validate \
  --definition definition-record.json --parameters parameters.json \
  --failure-parameters failure-parameters.json --out validation
grounds eval envcheck submit --file validation/validation.json --files validation --json
```

通过要求真实隔离成功、受控脚本失败、协议失败探针和实际 Docker worker 边界检查，绑定准确定义 digest、adapter 和试验参数。不伪造全 true 记录。CLI 检查结构/digest/关联，不能认证宿主诚实性。脚本改变产生新版本并需新验证。

脚本接收 `GROUNDS_ENV_INPUT`、`GROUNDS_ENV_RESULT`、`GROUNDS_ENV_ATTEMPT`、`GROUNDS_ENV_ROOT`、`GROUNDS_ENV_HELPER`，写一个 JSON 结果：

```json
{
  "format": "grounds.environment-preparation-result/v1",
  "attempt_id": "the exact supplied attempt ID",
  "status": "success",
  "workspace": {"root":"workspace","materials":[{"id":"code","role":"code","path":"code"}]},
  "tools": [],
  "sources": [{"kind":"git","identity":"git.example.test/team/repo","revision":"actual commit","role":"code","branch":"main"}]
}
```

失败将 `workspace/tools/sources` 替换为 `"error":{"stage":"clone_repository","message":"diagnostic","details":"optional"}`。输出缺失/格式错、非零成功、崩溃和超时都是监督器失败，保留日志/原输出。监督器独立检查路径和哈希，不以脚本提供的哈希作为验证。准备和答题均使用固定运行声明的网络策略；不提供 host allowlist proxy，不暗示域名过滤。容器任务结束须由统一 runtime 确认全部进程停止，未知状态保留现场，不能在宿主按容器 PID 发信号。

<a id="prepare-agent-skills"></a>

### 准备 Agent Skills

答题环境可声明完整 Skill bundles：

```json
"skills": [{"name":"graphkb-cli","entrypoint":"SKILL.md"}]
```

准备脚本将整个目录安装到受管 Workspace，并加入原始结果条目，如 `{"name":"graphkb-cli","root":"skills/graphkb-cli","entrypoint":"SKILL.md"}`。脚本不自行声明 digest。监督器校验 frontmatter（`name`、`description`），拒绝链接/路径重叠/超限 bundle，计算完整目录 digest 并保存增强 receipt。`SKILL.md` 旁 references/scripts/assets 都在 digest 内。

答题绑定用 `"required_skills":["graphkb-cli"]` 选择已准备 Skills。这是 `execution_config` 保留字段，不是第二安装机制或独立 Agent profile。模型调用前对 Environment 定义和 Preparation receipt 校验。grade 环境不能声明/加载被测 Skills。

每次答题只复制所选 bundles 到私有 `scratch/.agents/skills` 发现根，记录 `staged_skills`，执行后再核对 digest；原始输入只读，私有展开副本可写，材料或 Skill 修改必须记录为失败/限制。暂存证据不证明 Agent 读过/遵守 Skill，该行为用检索/grounding Grader 检查冻结 trace。adapter 固定 `codex_version`；新版本正式评测前须通过 Skill 发现集成检查。

<a id="bind-an-experiment"></a>

## 绑定实验

在已有 subject JSON 增加 `environment.answer` 和 `environment.grade`，每项形状为：

```json
{
  "environment": {"id":"ENVIRONMENT_UUID","version":1,"digest":"sha256:DEFINITION_DIGEST"},
  "parameters": {"kb":"target","kb_server":"https://kb.example.test/v1","materials":"code"},
  "validation": {"id":"ENVCHECK_UUID","version":1},
  "execution_config": {"model":"MODEL","codex_version":"INSTALLED_VERSION","auth_mode":"codex-login","timeout_seconds":300,"enable_kb":false}
}
```

逐字使用 validation 的 environment 引用。grade 绑定自身空 Workspace 定义/参数及评分配置。execution config 必须匹配 capture config，排除宿主绑定 `environment_task`、`codex_command`、`codex_home`、`api_key_env`、`graphkb_command`。启用 KB 身份须匹配准备参数。A/B 用 `enable_kb:false`，C/D 用 `true` 并提供 `kb`、`kb_server` 和宿主 GraphKB 程序；grade 无 KB 访问。凭据由显式 grant 注入当前 Docker 任务的私有路径。语义参数、脚本版本或执行配置变化需新 experiment。

正常用 `--suite` 或固定 `--snapshot` 创建实验，再按 [QA 指南](evaluation-qa.md)使用 `grounds_eval_run.py start`。所选任务共用一个答题 Workspace，每次答题/评分都有新会话和临时目录，每个 Docker 任务使用独立普通 Git runner 仓库及选定的固定输入。

兼容实验可用 `start-plan` 共享一个准备 owner。plan 是外部协调输入，不是新 Grounds 实体；JSON 是含 `experiment`、`answer_config`、`grader_config` 文件路径的数组：

```sh
python3 "$GROUNDS_SKILL_ROOT/scripts/grounds_eval_run.py" start-plan \
  --file plan.json --grounds-command grounds --ledger-config "$GROUNDS_CONFIG" \
  --budget-seconds 1800 --out NEW_PLAN_DIRECTORY
```

规范准备契约覆盖脚本、执行、语义参数、权限、声明 Skills 和 adapter，全部须匹配。四组条件的权限/Skills 不同，因此分别 Preparation；各兼容实验内部仍共享只读 Workspace。不逐题复制仓库，但不把不同被测环境当同一准备。成本归首个声明的兼容消费者，每次 attempt 计一次。只有 plan owner 能恢复子任务或释放共享 Workspace。

<a id="recover-and-inspect"></a>

## 恢复与检查

`resume --out JOURNAL` 复用完成捕获，只重试相同待提交 DB 请求，不重新启动结果不确定的模型会话。准备失败在答题前暂停。`retry-prepare --out JOURNAL` 是显式重试，定义不变、新 attempt/目录、保留旧诊断。共享 plan 操作 owner journal。中断准备只有记录进程归属可验证才恢复；PID 复用或未知后代导致停止，不给无关进程发信号。

`eval environment/envcheck/preparation/instance show ID [--version N]` 读取记录；`eval envcheck/preparation/instance export ID --out NEW_DIRECTORY` 从配置 DB 导出证据字节。报告含实际来源、尝试、实例 validity/release、耗时和可获 token。未知用量保留 `null`，cached input 是 input tokens 子集。

全部消费者释放后，helper 删除工作文件并保留 DB 证据。本地捕获保留至入库成功。评分读保存答案/证据的固定投影，排除处理条件，不重开实时仓库或 KB。清理后重评只创建评分实例和成本。历史答案缺环境来源仍未知，即使新评分成功。
