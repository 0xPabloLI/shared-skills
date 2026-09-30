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
 * 用法: node cached-search.mjs "query" [--max-results N]
 * 环境变量:
 *   SEARCH_POOL_CLI / INSIDE_CHINA_AI_REPO  适配器位置
 *   CACHED_SEARCH_STORE                     缓存文件（默认 /tmp/web-access-search-cache.json）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CACHE_VERSION = 1;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_STORE = "/tmp/web-access-search-cache.json";
const POOL_RELATIVE_PATH = "scripts/short-video/lib/search-pool.mjs";

/** 按优先级发现适配器，只返回真实存在于本机的那些。 */
export function discoverAdapters(env = process.env) {
  const candidates = [];
  if (env.SEARCH_POOL_CLI) candidates.push({ path: env.SEARCH_POOL_CLI, declaredBy: "SEARCH_POOL_CLI" });
  if (env.INSIDE_CHINA_AI_REPO)
    candidates.push({ path: join(env.INSIDE_CHINA_AI_REPO, POOL_RELATIVE_PATH), declaredBy: "INSIDE_CHINA_AI_REPO" });

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
    (e) => normalizeKey(e?.adapter) === normalizeKey(adapter) && normalizeKey(e?.keyword) === normalizeKey(keyword),
  );
  if (!hit || !Array.isArray(hit.results) || hit.results.length === 0) return null;
  const ts = Date.parse(hit.timestamp);
  if (!Number.isFinite(ts) || now - ts >= ttlMs) return null;
  return hit.results;
}

/** 只记录非空结果：临时失败与「确实没有内容」在这一层无法区分，缓存空值会放大故障。 */
export function cacheSet(cache, { adapter, keyword, results, timestamp = new Date().toISOString() }) {
  if (!cache || !Array.isArray(cache.entries)) return false;
  if (!Array.isArray(results) || results.length === 0) return false;
  const i = cache.entries.findIndex(
    (e) => normalizeKey(e?.adapter) === normalizeKey(adapter) && normalizeKey(e?.keyword) === normalizeKey(keyword),
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
    return parsed && parsed.version === CACHE_VERSION && Array.isArray(parsed.entries) ? parsed : fresh;
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

function runAdapter(adapter, query, maxResults) {
  const out = execFileSync("node", [adapter.path, query, "--max-results", String(maxResults)], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out);
}

export function search({ query, maxResults = 8, env = process.env, store = process.env.CACHED_SEARCH_STORE || DEFAULT_STORE, now = Date.now() }) {
  const adapters = discoverAdapters(env);
  const cache = loadCache(store);

  for (const adapter of adapters) {
    const cached = cacheGet(cache, { adapter: adapter.declaredBy, keyword: query, now });
    if (cached) return { articles: cached, engine: "cache", adapter: adapter.declaredBy, attempts: [], cacheHit: true };
  }

  const attempts = [];
  for (const adapter of adapters) {
    try {
      const result = runAdapter(adapter, query, maxResults);
      const articles = Array.isArray(result.articles) ? result.articles : [];
      if (articles.length > 0) {
        cacheSet(cache, { adapter: adapter.declaredBy, keyword: query, results: articles });
        saveCache(store, cache);
        return { articles, engine: result.engine ?? adapter.declaredBy, adapter: adapter.declaredBy, attempts, cacheHit: false };
      }
      attempts.push({ adapter: adapter.declaredBy, ok: false, error: `empty from engine=${JSON.stringify(result.engine)}` });
    } catch (error) {
      attempts.push({ adapter: adapter.declaredBy, ok: false, error: String(error.message).slice(0, 160) });
    }
  }

  if (attempts.length === 0) {
    attempts.push({
      adapter: null,
      ok: false,
      error: "no_adapter: 设 SEARCH_POOL_CLI=<search-pool.mjs 路径>（或 INSIDE_CHINA_AI_REPO）提供适配器",
    });
  }
  return { articles: [], engine: null, adapter: null, attempts, cacheHit: false };
}

function main() {
  const args = process.argv.slice(2);
  const query = args[0];
  if (!query || query.startsWith("--")) {
    console.error('用法: node cached-search.mjs "query" [--max-results N]');
    process.exit(2);
  }
  const maxIdx = args.indexOf("--max-results");
  const maxResults = maxIdx >= 0 ? Number(args[maxIdx + 1]) || 8 : 8;
  const result = search({ query, maxResults });
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

if (invokedAsScript) main();
