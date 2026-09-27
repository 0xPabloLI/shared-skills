#!/usr/bin/env node
/**
 * cached-search.mjs — search-pool CLI 的缓存 wrapper
 * 先查本地缓存（24h TTL），miss 再调 search-pool.mjs，结果写回缓存。
 * 用法: node cached-search.mjs "query" [--max-results N]
 * 依赖 INSIDE_CHINA_AI_REPO（指向 inside-china-ai checkout，cache 模块 + search-pool 都在那）。
 * 回退：INSIDE_CHINA_AI_REPO 未设或 cache 模块加载失败 → 无缓存直调 search-pool。
 */
import { execFileSync } from 'node:child_process';

const repo = process.env.INSIDE_CHINA_AI_REPO;
const args = process.argv.slice(2);
const query = args[0];
if (!query) {
  console.error('用法: node cached-search.mjs "query" [--max-results N]');
  process.exit(2);
}
const maxIdx = args.indexOf('--max-results');
const maxResults = maxIdx >= 0 ? args[maxIdx + 1] : '8';
const CACHE_FILE = '/tmp/web-access-search-cache.json';
const poolScript = repo ? `${repo}/scripts/short-video/lib/search-pool.mjs` : null;

function callPool() {
  if (!poolScript) { console.error('INSIDE_CHINA_AI_REPO 未设置，无法调 search-pool'); process.exit(1); }
  const out = execFileSync('node', [poolScript, query, '--max-results', maxResults], { encoding: 'utf8', env: process.env, maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(out);
}

let cacheMod = null;
if (repo) {
  try { cacheMod = await import(`${repo}/scripts/short-video/lib/search-results-cache.mjs`); } catch { cacheMod = null; }
}

if (cacheMod) {
  const cache = cacheMod.loadSearchResultsCache(CACHE_FILE);
  const cached = cacheMod.getCachedSearchResults(cache, { source: 'search-pool', keyword: query });
  if (cached) {
    console.log(JSON.stringify({ articles: cached, engine: 'cache', cacheHit: true }, null, 2));
    process.exit(0);
  }
  const result = callPool();
  if (result.articles && result.articles.length > 0) {
    cacheMod.recordSearchResults(cache, { source: 'search-pool', keyword: query, results: result.articles });
    cacheMod.saveSearchResultsCache(CACHE_FILE, cache);
  }
  console.log(JSON.stringify({ ...result, cacheHit: false }, null, 2));
} else {
  const result = callPool();
  console.log(JSON.stringify({ ...result, cacheHit: false }, null, 2));
}