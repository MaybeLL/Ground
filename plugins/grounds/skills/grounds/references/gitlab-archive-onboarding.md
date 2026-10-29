# GitLab 项目归档接入

先按[共享准备协议](../../../references/preparation.md)核对 CLI、配置、账本与当前 Agent 身份。所有命令通过同一 helper 的 `invoke --cwd CLONE -- ...` 调用。只操作用户明确选择的注册 Repository，不根据项目同名、当前 checkout 或历史 push 成功猜权限。

## 首次检查与管理员引导

```text
repository archive-show --repository REPOSITORY_ID
repository archive-check --repository REPOSITORY_ID [--instance https://gitlab.example.com]
repository archive-guide --repository REPOSITORY_ID [--instance https://gitlab.example.com]
```

`archive-show` 只读取共享绑定，授权保持 unknown；`archive-check` 和 `archive-guide` 显式读取所选实例的当前用户、版本、项目和全部保护规则。报告列出项目 ID、路径、canonical remote、检查时间、两个命名空间及当前用户创建权限。无绑定、配置缺失、无创建权限、项目身份变化和未知分别报告。API 失败不等于配置正常。

Grounds 推荐 `grounds/candidates/*` 与 `grounds/deliveries/*` 都允许 Developer 及以上创建。已存在 tag 不允许 Git 覆盖/删除；Maintainer/Owner 仍须在 GitLab 页面/API 通过原权限和确认路径显式删除。Grounds 不实现保护规则或成员角色的写接口，也不执行建议预览中的 POST 请求。管理员到所选项目的 Settings → Repository → Protected tags 核对已有规则后设置；更严格/自定义规则保留，不为使检查通过而自动放宽。

用户明确确认项目绑定后，使用当前 `binding_version`（初次为 0）和稳定 Agent 身份：

```text
repository archive-bind --repository REPOSITORY_ID --instance https://gitlab.example.com --expected-version 0
repository archive-check --repository REPOSITORY_ID
```

绑定只保存实例、项目 ID/路径、remote 和命名空间，不保存 token、认证文件或机器路径。可先绑定已发现但尚缺保护的项目；只有管理员操作后重新读取有效规则，且当前用户实际获准创建，检查才 ready。项目转移、重建、remote 或实例改变时，重新核对后显式按当前版本绑定，不能沿用旧身份。

## 多项目与认证

对检查、引导和模板命令重复 `--repository`，最多 50 个不同的明确注册 ID：

```text
repository archive-check --repository PROJECT_A_REPOSITORY --repository PROJECT_B_REPOSITORY
repository archive-guide --repository PROJECT_A_REPOSITORY --repository PROJECT_B_REPOSITORY
repository archive-template --repository PROJECT_A_REPOSITORY --repository PROJECT_B_REPOSITORY
```

每个项目单独解析其绑定/实例、认证和结果。失败项目保留诊断，汇总不复制成功状态、不扩大选择范围。模板含两个模式、默认创建角色及管理员预期效果，不包含私有凭据或作者临时文件。

认证由当前 OS 用户的 Git credential helper 或按主机选择的 `glab auth token` 提供；读取失败不输出 helper 内容。可显式用私有环境变量 `GROUNDS_GITLAB_TOKEN`，同时必须设置精确匹配的 `GROUNDS_GITLAB_INSTANCE`。环境实例不匹配、凭据失效时停止，不转用另一用户/实例的登录。普通 `GITLAB_TOKEN` 不作为跨实例回退；GitLab 安装在 URL 子路径时使用显式实例绑定的私有环境变量。认证不通过共享配置传递，Git 传输继续使用操作者原有 Git/SSH 认证。

## 日常归档与恢复

已绑定项目的 `candidate submit`、`candidate archive`、`integration landing` 自动使用项目绑定，并在归档前/后重新读取两个命名空间及当前用户权限；不要求逐次手写 JSON。规则更严格而调用者不能创建时显示实际限制。正式归档仍需既有远端写入授权，仍校验 source、ordered parents、tree、base、ref 和完整远端历史。项目 ready 不是某个工件已经归档、验证通过、实际采用或已发行。

403、网络/认证失败、版本能力未知、规则漂移或缺少任一命名空间时，检查/归档保持准确诊断；修正后先显式 `archive-check`，再按[候选归档协议](candidate-archive.md)恢复原 operation ID 和固定输入。归档失败不撤销已记录的实际采用。已完成操作的幂等回放是历史回执，不是新的权限检查。

显式 `--archive-policy FILE` 或 `GROUNDS_ARCHIVE_POLICY` 继续优先使用旧运维核验路径，必须匹配仓库/remote/目标命名空间、有效期及可复核原始来源。实时失败不会自动回退到历史文件；保存的 platform-api 回执不能冒充实时适配器。

当前适配器限 GitLab 14.10–18.x 的已识别保护规则 API；版本范围内仍按实际响应能力核对。通配符使用 `*`，全命名空间匹配和权限取并集有界证明，复杂度超限保持未知。显式测试夹具允许回环 HTTP，生产实例要求 HTTPS。真实专用 GitLab 权限验收和备份验证须另行实测；本地兼容夹具不能证明所有 GitLab 版本。

API认证统一使用兼容OAuth/PAT的Bearer头。平台自定义身份授权的`access_level:null`保留其单一用户/组/部署密钥范围，不当作通用角色授权；重绑不消除权限未知，遇到组成员API不可读仍需按返回诊断复查。

项目角色通过当前调用者的`GET /projects/:id/members/all/:user_id`实时读取，纳入继承/邀请共享组的有效成员角色；不以项目响应中的直接成员/所属组字段代替完整权限。身份不匹配、成员API不可读时保持未知，过期或非活动成员不授予角色。保护列表兼容GitLab EE的ADMIN60规则：无关规则不会阻断解析，普通用户也不会因此被授予管理员权限。

`candidate archive --dry-run`缺绑定、认证失败或API拒绝时返回`STATE_CONFLICT`及项目级`protection_diagnosis`，按其中恢复步骤处理后复查；预览不写归档或改候选。GitLab版本可能限制保护API读取，例如14.10需项目管理权限；普通Developer无法读取时仍须显式使用有效运维核验，不将兼容API夹具的成功替代真实权限验收。

规则名中的合法字面字符（例如`]`）不作通配符，也不使无关规则阻断接入。显式组授权按读取的GitLab版本处理：14.10–17.1检查获准组直接成员资格；17.2及以后还要求项目直接邀请该组，邀请上限和组内角色均至少Developer。项目角色仍单独核验，不能用其他来源的较高项目角色补足新版本组限制；版本未知不放行。
