# shared-skills

三个联网类 Agent Skill 的单一来源，以 git submodule 形式分发给使用它们的仓。

| Skill | 一句话 | 入口 |
| --- | --- | --- |
| `web-access` | 驱动本机 Chrome/Edge 的真实浏览器联网：动态渲染页、登录态站点、截图与 DOM 取证 | [`web-access/SKILL.md`](web-access/SKILL.md) |
| `web-deep-research` | 8 阶段深度研究流程，多角度切分、引用可回溯 | [`web-deep-research/SKILL.md`](web-deep-research/SKILL.md) |
| `search-pool` | 多引擎 REST 搜索（fallback 链 + 跨索引族扇出）、本地聚合 SearXNG、免 key 垂直一手源 | [`search-pool/SKILL.md`](search-pool/SKILL.md) |

## 怎么被使用

引用方仓把本仓挂在 `skills/shared`，再用软链把各 skill 目录暴露到自己的 skill 搜索路径：

```
skills/shared            ← 本仓（submodule）
skills/web-access        → skills/shared/web-access
skills/search-pool       → skills/shared/search-pool
skills/web-deep-research → skills/shared/web-deep-research
```

需要独立演化时就逐组件拷贝，**不要整目录覆盖**——接收端的本地改编不回写本仓，本仓也不替它保留分支式的差异。

## config.env 是随行文件

`web-access/config.env`（浏览器偏好、宿主工具映射）属于**用户本地偏好**：拷贝对应 skill 到任何仓时一并带走，各处允许按本机环境各自演化。密钥不在这里，也不在本仓任何文件里。

## 本仓不装什么

- **仓专属内容**：品牌资产、项目管线、领域文档留在各自仓的 `docs/`。本仓只收换一个仓也成立的通用骨架。
- **凭据与搜索后端**：Search Pool CLI 与它的 key 住在**底本仓 checkout** 里。从别处调用时注入 CLI 位置：

  ```bash
  export SEARCH_POOL_CLI=/path/to/<底本仓>/scripts/short-video/lib/search-pool.mjs
  ```

  `INSIDE_CHINA_AI_REPO` 是历史注入点，仅为兼容既有本机配置而保留。两者都是可选的：都没有时 `cached-search` 返回 `{engine: null, attempts:[…no_adapter…]}` 并以 0 退出，由调用方决定下一档，不会把调用方炸停。key 缺失同样不是错误——`attempts` 里逐条写明 `missing <X>_API_KEY`。

## 站点模式住哪儿

`web-access/references/site-patterns/<domain>.md`，一个域名一条文件，frontmatter 的 `updated:` 就是这批 DOM 判据的**实测日期**。第三方站点改版导致选择器或判据失效时，改这里，不改 `SKILL.md`。
