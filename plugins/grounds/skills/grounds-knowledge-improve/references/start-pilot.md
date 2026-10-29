# 从安装的 Skill 启动一次试点

协调 Agent 按[闭环工作流](workflows/improve.md)启动宿主提供的独立提问者、核题与修复上下文。Python helper 负责材料准备及 eval 的确定性执行；`grounds_eval_run.py` 调用 capture，capture 在实际受限环境中启动 `codex exec --json --ephemeral` 来答题或评分。本文不新增角色服务、模型 runner 或另一份业务账本。

## 先固定输入与工作目录

先按[材料助手与角色预检](materials-helper.md)保存 `GROUNDS_KNOWLEDGE_ROOT`、运行 `inputs` 创建本轮私有目录与唯一截止时间，并在实际角色沙箱完成所需预检。再切换到 [grounds-eval](../../grounds-eval/SKILL.md)，按其共享准备协议重新解析并导出 helper 根为 `GROUNDS_EVAL_ROOT`，先读 author 工作流。选定 doc/code 本地路径、文档可写范围、题数/修复上限与唯一绝对截止时间。私有目录应在全部材料仓库之外；先进入该目录，再运行预检和 CLI：

```sh
cd "$KNOWLEDGE_RUN_DIR"
set -C
python3 "$GROUNDS_EVAL_ROOT/scripts/grounds_agent.py" preflight --write

g() {
  python3 "$GROUNDS_EVAL_ROOT/scripts/grounds_agent.py" invoke \
    --cwd "$KNOWLEDGE_RUN_DIR" -- "$@"
}
```

`GROUNDS_CONFIG` 指向已选定且可用的配置，`GROUNDS_AGENT_ID/NAME` 使用稳定协调者身份。新目录不是自动初始化账本的指令；需要配置时沿用 Grounds 配置协议。不要因原 cwd 的旧状态阻塞而删除或迁移它。恢复时进入已有目录并读取原回执/journal，不重新创建输入工作单或重复发布。

本例所有路径为绝对路径；变量来自本轮交接，不使用团队名称、固定模型或源码 checkout。命令出错立即检查返回结构；保留 helper 的 operation ID，结果不确定时不重新生成写请求。重定向输出使用新文件并启用 shell 的 `set -C`，防止覆盖回执。

按 author 流程核验并发布 QA、Grader、主 Suite 与回归 Suite；准备 `answer-config.json`、`grader-config.json` 和经过验证的 `grade-binding.json`。两份 capture 配置均禁用 KB、`required_skills: []`，不带 GraphKB 字段。模型、认证、Codex 版本、单次时间/调用上限必须是真实已核验值。题目/标准的格式与 grade 空工作空间准备沿用 eval 的 QA/环境参考，不从本示例臆造。

## 材料与环境只变必要部分

按[仓库材料](repository-materials.md)生成 `doc-before`，保存其参数和私有 binding。首次生成并发布一次 doc-only 定义；成功后保存返回的记录为 `answer-environment-record.json`：

```sh
python3 "$GROUNDS_EVAL_ROOT/scripts/grounds_eval_environment.py" template \
  --source repositories --mode doc-only > answer-definition.json
g eval environment publish --file answer-definition.json > answer-publish.json
python3 - <<'PY'
import json
from pathlib import Path
x = json.loads(Path('answer-publish.json').read_text())
if not x.get('ok'):
    raise SystemExit('Inspect the failed publish receipt before continuing')
with open('answer-environment-record.json', 'x') as f:
    json.dump(x['data']['payload'], f, ensure_ascii=False, indent=2)
PY
```

以下块用于每一份**新**材料快照。先设置 `PHASE=before`、`DOC_SNAPSHOT` 为其绝对目录；修复后用 `PHASE=after` 和新目录重复此块，继续用同一 Environment 记录。不能复用旧 Validation，因为参数摘要已变化。

```sh
export PHASE DOC_SNAPSHOT
export GROUNDS_PREPARE_REPOSITORIES="$DOC_SNAPSHOT/bindings.json"
python3 - <<'PY'
import json, os
from pathlib import Path
phase = os.environ['PHASE']
p = json.loads((Path(os.environ['DOC_SNAPSHOT']) / 'parameters.json').read_text())
with open(f'{phase}-failure-parameters.json', 'x') as f:
    json.dump({**p, 'simulate_failure': True}, f)
PY
python3 "$GROUNDS_EVAL_ROOT/scripts/grounds_eval_environment.py" validate \
  --definition answer-environment-record.json \
  --parameters "$DOC_SNAPSHOT/parameters.json" \
  --failure-parameters "$PHASE-failure-parameters.json" --out "$PHASE-validation"
g eval envcheck submit --file "$PHASE-validation/validation.json" \
  --files "$PHASE-validation" > "$PHASE-check.json"
```

从成功回执构造 subject，避免手抄 ID、版本和摘要。`grade-binding.json` 是 author 阶段按 eval 环境协议建立的独立评分绑定：

```sh
python3 "$GROUNDS_KNOWLEDGE_ROOT/scripts/grounds_knowledge.py" subject \
  --check "$PHASE-check.json" --parameters "$DOC_SNAPSHOT/parameters.json" \
  --answer-config answer-config.json --grade-binding grade-binding.json \
  --name "Knowledge improvement $PHASE" --out "$PHASE-subject.json"
```

基线用 `g eval experiment create --suite "$MAIN_SUITE_ID" --file before-subject.json`。保存 Experiment ID 及返回的 `data.snapshot_id`；复测用 `g eval experiment create --snapshot "$MAIN_SNAPSHOT_ID" --file after-subject.json`。回归 Suite 同理，保存自己的 snapshot；不要与主 Suite 混用 ID。每次写入都保存完整成功/失败回执并检查后再继续。

## 运行与修复交接

author 返回成功后再读 eval 的 run 工作流。先通过实际模型与访问边界预检；以下只示范调用已安装 runner，`EXPERIMENT_ID` 来自本阶段成功回执，`NEW_JOURNAL` 是新私有目录，截止时间从 `inputs.json` 读取；阶段开始前可用材料助手的 `budget` 检查剩余额度：

```sh
export EXPERIMENT_ID NEW_JOURNAL
python3 - <<'PY'
import json, os, subprocess, sys, time
from pathlib import Path
remaining = int(json.loads(Path('inputs.json').read_text())['deadline_epoch'] - time.time())
configs = [json.loads(Path(p).read_text()) for p in ('answer-config.json', 'grader-config.json')]
if remaining < sum(c['timeout_seconds'] for c in configs):
    raise SystemExit('Insufficient remaining budget; preserve the unfinished phase')
command = [sys.executable, str(Path(os.environ['GROUNDS_EVAL_ROOT']) / 'scripts/grounds_eval_run.py'),
           'start', '--ledger-config', os.environ['GROUNDS_CONFIG'],
           '--experiment', os.environ['EXPERIMENT_ID'],
           '--answer-config', 'answer-config.json', '--grader-config', 'grader-config.json',
           '--budget-seconds', str(remaining), '--out', os.environ['NEW_JOURNAL'],
           '--agent-id', os.environ['GROUNDS_AGENT_ID'], '--agent-name', os.environ['GROUNDS_AGENT_NAME']]
subprocess.run(command, check=True)
PY
```

此处使用 PATH 上已安装的 `grounds`；需要指定可执行文件时用 runner 的 `--grounds-command`。单题预算检查不保证整组能完成，未完成题如实保留；不能为 after 或回归重置总截止时间。提交中断用已有 journal 的 `resume`，不重新启动已捕获答案。

主问题基线完成后，按[材料助手](materials-helper.md)的 `handoff` 用明确 QA ID@version 白名单生成新修复目录，并在实际修复环境检查读取、允许写入/补丁输出和保留题拒绝；保留题文件不在其可见材料中。检查授权 doc diff，生成 `doc-after`，重新验证新参数，再用相同题集 snapshot 运行 after。主问题、预冻结变式、旧题回归分别记录前后结果。回答、trace、评分保留在 Grounds；外部交接只关联版本、run、doc 摘要、diff 与未解决项。

收尾复用原生 `eval compare` 的完整报告，必要时以材料助手 `compare` 补充配置可比性与全尝试对照。具体字段、失败和解释边界见[材料助手](materials-helper.md)。
