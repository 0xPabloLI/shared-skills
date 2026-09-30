import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverAdapters,
  cacheGet,
  cacheSet,
  loadCache,
  saveCache,
  search,
  dedupeFamilies,
  FAMILIES,
  CACHE_VERSION,
} from "../cached-search.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "cached-search.mjs");

const T0 = Date.parse("2026-09-30T00:00:00Z");
const emptyCache = () => ({ version: CACHE_VERSION, entries: [] });

describe("discoverAdapters", () => {
  it("resolves the generic injection point and the historical one", () => {
    const found = discoverAdapters({
      SEARCH_POOL_CLI: import.meta.filename,
      INSIDE_CHINA_AI_REPO: "/nope-absent",
    });
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
    cacheSet(c, {
      adapter: "SEARCH_POOL_CLI",
      keyword: "cat",
      results: [{ url: "https://x" }],
      timestamp: new Date(T0).toISOString(),
    });
    expect(cacheGet(c, { adapter: "SEARCH_POOL_CLI", keyword: "cat", now: T0 })).toHaveLength(1);
    expect(
      cacheGet(c, { adapter: "SEARCH_POOL_CLI", keyword: "cat", now: T0 + 25 * 3600 * 1000 }),
    ).toBeNull();
    expect(cacheGet(c, { adapter: "OTHER", keyword: "cat", now: T0 })).toBeNull();
    expect(
      cacheGet(
        { version: 99, entries: [] },
        { adapter: "SEARCH_POOL_CLI", keyword: "cat", now: T0 },
      ),
    ).toBeNull();
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
        {
          adapter: "SEARCH_POOL_CLI",
          keyword: "hot",
          timestamp: new Date(T0).toISOString(),
          results: [{ url: "https://cached" }],
        },
      ],
    });
    // 适配器指向本文件：若真去 spawn 会解析不出 JSON，因此 engine=cache 即证明未调用
    const out = search({
      query: "hot",
      env: { SEARCH_POOL_CLI: import.meta.filename },
      store,
      now: T0 + 1000,
    });
    expect(out.engine).toBe("cache");
    expect(out.cacheHit).toBe(true);
    expect(out.articles[0].url).toBe("https://cached");
  });
});

/**
 * A stand-in for scripts/short-video/lib/search-pool.mjs: honors `--engine` and
 * returns canned articles, so the fan-out path can be tested without spending
 * API quota or depending on which repo happens to be on this machine.
 */
function fakePool(body) {
  const path = `/tmp/fake-search-pool-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`;
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  return path;
}

const ECHO_POOL = `
const a = process.argv.slice(2);
const eng = a.includes("--engine") ? a[a.indexOf("--engine") + 1] : "default";
const URLS = {
  serper: [{ url: "https://www.s1.example/a" }, { url: "https://shared.example/x" }],
  brave: [{ url: "https://b1.example/a" }, { url: "https://shared.example/x/" }],
  tavily: [{ url: "https://t1.example/a" }],
};
process.stdout.write(JSON.stringify({ articles: URLS[eng] || [], engine: eng, attempts: [] }));
`;

describe("索引族扇出", () => {
  it("每族一个引擎，且不含实测为镜像的 jina", () => {
    expect(FAMILIES.map((f) => f.engine)).toEqual(["serper", "brave", "tavily"]);
    expect(FAMILIES.map((f) => f.family)).toEqual(["google", "brave", "tavily"]);
  });

  it("dedupeFamilies 跨族去重（www 与尾斜杠归一）、先到先得、标注来源族", () => {
    const { articles, byFamily } = dedupeFamilies([
      {
        family: "google",
        articles: [{ url: "https://www.s1.example/a" }, { url: "https://shared.example/x" }],
      },
      { family: "brave", articles: [{ url: "https://shared.example/x/", title: "brave 版本" }] },
      {
        family: "tavily",
        articles: [{ url: "https://t1.example/a" }, { url: "" }, { url: 123 }, null],
      },
    ]);
    expect(articles.map((a) => a.url)).toEqual([
      "https://www.s1.example/a",
      "https://shared.example/x",
      "https://t1.example/a",
    ]);
    expect(articles[1].family).toBe("google");
    expect(articles[1].title).toBeUndefined();
    expect(articles[2].family).toBe("tavily");
    expect(byFamily).toEqual({ google: 2, brave: 1, tavily: 4 });
  });

  it("--fanout 合并三族并写入独立缓存键", () => {
    const pool = fakePool(ECHO_POOL);
    const store = `/tmp/cached-search-fanout-${process.pid}.json`;
    const env = { SEARCH_POOL_CLI: pool, INSIDE_CHINA_AI_REPO: "", CACHED_SEARCH_STORE: store };
    try {
      const out = search({ query: "q", fanout: true, env, store });
      expect(out.engine).toBe("fanout");
      expect(out.families).toEqual({ google: 2, brave: 2, tavily: 1 });
      expect(out.articles).toHaveLength(4);
      expect(out.attempts).toEqual([]);

      const again = search({ query: "q", fanout: true, env, store, now: T0 + 1000 });
      expect(again.cacheHit).toBe(true);
      // 扇出与单档 fallback 不共用缓存条目：否则一次 fanout 结果会被后续单档查询当成 serper 的答案
      expect(loadCache(store).entries.map((e) => e.adapter)).toEqual(["SEARCH_POOL_CLI:fanout"]);
    } finally {
      unlinkSync(pool);
      if (existsSync(store)) unlinkSync(store);
    }
  });

  it("缺 key 的族只记 attempts，不掩盖其余族的结果", () => {
    const pool = fakePool(`
const a = process.argv.slice(2);
const eng = a[a.indexOf("--engine") + 1];
if (eng === "brave") { process.stderr.write("missing BRAVE_SEARCH_API_KEY"); process.exit(1); }
process.stdout.write(JSON.stringify({ articles: [{ url: "https://only-" + eng + ".example" }], engine: eng, attempts: [] }));
`);
    const store = `/tmp/cached-search-fanout-partial-${process.pid}.json`;
    try {
      const out = search({
        query: "q2",
        fanout: true,
        env: { SEARCH_POOL_CLI: pool, INSIDE_CHINA_AI_REPO: "" },
        store,
      });
      expect(out.articles.map((a) => a.family)).toEqual(["google", "tavily"]);
      expect(out.attempts).toHaveLength(1);
      expect(out.attempts[0].family).toBe("brave");
      expect(out.families).toEqual({ google: 1, brave: 0, tavily: 1 });
    } finally {
      unlinkSync(pool);
      if (existsSync(store)) unlinkSync(store);
    }
  });

  it("没有适配器时 --fanout 同样降级，不抛错", () => {
    const out = search({
      query: "q",
      fanout: true,
      env: { SEARCH_POOL_CLI: "", INSIDE_CHINA_AI_REPO: "" },
      store: "/tmp/cached-search-fanout-none.json",
    });
    expect(out.engine).toBeNull();
    expect(out.attempts[0].error).toMatch(/no_adapter/);
  });
});
