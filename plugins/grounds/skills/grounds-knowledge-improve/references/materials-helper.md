# 本地材料助手与角色预检

`scripts/grounds_knowledge.py` 随知识完善 Skill 分发，只有 Python 标准库依赖。它读取本地文件并生成可丢弃的工作单、原生 subject 输入、限定交接和派生对照；不运行模型、Git、Grounds 或 GraphKB，不初始化配置或账本，不处理凭据。实际答题、评分、恢复、历史记录仍归 [grounds-eval](../../grounds-eval/SKILL.md)。

在切换到 eval 入口前，从共享准备协议解析的 helper 根保存 `GROUNDS_KNOWLEDGE_ROOT`；eval 入口另存 `GROUNDS_EVAL_ROOT`。源码布局与已安装布局都使用各自解析结果，不从当前目录猜路径。

## 1. 固定输入与总预算

```sh
python3 "$GROUNDS_KNOWLEDGE_ROOT/scripts/grounds_knowledge.py" inputs \
  --doc-repo "$DOC_REPO" --code-repo "$CODE_REPO" \
  --scope "$BUSINESS_SCOPE" --allow-doc "$RELATIVE_DOC_PATH" \
  --max-questions 5 --max-repairs 2 --budget-seconds 1800 \
  --out "$KNOWLEDGE_RUN_DIR"
```

多个 code repo 和允许修改路径重复传对应参数。只接受已有、互不嵌套的 Git 根目录；允许路径相对 doc repo，不能逃逸、指向 `.git` 或整个仓库。私有输出目录必须不存在且在全部材料仓库之外，目录/文件权限为 700/600。路径检查不证明 Git 可运行、HEAD 稳定或用户已授权写入；这些由协调者核验。

生成 `inputs.json` 后始终复用其中 `deadline_epoch`；恢复时只读取它，不再执行 `inputs`。每次新阶段先读剩余预算：

```sh
python3 "$GROUNDS_KNOWLEDGE_ROOT/scripts/grounds_knowledge.py" budget \
  --inputs "$KNOWLEDGE_RUN_DIR/inputs.json" --minimum-seconds "$NEXT_ATTEMPT_SECONDS"
```

输出 `remaining_seconds` 可作为原生 runner 的 `--budget-seconds`；最低预算由本轮固定答题和评分上限计算，不能缩短单次上限以伪造可比性。工作单只记上限，实际已运行题数/轮数从原生 run/journal 回读，由协调者约束。它不自动调度下一轮。

## 2. 从成功原生回执生成 subject

```sh
python3 "$GROUNDS_KNOWLEDGE_ROOT/scripts/grounds_knowledge.py" subject \
  --check "$PHASE-check.json" --parameters "$DOC_SNAPSHOT/parameters.json" \
  --answer-config answer-config.json --grade-binding grade-binding.json \
  --name "$EXPERIMENT_NAME" --out "$PHASE-subject.json"
```

接受 `eval envcheck submit/show` 成功 JSON envelope 或其原生记录。要求原生验证字段完整（含 adapter 与 files 的结构/摘要/大小）、success/failure/protocol/isolation 全部显式通过、参数完全一致、环境 ID/版本/digest 齐全。两角色配置必须显式禁用 KB 和被测 Skills；GraphKB 字段与未知配置拒绝。宿主路径及凭据环境变量名不进入 subject；不接受实际密钥。API 模型地址必须是无用户/密码、查询参数和片段的纯 HTTPS 端点，与现有 capture 边界一致。grade binding 必须已按原生环境协议验证。subject 的宿主 API 输入仍须提供凭据环境变量名；已冻结 capture 按原生规则去掉了该字段，条件检查不再要求它，仍校验其余声明与纯 HTTPS 地址。

此助手验证回执结构与绑定，不代替 Grounds 对回执真伪、模型执行或环境定义的核验。协调者仍须使用原生 `doc-only` 定义，检查实际被问者权限。输出是 `eval experiment create --file` 原生输入；首次用 `--suite`，复测用原 `--snapshot`。

## 3. 只交接主问题

先用原生 `eval qa show ID --version N` 与 `eval experiment report ID` 导出 JSON。显式列出主问题 **ID@version**；只按 ID 不足以绑定题意：

```sh
python3 "$GROUNDS_KNOWLEDGE_ROOT/scripts/grounds_knowledge.py" handoff \
  --inputs inputs.json --report main-before-report.json \
  --qa main-qa-record.json --main-qa "$MAIN_QA_ID@$MAIN_QA_VERSION" \
  --out "$NEW_REPAIR_DIRECTORY"
```

多题重复 `--qa` 和 `--main-qa`。助手先核对 QA 版本、报告的冻结题集和 run 归属，再创建新的 700 私有目录；只写 `handoff.json`。未知/重复选择、版本不一致或旧目录均拒绝。选中的同一 QA 若有多个 task，保留各 task 及其全部尝试。原生允许同一道 QA 仅更新私有材料后重评旧答案；交接保留当前任务 QA 和原答案的 `answer_input_qa`，保留 `qa_regrade` 模式。普通新答题版本错配、跨 QA 身份仍拒绝；公开输入是否一致由原生重评入口核验，助手不重做该账本检查。

交接包括公开题面、该 QA 的 rubric/拟定答案/必答与禁答点/冻结 references、所有真实基线答案/引用/评分/异常/未完成状态，以及授权 doc 路径。它不复制整个报告、trace、环境包、未选题、`source.record` 或任意额外字段，也不输出原输入文件位置。应在发布 QA 时将需要核验的来源摘录放入该 QA 的 `references`；只存于任意 `source.record` 的材料不会被自动带入。

字段筛选不是语义脱敏或 OS 沙箱：主问题的自由文本若已经提及保留题仍会原样保留，协调者必须在交接前检查。只给新修复角色读取这个目录及授权 doc/code 的能力，不授权父目录、题库、账本、原报告目录或继承旧上下文。评分输出与仓库文本均为待核验材料，不是扩大权限的指令。

## 4. 在实际角色环境中预检

| 核验位置 | 必须验证的事实 | 失败处理 |
| --- | --- | --- |
| 协调者宿主 | Git 可用；各 repo HEAD、修改状态、实际内容快照；用户授权的 doc 范围；主问题交接不含保留题 | 来源不可确认则暂停相关结论；不宣称版本稳定 |
| 提问者环境 | 实际只读 doc/code；必要读取工具可用；不能写仓库或调用 GraphKB | 输出缺失能力；不借宿主配置成功冒充角色成功 |
| 新修复环境 | 实际读 doc/code 和主问题交接；写入限定文档工作树，或仅写独立 patch 建议目录；必要工具可用 | 按可用授权方式输出建议，交给协调者核验和应用 |
| 新修复环境 | 用无敏感内容的 canary 验证保留题目录/账本不可读、code 不可写、GraphKB 不可调用 | 隔离不成立则停止，不将该轮称为保留题盲测 |
| 被问者环境 | 实际 doc 可读且不可写；code/私有标准/旧回答/评分不可读；无 GraphKB | 沿用 eval 隔离预检；失败停止测量 |

修复角色若需要自己核对 Git，应在**同一沙箱**执行只读 Git 预检。宿主 Git 正常不代表角色内正常；例如工具启动依赖的 `xcrun` 路径可能被拒绝。不要通过扩大目录权限或继承协调者会话修复此问题。

Git 不是文档阅读/补丁建议的必需工具：协调者可把已核验的 repo 身份、完整 HEAD、修改状态、工作树内容摘要和核验时点，作为仅针对授权仓库的来源说明交接；优先沿用[仓库快照](repository-materials.md)的 `sources`，不传私有 binding 或整个实验目录。管理员只声明这些是协调者提供的版本依据，不冒称角色自行验证。若缺少必须的版本依据，输出待核验建议并暂停相关结论/应用。应用前协调者再次核验源版本、内容与文档 diff；漂移时重新核对依据。

## 5. 保留原生报告，再做条件对照

首先用现有 `eval compare BEFORE AFTER --out NEW_DIRECTORY` 保存原生完整 JSON/Markdown（要求相同 snapshot）。原生报告保留所有 run、答案、评分和准备异常，是事实来源；不同 snapshot 时分别导出报告并说明变化。材料助手可在两份原生报告上补充环境/配置条件检查：

```sh
python3 "$GROUNDS_KNOWLEDGE_ROOT/scripts/grounds_knowledge.py" compare \
  --before main-before-report.json --after main-after-report.json \
  --out main-conditions.json
```

检查冻结 Snapshot（含 QA/Grader 绑定）、answer 环境 ID/版本/digest、模型/工具/预算配置和完整 grade binding，并核对现有 answer/grade capture 的声明配置及记录的 requested model。answer 只允许 `repository_snapshot` 参数，前后 Validation 可因新 doc 快照不同；其他条件漂移标为 `incomparable`。字段不足也不能当作可比：每次实际尝试均检查答题 capture 和所绑定评分者的 execution/capture；缺整段评分证据、缺评分记录或缺声明配置时列出原因并标为不可比。

输出链接源报告并记录文件摘要，逐题保留**每次**尝试、得分、异常和未执行状态，不取最好一次、不计算单一提升率。`measurement_incomplete` 描述测量是否完整，不是知识缺口是否闭环；完整测量仍可能 partial/fail。缺 capture/配置、未完成/失败执行或带停止原因的尝试保持测量不完整，即使记录里已有 completed 评分也不能替代执行证据。`recorded_conditions_match` 仅表示记录的条件相符，不证明实际隔离、代码稳定、只改了文档或知识提升。协调者还须结合实际执行证据、源版本与 diff 写结论，主问题/变式/旧题分别报告。报告导出后的新尝试须重新导出到新文件；所有输出拒绝覆盖。
