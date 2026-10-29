<a id="reproducible-evaluation-execution"></a>

# 可复现的评测执行

本手册记录 TW SPL Coding 试点验证的执行实践。协调者 Skill 启动/监督 Agent 会话，CLI 管理账本与固定单测。单独的 Workspace 或共享账本不等于执行隔离。

<a id="before-starting-an-experiment-or-explicit-regrade"></a>

## 实验或显式重评前

1. 固定 CLI 工件（发行版，或保留的 build/源码 commit）、Issue、Baseline、suite snapshot、Grader 版本、被测模型/设置和预算。执行中不变更已发布 Graders。
2. 准备真实目标 package 和依赖。在新会话内，用评估者相同文件系统/网络权限及工具链运行能进入测试体的测试；仅宿主 build 或 `go version` 成功不足。验证会话外私有 canary 不可读。
3. 记录 Go 版本、GOOS、GOARCH、CGO_ENABLED、module 目录、vendor/module 模式、缓存路径和编译并发。TW SPL 仅对其 package 验证 Go 1.19、darwin/arm64、CGO_ENABLED=0、离线 vendor，不默认适用于其他项目。需要 CGO 时在同样限制下预检真实编译器/SDK。
4. 每个评估者只接收自身冻结材料和物化 Candidate，不含开发记录、他人结论、私有协调状态或 KB 访问。开发者只接收公开任务和预期工具，私有 Graders 不可读。
5. 提供包含新增文件的完整不可变 Candidate 工件；`git diff HEAD` 可能遗漏 untracked 文件。重建 patch 时核对 digest 与记录工件一致。

沙箱运行时需要执行自身时使用规范可执行路径，符号链接可能越过拒绝目录。只授予必需程序/runtime 访问，不复制凭据进评估者工作区。按需解析解释器/编译器 shim；警告本身不是测试失败，保留退出码和测试事件。

<a id="run-and-supervise"></a>

## 执行与监督

- 资源预算的并发尚未验证时默认串行 Grader；失败不跳过余项。
- 评估者各用独立工作树/缓存。预热只复制公开 Baseline 缓存，不暴露私有校准或其他 Candidate 缓存。复制缓存不保证跨工作树路径全部命中。
- 每个评估者同时只运行一个测试命令。监督入口拒绝重叠调用、固定环境、保存命令/输出/退出状态，强制进程和测试体期限，超时终止自己拥有的进程组。
- 会话监督器在正常退出和超时都追踪/清理自身后代。工具子进程可能另建组，不能只杀模型。核对归属并防 PID 复用，不按进程名广泛 kill。
- 轮询已有工具会话，不重复启动编译。评分中不改工具链或增加期限。
- 保留生成测试源码和完整输出，含失败的 evaluator fixture 配置尝试。修复 evaluator 专属 fixture 与改 Candidate 或静默重复已完成评分不同。基础设施/fixture 失败不是业务反例。
- Agent 评分前后核对 Candidate 内容；评估者改了工件则不导入 completed 结论。

Git helper 每个本地命令上限 120 秒，patch 通过私有普通文件描述符而非 stdin pipe 输入。二进制 patch/result-tree 校验保持。这不是总体实验期限。

<a id="close-report-and-regrade"></a>

## 关闭、报告与重评

导入独立结果不改结论。测试通过只证明断言覆盖范围；测试整个 JSON `null` 或数值成员，不证明拒绝值为 `null` 的对象成员。

Grader 分歧时保留原结果，报告证据和覆盖缺口。可复现契约反例不被 Agent pass 抵消；不投票、平均或合成分数掩盖分歧。

全部选定 Grader 有结果才 finish，或显式 stop 并保留缺失检查。修复后仅在明确授权下用 `eval run start --candidate ... --rerun-of ...` 创建关联重评；保留旧尝试，引用原开发耗时，不把重评算新开发。核对自身评估进程全部结束，随报告保留源码、日志、不可变结果 ID 和执行来源。
