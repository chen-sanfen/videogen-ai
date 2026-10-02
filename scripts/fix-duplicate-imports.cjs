#!/usr/bin/env node
// 修复已生成工程里的「重复声明」——只动 import 块与被遮蔽的自造声明，不改视觉代码。
//
// 覆盖两类（都会让 vite 预览整页白屏）：
//   A. 同一标识符 import 两次：
//        import { interpolate } from "../safeInterp";
//        import { interpolate } from "remotion";        ← Identifier already declared
//      成因：AI 把 interpolate 单独写成第二条 remotion import 时，
//            旧的「补 remotion import」逻辑把同名项补进第一条。
//   B. 自造兜底声明与顶部 import 撞名：
//        import { useCurrentFrame } from "remotion";
//        function useCurrentFrame() { ... }             ← Duplicate declaration
//
// 修复走的都是生成器内部同一套归一化函数，产物与「重新生成」一致。
//
// 用法：
//   node scripts/fix-duplicate-imports.cjs            # 只报告（dry-run，默认）
//   node scripts/fix-duplicate-imports.cjs --write    # 实际写盘
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");
const {
  routeInterpolateToSafe,
  dropShadowedApiDeclarations,
  dedupeImports,
} = require(path.join(ROOT, "generator/codegen.js"));

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
      if (SKIP_DIR.has(e.name) || e.name.startsWith(".")) continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
}

// 用 Babel 判定「能不能编译」——必须用 Babel，esbuild 会静默放过重复声明
function babelError(code, file) {
  try {
    require("@babel/core").transformSync(code, {
      filename: file, babelrc: false, configFile: false, code: false, ast: false,
      sourceMaps: false, sourceType: "module",
      parserOpts: { plugins: ["typescript", "jsx"], sourceType: "module" },
    });
    return null;
  } catch (e) {
    return String(e.message || e).split("\n")[0].replace(ROOT, "").trim();
  }
}

// 重复 import 标识符（只看 import 之间；声明 vs 导入由 dropShadowedApiDeclarations 负责）
function importDupNames(code) {
  const seen = new Set();
  const dup = [];
  for (const m of String(code).matchAll(/^[ \t]*import\s+([^;]*?)\s+from\s*["']([^"']+)["']/gm)) {
    const names = [];
    const b = m[1].match(/\{([\s\S]*)\}/);
    if (b) for (const s of b[1].split(",")) {
      const t = s.trim();
      if (t) names.push(t.split(/\s+as\s+/).pop().trim());
    }
    const head = m[1].replace(/\{[\s\S]*\}/, "").replace(/,\s*$/, "").trim();
    if (head) names.push(head.split(/\s+as\s+/).pop().trim());
    for (const n of names) {
      if (seen.has(n)) dup.push(n);
      else seen.add(n);
    }
  }
  return dup;
}

const files = [];
for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (d.isDirectory() && !SKIP_DIR.has(d.name) && !d.name.startsWith(".")) {
    walk(path.join(ROOT, d.name), files);
  }
}

let fixed = 0;
let manual = 0;
for (const abs of files) {
  const before = fs.readFileSync(abs, "utf8");
  if (!babelError(before, abs)) continue; // 本来就能编译，跳过

  const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
  const projectRoot = rel.split("/")[0];
  const fileInProject = rel.slice(projectRoot.length + 1); // src/scenes/Scene2.tsx

  const dupBefore = importDupNames(before);
  let next = routeInterpolateToSafe(fileInProject, before).code;
  const shadow = dropShadowedApiDeclarations(fileInProject, next);
  if (shadow.removed.length) next = shadow.code;

  const after = babelError(next, abs);
  if (after || next === before) {
    manual++;
    console.log(`  ⚠️ 需人工处理 ${rel}`);
    console.log(`      Babel: ${before === next ? babelError(before, abs) : after || "内容未变化"}`);
    continue;
  }

  console.log(`  ${WRITE ? "已修复" : "待修复"} ${rel}`);
  if (dupBefore.length) console.log(`      重复导入: ${[...new Set(dupBefore)].join(", ")}`);
  for (const r of shadow.removed) console.log(`      自造声明撞名: ${r}`);
  if (WRITE) fs.writeFileSync(abs, next, "utf8");
  fixed++;
}

console.log(
  `\n${WRITE ? "已修复" : "可修复"} ${fixed} 个文件` +
    (manual ? `，${manual} 个需人工处理` : "") +
    (WRITE ? "" : "\n（dry-run：加 --write 才会写盘）")
);
process.exit(manual ? 1 : 0);
