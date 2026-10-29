# 正式 Candidate 的 Git 归档与历史查询

正式 Git 工件固定 source commit、ordered parents、result tree、逻辑 base 和远程归档 ref。归档 tag 与开发分支各自独立：删除开发分支不会使仍被归档 tag 引用的对象不可达；仅保存 SHA、曾 push 成功或 MR 页面仍可见，都不等于长期归档。

## 封存与恢复边界

正式新模式 Candidate 的远程归档是封存的一部分。归档属于远程写入，遵循用户已有授权；普通本地 checkpoint 不要求归档。封存使用部署方提供、范围匹配且仍有效的保护策略，不因为 ref 名字包含 `grounds` 就认定它受保护。策略须有可核查来源、团队按 ref 读取权限、普通身份不能覆盖/删除和归档身份可创建；仓库与数据库备份状态分别披露。

已按 [GitHub 项目接入](github-archive-onboarding.md)或 [GitLab 项目接入](gitlab-archive-onboarding.md)绑定的仓库，`candidate submit` 默认使用实时API核验；显式 `--archive-policy FILE` / `GROUNDS_ARCHIVE_POLICY` 保留有时效、来源可复核的运维核验兼容路径。实时检查覆盖两个完整命名空间和本次用户权限，绑定/旧检查成功不持续放行，也不自动回退到旧文件。

`candidate submit` 将固定输入绑定同一归档操作。网络与 SQL 不在同一事务中；失败不表示未写远端。先读取 `candidate archive-operation --operation-id UUID`，核对原操作的 Candidate、source、base、tree、仓库和 ref，保留原 operation ID 恢复。不得 force 覆盖冲突引用、盲目另造 Candidate、删除已成功的远端 ref 或将重试输入改成当前 HEAD。pending/unknown 不是正式归档成功。

- `candidate archive-status ID` 只报告历史回执与本机观察；未刷新时远程当前状态保持 unknown。
- 用户已授权远程读取时，`candidate archive-status ID --refresh` 显式观察远端；历史成功回执保持历史事实，不能覆盖当前 missing/conflict/unreadable/incomplete/unknown。
- `candidate fetch ID` 显式取回已绑定的固定归档对象，校验 source、parents、tree、base 和完整历史；不接管其他用户路径，不覆盖漂移的本机 ref。
- `candidate restore ID --path NEW_DIRECTORY` 在新调用者目录恢复原始提交及历史；目标必须不存在，原活动目录不变。先检查固定归档身份及对象完整性，失败保留可诊断信息。
- `candidate lineage ID` 查询业务修订前身和后继；业务前身不是 Git parents，不按创建时间猜关系。
- 归档操作只针对受支持的 Git 工件，使用固定对象和原操作身份恢复；历史 patch-only 不因带有 source 字段重新进入支持范围。

新 Git 工件恢复应保持原 source 和真实历史。历史 patch-only 工件的内容读取、恢复、修复前身、验证、选择与交付均明确 unsupported，不自动迁移、转换或回填为 Git 工件。历史 SQL 行、patch 字节、摘要、签名与审计保留，不因退役删除。任何候选的旧验证都不自动授予新候选或继续开发的 HEAD。

回填在 SQL 绑定已成功、操作完成标记未写入时，也沿用原 operation 续接。重试要重新验证当前策略及远端完整性；新观察保留在操作记录，返回首次已持久的归档绑定与历史回执，不因观察时间更新改写它。稳定身份或生成规则不一致仍须拒绝。

## Review 与交付

Review 的 `comparison_basis` 固定左右提交、用途和生成规则版本；默认需求变更为候选逻辑 base（已整合目标 T）到候选 C。远端目标之后移动不改变历史端点。上游 B→T、候选演变 C0→C1、累计 B→C1 与实际落地增量分别解释，不把整合来的上游变更都称作者新增。

公开固定差异入口为 `candidate diff ID --view candidate|original|upstream|evolution|cumulative|landing|target`。candidate 为 T→C1，original 为根候选自身 base→source，upstream 为 B→T，evolution 为业务前身 C0→C1，cumulative 为 B→C1。landing 另传准确 `--landing-record ID`，采用已确认的实际目标更新前驱 P→L；target 另传固定 `--target-commit OID --observation-time ISO`，返回 `target_observation` 和 `delivery_ready:false`，不改历史默认 Review。只读本机对象，缺对象返回 unavailable，不隐式 fetch；二进制和过大差异明确标记，不以空 patch 冒充无改动。

实际目标更新前驱 P 是这次目标引用移动前的提交。FF 多提交可能是 `P → A → L`，目标从 P 直接前移到 L，此时 L 的 Git 首父是 A，实际落地增量却是 P→L。`landing.target_predecessor` 将 P 的 confirmed/unknown/conflict、commit 与证据来源分别返回；旧记录缺少该字段按 unknown 读取，不用 gate T 或 L.parents[0] 补值。

新 FF 记录在 `--adoption-file` 的 `grounds.adoption-binding/v1` 中显式提供完整 `target_predecessor` OID，与 `source.kind/reference` 所指的真实采用证据一致；CLI 核对 P 的固定对象、完整历史与 P→L 祖先关系。merge/squash 可结合可信采用方法及真实首父确认 P；若显式声明冲突，保持 conflict，不覆盖已核实的 L。字段对旧输入和旧事件是可选的，不改写旧事件摘要。补充证据使用明确的新观察和操作身份，不能修改原操作已封存的来源。

只有 confirmed P 可作为 L 归档 binding.base_commit、retained_commits 和 landing diff 左端点。缺 P 时 `landing_archive` 保持 pending / `actual_target_predecessor_unknown`；冲突时保持 unknown / `actual_target_predecessor_conflict`。已记录的采用事实保留，原归档操作存在也不证明 P 已确认；landing diff 报 STATE_CONFLICT 及同名 reason，不返回推测端点或伪空差异。

C 是候选 tag 指向的提交；L 是实际被目标采用的落地提交。快进时可能 C=L，merge/squash 通常不同。归档不证明采用，同树不证明同历史，Selection 不证明合入。`integration landing` 使用已绑定项目的实时核验（或显式 `--archive-policy FILE`）可为已核实的 L 归档；采用事实与 L 归档 pending 分别报告，不因归档失败抹去已核实事实，也不把 pending 视为历史可恢复。

本机可用性、历史归档回执、当前远程观察、完整性、Verification、Selection、采用与 L 保留分别汇报。Git 负责固定代码，DB 负责契约、理由、验证、关系和采用事实；任一侧备份都不能代替另一侧。盲验仍按原协议隔离作者说明、commit 文案和其他验证结论，不将完整作者历史直接传给验证者。

开发分支采用 `grounds/<issue-slug>/<route-key>`，容器内沿用同名本地分支；正式候选与落地归档使用既有完整 ID tag，分支不是归档前置条件。修复候选明确 `refines_candidate_id`，独立根候选可以没有前身；不能按时间或 Git parents 猜业务前身。容器本地提交须交接实际对象并校验后由协调者依授权推送；原操作重试不重新开发、换候选或移动 tag。
