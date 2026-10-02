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
 * 用法:
 *   node vertical-search.mjs "<query>" [--sources openalex,arxiv,hn,stackoverflow,wikipedia,github]
 *                                      [--lang zh]
 *                                      [--max-results N] [--doctor] [--list]
 * 输出 stdout 纯 JSON（与 search-pool CLI 同形状，便于同一套解析）：
 *   { articles:[{title,url,snippet,publishedAt,source}], sources, attempts, engine:"vertical" }
 * 退出码：0 = 有结果或全部失败（失败原因在 attempts）；2 = 用法错误。
 */
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UA = "inside-china-ai-research/1.0 (vertical search adapter)";
const TIMEOUT_MS = 20000;
const DEFAULT_LIMIT = 5;

const normUrl = (u) => {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^(www|m)\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return String(u || "").toLowerCase();
  }
};

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

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const SOURCES = {
  openalex: {
    kind: "学术",
    build: (q, n) =>
      `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${n}&select=id,display_name,doi,publication_date,cited_by_count,primary_location`,
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
      `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=${n}`,
    // Atom 是 XML 而非 JSON，因此单独取文本
    raw: async (q, n, opts) => {
      const res = await fetch(SOURCES.arxiv.build(q, n, opts), {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
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
    parse: (j, name) =>
      (j.items || []).map((r) =>
        item(r.full_name, r.html_url, r.description, r.updated_at?.slice(0, 10), name),
      ),
    kindNote: "免 key 限 10 req/min，扇出时别连打",
  },
};

export const DEFAULT_SOURCES = ["openalex", "arxiv", "hn", "stackoverflow", "wikipedia", "github"];

/** 单源查询。任何失败都只记进 attempts，不抛。 */
async function searchOne(name, query, limit, opts = {}) {
  const src = SOURCES[name];
  if (!src) return { articles: [], error: `unknown source ${name}` };
  try {
    if (src.parseXml) return { articles: src.parseXml(await src.raw(query, limit, opts), name) };
    return { articles: src.parse(await getJson(src.build(query, limit, opts)), name, opts) };
  } catch (error) {
    return {
      articles: [],
      error: error.name === "TimeoutError" ? "timeout" : String(error.message).slice(0, 120),
    };
  }
}

/**
 * 合并各源结果：按归一化 URL 去重（先到先得，顺序即 --sources 顺序），每源条数与
 * 失败原因分开记。与网络无关，因此可单测。
 * @param {string[]} picked 参与源（决定优先级）
 * @param {{articles:any[], error?:string}[]} results 与 picked 同序
 */
export function merge(picked, results, query) {
  const articles = [];
  const attempts = [];
  const seen = new Set();
  const bySource = {};
  results.forEach((r, i) => {
    const name = picked[i];
    const list = Array.isArray(r.articles) ? r.articles : [];
    bySource[name] = list.length;
    if (r.error) attempts.push({ source: name, ok: false, error: r.error });
    for (const a of list) {
      const k = normUrl(a.url);
      if (seen.has(k)) continue;
      seen.add(k);
      articles.push(a);
    }
  });
  return { articles, engine: "vertical", sources: bySource, attempts, query };
}

/** 并行扇出 + 合并。 */
export async function fanout({
  query,
  sources = DEFAULT_SOURCES,
  maxResults = DEFAULT_LIMIT,
  lang = "",
}) {
  const opts = { lang };
  const picked = sources.filter((s) => Object.prototype.hasOwnProperty.call(SOURCES, s));
  const results = await Promise.all(picked.map((s) => searchOne(s, query, maxResults, opts)));
  return merge(picked, results, query);
}

/** 可用性自检：只报「能不能用/缺什么」，永不回显任何密钥值。 */
export async function doctor() {
  const probed = await Promise.all(
    Object.keys(SOURCES).map(async (name) => {
      const r = await searchOne(name, "test", 1);
      return {
        source: name,
        kind: SOURCES[name].kind,
        ok: r.articles.length > 0,
        note: r.error || SOURCES[name].kindNote || "",
      };
    }),
  );
  const adapters = [
    {
      name: "SEARCH_POOL_CLI",
      present: !!process.env.SEARCH_POOL_CLI && existsSync(process.env.SEARCH_POOL_CLI || ""),
    },
    { name: "INSIDE_CHINA_AI_REPO", present: !!process.env.INSIDE_CHINA_AI_REPO },
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
  return { vertical: probed, webAdapters: adapters, poolKeys: keys, searxngLocal: searxng };
}

function main(argv) {
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
