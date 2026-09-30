import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverAdapters,
  cacheGet,
  cacheSet,
  loadCache,
  saveCache,
  search,
  CACHE_VERSION,
} from "../cached-search.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "cached-search.mjs");

const T0 = Date.parse("2026-09-30T00:00:00Z");
const emptyCache = () => ({ version: CACHE_VERSION, entries: [] });

describe("discoverAdapters", () => {
  it("resolves the generic injection point and the historical one", () => {
    const found = discoverAdapters({ SEARCH_POOL_CLI: import.meta.filename, INSIDE_CHINA_AI_REPO: "/nope-absent" });
    expect(found).toHaveLength(1);
    expect(found[0].declaredBy).toBe("SEARCH_POOL_CLI");
  });

  it("skips an INSIDE_CHINA_AI_REPO checkout that has no pool CLI", () => {
    expect(discoverAdapters({ INSIDE_CHINA_AI_REPO: "/nope-absent" })).toEqual([]);
  });

  it("drops a declared adapter whose path does not exist rather than failing later", () => {
    expect(discoverAdapters({ SEARCH_POOL_CLI: "/nope/search-pool.mjs" })).toEqual([]);
  });
});

describe("cache", () => {
  it("misses on absent, expired, empty and malformed entries without throwing", () => {
    const c = emptyCache();
    cacheSet(c, { adapter: "SEARCH_POOL_CLI", keyword: "cat", results: [{ url: "https://x" }], timestamp: new Date(T0).toISOString() });
    expect(cacheGet(c, { adapter: "SEARCH_POOL_CLI", keyword: "cat", now: T0 })).toHaveLength(1);
    expect(cacheGet(c, { adapter: "SEARCH_POOL_CLI", keyword: "cat", now: T0 + 25 * 3600 * 1000 })).toBeNull();
    expect(cacheGet(c, { adapter: "OTHER", keyword: "cat", now: T0 })).toBeNull();
    expect(cacheGet({ version: 99, entries: [] }, { adapter: "SEARCH_POOL_CLI", keyword: "cat", now: T0 })).toBeNull();
    expect(cacheGet(null, { adapter: "SEARCH_POOL_CLI", keyword: "cat", now: T0 })).toBeNull();
  });

  it("never stores an empty result set", () => {
    const c = emptyCache();
    expect(cacheSet(c, { adapter: "A", keyword: "k", results: [] })).toBe(false);
    expect(c.entries).toHaveLength(0);
  });

  it("replaces rather than appends for the same adapter+keyword", () => {
    const c = emptyCache();
    cacheSet(c, { adapter: "A", keyword: "k", results: [{ url: "1" }] });
    cacheSet(c, { adapter: "A", keyword: "k", results: [{ url: "2" }] });
    expect(c.entries).toHaveLength(1);
  });

  it("survives a corrupt store file and an unwritable path", () => {
    expect(loadCache("/definitely/not/here.json").entries).toEqual([]);
    expect(saveCache("/dev/null/impossible", emptyCache()).success).toBe(false);
  });
});

describe("CLI through a symlinked path", () => {
  // Skills run as `node ~/.agents/skills/web-access/scripts/cached-search.mjs`.
  // Node resolves that symlink before the module runs, so a main() guard that
  // compares raw argv to import.meta.url silently skips the entry point and
  // prints nothing — the exact bug this guards.
  const LINK = `/tmp/cached-search-symlink-test-${process.pid}.mjs`;

  it("prints parseable JSON and exits 0 when no adapter is present", () => {
    if (existsSync(LINK)) unlinkSync(LINK);
    symlinkSync(SCRIPT, LINK);
    try {
      const out = execFileSync("node", [LINK, "任何查询"], {
        encoding: "utf8",
        env: {
          ...process.env,
          SEARCH_POOL_CLI: "",
          INSIDE_CHINA_AI_REPO: "/nope-absent",
          CACHED_SEARCH_STORE: `/tmp/cached-search-cli-${process.pid}.json`,
        },
      });
      const json = JSON.parse(out);
      expect(json.engine).toBeNull();
      expect(json.articles).toEqual([]);
      expect(json.attempts[0].error).toMatch(/no_adapter/);
    } finally {
      unlinkSync(LINK);
    }
  });
});

describe("search", () => {
  it("degrades to a diagnosable payload instead of exiting when no adapter exists", () => {
    const out = search({ query: "anything", env: {}, store: "/tmp/cached-search-test-0.json" });
    expect(out.engine).toBeNull();
    expect(out.articles).toEqual([]);
    expect(out.attempts[0].error).toMatch(/no_adapter/);
  });

  it("serves a warm cache without touching the adapter", () => {
    const store = "/tmp/cached-search-test-warm.json";
    saveCache(store, {
      version: CACHE_VERSION,
      entries: [
        { adapter: "SEARCH_POOL_CLI", keyword: "hot", timestamp: new Date(T0).toISOString(), results: [{ url: "https://cached" }] },
      ],
    });
    // 适配器指向本文件：若真去 spawn 会解析不出 JSON，因此 engine=cache 即证明未调用
    const out = search({ query: "hot", env: { SEARCH_POOL_CLI: import.meta.filename }, store, now: T0 + 1000 });
    expect(out.engine).toBe("cache");
    expect(out.cacheHit).toBe(true);
    expect(out.articles[0].url).toBe("https://cached");
  });
});
