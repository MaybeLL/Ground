<a id="shared-grounds-preparation"></a>

# Grounds 共享准备协议

定位当前入口目录，即包含 `grounds`、`grounds-eval` 或 `grounds-knowledge-improve` SKILL.md 的目录。若其中包含 `scripts/grounds_agent.py`，将该目录导出为 `GROUNDS_SKILL_ROOT`；否则导出其所属 Plugin 根目录。遵循可选的 `GROUNDS_CONFIG` 和 Plugin 宿主的 `PLUGIN_ROOT` 回退设置。此根目录用于脚本调用；专属参考按当前文件的相对链接读取，不从 helper 根猜测其位置。Plugin 源码与独立安装遵循同一协议，不混用不同安装中的资源。

在三个入口之间切换时，重新解析并导出当前入口的 helper 根，不沿用另一个 Skill 的根目录。独立安装只携带本 Skill 所需脚本；知识完善协调切换到 `grounds-eval` 后调用评测 helper，不重复分发或改写 runner。共享协议仍有效，不需要重复已经取得的授权。

执行 CLI 操作前，运行 `python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" preflight`。业务写入前加上 `--write`，并要求稳定的 `GROUNDS_AGENT_ID` 和 `GROUNDS_AGENT_NAME`。验证者按验证协议使用自己的身份。检查 `installation_status`：出现 `upgrade_required` 时，在业务操作前按返回的建议命令完成升级；仅有 registry 可用性警告不阻止本地工作。

契约草稿的 `draft new/list/show/read/save/edit/resolve/bind/migrate`（兼容 `workspace` 别名） 以及无 `--output` 的 `contract render --workspace NAME` 只核对 CLI 安装与命令能力，不要求数据库预检成功；数据库不可达、schema 不兼容或离线不得阻止这些本地操作。新建草稿仍须有已配置的账本身份；打开账本现有来源、远端查询、发布仍执行完整预检。

这个 helper `preflight` 只检查工具、配置和数据库准备情况，不证明目标分支最新或契约仍适用。普通目标开发流程还需按定义/开发工作流执行 Grounds 的 `preflight observe/assess/show`，并由发布或开工入口校验其事实绑定。不能把安装检查通过、历史可达或旧计划的本地跟踪观察代替目标刷新。目标刷新在明确授权内显式执行，同一任务及同一目标已有的有效授权不重复询问；无授权或刷新失败时不静默降级放行。离线草稿读写和固定起点评测仍按各自边界执行，不因此暗中联网。

JSON CLI 调用使用共享 helper 的 `invoke --cwd CLONE -- COMMAND`，由它按需提供配置、归属和幂等信息。读取成功或错误返回结构，不能假定调用成功。未知筛选条件以已安装命令的帮助为准。重试保留 operation ID，并遵循所选流程的冲突处理规则。不要编辑 `.grounds/` 内部文件。

只读诊断使用 `config path`、`config validate`、`db test` 和 `db status`。状态查询失败不授权初始化、迁移或修复。用户要求配置时，遵循定义需求流程中的明确确认协议。自然语言理解由 Agent 负责，CLI 参数只包含确定的筛选条件。

准备协议跨流程切换共享。写入前，以及配置、安装或身份变化后重新检查；不要在每次切换时重新加载所有流程参考文件。
