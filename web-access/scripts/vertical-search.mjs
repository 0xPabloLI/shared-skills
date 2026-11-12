#!/usr/bin/env node
/**
 * vertical-search.mjs — 免 key 垂直一手源（广度层）
 *
 * 为什么需要它：通用 web 引擎之间高度重合（本机实测 Serper×Jina 重合 100%、
 * Google×Serper 73/33/54%、SearXNG 的 brave 与 pool 的 brave 82/43/82%），
 * 多打几个引擎买的是排序不是新内容。真正带来正交信源的是通用索引覆盖不到的
 * 一手/结构化层：论文预印本、代码、问答、百科与实体。它们还自带
 * publishedAt / 作者 / 引用数，直接可用于研究的 Tier 1 判据。
 *
 * 与 search-pool 的分工：本文件**不做**通用 web 引擎，也不与 pool 互相
 * fallback（#284 单向阶梯：降级链的单一来源是 web-access 工具选择表）。
 * 两者是并列的两档，由调用方按问题类型选。
 *
 * 可用性均在 2026-09-30 于本机实测；Semantic Scholar 未列入（免 key 时 429 限流），
 * SEC EDGAR 未列入（browse-edgar 的 output=json 已废，返回 HTML）。
 *
 * 身份（#468）：UA 是中立产品标识；OpenAlex 在设了 SEARCH_CONTACT_EMAIL 时附带
 * `mailto`（没设也照常工作，只是不进 polite pool）；GitHub 有 GITHUB_TOKEN/GH_TOKEN
 * 就带 Bearer，没有则按匿名 10 req/min 串行并显式告警。
 * 输出里的 `warnings` 让「某个源这次没到」不再只活在 attempts 里。
 *
 * 用法:
 *   node vertical-search.mjs "<query>" [--sources openalex,arxiv,hn,stackoverflow,wikipedia,github]
 *                                      [--lang zh]
 *                                      [--max-results N] [--doctor] [--list]
 * 输出 stdout 纯 JSON（与 search-pool CLI 同形状，便于同一套解析）：
 *   { articles:[{title,url,snippet,publishedAt,source}], sources, attempts, warnings, engine:"vertical" }
 * 退出码：0 = 有结果或全部失败（失败原因在 attempts/warnings）；2 = 用法错误。
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "web-access-vertical/1.0 (+https://github.com/0xPabloLI/shared-skills)";
const TIMEOUT_MS = 20000;
const DEFAULT_LIMIT = 5;
const RETRY_WAIT_MS = 6000;
const MAX_RETRY_WAIT_MS = 10000;
const GITHUB_ANON_INTERVAL_MS = 6000;

// 跟踪参数不参与去重身份：同一个页面加不加 utm_* 是同一条结果。
const TRACKING_PARAM_RE = /^(utm_.+|fbclid|gclid|mc_cid|mc_eid|igshid|ref|ref_src|source)$/i;

const normUrl = (u) => {
  try {
    const x = new URL(u);
    // 只丢 x.search 会把 ID 放在 query 里的源（wikipedia ?curid=、HN ?id=）
    // 全部塌成一条（#468）。保留 query，剔除跟踪参数并排序，使参数顺序无关。
    const params = [...x.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM_RE.test(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
    return (
      x.hostname.replace(/^(www|m)\./, "") +
      x.pathname.replace(/\/+$/, "") +
      query
    ).toLowerCase();
  } catch {
    return String(u || "").toLowerCase();
  }
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 联系邮箱只用于 provider 的礼貌池参数；缺失或形状不对就当没设。 */
function contactEmail() {
  const v = String(process.env.SEARCH_CONTACT_EMAIL || "").trim();
  return EMAIL_RE.test(v) ? v : "";
}

function githubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
}

// --lang 会被拼进 URL 的 host，所以只接受语言标签形状；否则 `--lang evil.com/x?`
// 就能把请求打到别的主机上。
const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
function wikiHost(lang) {
  const l = String(lang || "").trim();
  // 端点只挂在 <lang>.wikipedia.org 上，默认 en；非语言标签形状的值不采信。
  return `${LANG_RE.test(l) ? l.toLowerCase() : "en"}.wikipedia.org`;
}

function item(title, url, snippet, publishedAt, source) {
  return {
    title: String(title || "").trim(),
    url,
    snippet: String(snippet || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240),
    publishedAt: publishedAt || null,
    source,
  };
}

class HttpError extends Error {
  constructor(status, retryAfterMs) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retry-After 两种写法都认：秒数或 HTTP 日期。 */
function parseRetryAfter(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

async function request(url, headers) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json", ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // fetch 只抛 "fetch failed"，真正的原因（DNS/连接/TLS）在 cause.code 里。
    // 把它带到 message 之外，错误分类才分得清「源坏了」和「这台机器到不了」。
    const code = error?.cause?.code || error?.code || "";
    const wrapped = new Error(error?.message || "fetch failed", { cause: error });
    wrapped.name = error?.name === "TimeoutError" ? "TimeoutError" : "NetworkError";
    wrapped.code = code;
    throw wrapped;
  }
  if (!res.ok) throw new HttpError(res.status, parseRetryAfter(res.headers));
  return res;
}

const getJson = async (url, headers) => (await request(url, headers)).json();
const getText = async (url, headers) => (await request(url, headers)).text();

const CONNECT_HINT = "连不上（出网路由/代理），不是死源";

/** 把失败翻成「哪一类」，调用方才能决定是重试、补身份还是配代理。 */
function describeError(error) {
  if (error instanceof HttpError) {
    const { status, retryAfterMs } = error;
    if (status === 429)
      return {
        kind: "rate-limit",
        hint: "provider 限流；稍后重试，或补身份（SEARCH_CONTACT_EMAIL / GITHUB_TOKEN）",
        retryAfterMs,
        retryable: true,
      };
    if (status === 401 || status === 403)
      return {
        kind: "auth",
        hint: "权限/配额：设 GITHUB_TOKEN 或换更小范围",
        retryAfterMs,
        // GitHub 的 secondary limit 也是 403，带 Retry-After 才值得再试一次。
        retryable: retryAfterMs != null,
      };
    if (status >= 400 && status < 500) return { kind: "request", hint: "请求被拒（参数/校验）" };
    return { kind: "http", hint: "provider 端错误，稍后再试" };
  }
  if (error?.name === "TimeoutError")
    return { kind: "timeout", hint: `超过 ${TIMEOUT_MS / 1000}s 未响应` };
  if (error?.code || /fetch failed/i.test(error?.message || ""))
    return { kind: "connect", hint: CONNECT_HINT };
  return { kind: "unknown", hint: "" };
}

export const SOURCES = {
  openalex: {
    kind: "学术",
    build: (q, n) => {
      const mailto = contactEmail();
      return (
        `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${n}` +
        "&select=id,display_name,doi,publication_date,cited_by_count,primary_location" +
        (mailto ? `&mailto=${encodeURIComponent(mailto)}` : "")
      );
    },
    parse: (j, name) =>
      (j.results || []).map((w) =>
        item(
          w.display_name,
          w.doi || `https://openalex.org/${String(w.id).split("/").pop()}`,
          null,
          w.publication_date,
          name,
        ),
      ),
  },
  arxiv: {
    kind: "预印本",
    build: (q, n) =>
      `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=${n}`,
    // Atom 是 XML 而非 JSON，因此单独取文本
    accept: "application/atom+xml",
    parseXml: (xml, name) =>
      (xml.match(/<entry>[\s\S]*?<\/entry>/g) || []).map((e) => {
        const g = (re) => (e.match(re) || [])[1]?.trim() || "";
        return item(
          g(/<title>([^<]*)/),
          g(/<id>([^<]*)/),
          g(/<summary>([^<]*)/),
          g(/<published>(\d{4}-\d{2}-\d{2})/),
          name,
        );
      }),
    kindNote: "免 key；12s 级延迟，别当快档用",
  },
  hn: {
    kind: "社区",
    build: (q, n) =>
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&hitsPerPage=${n}`,
    parse: (j, name) =>
      (j.hits || [])
        .filter((h) => h.title)
        .map((h) =>
          item(
            h.title,
            h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
            h.story_text || null,
            h.created_at?.slice(0, 10),
            name,
          ),
        ),
  },
  stackoverflow: {
    kind: "问答",
    build: (q, n) =>
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(q)}&site=stackoverflow&pagesize=${n}&filter=!nNPvSNdWme`,
    parse: (j, name) =>
      (j.items || []).map((it) =>
        item(
          it.title,
          it.link,
          it.body?.slice(0, 200),
          new Date((it.creation_date || 0) * 1000).toISOString().slice(0, 10),
          name,
        ),
      ),
  },
  wikipedia: {
    kind: "百科",
    // --lang zh 走 zh.wikipedia；非语言标签形状的值一律忽略（见 wikiHost）
    build: (q, n, opts) =>
      `https://${wikiHost(opts?.lang)}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=${n}&format=json`,
    parse: (j, name, opts) =>
      (j.query?.search || []).map((s) =>
        item(
          s.title,
          `https://${wikiHost(opts?.lang)}/?curid=${s.pageid}`,
          s.snippet,
          s.timestamp?.slice(0, 10),
          name,
        ),
      ),
  },
  github: {
    kind: "代码",
    build: (q, n) =>
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=${n}`,
    // 匿名 10 req/min；有 token 就带上，把配额抬到 token 的额度。
    headers: () => (githubToken() ? { authorization: `Bearer ${githubToken()}` } : {}),
    parse: (j, name) =>
      (j.items || []).map((r) =>
        item(
          r.full_name,
          r.html_url,
          // updated_at 是推送/星标/编辑时间，不是发布日期；冒充 publishedAt 会
          // 让陈旧仓库看起来是刚发布的。降级成 snippet 里的一行事实。
          [r.description, r.updated_at ? `仓库更新于 ${r.updated_at.slice(0, 10)}` : ""]
            .filter(Boolean)
            .join(" · "),
          null,
          name,
        ),
      ),
    kindNote: "免 key 限 10 req/min；设 GITHUB_TOKEN 可抬高配额，扇出时别连打",
  },
};

export const DEFAULT_SOURCES = ["openalex", "arxiv", "hn", "stackoverflow", "wikipedia", "github"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 匿名 GitHub 是 10 req/min。第一次调用不等待，之后按 6s 间隔串行，
// 否则一次扇出就会把这一源打成 403/422。
let lastGithubAt = 0;
async function throttle(name, wait) {
  if (name !== "github" || githubToken()) return;
  const gap = GITHUB_ANON_INTERVAL_MS - (Date.now() - lastGithubAt);
  if (lastGithubAt && gap > 0) await wait(gap);
  lastGithubAt = Date.now();
}

/** 单源查询。任何失败都只记进 attempts，不抛。 */
export async function searchOne(name, query, limit, opts = {}) {
  const src = SOURCES[name];
  if (!src) return { articles: [], error: `unknown source ${name}` };
  const wait = opts.sleep || sleep;
  await throttle(name, wait);

  const once = async () => {
    const url = src.build(query, limit, opts);
    const headers = { ...(src.accept ? { accept: src.accept } : {}), ...(src.headers?.() || {}) };
    if (src.parseXml) return src.parseXml(await getText(url, headers), name, opts);
    return src.parse(await getJson(url, headers), name, opts);
  };

  try {
    try {
      return { articles: await once() };
    } catch (error) {
      const info = describeError(error);
      if (!info.retryable) throw error;
      // 有界退避：只重试一次，等待不超过预算，绝不硬睡 provider 的整个窗口。
      await wait(Math.min(info.retryAfterMs ?? RETRY_WAIT_MS, MAX_RETRY_WAIT_MS));
      return { articles: await once() };
    }
  } catch (error) {
    const info = describeError(error);
    return {
      articles: [],
      error: error.name === "TimeoutError" ? "timeout" : String(error.message).slice(0, 120),
      kind: info.kind,
      hint: info.hint,
    };
  }
}

/**
 * 合并各源结果：按归一化 URL 去重（先到先得，顺序即 --sources 顺序），每源条数与
 * 失败原因分开记。与网络无关，因此可单测。
 * @param {string[]} picked 参与源（决定优先级）
 * @param {{articles:any[], error?:string, kind?:string, hint?:string}[]} results 与 picked 同序
 */
export function merge(picked, results, query) {
  const articles = [];
  const attempts = [];
  const warnings = [];
  const seen = new Set();
  const bySource = {};
  results.forEach((r, i) => {
    const name = picked[i];
    const list = Array.isArray(r.articles) ? r.articles : [];
    bySource[name] = list.length;
    if (r.error) {
      const attempt = { source: name, ok: false, error: r.error };
      if (r.kind) attempt.kind = r.kind;
      if (r.hint) attempt.hint = r.hint;
      attempts.push(attempt);
      // attempts 只有读了才知道；warnings 是给不读 attempts 的调用方的第二通道。
      warnings.push(`${name}: ${r.kind || "failed"} — ${r.hint || r.error}`);
    }
    for (const a of list) {
      const k = normUrl(a.url);
      if (seen.has(k)) continue;
      seen.add(k);
      articles.push(a);
    }
  });
  return { articles, engine: "vertical", sources: bySource, attempts, warnings, query };
}

/** 并行扇出 + 合并。 */
export async function fanout({
  query,
  sources = DEFAULT_SOURCES,
  maxResults = DEFAULT_LIMIT,
  lang = "",
  sleep: wait,
}) {
  const opts = { lang, sleep: wait };
  const picked = sources.filter((s) => Object.prototype.hasOwnProperty.call(SOURCES, s));
  const results = await Promise.all(picked.map((s) => searchOne(s, query, maxResults, opts)));
  const merged = merge(picked, results, query);
  if (picked.includes("github") && !githubToken()) {
    merged.warnings.push(
      "github: 未设 GITHUB_TOKEN/GH_TOKEN — 匿名 10 req/min，已按 6s 间隔串行；连续调研请补 token",
    );
  }
  return merged;
}

/** SEARCH_POOL_CLI=<repo>/scripts/short-video/lib/search-pool.mjs → repo root */
function repoRootFromCli() {
  const cli = process.env.SEARCH_POOL_CLI;
  return cli ? join(dirname(cli), "..", "..", "..") : "";
}

/**
 * 入口负责加载配置，库函数不自载 env（与 #287 同一口径）。先 repo 的 .env.local，
 * 再 skill 自己的 config.env；process.loadEnvFile 不覆盖已存在的变量。
 */
function loadEnvFiles() {
  const repo = process.env.INSIDE_CHINA_AI_REPO || repoRootFromCli();
  const files = [repo ? join(repo, ".env.local") : "", join(SKILL_ROOT, "config.env")].filter(
    Boolean,
  );
  for (const file of files) {
    try {
      process.loadEnvFile(file);
    } catch (error) {
      if (error?.code !== "ENOENT")
        process.stderr.write(`warn: loadEnvFile(${file}) failed: ${error?.message ?? error}\n`);
    }
  }
}

/** 可用性自检：只报「能不能用/缺什么」，永不回显任何密钥值。 */
export async function doctor() {
  const probed = await Promise.all(
    Object.keys(SOURCES).map(async (name) => {
      const r = await searchOne(name, "test", 1);
      const reachable = !r.error;
      return {
        source: name,
        kind: SOURCES[name].kind,
        // 可达但 0 结果不是「不可用」——旧实现把这两种混成了一句。
        ok: reachable,
        empty: reachable && r.articles.length === 0,
        note: !reachable
          ? `${r.kind || "failed"}: ${r.hint || r.error}`
          : r.articles.length === 0
            ? "可达但 0 结果"
            : SOURCES[name].kindNote || "",
      };
    }),
  );
  const repoDir = process.env.INSIDE_CHINA_AI_REPO || "";
  const repoScript = repoDir ? join(repoDir, "scripts/short-video/lib/search-pool.mjs") : "";
  const adapters = [
    {
      name: "SEARCH_POOL_CLI",
      present: !!process.env.SEARCH_POOL_CLI && existsSync(process.env.SEARCH_POOL_CLI),
      note: process.env.SEARCH_POOL_CLI ? "" : "未设置",
    },
    {
      name: "INSIDE_CHINA_AI_REPO",
      // 只看环境变量会让写错的路径也报 present；探一下脚本是否真的在。
      present: !!repoScript && existsSync(repoScript),
      note: !repoDir
        ? "未设置"
        : existsSync(repoScript)
          ? ""
          : `路径下没有 scripts/short-video/lib/search-pool.mjs`,
    },
  ];
  const identities = [
    { name: "SEARCH_CONTACT_EMAIL", present: !!contactEmail() },
    { name: "GITHUB_TOKEN", present: !!githubToken() },
  ];
  const keys = ["SERPER_API_KEY", "BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "JINA_API_KEY"].map(
    (k) => ({ name: k, present: !!process.env[k] }),
  );
  // 探聚合端点会把「慢」读成「不可达」（本机聚合一次 15-20s，见 tools-catalog
  // SearXNG 段），所以只钉一个引擎探：单引擎实测 1-2s。
  let searxng = false;
  try {
    searxng = (
      await fetch("http://localhost:8888/search?q=probe&format=json&engines=brave", {
        signal: AbortSignal.timeout(12000),
      })
    ).ok;
  } catch {
    searxng = false;
  }
  return {
    vertical: probed,
    webAdapters: adapters,
    identities,
    poolKeys: keys,
    searxngLocal: searxng,
  };
}

function main(argv) {
  loadEnvFiles(); // 入口自载；--list 也读 config.env（只为一致性，不触发网络）

  const get = (flag) => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 ? argv[i + 1] : null;
  };

  if (argv.includes("--list")) {
    process.stdout.write(
      Object.entries(SOURCES)
        .map(([k, v]) => `${k}\t${v.kind}\t${v.kindNote || ""}`)
        .join("\n") + "\n",
    );
    return Promise.resolve(0);
  }

  // --doctor 不需要查询词，必须排在用法校验之前
  if (argv.includes("--doctor")) {
    return doctor().then((d) => {
      const usable = d.vertical.filter((v) => v.ok).map((v) => v.source);
      const down = d.vertical.filter((v) => !v.ok);
      // stdout 只放 JSON，人类摘要走 stderr —— 与 pool CLI 同一条契约。否则
      // `--doctor | jq` 会在 JSON 之后撞上摘要而解析失败。
      process.stdout.write(JSON.stringify({ ...d, usable }, null, 2) + "\n");
      process.stderr.write(
        "免 key 可用: " +
          (usable.join(", ") || "无") +
          // 缺席要带原因：只报「少了谁」会把「限流」「要代理」「选择器坏」混成一句话
          "\n免 key 不可用: " +
          (down.map((v) => `${v.source}(${v.note || "?"})`).join(", ") || "无") +
          "\n付费 web 适配器: " +
          (d.webAdapters.some((a) => a.present) ? "已注入" : "未注入（设 SEARCH_POOL_CLI）") +
          "\n本地 SearXNG: " +
          (d.searxngLocal ? "可达" : "不可达") +
          "\n身份（只列有无）: " +
          d.identities.map((i) => `${i.name}=${i.present ? "有" : "无"}`).join(", ") +
          "\n缺失的 key（只列名，不列值）: " +
          (d.poolKeys
            .filter((k) => !k.present)
            .map((k) => k.name)
            .join(", ") || "无") +
          "\n",
      );
      return 0;
    });
  }

  const query = argv[0];
  if (!query || query.startsWith("--")) {
    console.error(
      '用法: node vertical-search.mjs "<query>" [--sources a,b] [--max-results N] [--lang zh] [--doctor|--list]',
    );
    return Promise.resolve(2);
  }

  const sourcesArg = get("sources");
  const sources = (sourcesArg ? sourcesArg.split(",") : DEFAULT_SOURCES)
    .map((s) => s.trim())
    .filter(Boolean);
  const maxResults = Number(get("max-results")) || DEFAULT_LIMIT;

  return fanout({ query, sources, maxResults, lang: get("lang") || "" }).then((r) => {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return 0;
  });
}

// 同 cached-search：skill 经 ~/.agents/skills 软链执行，Node 会先把软链解析成
// 真实路径，用裸 argv 比对 import.meta.url 会让 main 静默不跑、stdout 为空。
const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedAsScript) main(process.argv.slice(2)).then((code) => process.exit(code));
