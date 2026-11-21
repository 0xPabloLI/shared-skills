#!/usr/bin/env node
// 站点经验目录的单一解析入口（#469）
//
// 站点经验是本机运行时积累的缓存，不是入库资产：默认住 `~/.cache/web-access/site-patterns/`，
// 可用 `WEB_ACCESS_SITE_PATTERNS_DIR` 覆盖。旧的仓内目录 `references/site-patterns/` 只在
// 本机缓存还没有内容时作**只读回退**，让升级前的机器不丢经验；迁移用
// `web-access/scripts/migrate-site-patterns.mjs`。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_DIR = path.join(ROOT, "references", "site-patterns");

const DEFAULT_DIR = path.join(os.homedir(), ".cache", "web-access", "site-patterns");

/** Markdown 站点经验文件数（目录不存在算 0）。 */
export function countSitePatterns(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/**
 * @returns {{dir: string, legacy: boolean, default: string, legacyDir: string}}
 *   `legacy: true` 表示当前在用旧仓内目录（只读回退），调用方应提示迁移。
 */
export function resolveSitePatternsDir() {
  const override = (process.env.WEB_ACCESS_SITE_PATTERNS_DIR || "").trim();
  if (override) return { dir: override, legacy: false, default: DEFAULT_DIR, legacyDir: LEGACY_DIR };
  if (countSitePatterns(DEFAULT_DIR) > 0 || countSitePatterns(LEGACY_DIR) === 0) {
    return { dir: DEFAULT_DIR, legacy: false, default: DEFAULT_DIR, legacyDir: LEGACY_DIR };
  }
  return { dir: LEGACY_DIR, legacy: true, default: DEFAULT_DIR, legacyDir: LEGACY_DIR };
}
