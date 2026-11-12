#!/usr/bin/env node
/**
 * cached-search.mjs — 搜索适配器 + 24h 结果缓存（零仓库依赖）
 *
 * 可移植契约：本脚本不假设任何具体 repo 在这台机器上的位置，也不因为某个
 * 环境变量没设就 exit(1)。适配器按顺序发现、找到就跑、跑空就换下一个；
 * 一个都没有时返回 `{ engine: null, attempts: [...] }` 并以 0 退出——与
 * search-pool CLI 的既有约定一致，让调用方（web-access 工具表）自己决定
 * 下一步，而不是在这里发明第二套降级阶梯（#284 单向阶梯 guard）。
 *
 * 适配器注入点，按优先级：
 *   1. SEARCH_POOL_CLI —— 指向任意一个 search-pool.mjs（任何 repo、任何目录）
 *   2. INSIDE_CHINA_AI_REPO/scripts/short-video/lib/search-pool.mjs —— 历史注入点，
 *      保留是为了不打断已经这样配的机器；本机没有该 checkout 时静默跳过
 *
 * 缓存是额度优化，不是正确性依赖：文件损坏/不可写一律当 miss。
 *
 * 用法: node cached-search.mjs "query" [--max-results N] [--fanout]
 * --fanout = 按索引族扇出（每族一个引擎 + 合并去重；三族**并发**调用，
 *            延迟按最慢一族计而不是三次往返叠加），用于需要独立信源的调研；
 *            默认仍是单档 fallback（省额度，够快）。
 * 环境变量:
 *   SEARCH_POOL_CLI / INSIDE_CHINA_AI_REPO  适配器位置
 *   CACHED_SEARCH_STORE                     缓存文件（默认 /tmp/web-access-search-cache.json）
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const CACHE_VERSION = 1;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_STORE = "/tmp/web-access-search-cache.json";
const POOL_RELATIVE_PATH = "scripts/short-video/lib/search-pool.mjs";

/**
 * 子进程硬上限：单族挂起不能拖住整次扇出。pool CLI 自己的 HTTP timeout 是 15s，
 * 这里留足代理/慢引擎的余量；超时按族失败记入 attempts，其余族照常合并。
 */
const ADAPTER_TIMEOUT_MS = 60_000;
const ADAPTER_MAX_BUFFER = 10 * 1024 * 1024;
const execFileAsync = promisify(execFile);

/** 按优先级发现适配器，只返回真实存在于本机的那些。 */
export function discoverAdapters(env = process.env) {
  const candidates = [];
  if (env.SEARCH_POOL_CLI)
    candidates.push({ path: env.SEARCH_POOL_CLI, declaredBy: "SEARCH_POOL_CLI" });
  if (env.INSIDE_CHINA_AI_REPO)
    candidates.push({
      path: join(env.INSIDE_CHINA_AI_REPO, POOL_RELATIVE_PATH),
      declaredBy: "INSIDE_CHINA_AI_REPO",
    });

  const seen = new Set();
  return candidates
    .filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)))
    .filter((c) => existsSync(c.path));
}

function normalizeKey(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** 缺缓存、过期、空结果、结构不符都返回 null（miss），绝不抛错。 */
export function cacheGet(cache, { adapter, keyword, now = Date.now(), ttlMs = CACHE_TTL_MS }) {
  const entries = cache && Array.isArray(cache.entries) ? cache.entries : [];
  const hit = entries.find(
    (e) =>
      normalizeKey(e?.adapter) === normalizeKey(adapter) &&
      normalizeKey(e?.keyword) === normalizeKey(keyword),
  );
  if (!hit || !Array.isArray(hit.results) || hit.results.length === 0) return null;
  const ts = Date.parse(hit.timestamp);
  if (!Number.isFinite(ts) || now - ts >= ttlMs) return null;
  return hit.results;
}

/** 只记录非空结果：临时失败与「确实没有内容」在这一层无法区分，缓存空值会放大故障。 */
export function cacheSet(
  cache,
  { adapter, keyword, results, timestamp = new Date().toISOString() },
) {
  if (!cache || !Array.isArray(cache.entries)) return false;
  if (!Array.isArray(results) || results.length === 0) return false;
  const i = cache.entries.findIndex(
    (e) =>
      normalizeKey(e?.adapter) === normalizeKey(adapter) &&
      normalizeKey(e?.keyword) === normalizeKey(keyword),
  );
  const entry = { adapter, keyword, timestamp, results };
  if (i >= 0) cache.entries[i] = entry;
  else cache.entries.push(entry);
  return true;
}

export function loadCache(store) {
  const fresh = { version: CACHE_VERSION, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(store, "utf8"));
    return parsed && parsed.version === CACHE_VERSION && Array.isArray(parsed.entries)
      ? parsed
      : fresh;
  } catch {
    return fresh;
  }
}

/** 原子写；失败只说明优化没做成，不影响本次搜索。 */
export function saveCache(store, cache) {
  let tmp = null;
  try {
    if (!existsSync(dirname(store))) mkdirSync(dirname(store), { recursive: true });
    tmp = `${store}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", "utf8");
    renameSync(tmp, store);
    return { success: true };
  } catch (error) {
    if (tmp && existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        /* 临时文件清不掉也不该掩盖结果 */
      }
    }
    return { success: false, error: error.message };
  }
}

/**
 * 索引族：实测互为镜像的引擎只算一档 —— Jina×Serper 结果重合 100%、Google×Serper
 * 73/33/54%，全打等于把同一份 top-10 取四遍。Tavily 是唯一近正交的（与其他 11-43%）。
 * 所以扇出的正确形状是「每族一个」，不是把 fallback 链全跑一遍；Jina 不入族。
 */
export const FAMILIES = [
  { family: "google", engine: "serper" },
  { family: "brave", engine: "brave" },
  { family: "tavily", engine: "tavily" },
];

function normArticleUrl(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^(www|m)\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return String(u || "").toLowerCase();
  }
}

/** 跨族合并去重：先到先得（顺序即 FAMILIES 顺序），并标出每条来自哪族。 */
export function dedupeFamilies(groups) {
  const seen = new Set();
  const articles = [];
  const byFamily = {};
  for (const g of groups) {
    const list = Array.isArray(g.articles) ? g.articles : [];
    byFamily[g.family] = list.length;
    for (const a of list) {
      // 适配器输出是不可信边界：一条畸形记录不该让整次扇出结果作废
      if (!a || typeof a !== "object" || typeof a.url !== "string") continue;
      const k = normArticleUrl(a.url);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      articles.push({ ...a, family: g.family });
    }
  }
  return { articles, byFamily };
}

/** 一次适配器诊断：只留一行，去掉可能的凭据，再进 attempts。 */
function describeAdapterError(error, timeoutMs = ADAPTER_TIMEOUT_MS) {
  // Only the execFile timeout sets `killed`; a bare `signal` is an external
  // kill (OOM, abort), which must not be reported as a 60s timeout.
  if (error?.killed) {
    return `killed after ${timeoutMs}ms (${error.signal || "no signal"})`;
  }
  if (error?.signal) {
    return `signal ${error.signal}`;
  }
  const raw = String(error?.stderr || error?.message || error || "");
  const scrubbed = raw
    // Scheme first: `Authorization: Bearer <token>` would otherwise let the
    // key=value rule consume the word "Bearer" and leave the token behind.
    .replace(/\b(?:Bearer|Basic|Digest|Token)\s+[^\s,;]+/gi, "[redacted]")
    // Quotes are optional on both sides (`"api_key": "sk-…"` is common).
    .replace(
      /(["']?(?:api[_-]?key|apikey|token|secret|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim();
  const label =
    typeof error?.code === "number" ? `exit ${error.code}` : String(error?.code || "error");
  return `${label}${scrubbed ? `: ${scrubbed}` : ""}`.slice(0, 160);
}

async function runAdapter(adapter, query, maxResults, engine, timeoutMs = ADAPTER_TIMEOUT_MS) {
  const argv = [adapter.path, query, "--max-results", String(maxResults)];
  if (engine) argv.push("--engine", engine);
  const { stdout } = await execFileAsync("node", argv, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: ADAPTER_MAX_BUFFER,
    timeout: timeoutMs,
    // 子进程是本次查询专属的无状态 CLI：超时后不能留下仍在跑的子进程。
    killSignal: "SIGKILL",
  });
  return JSON.parse(stdout);
}

export async function search({
  query,
  maxResults = 8,
  fanout = false,
  env = process.env,
  store = process.env.CACHED_SEARCH_STORE || DEFAULT_STORE,
  now = Date.now(),
  // Test seam: production always uses ADAPTER_TIMEOUT_MS; unit tests shorten it
  // so the timeout branch does not wait 60s.
  adapterTimeoutMs = ADAPTER_TIMEOUT_MS,
}) {
  const adapters = discoverAdapters(env);
  const cache = loadCache(store);

  if (fanout && adapters.length) {
    const key = `${adapters[0].declaredBy}:fanout`;
    const warm = cacheGet(cache, { adapter: key, keyword: query, now });
    if (warm)
      return { articles: warm, engine: "cache", adapter: key, attempts: [], cacheHit: true };
    // 每族一个并发子进程；Promise.all 按 FAMILIES 顺序返回，所以合并顺序
    // 与完成先后无关。单族抛错只影响它自己的 group/attempt。
    const perFamily = await Promise.all(
      FAMILIES.map(async (f) => {
        try {
          const r = await runAdapter(adapters[0], query, maxResults, f.engine, adapterTimeoutMs);
          const list = Array.isArray(r.articles) ? r.articles : [];
          return {
            group: { family: f.family, articles: list },
            attempt: list.length
              ? null
              : {
                  family: f.family,
                  engine: f.engine,
                  ok: false,
                  error: `empty (engine=${JSON.stringify(r.engine)})`,
                },
          };
        } catch (error) {
          return {
            group: { family: f.family, articles: [] },
            attempt: {
              family: f.family,
              engine: f.engine,
              ok: false,
              error: describeAdapterError(error, adapterTimeoutMs),
            },
          };
        }
      }),
    );
    const groups = perFamily.map((r) => r.group);
    const attempts = perFamily.map((r) => r.attempt).filter(Boolean);
    const merged = dedupeFamilies(groups);
    if (merged.articles.length) {
      cacheSet(cache, { adapter: key, keyword: query, results: merged.articles });
      saveCache(store, cache);
    }
    return {
      articles: merged.articles,
      engine: "fanout",
      adapter: adapters[0].declaredBy,
      families: merged.byFamily,
      attempts,
      cacheHit: false,
    };
  }

  for (const adapter of adapters) {
    const cached = cacheGet(cache, { adapter: adapter.declaredBy, keyword: query, now });
    if (cached)
      return {
        articles: cached,
        engine: "cache",
        adapter: adapter.declaredBy,
        attempts: [],
        cacheHit: true,
      };
  }

  const attempts = [];
  for (const adapter of adapters) {
    try {
      const result = await runAdapter(adapter, query, maxResults, undefined, adapterTimeoutMs);
      const articles = Array.isArray(result.articles) ? result.articles : [];
      if (articles.length > 0) {
        cacheSet(cache, { adapter: adapter.declaredBy, keyword: query, results: articles });
        saveCache(store, cache);
        return {
          articles,
          engine: result.engine ?? adapter.declaredBy,
          adapter: adapter.declaredBy,
          attempts,
          cacheHit: false,
        };
      }
      attempts.push({
        adapter: adapter.declaredBy,
        ok: false,
        error: `empty from engine=${JSON.stringify(result.engine)}`,
      });
    } catch (error) {
      attempts.push({
        adapter: adapter.declaredBy,
        ok: false,
        error: describeAdapterError(error, adapterTimeoutMs),
      });
    }
  }

  if (attempts.length === 0) {
    attempts.push({
      adapter: null,
      ok: false,
      error:
        "no_adapter: 设 SEARCH_POOL_CLI=<search-pool.mjs 路径>（或 INSIDE_CHINA_AI_REPO）提供适配器",
    });
  }
  return { articles: [], engine: null, adapter: null, attempts, cacheHit: false };
}

async function main() {
  const args = process.argv.slice(2);
  const query = args[0];
  if (!query || query.startsWith("--")) {
    console.error('用法: node cached-search.mjs "query" [--max-results N] [--fanout]');
    process.exit(2);
  }
  const maxIdx = args.indexOf("--max-results");
  const maxResults = maxIdx >= 0 ? Number(args[maxIdx + 1]) || 8 : 8;
  const result = await search({ query, maxResults, fanout: args.includes("--fanout") });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  // 空结果不是错误：attempts 里写明原因，由调用方决定下一步（与 pool CLI 一致）。
  process.exit(0);
}

// Skills run through a symlinked path under ~/.agents/skills, and Node resolves
// that symlink before the module ever sees it — comparing raw argv against
// import.meta.url would then never match, silently skipping main() and printing
// nothing.
const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((error) => {
    console.error(`cached-search: ${error?.message || error}`);
    process.exit(1);
  });
}
