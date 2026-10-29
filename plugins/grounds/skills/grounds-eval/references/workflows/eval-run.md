<a id="run-evaluations"></a>

# 运行评测

当前命令与 JSON 格式见[评测说明](../evaluation.md)。本 Skill 协调外部 Agent 会话；CLI 不启动模型，也不安装被测配置。

遵循[共享准备协议](../../../../references/preparation.md)，下列命令使用导出的 helper 根目录。

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$SOURCE_CLONE" -- eval --help
```

执行预检、监督和证据检查清单见 [执行手册](../evaluation-execution.md)。

<a id="select-the-task-route"></a>

## 选择任务路径

原生 QA 阅读 [QA 说明](../evaluation-qa.md)；版本化脚本准备和 A/B/C/D 来源访问还需 [环境说明](../evaluation-environments.md)。使用分发的 `scripts/grounds_eval_run.py` 协调者，它调用 `scripts/grounds_eval_capture.py`，负责公开材料交付、统一 Docker 隔离、逐题新 Codex 会话、冻结证据、独立评分、恢复和报告。QA 只读取此路径，下文 Coding 要求不适用。新私有 journal 使用 `start`，复用已完成捕获并继续待办阶段使用 `resume`；启动结果不确定时不能自动重复。suite、配置和预算固定后，不逐题索要确认。答错继续，环境/权限/预算阻塞则暂停。绑定环境实验前验证已保存定义，不编造通过检查。仅在明确重试指令后用 `retry-prepare`。兼容实验可用 `start-plan` 共享准备，从 owner journal 恢复。Python 协调者处理只读 QA；Coding 私有 Grader 由核心统一 Docker 执行接口承载。

<a id="prepare-the-comparison"></a>

## 准备对照

一个实验以一份冻结 suite snapshot 评测一个声明的被测配置。首个实验使用 `--suite`，对照实验使用返回的 `snapshot_id`。保持任务 Baseline、模型设置和资源预算可比。description 记录预期配置，不代表 CLI 独立验证 KB/工具使用。

协调者可以看到私有 Graders。被测开发者只接收 `eval run context`、受管开发工作树和预期被测工具，不能得到 Grader 材料、参考解法、旧结果、协调者对话或可读私有 Graders 的共享账本凭据。Skill 本身不能强制 OS/工具隔离。宿主不能提供新的受限开发上下文时，记录局限并安排独立交接，再谈盲测对照。

<a id="execute-and-collect"></a>

## 执行与收集

- 每个任务用 `eval run start` 创建一个 EvalRun。开发运行创建 DevRun 和受管工作树，通过已有 Candidate 提交流程开发，不改变封存 Issue 契约。开发耗时从 DevRun 创建到 Candidate 提交或明确放弃，含等待和本地测试。
- 已有 Candidate 可用 `--candidate` 重评，不创建 DevRun。开发耗时标为引用，不计为新独立 Coding 尝试。
- Candidate 提交后执行全部选定 Graders。单测 Grader 用 `eval grader execute`。一项失败不跳过其他项；编译/配置错误和测试缺失/跳过不是 Candidate 行为失败。
- Agent Grader 用 `eval grader context`。在新评估者上下文中，将固定 Candidate 物化到新的 review 路径，读取固定 rubric，优先编写和运行普通表驱动单测。保留生成测试源码和命令输出。无法实际测试的方面解释代码位置和推理。不改生产代码，也不弱化预期行为以通过测试；证据不足用 `inconclusive`。
- 使用材料中的准确 execution ID 和 context digest 提交单项执行结果。协调者导入，评估者不需要账本凭据。Eval Grader 可只覆盖部分 Issue，与全 Criteria 的独立 Verification 不同。
- 全部检查有结果后 finish，或带原因显式 stop。只有关闭形成不可变 EvalResult。重跑需 `--rerun-of`，保留旧尝试。不自动重复直到通过。单测进程中断时，有保存证据则导入，否则停止并显式创建新 run。

<a id="explain-the-report"></a>

## 解释报告

导出实验报告，用相同 snapshot 的实验做对照。展示每题、每次 run、结论/分数及 rubric、理由、证据、缺失结果、执行错误和开发耗时。不合成加权或综合总分，不静默选择最佳/最新尝试。标明重评和待运行任务，区分配置的 KB 条件与已验证 KB 效果。

Coding 记录开发耗时。QA 另记录观察到的执行元数据和可获得 token 用量；两条路径都不推断货币费用。
