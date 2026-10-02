#!/usr/bin/env node
// 审计：找出生成工程里「同一个标识符被 import 两次」的组件文件。
// 背景：AI 偶尔会写两条 from "remotion" 的 import（第二条单独导入 interpolate），
// 而修复逻辑只认第一条，导致 `import { interpolate } from "../safeInterp"` +
// `import { interpolate } from "remotion"` 并存 → vite/babel 直接
// "Identifier 'interpolate' has already been declared"，预览整页报错。
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIR = new Set([
  "node_modules", ".git", ".workbuddy", "out", "dist", "build",
  "web", "generator", "scripts", "视频", "public",
]);

function walk(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name) || e.name.startsWith(".tsc-check-") || e.name.startsWith(".")) continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
}

// 解析一条 import 语句里声明的本地标识符
function localNames(spec) {
  const names = [];
  const brace = spec.match(/\{([\s\S]*)\}/);
  if (brace) {
    for (const raw of brace[1].split(",")) {
      const t = raw.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.push((as[1] || as[0]).trim());
    }
  }
  const head = spec.replace(/\{[\s\S]*\}/, "").replace(/,\s*$/, "").trim();
  if (head) names.push(head.split(/\s+as\s+/).pop().trim());
  return names.filter(Boolean);
}

function inspect(code) {
  const re = /^[ \t]*import\s+([^;]*?)\s+from\s*["']([^"']+)["']/gm;
  const seen = new Map(); // 本地名 → 模块
  const dups = [];
  let m;
  while ((m = re.exec(code)) !== null) {
    for (const n of localNames(m[1])) {
      if (seen.has(n)) dups.push(`${n}（${seen.get(n)} 与 ${m[2]}）`);
      else seen.set(n, m[2]);
    }
  }
  return dups;
}

function main() {
  const files = [];
  for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (d.isDirectory() && !SKIP_DIR.has(d.name) && !d.name.startsWith(".")) {
      walk(path.join(ROOT, d.name), files);
    }
  }
  const byProject = new Map();
  for (const f of files) {
    const dups = inspect(fs.readFileSync(f, "utf8"));
    if (!dups.length) continue;
    const proj = path.relative(ROOT, f).split(/[\\/]/)[0];
    if (!byProject.has(proj)) byProject.set(proj, []);
    byProject.get(proj).push(`${path.relative(ROOT, f).replace(/\\/g, "/")} → ${[...new Set(dups)].join("; ")}`);
  }
  const total = [...byProject.values()].reduce((a, b) => a + b.length, 0);
  console.log(`扫描 ${files.length} 个 .tsx/.ts 文件：${total} 个文件存在重复导入标识符`);
  if (!total) return 0;
  for (const [proj, list] of byProject) {
    console.log(`\n【${proj}】`);
    for (const l of list) console.log("  " + l);
  }
  return 1;
}

if (require.main === module) process.exit(main());
module.exports = { inspect, localNames };
