---
name: grounds
description: 使用 Grounds 的 task/work/grade 闭环定义验收标准、开发并冻结代码交付，由全新子 agent 独立核验，按证据修复和结束工作。用于日常开发与进度查询；不启动旧 Python 协调器或 Codex 采集器。
---

# 使用 Grounds 开发与独立验收

先读[共享准备协议](../../references/preparation.md)。直接使用 Grounds CLI；不调用外部脚本编排 agent。

当前闭环：**TaskRevision → Work / TaskRun → 冻结交付 → 独立 gate → 精化或结束 Work**。任务修订不可变，工作头表示当前方案，验收绑定确切任务版本、标准及交付；归档成功不代表验收通过。

## 定位当前工作

```bash
grounds task list --json
grounds task show --task "$TASK_ID" --json
grounds work show --work "$WORK_ID" --json
grounds work run --run "$RUN_ID" --json
grounds grade list --run "$RUN_ID" --json
```

根据用户给出的目标和真实回执选择工作，不自行选最新运行。已知 run 的契约通过返回的 `run.taskRevision.definitionId` 和 `seq` 查询，不能用任务最新版本替代。没有 Work 列表或自然语言搜索接口时，不编造命令。只读询问以当前事实和建议收尾。

## 按目标加载一个流程

| 目的 | 指引 |
| --- | --- |
| 确定目标、上下文与可判断的验收标准 | [定义任务](references/workflows/define.md) |
| 开始、继续或分支开发，提交冻结代码 | [开发与归档](references/workflows/develop.md) |
| 对冻结交付逐条给出独立结论 | [独立验收](references/workflows/verify.md) |
| 已授权的验证—修复循环 | [有限闭环](references/workflows/auto-repair.md) |
| 选择方案、结束工作或准备外部合入 | [结果与交付](references/workflows/deliver.md) |
| 导出固定任务正文到 Confluence | [文档导出](references/workflows/export-confluence.md) |

## 必须保持的边界

- **主 agent 必须启动全新的子 agent 做验收。** 不 resume 工作者，不继承父会话；改名、切换 skill、同一会话自评都不算独立。
- 交付冻结后再创建验收会话并登记 evaluator。Grounds 签发的 evaluator session 必须不同于 worker session；登记标识不能代替宿主实际创建独立上下文。
- 盲验阶段只传固定契约、固定代码和许可公共资料。不得传作者声明、实现过程、旧评分、主 agent 对话或凭据。冻结独立发现之后才对照额外声明。
- worktree 是协作式隔离，不是安全沙箱。宿主无法提供新上下文或所需材料边界时，明确停止自动验收并交接，不能宣称通过。
- 精化使用新 TaskRun、新 worktree，起点为前一轮冻结交付；不把旧外部工作者的目录移交给新工作者。
- `work close` 不等于通过；`accepted` 不等于已合并或已发布。推送交付归档标签是 `work deliver` 的外部副作用，开始前明确授权；合并、部署、清理需要各自授权。

旧 `eval` 命令、评测与知识改进 skill 已退役，不再发布或读取旧评测资产。新评测资产、托管执行和实验分别待 P3–P5 实现，不以临时 runner 或伪造记录补足。新结果及评分输入已有分发契约，真实 agent 冒烟仍待验收，不能把示例流程当作已验证的模型效果。
