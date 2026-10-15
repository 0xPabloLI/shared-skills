---
domain: github.com
aliases: [GitHub]
updated: 2026-09-30
---

## 平台特征

- `github.com/settings/*` 的账户级敏感页（App 安装详情、branch protection 等）在登录态之外还叠加 **sudo mode**：即使 cookie 已登录，首访会跳 `Confirm access`（title/h1 均为 `Confirm access`，选项为 passkey / GitHub Mobile / 验证器 / 邮件码）。**这步只能人类在浏览器里点**，任何自动化工具都无法代替；用户完成后再刷新同一标签即可继续读取。
- App 安装详情页（`/settings/installations/<id>`）渲染为**内联可编辑表单**（含 radio、Save/Cancel、Danger zone）。因此页面上同时存在 "All repositories" 与 "Only select repositories" **两段标签文字**——它们是 radio 的 label，不代表当前选择。
- 该页没有 "last run / run now" 控件；托管版 Renovate 的运行节奏不在此 UI 暴露。
- 侧栏 widget 会渲染 `Sorry, something went wrong.`（多次）作为占位失败态，与用户要看的资源无关，不是页面级错误。

## 有效模式

- 判断仓库访问范围：读 `input[name=install_target]` 的 **`.checked` 属性**（DOM property，非 attribute），`value="all"` / `value="selected"` 二选一为真。用 label 文字判断必然误判。
- 读取已选仓库清单：`document.body.innerText` 中，从 `"Select at least one repository."` 之后到 `"Save"` 之前的一段即为 chip 列表（形如 `0xPabloLI/aaveapy`）。仓库选择器不是 `input[type=checkbox][name=repository_ids[]]`（查不到元素）。
- App 权限是否齐：该页 `Permissions` 段落直接列全文（`Read and write access to checks, code, commit statuses, issues, pull requests…`），无待批权限时不会出现额外横幅。
- 一次性验证 sudo 是否已过：`/navigate` 同 URL 后读 `document.title`，出现 `Installed GitHub App - <App>` 即已可用。

## 已知陷阱

- 用 label 文字（"All repositories"）判范围 → 误报。实测本例 radio 为 `selected`，7 个仓库。
- `GET /repos/{owner}/{repo}/installations`、`/app/installations`、`/repos/.../collaborators/<bot>[bot]` 用普通 PAT 全部 404；列 App installation 需要 App 管理员身份。**不要试图用 API 替代这条 UI 路径**。
- `github.com/settings/confirmations` 是 **404**（Page not found）：不存在该页；App 的待批权限只以安装详情页横幅形式出现。
- `input.getAttribute("checked") !== null` 与 `.checked` 不等价（GitHub 表单常只有 property 为真）；读 `.checked`。
