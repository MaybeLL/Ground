<a id="knowledge-repository-materials"></a>

# 直接使用仓库材料

执行前切换到 [grounds-eval](../../grounds-eval/SKILL.md)，读取其 preparation 和当前 author/run 工作流，重新解析 `GROUNDS_SKILL_ROOT`。以下 helper 位于该评测入口，不在本知识 Skill 中重复打包：

```sh
export GROUNDS_EVAL_ROOT="$GROUNDS_SKILL_ROOT"
```

本流程只读取用户明确指定的本地 Git 仓库；不自动 clone/fetch/pull，不查 GraphKB catalog，不要求固定远端、团队名称或文档布局。选定仓库须有 HEAD。Git 未提交的 tracked 修改与删除包含在工作树快照内；未跟踪文件默认不纳入，需要时显式加 `--include-untracked`。私有问题、参考答案、日志与配置放在仓库之外。

## 快照与材料边界

```sh
python3 "$GROUNDS_EVAL_ROOT/scripts/grounds_eval_repositories.py" \
  --doc-repo "$DOC_REPO" --include-untracked --out "$NEW_DOC_SNAPSHOT"
python3 "$GROUNDS_EVAL_ROOT/scripts/grounds_eval_environment.py" template \
  --source repositories --mode doc-only > "$ANSWER_ENVIRONMENT_FILE"
```

输出目录必须不存在且位于全部输入仓库之外。`snapshot.json` 记录材料、实际 Git HEAD、工作树内容摘要和完整文件 manifest；`parameters.json` 只含 `repository_snapshot` 内容摘要。`bindings.json` 将摘要映射至本机快照目录，只供监督器使用，不进入定义、实验参数或答题包：

```sh
export GROUNDS_PREPARE_REPOSITORIES="$NEW_DOC_SNAPSHOT/bindings.json"
```

参数绑定实际字节，不能用 HEAD 代替 dirty 文档快照。prepare 校验摘要及文件后，仅复制 `read_roles` 所选材料到受管目录；原始仓库路径、Git 元数据和本机 binding 不给答题进程。答题包只列可读 doc 材料，doc 中指向 code 的链接不授予跨目录权限。

需要给提问者/管理员固定来源材料时，可在另一份私有快照中重复 `--code-repo PATH`；其只读分析配方为 `template --source repositories --mode doc-code`。角色上下文由现有宿主协调，不为了运行研究角色而创建假 QA 实验；编辑回到授权的 doc 工作树并检查 diff，不改只读快照或 code repo。

快照排除 `.git`、`.grounds`、`.patchledger`、`.codex`、`.agents`、`node_modules`、`__pycache__` 与 `.env`、`.env.*`；不随材料加载 Agent Skills。子模块、符号链接、LFS pointer、特殊文件、路径碰撞或捕获中的可见变化失败关闭。单文件上限 32 MiB、总量 256 MiB、至多 50,000 文件；失败目录保留供检查，重试使用新目录。快照是固定输入，不证明多仓库来自同一发布，也不保证检测所有并发编辑。

## 接入既有 eval

1. 用既有 `eval environment publish` 发布 answer 定义，取回准确 ID、版本和 digest；grade 沿用 `template --mode grade`。
2. success 参数使用生成的 `parameters.json`；failure 参数复制它并加 `simulate_failure: true`。按评测环境协议执行 `validate`、`eval envcheck submit`，必须真实通过 success/failure/protocol/isolation。
3. answer/grade 的 `execution_config` 与各自 capture 配置一致；明确 `enable_kb: false`、`required_skills: []`，不设置 `graphkb_command`、`kb`、`kb_server` 或 `expected_revision`。模型、认证与 Codex 版本沿用既有 QA 协议；凭据留在宿主。
4. 创建绑定 QA Suite Snapshot、环境、参数、Validation 的 Experiment，运行现有 `grounds_eval_run.py start`。保持该次 `GROUNDS_PREPARE_REPOSITORIES` binding 可用，恢复沿用原摘要与原 journal。
5. 更新文档后创建新的快照目录、参数、Validation 与 Experiment；复用原 Environment ID/版本/定义、相同题集快照和配置，不重复发布同一配方。Validation 重新绑定新参数。旧输入、答案、结果与 journal 保留。`regrade` 不替代新答题。完整衔接见[启动范例](start-pilot.md)。

需要同时准备多个快照时，私有 binding 文件可包含多个 `摘要: 绝对目录` 项；摘要和目录必须精确匹配，不把此映射加入被测资料。准备不需要下载网络；答题的 broker 不开放 GraphKB 和 hosted search/MCP。第一次正式运行前同时核验 doc 可读、code/私有目录不可读、doc 不可写、GraphKB 不可调用；仅完成静态配置不代表隔离已验证。
