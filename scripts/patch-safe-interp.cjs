/**
 * 存量工程插值安全网批量修补
 *
 * 背景：AI 生成的场景里 interpolate 的 inputRange 可能不是严格递增
 * （典型 [10 + i * 4, 22 + i * 4, 45, 55]，i 大一点就越过后面的固定帧），
 * Remotion 会抛 "inputRange must be strictly monotonically increasing" 让整个分镜白屏。
 * 生成器已对**新工程**注入 src/safeInterp.ts 并把 interpolate 改道；本脚本用同一套逻辑
 * 把**磁盘上已有的工程**也补一遍，老工程点预览/导出同样不会再崩。
 *
 * 用法：
 *   node scripts/patch-safe-interp.cjs            # 修补全部含 preview.json 的工程
 *   node scripts/patch-safe-interp.cjs <目录名>... # 只修补指定工程
 *   node scripts/patch-safe-interp.cjs --dry      # 只看会改哪些文件，不落盘
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const cg = require(path.join(ROOT, "generator", "codegen.js"));

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const only = argv.filter((a) => !a.startsWith("--"));

const SKIP = new Set([
  "node_modules",
  "out",
  "web",
  "web-dist",
  "generator",
  "scripts",
  "public",
  "src",
  "视频",
  ".workbuddy",
  ".git",
]);

// 只认「生成器产出的工程」：服务端就是这么筛的（有 film.config.json 或 preview.json）+ 有 src/
function isGeneratedProject(dir) {
  return (
    (fs.existsSync(path.join(dir, "film.config.json")) || fs.existsSync(path.join(dir, "preview.json"))) &&
    fs.existsSync(path.join(dir, "src")) &&
    fs.statSync(path.join(dir, "src")).isDirectory()
  );
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const projects = (only.length ? only : fs.readdirSync(ROOT).filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory()))
  .filter((d) => !SKIP.has(d))
  .map((d) => path.join(ROOT, d))
  .filter(isGeneratedProject);

if (!projects.length) {
  console.log("没有找到需要修补的工程（判定条件：目录下有 preview.json 与 src/）");
  process.exit(0);
}

let touched = 0;
let wroteShim = 0;

for (const proj of projects) {
  const name = path.basename(proj);
  const shimPath = path.join(proj, "src", "safeInterp.ts");
  const needShim = fs.existsSync(shimPath) ? fs.readFileSync(shimPath, "utf8") !== cg.SAFE_INTERP_MODULE : true;
  if (needShim) {
    if (!DRY) {
      fs.writeFileSync(shimPath, cg.SAFE_INTERP_MODULE, "utf8");
      wroteShim++;
    }
    console.log(`  [shim] ${name}/src/safeInterp.ts ${fs.existsSync(shimPath) ? "更新" : "新增"}`);
  }

  for (const file of walk(path.join(proj, "src"))) {
    const rel = path.relative(proj, file).split(path.sep).join("/"); // src/scenes/Scene1.tsx
    const src = fs.readFileSync(file, "utf8");
    const squeezed = cg.squeezeLiteralInputRanges(src);
    const routed = cg.routeInterpolateToSafe(rel, squeezed.code);
    if (!squeezed.fixed && !routed.moved.length && !routed.pathFixed) continue;
    if (!DRY) fs.writeFileSync(file, routed.code, "utf8");
    touched++;
    console.log(
      `  [fix] ${name}/${rel}` +
        (squeezed.fixed ? ` 字面量挤压 ${squeezed.fixed} 处` : "") +
        (routed.moved.length ? ` 改道 ${routed.moved.join("/")} → ${cg.safeInterpImportPath(rel)}` : "") +
        (routed.pathFixed ? ` 修正导入路径 ${routed.pathFixed} → ${cg.safeInterpImportPath(rel)}` : "")
    );
  }
}

console.log(
  `\n${DRY ? "[dry-run] " : ""}扫描 ${projects.length} 个工程 · 安全网文件 ${wroteShim} 个 · 改写源码 ${touched} 个文件`
);
