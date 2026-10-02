// 单独渲染一个工程的指定帧，排查渲染环境是否可用
const path = require("node:path");
const fs = require("node:fs");
const ROOT = path.resolve(__dirname, "..");
const project = process.argv[2];
const frame = Number(process.argv[3] || 30);
const dir = path.join(ROOT, project);
const cfg = JSON.parse(fs.readFileSync(path.join(dir, "film.config.json"), "utf8"));
const out = path.join(dir, "out", "__probe.png");
(async () => {
  const { bundle } = require("@remotion/bundler");
  const { selectComposition, renderStill } = require("@remotion/renderer");
  const serveUrl = await bundle({ entryPoint: path.join(dir, "src", "index.ts"), publicDir: path.join(dir, "public") });
  const comp = await selectComposition({ serveUrl, id: cfg.id, inputProps: {} });
  console.log("composition:", comp.id, comp.width + "x" + comp.height, comp.durationInFrames, "frames");
  await renderStill({ serveUrl, composition: comp, frame, output: out, imageFormat: "png", inputProps: {} });
  console.log("renderStill 已 resolve");
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(out)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log("渲染成功:", out, fs.statSync(out).size, "字节");
})().catch((e) => {
  console.error("渲染失败:", e && e.stack ? e.stack.slice(0, 1500) : e);
  process.exit(1);
});
