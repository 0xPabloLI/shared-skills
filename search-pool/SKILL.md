---
name: search-pool
description: |
  Search Pool CLI（多引擎 fallback REST 搜索：Serper > Brave > Tavily > Jina）、curl SearXNG（本地聚合、无额度广度扫描）与免 key 垂直一手源（arXiv/OpenAlex/HN/StackOverflow/Wikipedia/GitHub，广度正交）的使用说明。
  触发场景：agent 需要搜索主流新闻/论文/深度技术信息（Search Pool CLI），或做无额度顾虑的多引擎聚合扫描（SearXNG），或需要学术/代码/社区/百科一手源与新设备搜索能力自检（vertical-search CLI / --doctor）。
  登录态/反爬站点（微信公众号、知乎、微博、小红书等需要浏览器的内容）不在本 skill 范围——直接用 web-access skill，不经本 skill 中转。
metadata:
  author: inside-china-ai
  version: "1.2.0"
  issue: "#265"
---

# search-pool Skill

本 skill 覆盖三档搜索：**Route A — Search Pool CLI**（质量优先、消耗付费额度）、**Route B — curl SearXNG**（零额度广度扫描）与 **Route C — vertical-search CLI**（免 key 垂直一手源，正交广度）。搜索降级阶梯的单一来源仍是 web-access skill 的工具选择表（#284）——Route C 是并列的源集，不是阶梯上的一档。

判断要点：

- Route A 是 REST API 链（Serper > Brave > Tavily > Jina），结果干净、snippet 截断到 200 字符，消耗付费额度——不要用它做广撒网式扫描。
- Route B 是自托管 metasearch（localhost:8888），零限额、聚合最多 269 个引擎，约 2s 返回；结果是原始 JSON，相关性质量不如 Route A 的商业引擎。
- 登录态/反爬站点：由 web-access skill 的工具表 CDP 行直接承接（其 description 覆盖这些触发词）。
- 平台专有搜索（X/Twitter 等需登录态或专用 API 的源）不在此 skill 范围；见 `docs/tools-catalog.md` 的搜索工具表。arXiv/GitHub 这类免 key 一手源已收进 Route C。

## Route A — Search Pool CLI

质量优先的多源 fallback：Serper > Brave > Tavily > Jina，按序尝试，第一个返回非空结果的引擎胜出。引擎缺 key 或失败（HTTP 429/5xx、0 结果、超时）自动落到下一个。

> Grok bridge（mcp-search-bridge）**不在 pool 链内**——它是 `search-sources.mjs` Layer 3 的独立 spawn 兜底（#265 明确不动该桥）。pool CLI 的 fallback 链只有上述 4 个 API 引擎，`--engine grok` 会报错。

```bash
node scripts/short-video/lib/search-pool.mjs "<query>" [--engine <serper|brave|tavily|jina>] [--max-results <n>]
```

**调用路径**：在本 repo（inside-china-ai）内直接用上面的相对路径。**从别处调用时把 CLI 位置注入 `SEARCH_POOL_CLI`**（通用注入点，`cached-search.mjs` 优先读它）：`export SEARCH_POOL_CLI=/path/to/inside-china-ai/scripts/short-video/lib/search-pool.mjs`。`INSIDE_CHINA_AI_REPO` 是历史注入点，仅为兼容本机既有 shell 配置而保留。**两者都是可选的**：都没有时 `cached-search.mjs` 返回 `{engine: null, attempts:[…no_adapter…]}` 并以 0 退出，由 agent 按 web-access 工具表决定下一档，不会把调用方炸停。CLI 与 key 都在那个 checkout 里，由 CLI 自己 `loadEnv()` 读其仓库根 `.env.local`。

**首次使用自检**：key 从该 checkout 的仓库根 `.env.local` 读取（`.env.example` 底部有占位模板）。key 缺失不是错误——返回 `engine: null` + 空数组，`attempts` 里逐条写明 `missing <X>_API_KEY`，照着补 key 即可。

stdout 是纯 JSON（所有日志走 stderr），直接 `JSON.parse`：

```bash
node scripts/short-video/lib/search-pool.mjs "中国 AI 芯片出口管制" --max-results 5
```

```json
{
  "articles": [{ "title": "...", "url": "https://...", "snippet": "..." }],
  "engine": "serper",
  "attempts": []
}
```

解析要点（agent 侧）：

- `articles[]`：`{title, url, snippet}`；`snippet` 截断到 200 字符。
- `engine`：实际命中的引擎名；`null` 表示全部引擎失败（此时 `articles` 为空数组）。
- `attempts[]`：失败尝试记录（缺 key、HTTP 错误、0 结果、超时等，含原因）——命中首个引擎时为空数组，用于诊断为何降级。
- 退出码：0 = 有结果或空结果（空结果也是合法输出，读 `attempts` 判断原因）；1 = 参数错误/未知引擎/异常。
- `--engine <name>` 只跑指定引擎；`--max-results <n>` 截取前 n 条。

API key 从仓库根 `.env.local` 读取（`SERPER_API_KEY` / `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` / `JINA_API_KEY`），无需注入环境变量。

适用：中文或英文的主流新闻检索、论文发现、技术事实核实。额度敏感——单次查询即可命中时优先 `--max-results` 截取，避免为凑数反复搜索。

**引擎可用性记录（#281，2026-09-14 复测，逐引擎）**：**Serper 可用**（HTTP 200 + organic 命中；修复 `parseArticles` 对 `link`/`snippet` 的映射后链头直击）。**Brave 可用**（Node fetch HTTP 200 + 20 条，fake-ip DNS 下不再 fetch failed）；历史故障特征（2026-08 观察，供复发时对照）：TUN fake-ip 把 `api.search.brave.com` 解析到 198.18.x 且 Node fetch 报 fetch failed——绕行方法：代理规则让该域名走代理（非 DIRECT），或 DoH 解析真实 IP 后 `curl --resolve` 钉住。**Tavily 可用**（#265 smoke 命中、#287 smoke 沿用，本票未重复单测）。**Jina 可用**（pool CLI 命中 HTTP 200 + 9 条，5.7s 偏慢；首轮误判"未配置"系探针 grep 前缀笔误——key 实际一直在 `.env.local`）。

## Route B — curl SearXNG

本地自托管 metasearch，无额度限制，适合广度探索和多角度扫描：

```bash
curl -s 'http://localhost:8888/search?q=<url-encoded-keyword>&format=json'
```

结果在 `.results[]`，每条含 `title` / `url` / `content`（snippet）/ `engine`（来源引擎）。可加 `&language=zh-CN`、`&safesearch=0` 等参数。

运维提示：容器由 colima 托管（Watchtower 24h 自动更新）；若 JSON 返回 403，是 `settings.yml` 的 `search.formats` 被镜像更新回退，需复查配置——详见 `docs/tools-catalog.md` → SearXNG 章节。

适用：关键词发散、竞品/话题面扫描、不需要高质量排序的批量发现。不可用时（容器未启动）降级回 Route A。

## Route C — 免 key 垂直一手源（广度层，不是阶梯的一档）

```bash
node ~/.agents/skills/web-access/scripts/vertical-search.mjs "<query>" [--sources openalex,arxiv,hn,stackoverflow,wikipedia,github] [--max-results N] [--lang zh] [--doctor|--list]
```

为什么要有它：通用 web 引擎之间高度重合（本机 2026-09-30 实测 Serper×Jina 重合 **100%**、Google×Serper 73/33/54%、SearXNG 的 brave 与 pool 的 brave 82/43/82%），多买引擎换的是排序不是新内容。正交信源来自通用索引覆盖不到的一手层——论文预印本、代码仓库、社区问答、百科与实体，且都自带 `publishedAt`，可直接喂研究的 Tier 1 判据。

输出与 Route A 同形状，便于同一套解析：`{articles:[{title,url,snippet,publishedAt,source}], sources:{每源条数}, attempts, engine:"vertical"}`。失败进 `attempts`，不抛、不 exit 非 0。

**它不是降级阶梯的一档**（#284 单向阶梯）：与 Route A/B 并列，由调用方按问题类型选，彼此不互相 fallback。

实测边界（写在这里是为了别把它当保证）：`arxiv` 单源 ~12s，别当快档；`github` 免 key 限 10 req/min，扇出别连打；`semanticscholar` 与 SEC EDGAR **未实现**——前者免 key 时 429 限流，后者 `browse-edgar` 的 `output=json` 已废（返回 HTML）。中文登录态平台（微博/知乎/微信/小红书）不在此路，交 web-access 的 CDP 行。

## 新设备自检（缺什么只报键名，绝不回显值）

```bash
node ~/.agents/skills/web-access/scripts/vertical-search.mjs --doctor
```

一次跑完告诉你四件事：免 key 六源哪几源出数、付费 web 档是否已注入适配器（`SEARCH_POOL_CLI` 或 `INSIDE_CHINA_AI_REPO`）、本地 SearXNG 是否可达、`SERPER/BRAVE/TAVILY/JINA` 四个**变量名**哪些没设。

新设备的 bootstrap 次序因此是明确的，不需要读代码：

1. 免 key 档立即可用 → 什么都不装就能做广度检索（Route C）。
2. 要通用 web 引擎：先有一个提供 `search-pool.mjs` 的 checkout，把路径写进 `SEARCH_POOL_CLI`；再按需申请 key，`export` 到 shell（值由人给，脚本拿不到也不该拿到）。
3. 要零额度聚合广度：起 SearXNG（自托管 metasearch，见 `docs/tools-catalog.md`，本 skill 不假设它存在）。
4. 要登录态平台：走 web-access 的 CDP 档。

缺任何一档都只是少一档能力，`--doctor` 会说出来，不会把调用方炸停。

## 参考

- Pool 设计与引擎链实现：`scripts/short-video/lib/search-pool.mjs`（#65/#226）
- 旧 MCP 常驻消费方式已废弃：`scripts/short-video/lib/search-pool-server.mjs`（#265）
- 工具额度与路由总表：`docs/tools-catalog.md`
