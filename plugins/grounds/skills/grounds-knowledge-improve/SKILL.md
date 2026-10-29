---
name: grounds-knowledge-improve
description: Improve a team's Git documentation repository through source-backed adversarial questions, doc-only QA evaluation, verified documentation edits and bounded retesting with Grounds. Use for finding and repairing knowledge coverage gaps; no GraphKB is used.
---

# 用问答闭环完善知识仓库

用团队已有的 doc repo 与 code repos，发现可复查的知识缺口并修复。三角色策略由本 Skill 协调；题目版本、私有评分、实验、答案与历史结果复用 [grounds-eval](../grounds-eval/SKILL.md)。不要给核心账本添加知识缺口实体，也不要将研究、写文档包装为虚假的 Coding Issue 或 QA 测量。

## 输入与访问边界

从当前会话和仓库配置定位 `doc_repo`、`code_repos`、业务范围、允许修改的文档及运行预算；只有缺少会影响执行的信息时才询问。读取各仓库的 AGENTS 和现有目录约定；不强制行业、语言或目录结构。这里的知识库就是 doc repo，三个角色都不使用 GraphKB CLI、Skill、MCP 或服务，也不通过 GraphKB 发现仓库。

| 角色 | 可见材料 | 产出与写入 |
| --- | --- | --- |
| 提问者 | doc repo＋code repos；只读 | 有业务价值的问题、拟定答案、固定版本的来源证据 |
| 被问者 | 公开问题＋指定 doc repo 快照；只读 | 答案、文档引用；不知道时说明缺少的材料 |
| 知识管理员 | doc repo＋code repos＋私有核验材料 | 独立核验拟定答案和缺口；按授权修改 doc repo |

提问者、知识管理员由用户现有 Agent 宿主提供独立角色上下文；只传入本角色材料和仓库范围，不提供 GraphKB 工具。它们不属于被测样本。被问者必须用 eval 的新会话与实际文件隔离，不能用同一会话切换角色或靠提示词伪装只读盲测。独立 Grader 是现有 eval 评分步骤，只看冻结评分包与证据，不查询实时仓库。宿主不能提供所需上下文或只读答题隔离时，先完成可独立审阅的出题/修复建议，明确未执行实验，保留待执行入口。

被问者不能读 code repo、私有 rubric、拟定答案、旧回答、旧评分或协调者会话；doc 中的源码链接也不授予源码读取权限。Grounds 配置、题目草稿、参考答案和闭环日志必须位于仓库材料之外。code repos 始终只读；Git 提交、推送与远端发布按用户另行给出的授权执行。

## 执行与边界

先读[共享准备协议](../../references/preparation.md)，通过 `python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py"` 预检。评测写入时切换到 grounds-eval 并重新解析其 helper 根；不要从本 Skill 猜测评测脚本路径。

按[闭环工作流](references/workflows/improve.md)完成：出题与核题 → 冻结 QA/Grader/题集 → doc-only 基线 → 归因与修复 → 新 doc 快照重新答题 → 回归与交接。首次串接各阶段时读[启动范例](references/start-pilot.md)，材料边界见[仓库材料](references/repository-materials.md)。使用[本地材料助手](references/materials-helper.md)复用输入/截止时间、原生 subject 绑定、主问题白名单交接和全尝试对照；先在实际角色环境预检所需工具与访问边界。当前测量路径使用统一 Docker 只读 QA adapter；必须绑定角色裁切后的固定材料和独立 runner，旧 macOS 试点证据不能作为新适配器验收。

优先沿用用户预算；未指定时采用最多 5 题、每题最多 2 轮修复、整轮 30 分钟的上限，并在启动前说明。选择和记录实际可用的答题/评分模型与每次时间、调用上限；不能只写模型名称而不核验真实执行配置。启动前有且只有一个总截止时间；后续新实验使用剩余时间，恢复不重置预算。额度、隔离、模型调用或材料准备失败时停止相关执行；答错保留结果后继续诊断，不能自动重跑到通过。

相同问题的前后对照固定同一 Suite Snapshot、模型、预算、评分标准与工具边界，仅改变 doc 内容快照；两份 Experiment 保留各自答案。重评旧答案不能证明新文档有效。修改公开问题须重新答题，评分标准变更须新版本/快照，不能借此抹去旧失败。

## 闭环交接

为每题保留少量关联：QA/Grader 版本、来源证据、基线与后续 run、缺口归因、文档 diff/快照、回归结果和未解决原因。详细答案、trace 与评分仍以 Grounds 为准，轻量日志不是第二份账本。有限轮次耗尽仍未通过时如实保留；同题通过只表示该题闭环，变式和旧题回归单独报告。
