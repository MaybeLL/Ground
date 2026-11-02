---
name: grounds-knowledge-improve
description: Prepare source-backed questions and verified documentation repair proposals from Git repositories. The automated doc-only evaluation loop is unavailable during the work-model cutover; do not claim measured improvement without real recorded evidence.
---

# 知识缺口分析与修复准备

先读[共享准备协议](../../references/preparation.md)。本 skill 当前支持输入固定、出题与核题、文档修复建议，以及已有评测证据的检查。**旧自动评测 runner 已删除，当前不执行 doc-only 基线、自动复测或 journal 恢复。** 没有真实实验就不能宣称完成了测量闭环或提升了通过率。

从用户请求定位 doc repo、code repos、业务范围、允许修改路径和预算。只读请求不授权改文档；Git 提交、推送和发布另按用户授权。各仓库的 AGENTS 与本地规则优先，不使用 GraphKB 或远程知识替代给定来源。

| 角色 | 材料边界 |
| --- | --- |
| 提问者 | 只读文档和源码，提出有业务意义的问题及可核验依据 |
| 核题者/知识管理员 | 独立检查来源与拟定答案，在授权范围提出或实施文档修复 |
| 被测答题者 | 只接收公开问题和许可文档快照；目前没有分发的自动运行入口 |

上下文角色不同不等于实际文件隔离。私有参考、rubric、先前答案与父会话不得泄漏给被测角色；无合适宿主能力就停止相应步骤，不让主 agent 冒充独立被测者。

按[工作流](references/workflows/improve.md)记录证据和待执行项；[启动范例](references/start-pilot.md)给出准备步骤，[仓库材料边界](references/repository-materials.md)说明快照要求。可使用[材料助手](references/materials-helper.md)生成本地工作单、限定交接或读取旧报告进行对照。该纯文件工具不启动模型、CLI、Git 或容器，保留它不代表旧执行器仍可用。

已有评测对象和报告通过 [grounds-eval](../grounds-eval/SKILL.md) 读取。新问题或评分条件变化必须保留版本区分；不要用改过的 rubric 回写旧成绩。收尾区分已核实文档缺口、已实施修复、未测量效果与执行能力缺口。
