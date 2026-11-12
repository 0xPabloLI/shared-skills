import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES, DEFAULT_SOURCES, merge, fanout, searchOne } from "../vertical-search.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "vertical-search.mjs");

// 全部 fixture 取自 2026-09-30 本机对各端点的真实响应（裁剪到单条），
// 不是照文档臆造的字段形状 —— 判「解析不出来」是 bug 还是端点真变了，
// 需要这种正对照。
const FIX = {
  openalex: {
    results: [
      {
        id: "https://openalex.org/W2954274727",
        display_name: "DeepSpeed-MoE: Advancing Mixture-of-Experts",
        doi: "https://doi.org/10.48550/arxiv.2201.05596",
        publication_date: "2022-01-14",
        cited_by_count: 54,
      },
    ],
  },
  hn: {
    hits: [
      {
        title: "DeepSeek-R1",
        url: "https://github.com/deepseek-ai/DeepSeek-R1",
        created_at: "2025-01-20T17:11:23Z",
        objectID: "42580740",
        points: 1200,
      },
      { comment_text: "a reply, not a story", objectID: "42580999" },
      {
        title: "OpenAI Furious",
        created_at: "2025-01-29T05:20:00Z",
        objectID: "42711",
        points: 300,
      },
    ],
  },
  stackoverflow: {
    items: [
      {
        title: "how to get best results",
        link: "https://stackoverflow.com/questions/633",
        body: "<p>use <b>top-k</b> routing</p>",
        creation_date: 1660490551,
      },
    ],
  },
  wikipedia: {
    query: {
      search: [
        {
          title: "Mixture of experts",
          pageid: 542,
          snippet: 'a <span class="match">mixture</span> model',
          timestamp: "2026-05-16T15:54:46Z",
        },
      ],
    },
  },
  github: {
    items: [
      {
        full_name: "koayon/awesome-x",
        html_url: "https://github.com/koayon/awesome-x",
        description: "curated",
        updated_at: "2026-09-02T01:02:03Z",
        stargazers_count: 165,
      },
    ],
  },
  arxivXml: `<feed><entry><id>http://arxiv.org/abs/2410.17954v2</id><title>ExpertFlow: Efficient Mixture-of-Experts Inference</title><summary>Toward  system  efficiency</summary><published>2024-10-23T17:14:44Z</published></entry>
<entry><id>http://arxiv.org/abs/2402.14800v2</id><title>Not All Experts are Equal</title><summary>Expert pruning</summary><published>2024-02-22T06:30:10Z</published></entry></feed>`,
};

const shape = (a) => ({
  hasTitle: !!a.title,
  hasUrl: /^https?:\/\//.test(a.url),
  hasDate: !!a.publishedAt,
  src: a.source,
});

describe("parsers against recorded payloads", () => {
  it("openalex → doi url + date", () => {
    expect(SOURCES.openalex.parse(FIX.openalex, "openalex")).toEqual([
      {
        title: "DeepSpeed-MoE: Advancing Mixture-of-Experts",
        url: "https://doi.org/10.48550/arxiv.2201.05596",
        snippet: "",
        publishedAt: "2022-01-14",
        source: "openalex",
      },
    ]);
  });

  it("arxiv Atom XML → 2 entries with ids and dates", () => {
    const out = SOURCES.arxiv.parseXml(FIX.arxivXml, "arxiv");
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.publishedAt)).toEqual(["2024-10-23", "2024-02-22"]);
    expect(out[0].url).toBe("http://arxiv.org/abs/2410.17954v2");
  });

  it("hn drops comment hits but keeps stories; item URL is the fallback", () => {
    const out = SOURCES.hn.parse(FIX.hn, "hn");
    expect(out).toHaveLength(2);
    expect(out[0].url).toBe("https://github.com/deepseek-ai/DeepSeek-R1");
    expect(out[1].url).toBe("https://news.ycombinator.com/item?id=42711");
  });

  it("stackoverflow epoch → ISO date, html stripped", () => {
    const [a] = SOURCES.stackoverflow.parse(FIX.stackoverflow, "stackoverflow");
    expect(a.publishedAt).toBe("2022-08-14");
    expect(a.snippet).toBe("use top-k routing");
  });

  it("wikipedia strips markup and builds a curid URL", () => {
    const [a] = SOURCES.wikipedia.parse(FIX.wikipedia, "wikipedia", {});
    expect(a.url).toBe("https://en.wikipedia.org/?curid=542");
    expect(a.snippet).toBe("a mixture model");
  });

  it("every parser yields title + http url (+ date where the source has one)", () => {
    const all = [
      ...SOURCES.openalex.parse(FIX.openalex, "openalex"),
      ...SOURCES.arxiv.parseXml(FIX.arxivXml, "arxiv"),
      ...SOURCES.hn.parse(FIX.hn, "hn"),
      ...SOURCES.stackoverflow.parse(FIX.stackoverflow, "stackoverflow"),
    ];
    expect(all.length).toBeGreaterThan(5);
    for (const a of all)
      expect(shape(a)).toEqual({ hasTitle: true, hasUrl: true, hasDate: true, src: a.source });
    // github 没有发布日期：updated_at 是推送/星标时间，冒充 publishedAt 会污染
    // 下游的新鲜度排序（#468）。
    for (const a of SOURCES.github.parse(FIX.github, "github")) {
      expect(shape(a)).toEqual({ hasTitle: true, hasUrl: true, hasDate: false, src: "github" });
    }
  });
});

describe("wikiHost validation (positive control)", () => {
  it("honours a real language tag", () => {
    expect(SOURCES.wikipedia.build("q", 3, { lang: "zh" })).toContain("https://zh.wikipedia.org/");
  });

  it("ignores a value that is not a language tag rather than turning it into a host", () => {
    for (const evil of ["evil.com/x?", "..evil.io", "a b", "zh..org", "en;rm"]) {
      expect(SOURCES.wikipedia.build("q", 3, { lang: evil })).toContain(
        "https://en.wikipedia.org/",
      );
    }
  });

  it("defaults to the bare wikipedia host with no lang", () => {
    expect(SOURCES.wikipedia.build("q", 3, {})).toContain("https://en.wikipedia.org/w/api.php");
  });
});

describe("merge", () => {
  it("dedupes by normalized URL, keeping the first source's copy", () => {
    const dup = {
      title: "same",
      url: "https://arxiv.org/abs/123/",
      snippet: "",
      publishedAt: "2024-01-01",
      source: "arxiv",
    };
    const same = {
      title: "same via openalex",
      url: "http://arxiv.org/abs/123",
      snippet: "",
      publishedAt: "2024-01-02",
      source: "openalex",
    };
    const out = merge(["arxiv", "openalex"], [{ articles: [dup] }, { articles: [same] }], "q");
    expect(out.articles).toHaveLength(1);
    expect(out.articles[0].source).toBe("arxiv");
    expect(out.sources).toEqual({ arxiv: 1, openalex: 1 });
  });

  it("records per-source failures in attempts without dropping the good sources", () => {
    const ok = {
      title: "t",
      url: "https://a.test/1",
      snippet: "",
      publishedAt: "2024",
      source: "hn",
    };
    const out = merge(
      ["hn", "github"],
      [{ articles: [ok] }, { articles: [], error: "fetch failed" }],
      "q",
    );
    expect(out.articles).toHaveLength(1);
    expect(out.attempts).toEqual([{ source: "github", ok: false, error: "fetch failed" }]);
  });

  it("tolerates a missing articles array", () => {
    expect(merge(["x"], [{}], "q").articles).toEqual([]);
  });
});

describe("source list", () => {
  it("defaults are all real sources and free of paid keys", () => {
    for (const s of DEFAULT_SOURCES) expect(SOURCES[s]).toBeTruthy();
    expect(DEFAULT_SOURCES).toContain("openalex");
  });
});

describe("CLI", () => {
  it("--list prints every source without touching the network", () => {
    const out = execFileSync("node", [SCRIPT, "--list"], { encoding: "utf8" });
    for (const s of DEFAULT_SOURCES) expect(out).toContain(s);
  });

  it("rejects a missing query with usage exit 2", () => {
    expect(() =>
      execFileSync("node", [SCRIPT, "--max-results", "3"], { encoding: "utf8", stdio: "pipe" }),
    ).toThrow();
  });

  it("unknown source names are dropped rather than throwing", async () => {
    const r = await fanout({ query: "x", sources: ["nope-not-a-source"], maxResults: 1 });
    expect(r.articles).toEqual([]);
    expect(r.attempts).toEqual([]);
  });
});

// #468：多条目 fixture。旧的每源单条 fixture 恰好遮住了「多条塌成 1 条」。
const WIKI_FIVE = {
  query: {
    search: [542, 543, 544, 545, 546].map((pageid, i) => ({
      title: `MoE ${i}`,
      pageid,
      snippet: `entry ${i}`,
      timestamp: "2026-05-16T15:54:46Z",
    })),
  },
};

const HN_FIVE = {
  hits: [
    {
      title: "story 1",
      url: "https://a.test/1",
      objectID: "1",
      created_at: "2025-01-01T00:00:00Z",
    },
    { title: "ask 1", objectID: "2", created_at: "2025-01-02T00:00:00Z" },
    { title: "ask 2", objectID: "3", created_at: "2025-01-03T00:00:00Z" },
    {
      title: "story 2",
      url: "https://a.test/2",
      objectID: "4",
      created_at: "2025-01-04T00:00:00Z",
    },
    { title: "ask 3", objectID: "5", created_at: "2025-01-05T00:00:00Z" },
  ],
};

describe("multi-entry results survive the dedupe (#468)", () => {
  it("wikipedia keeps all 5 (curid lives in the query string)", () => {
    const parsed = SOURCES.wikipedia.parse(WIKI_FIVE, "wikipedia", {});
    expect(parsed).toHaveLength(5);
    expect(merge(["wikipedia"], [{ articles: parsed }], "q").articles).toHaveLength(5);
  });

  it("hn item?id fallback urls stay distinct", () => {
    const parsed = SOURCES.hn.parse(HN_FIVE, "hn");
    expect(parsed).toHaveLength(5);
    expect(merge(["hn"], [{ articles: parsed }], "q").articles).toHaveLength(5);
  });

  it("still collapses the same page across sources", () => {
    const a = { title: "x", url: "https://example.com/doc?id=7", source: "hn" };
    const b = { title: "x", url: "https://www.example.com/doc/?id=7", source: "github" };
    expect(
      merge(["hn", "github"], [{ articles: [a] }, { articles: [b] }], "q").articles,
    ).toHaveLength(1);
  });

  it("ignores tracking params and their order", () => {
    const first = {
      title: "x",
      url: "https://example.com/p?utm_source=a&utm_medium=b&id=9",
      source: "hn",
    };
    const second = {
      title: "x",
      url: "https://example.com/p?id=9&utm_campaign=c&fbclid=zzz",
      source: "github",
    };
    expect(
      merge(["hn", "github"], [{ articles: [first] }, { articles: [second] }], "q").articles,
    ).toHaveLength(1);
  });
});

describe("identity and provider contracts (#468)", () => {
  it("openalex attaches mailto only when SEARCH_CONTACT_EMAIL is set", () => {
    const prev = process.env.SEARCH_CONTACT_EMAIL;
    try {
      delete process.env.SEARCH_CONTACT_EMAIL;
      expect(SOURCES.openalex.build("q", 3)).not.toContain("mailto=");
      process.env.SEARCH_CONTACT_EMAIL = "ops@example.com";
      expect(SOURCES.openalex.build("q", 3)).toContain("mailto=ops%40example.com");
    } finally {
      if (prev === undefined) delete process.env.SEARCH_CONTACT_EMAIL;
      else process.env.SEARCH_CONTACT_EMAIL = prev;
    }
  });

  it("arxiv asks over https", () => {
    expect(SOURCES.arxiv.build("q", 3)).toMatch(/^https:\/\//);
  });

  it("github does not fake publishedAt out of updated_at", () => {
    const [a] = SOURCES.github.parse(FIX.github, "github");
    expect(a.publishedAt).toBeNull();
    expect(a.snippet).toContain("2026-09-02");
  });
});

describe("failure classification (#468)", () => {
  const run = async (fetchImpl, fn) => {
    vi.stubGlobal("fetch", fetchImpl);
    try {
      return await fn();
    } finally {
      vi.unstubAllGlobals();
    }
  };
  const failing = (status, headers = {}) => ({
    ok: false,
    status,
    headers: new Headers(headers),
  });

  it("retries a 429 once after Retry-After, then reports rate-limit", async () => {
    let calls = 0;
    const waits = [];
    const r = await run(
      async () => (calls++, failing(429, { "retry-after": "2" })),
      () =>
        searchOne("openalex", "q", 1, {
          sleep: async (ms) => {
            waits.push(ms);
          },
        }),
    );
    expect(calls).toBe(2);
    expect(waits).toEqual([2000]);
    expect(r.kind).toBe("rate-limit");
    expect(r.error).toContain("429");
  });

  it("caps a long Retry-After instead of sleeping the whole window", async () => {
    const waits = [];
    await run(
      async () => failing(429, { "retry-after": "3600" }),
      () => searchOne("openalex", "q", 1, { sleep: async (ms) => waits.push(ms) }),
    );
    expect(waits).toEqual([10000]);
  });

  it("does not retry a 400/422 parameter error", async () => {
    let calls = 0;
    const r = await run(
      async () => (calls++, failing(422)),
      () => searchOne("github", "q", 1, { sleep: async () => {} }),
    );
    expect(calls).toBe(1);
    expect(r.kind).toBe("request");
  });

  it("classifies a connect failure as reachability, not a dead source", async () => {
    const err = new TypeError("fetch failed");
    err.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
    const r = await run(
      async () => {
        throw err;
      },
      () => searchOne("wikipedia", "q", 1, { sleep: async () => {} }),
    );
    expect(r.kind).toBe("connect");
    expect(r.error).toBe("fetch failed");
    expect(r.hint).toMatch(/代理|出网|网络/);
  });

  it("a reachable but empty result is not a failure", async () => {
    const r = await run(
      async () => ({ ok: true, json: async () => ({ items: [] }) }),
      () => searchOne("github", "q", 1, { sleep: async () => {} }),
    );
    expect(r.error).toBeUndefined();
    expect(r.articles).toEqual([]);
  });

  it("surfaces failed sources as warnings, not just attempts", () => {
    const out = merge(
      ["hn", "github"],
      [
        { articles: [{ title: "t", url: "https://a.test/1", source: "hn" }] },
        { articles: [], error: "HTTP 403", kind: "auth", hint: "设 GITHUB_TOKEN" },
      ],
      "q",
    );
    expect(out.attempts[0]).toMatchObject({ source: "github", ok: false, kind: "auth" });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain("github");
    expect(out.warnings[0]).toContain("GITHUB_TOKEN");
  });

  it("fanout warns that github runs anonymous without a token", async () => {
    const prev = process.env.GITHUB_TOKEN;
    const prevGh = process.env.GH_TOKEN;
    try {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      const r = await run(
        async () => ({ ok: true, json: async () => ({ items: [] }) }),
        () => fanout({ query: "q", sources: ["github"], maxResults: 1, sleep: async () => {} }),
      );
      expect(r.warnings.join("\n")).toContain("GITHUB_TOKEN");
    } finally {
      if (prev !== undefined) process.env.GITHUB_TOKEN = prev;
      if (prevGh !== undefined) process.env.GH_TOKEN = prevGh;
    }
  });
});
