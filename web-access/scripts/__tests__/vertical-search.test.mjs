import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES, DEFAULT_SOURCES, merge, fanout } from "../vertical-search.mjs";

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

  it("every parser yields title + http url + date", () => {
    const all = [
      ...SOURCES.openalex.parse(FIX.openalex, "openalex"),
      ...SOURCES.arxiv.parseXml(FIX.arxivXml, "arxiv"),
      ...SOURCES.hn.parse(FIX.hn, "hn"),
      ...SOURCES.stackoverflow.parse(FIX.stackoverflow, "stackoverflow"),
      ...SOURCES.github.parse(FIX.github, "github"),
    ];
    expect(all.length).toBeGreaterThan(5);
    for (const a of all)
      expect(shape(a)).toEqual({ hasTitle: true, hasUrl: true, hasDate: true, src: a.source });
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
