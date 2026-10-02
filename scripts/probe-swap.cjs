/**
 * 单独验证「换素材」这一步到底有没有落到磁盘上、有没有被 bundle 吃到。
 *
 * 背景：渲染比对（正常素材 vs 换成全透明图）只有在两次 bundle 真的用了不同源码时才有效。
 * 一旦 swap 没生效，两张图会完全一样，于是报出"素材 0% 可见"的假阴性。
 * 这个脚本逐步骤打印事实，不再靠推理。
 *
 * 用法：node scripts/probe-swap.cjs <工程名> <场景号(1起)> <相对帧>
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..");
const { decodePng, diffRatio } = require("./lib-png-diff.cjs");

const [, , project, sceneNoArg, relFrameArg] = process.argv;
const sceneNo = Number(sceneNoArg || 2);
const relFrame = Number(relFrameArg || 60);
const projectDir = path.join(ROOT, project);
const cfg = JSON.parse(fs.readFileSync(path.join(projectDir, "film.config.json"), "utf8"));
const target = path.join(projectDir, "src", "scenes", `Scene${sceneNo}.tsx`);

const BLANK = "__blank.png";
const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);
const RE = /(staticFile\s*\(\s*["'`])assets\/[^"'`]+(["'`]\s*\))/g;
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);

// 绝对帧：按 cfg 的 overlap 规则复刻 timeline
const timeline = (() => {
  let cursor = 0;
  return cfg.scenes.map((s, i) => {
    const from = i === 0 ? 0 : cursor - (cfg.scenes[i - 1].overlap || 0);
    cursor = from + s.durationInFrames;
    return { from, durationInFrames: s.durationInFrames };
  });
})();
const absFrame = timeline[sceneNo - 1].from + relFrame;

const original = fs.readFileSync(target, "utf8");
const refs = original.match(RE);
console.log(`文件: ${path.relative(ROOT, target)}  sha=${sha(original)}`);
console.log(`引用的素材: ${refs ? refs.join(", ") : "(无)"}`);
console.log(`目标帧: 场景${sceneNo} 相对第 ${relFrame} 帧 → 绝对第 ${absFrame} 帧`);

const assetsDir = path.join(projectDir, "public", "assets");
fs.mkdirSync(assetsDir, { recursive: true });
const blankPath = path.join(assetsDir, BLANK);
if (!fs.existsSync(blankPath)) fs.writeFileSync(blankPath, BLANK_PNG);
console.log(`占位图: ${path.relative(ROOT, blankPath)} (${fs.statSync(blankPath).size} 字节)`);

const restore = () => fs.writeFileSync(target, original);
process.on("exit", restore);

(async () => {
  const { bundle } = require("@remotion/bundler");
  const { selectComposition, renderStill } = require("@remotion/renderer");
  const entry = path.join(projectDir, "src", "index.ts");
  const publicDir = path.join(projectDir, "public");
  const outDir = path.join(projectDir, "out", ".probe");
  fs.mkdirSync(outDir, { recursive: true });

  const renderOne = async (tag) => {
    const onDisk = fs.readFileSync(target, "utf8");
    console.log(`  [${tag}] 磁盘源码 sha=${sha(onDisk)}  ${onDisk === original ? "= 原文" : "= 已替换"}`);
    // 关缓存确保两次各自编译；不传 outDir，否则 public 会被拷到 public/ 子目录、staticFile 404
    const serveUrl = await bundle({ entryPoint: entry, publicDir, enableCaching: false });
    const comp = await selectComposition({ serveUrl, id: cfg.id, inputProps: {} });
    const frame = Math.min(absFrame, comp.durationInFrames - 1);
    const p = path.join(outDir, `${tag}.png`);
    await renderStill({ serveUrl, composition: comp, frame, output: p, imageFormat: "png", inputProps: {} });
    console.log(`  [${tag}] 渲染绝对第 ${frame} 帧 → ${path.relative(ROOT, p)} (${fs.statSync(p).size} 字节)`);
    return p;
  };

  // 变体 B：素材换成透明图
  fs.writeFileSync(target, original.replace(RE, `$1assets/${BLANK}$2`));
  const bp = await renderOne("blank");
  // 变体 A：正常素材
  restore();
  const ap = await renderOne("real");

  const { ratio, avgDelta } = diffRatio(decodePng(fs.readFileSync(ap)), decodePng(fs.readFileSync(bp)));
  console.log(`\n差异: ${(ratio * 100).toFixed(2)}% 像素变化，平均色差 ${avgDelta.toFixed(1)}`);
  console.log(ratio < 0.001 ? "⚠️ 两张图几乎完全相同 —— 要么素材真的没露出来，要么替换没生效（看上面的 sha）" : "✓ 正常");
})().catch((e) => {
  console.error("probe 失败:", String((e && e.message) || e).slice(0, 400));
  process.exitCode = 4;
});
