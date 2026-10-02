#!/usr/bin/env node
// 生成工程「组件可编译」检查：把 src/**/*.tsx 过一遍 Babel（与 vite 的 react-babel 同一套），
// 提前抓出让预览整页白屏的声明 / 语法错误。
//
// ⚠️ 必须用 Babel，不能用 esbuild：
//    对 `import { interpolate } from "../safeInterp";` + `import { interpolate } from "remotion";`
//    esbuild 转换**静默通过**（实测），只有 Babel 会抛
//    `Identifier 'interpolate' has already been declared. (4:9)`
//    而 vite 开发态走 Babel —— 所以这类错打包不报、浏览器里直接白屏。
//
// 用法：node scripts/check-generated-syntax.cjs [工程名...]
//   不带参数 = 检查所有生成工程
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIR = new Set(["node_modules", ".git", ".workbuddy", "out", "dist", "build", "web", "generator", "scripts", "视频", "public"]);

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

function makeBabelTransform() {
  const babel = require("@babel/core");
  return (code, file) =>
    babel.transformSync(code, {
      filename: file,
      babelrc: false,
      configFile: false,
      code: false,          // 只要语法/作用域校验，不需要产物
      ast: false,
      sourceMaps: false,
      sourceType: "module",
      parserOpts: { plugins: ["typescript", "jsx"], sourceType: "module" },
    });
}

function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const files = [];
  for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!d.isDirectory() || SKIP_DIR.has(d.name) || d.name.startsWith(".")) continue;
    if (only.length && !only.includes(d.name)) continue;
    walk(path.join(ROOT, d.name), files);
  }
  const sceneish = files.filter((f) => /[\\/]src[\\/]/.test(f));
  if (!sceneish.length) {
    console.log("没找到生成工程里的 src 组件");
    return 0;
  }

  const transform = makeBabelTransform();
  console.log(`用 Babel（同 vite react-babel 管线）检查 ${sceneish.length} 个组件…\n`);

  const bad = [];
  for (const f of sceneish) {
    const code = fs.readFileSync(f, "utf8");
    try {
      transform(code, f.replace(/\\/g, "/"));
    } catch (e) {
      const msg = String(e.message || e).split("\n")[0].replace(ROOT, "").replace(/\\/g, "/").trim();
      bad.push(`${path.relative(ROOT, f).replace(/\\/g, "/")} → ${msg}`);
    }
  }

  if (!bad.length) {
    console.log(`✓ ${sceneish.length} 个组件全部通过 Babel 转换，没有会让预览白屏的声明/语法错误`);
    return 0;
  }
  console.log(`✗ ${bad.length} 个组件无法转换：`);
  for (const b of bad) console.log("  " + b);
  console.log("\n提示：重复导入可用 `node scripts/fix-duplicate-imports.cjs --write` 修复");
  return 1;
}

process.exit(main());
