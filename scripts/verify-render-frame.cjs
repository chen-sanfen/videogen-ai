/**
 * 服务端渲染路径验证：直接对指定工程的「出错帧」做一次真实渲染。
 * 预览修好了不代表导出修好了——两边虽然消费同一份组件代码，但打包器不同
 * （预览走 Vite dev，导出走 Remotion 自己的 bundler），必须分别验一遍。
 *
 * 用法：node scripts/verify-render-frame.cjs [工程名] [帧号,帧号,...]
 *   默认 allterrainmechamemphis 46,47,50（首例 inputRange 崩溃发生在 scene1 第 45~55 帧）
 */
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const PROJECT = process.argv[2] || "allterrainmechamemphis";
const FRAMES = (process.argv[3] || "46,47,50").split(",").map((n) => Number(n.trim()));

(async () => {
  const { bundle } = require("@remotion/bundler");
  const { selectComposition, renderStill } = require("@remotion/renderer");

  const entry = path.join(ROOT, PROJECT, "src", "index.ts");
  if (!fs.existsSync(entry)) throw new Error(`找不到入口 ${entry}`);
  const preview = JSON.parse(fs.readFileSync(path.join(ROOT, PROJECT, "preview.json"), "utf8"));

  const outDir = path.join(ROOT, "out", ".render-check", PROJECT);
  console.log(`打包 ${PROJECT} …`);
  const serveUrl = await bundle({
    entryPoint: entry,
    outDir,
    publicDir: path.join(ROOT, PROJECT, "public"),
    onProgress: () => {},
  });
  const composition = await selectComposition({ serveUrl, id: preview.compositionId, inputProps: {} });
  console.log(`Composition ${composition.id} · ${composition.durationInFrames} 帧（${preview.totalFrames} 帧配置）`);

  let failed = 0;
  for (const frame of FRAMES) {
    const out = process.env.KEEP
      ? path.join(ROOT, "out", `${PROJECT}-frame-${frame}.png`)
      : path.join(outDir, `frame-${frame}.png`);
    try {
      await renderStill({ composition, serveUrl, output: out, frame, inputProps: {} });
      console.log(`✅ 第 ${frame} 帧渲染成功 → ${path.relative(ROOT, out)}`);
    } catch (e) {
      failed++;
      console.log(`❌ 第 ${frame} 帧渲染失败：${String(e.message).split("\n")[0]}`);
    }
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  console.log(failed ? `\n${failed}/${FRAMES.length} 帧失败` : `\n${FRAMES.length} 帧全部渲染通过（导出链路无插值崩溃）`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("验证失败:", e.message);
  process.exit(1);
});
