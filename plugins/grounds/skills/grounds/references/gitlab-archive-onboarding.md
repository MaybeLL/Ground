# GitLab 代码交付归档

新闭环通过普通 Git 远端归档，流程与 GitHub 一致：参见[归档步骤](github-archive-onboarding.md)。不调用旧 `repository archive-bind/check` 或 Candidate 接口。

- 确认远端项目和当前 Git 身份；不要把部署 token 或其他凭据写入任务正文。
- 若项目配置 protected tags，确认当前身份能创建 `grounds/deliveries/*` 标签。由管理员按项目策略操作，不自动提权或更改保护规则。
- `work deliver` 必须实际推送并读回确切 commit；无法访问远端就是未知/不可用，不等同于标签不存在。
- 不覆盖已有不同内容的归档标签。历史回执与当前远端可取回性分开，不能将归档成功解释为验收通过或 MR 已合并。

服务端保护策略不作为 D147 新归档协议的强制前提。需要实际 MR 操作时使用宿主 GitLab 工具并取得相应授权。
