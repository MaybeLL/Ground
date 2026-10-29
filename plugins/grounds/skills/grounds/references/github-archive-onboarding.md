# GitHub 项目归档接入

先按[共享准备协议](../../../references/preparation.md)核对 CLI、配置、账本与当前 Agent 身份。所有命令通过同一 helper 的 `invoke --cwd CLONE -- ...` 调用。只操作用户明确选择的注册 Repository。GitHub.com canonical remote 自动选择 GitHub 适配器，不需要 GitLab 账号、实例或 runner。GitHub Enterprise 暂不支持此原生适配，不根据自定义域名猜测兼容性。

## 检查、配置与绑定

```text
repository archive-show --repository REPOSITORY_ID
repository archive-check --repository REPOSITORY_ID
repository archive-guide --repository REPOSITORY_ID
repository archive-template --repository REPOSITORY_ID
```

`archive-show` 只读取已有绑定，授权仍为 unknown。`archive-check` 读取当前 GitHub 用户、实际 repository 身份/权限和全部适用 rulesets（包含继承规则及详情）。API 403、凭据失效、未知响应、复杂规则或无法证明的权限都不表示就绪。只认实际报告，不用此前 push 成功、用户名、仓库同名或管理员身份替代检查。

在 GitHub 的仓库 Settings → Rules → Rulesets 中，由获授权的管理员配置 active 的 tag ruleset：

- include 覆盖 `refs/tags/grounds/candidates/*` 和 `refs/tags/grounds/deliveries/*`；界面若只要求 tag pattern，输入对应的 `grounds/candidates/*` 和 `grounds/deliveries/*`。
- exclude 为空，bypass actors 为空。
- 启用限制更新（update）和限制删除（deletion）。
- 不限制创建（creation），使有仓库写权限的当前用户可创建新归档标签。

规则适用于两个完整命名空间，包括维护者；不存在维护者静默覆盖/删除的例外。Grounds 只返回配置预览，不写 GitHub rulesets、角色或 ACL。不为通过检查而自动放宽已有更严格规则。当前适配器对无法证明的模式、自定义条件、创建限制、未知参数或 active push 规则保持 unknown；需要管理员核查或显式采用下述运维核验协议。

私有仓库的 rulesets 能力取决于 GitHub 计划和实际 API 可用性。返回 403 时按诊断处理；不要把仓库改成公开或升级付费计划视为已获授权的自动恢复动作。

确认绑定的是用户选择的项目后，用当前 `binding_version`（首次为 0）和稳定 Agent 身份执行：

```text
repository archive-bind --repository REPOSITORY_ID --expected-version 0
repository archive-check --repository REPOSITORY_ID
```

绑定记录实例、GitHub repository ID、路径、canonical remote 和命名空间，不保存凭据或长期授权。绑定不等于规则已生效；必须以重新读取后的 `ready` 状态为准。项目转移、删除重建或 canonical remote 改变时重新核对身份并显式重绑。多项目命令可重复 `--repository`，每个项目独立检查，不将一个项目的成功推广到其他项目。

## 身份与凭据

通过当前 OS 用户的 `gh auth login --hostname github.com` 登录，或显式设置私有环境变量 `GROUNDS_GITHUB_TOKEN`。token 需要读取当前用户、目标仓库权限和 rulesets 详情；细粒度令牌按 GitHub 对这些端点的实际权限要求配置，不能只依据仓库写权限猜测 API 可读。Git 传输继续使用原有 Git/SSH 凭据；API 认证成功不替代 push 授权。

归档 Git 子进程会清除 `GIT_*` 环境覆盖并禁用全局 Git 配置，所以单独执行 `gh auth setup-git` 写入的全局 helper、或临时 `GIT_ASKPASS`，不足以保证 HTTPS 归档 push 可认证。优先使用已配置 SSH 密钥/agent 的 GitHub SSH remote；切换注册仓库的 canonical remote 时按仓库身份迁移协议操作，不能只改本地 remote 后沿用旧绑定。

保留 HTTPS remote 时，可在自己的目标 clone 配置仓库级 helper（只写本地 `.git/config`，不写源码或共享配置）：

```sh
gh auth login --hostname github.com
git config --local credential.https://github.com.helper '!gh auth git-credential'
```

`gh` 必须在执行 Grounds 的 `PATH` 中。Git 子进程保留 OS 用户的 `HOME`、`GH_CONFIG_DIR` 及非 `GIT_*` 环境变量，因此该 helper 可使用同一用户已保存的 gh 登录；显式私有 `GH_TOKEN`/`GITHUB_TOKEN` 也会按 gh 规则覆盖其 Git 传输身份。它不会自动读取 `GROUNDS_GITHUB_TOKEN`：该变量只供 Grounds 的 API 适配器使用。核对 API 用户与 Git 传输身份均获目标仓库授权，不将 token 写入 helper 命令、remote URL 或仓库文件。仓库级 helper 可供同一 clone 的 managed worktree 使用；私有仓库的隔离恢复读取还需要可独立使用的传输认证，推荐 SSH。

适配器只访问 `https://api.github.com`，不会跟随凭据到远端指定的其他主机。它不使用普通 `GH_TOKEN` 或 `GITHUB_TOKEN` 环境变量代替显式 Grounds token；CI 使用时必须显式配置适用身份及 `GROUNDS_GITHUB_TOKEN`，不把任意工作流的默认 token 当成人类身份。凭据不写进共享配置、账本、示例或日志。

## 日常归档与恢复

已绑定项目的 `candidate submit`、`candidate archive`、`integration landing` 在归档前后重新核验当前用户和两个命名空间。归档还需既有远端写入授权，并核对 source、parents、tree、base、ref 和完整历史。保护检查 ready 不表示候选已经验证、归档、采用或发布。

遇到失败先恢复权限或配置，再显式 `archive-check`，按[候选归档协议](candidate-archive.md)恢复同一 operation ID 和固定输入。归档失败不撤销已记录的采用事实；幂等历史回执不是新的权限检查。

显式 `--archive-policy FILE` 或 `GROUNDS_ARCHIVE_POLICY` 是兼容运维核验路径，必须有匹配仓库、remote、完整命名空间、有效期和可复核来源的真实证据。实时 API 失败不自动回退；不要伪造策略或把保存的 platform-api 回执当成新鲜授权。
