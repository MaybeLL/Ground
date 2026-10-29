<a id="author-evaluation-tasks"></a>

# 编写评测任务

使用用户现有 Agent 编写 Graders，不新增编写 Agent 服务。命令示例和输入形状见[评测说明](../evaluation.md)。

遵循[共享准备协议](../../../../references/preparation.md)，下列命令使用导出的 helper 根目录。

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$SOURCE_CLONE" -- eval --help
```

写入设置 `GROUNDS_AGENT_ID` 和 `GROUNDS_AGENT_NAME`。重放失败请求时保留 operation ID。

QA 编写和 CSV 迁移阅读 [QA 说明](../evaluation-qa.md)。发布具有必填 rubric 和可选参考答案的原生 QA 记录，将 QA Graders 和 suite tasks 绑定到准确版本。保留私有来源注释。下列 Issue/Candidate 要求只适用于 Coding。

1. 固定准确 Issue Version 及其公开 Requirement/Criteria。公开 Criteria 告知开发者所需行为；私有 Graders 定义如何评估提交的 Candidates，不能引入隐藏要求。
2. 每个独立检查或质量维度创建一个 Grader，执行类型与结果形式分别选择。单测 Grader 输出 pass/fail；Agent Grader 可输出 pass/fail 或具固定范围、方向和 rubric 的分数。不增加总分。
3. 使用 `eval grader template`。代码接口稳定时，在测试函数内编写普通 Go 表驱动测试。package、准确测试名和测试源码随 Grader 固定。不启动服务或增加独立 fixture/case 协议。合理的正确实现可能采用不同内部接口时，使用 Agent Grader，不猜测一个接口再拒绝其他实现。
4. Agent Grader 指令应要求优先编写并运行单测；仅对无法实际测试的方面使用代码推理。定义可读性/可维护性评分所需证据和证据不足的含义。生成测试属于本次执行，不自动成为已发布定义的一部分。
5. 有用时试验可用参考 Candidates、已知错误行为和其他合法实现。区分作者自验与独立试验。参考是证据，不是绝对真值。在 `limitations` 记录试验和缺失覆盖；发布固定版本，不认证可靠性。已知错误测试修复后才将 Grader 呈现为可用。用 `grader discourage ID --version N --reason ...` 注记有问题的已发布版本，不改历史结果。不要求不存在的参考样例，也不编造校准结果。
6. 在用户授权范围内发布。更新追加版本，已有 suite tasks 保留已选版本。使用当前 suite 版本显式增/改/删任务。移除任务不删除 Issue、Grader 或实验历史。

私有定义和测试不得进入开发交接。编写上下文看过私有 Graders 后，不能同时充当这些任务的盲测开发者。

QA 实验的环境定义遵循 [环境说明](../evaluation-environments.md)。准备脚本作为版本化定义保存，在绑定实验前附实际成功和受控失败的验证证据。题目本身不决定仓库 commit 或工具链。
