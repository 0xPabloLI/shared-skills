#!/usr/bin/env node
// 把旧仓内目录的站点经验迁到本机缓存（#469）
//
// 用法：
//   node scripts/migrate-site-patterns.mjs                 旧仓内目录 → ~/.cache/web-access/site-patterns
//   node scripts/migrate-site-patterns.mjs --from <dir>    指定来源（例如另一台 checkout）
//   node scripts/migrate-site-patterns.mjs --to <dir>      指定目标
//   node scripts/migrate-site-patterns.mjs --dry-run       只报计划
//
// 语义：逐文件复制；目标已有同名文件时不覆盖，只报告冲突（两份内容谁对谁错要人来判）。
// 来源目录不删除——迁完由人确认后再清理。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSitePatternsDir } from "./site-patterns-dir.mjs";

function parseArgs(argv) {
  const opts = { from: null, to: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from" && argv[i + 1]) opts.from = argv[++i];
    else if (argv[i] === "--to" && argv[i + 1]) opts.to = argv[++i];
    else if (argv[i] === "--dry-run") opts.dryRun = true;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const resolved = resolveSitePatternsDir();
const from = opts.from ? path.resolve(opts.from) : resolved.legacyDir;
const to = opts.to
  ? path.resolve(opts.to)
  : resolved.default || path.join(os.homedir(), ".cache", "web-access", "site-patterns");

if (from === to) {
  console.log(`来源与目标相同（${to}），无需迁移。`);
  process.exit(0);
}
if (!fs.existsSync(from)) {
  console.log(`来源目录不存在：${from}，没有可迁移的站点经验。`);
  process.exit(0);
}

const files = fs.readdirSync(from).filter((name) => name.endsWith(".md"));
if (!files.length) {
  console.log(`${from} 下没有 .md 站点经验，无需迁移。`);
  process.exit(0);
}

if (!opts.dryRun) fs.mkdirSync(to, { recursive: true });

let copied = 0;
const conflicts = [];
for (const name of files) {
  const target = path.join(to, name);
  if (fs.existsSync(target)) {
    conflicts.push(name);
    continue;
  }
  if (!opts.dryRun) fs.copyFileSync(path.join(from, name), target);
  copied++;
}

console.log(`${opts.dryRun ? "将复制" : "已复制"} ${copied} 个文件：${from} → ${to}`);
if (conflicts.length) {
  console.log(`目标已存在、未覆盖 ${conflicts.length} 个：${conflicts.join(", ")}`);
}
if (copied && !opts.dryRun) {
  console.log("旧目录未删除；确认新位置内容无误后自行清理即可。");
}
