#!/usr/bin/env node
// 真实链路验证：拿一张真实图片走完整的「提取 → 重绘」，看落盘产物是否忠于原图。
// 会真实调用一次 LLM（元素提取 + SVG 绘制），只在需要验证真机效果时才跑。
//
// 关键：用 lib-image-facts 从原图算出真实特征（色板/占比/网格图/主体显著区域），
// 喂给重绘模块 —— 这样才能验证「重绘是否忠于原图」，而不是用假数据自欺。
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("../generator/asset-redraw.js");
const { decodePng } = require("./lib-png-diff.cjs");
const { extractFacts } = require("./lib-image-facts.cjs");

// 参数：probe-redraw-live.cjs [输入图] [--keep 产物保存路径]
const argv = process.argv.slice(2);
let keepPath = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--keep") {
    keepPath = argv[++i] || null;
    continue;
  }
  positional.push(argv[i]);
}
const SRC = positional[0] || path.join(__dirname, "..", "out", "avantgardetoymemphis-frame-60.png");
const apiKey =
  process.env.DEEPSEEK_API_KEY ||
  fs.readFileSync(path.join(__dirname, "..", "generator", ".deepseek-key"), "utf8").trim();

(async () => {
  const buf = fs.readFileSync(SRC);
  const img = decodePng(buf); // {w,h,bpp,data}
  const facts = extractFacts(img, { width: img.w, height: img.h });
  console.log("原图特征:");
  console.log("  尺寸      :", facts.width, "x", facts.height);
  console.log(
    "  主色+占比 :",
    facts.palette.map((c, i) => `${c}(${Math.round((facts.paletteRatio[i] || 0) * 100)}%)`).join("  ")
  );
  console.log("  明度      :", facts.brightness.toFixed(2));
  console.log("  主体区域  :", JSON.stringify(facts.subject));

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "redraw-live-"));
  const copy = path.join(outDir, "src.png");
  fs.copyFileSync(SRC, copy);

  const t0 = Date.now();
  const r = await R.redrawAssets(
    [
      {
        kind: "image",
        file: "src.png",
        absPath: copy,
        label: path.basename(SRC),
        width: facts.width,
        height: facts.height,
        palette: facts.palette,
        paletteRatio: facts.paletteRatio,
        brightness: facts.brightness,
        grid: facts.grid,
        subject: facts.subject,
        map: facts.map,
        detail: facts.detail,
      },
      { kind: "video", file: "clip.mp4", absPath: copy, label: "clip.mp4" },
    ],
    {
      apiKey,
      outDir,
      styleContext: "视频主题：Memphis 风格的玩具品牌宣传片，活泼、撞色、几何感",
    }
  );
  const a = r.assets[0];
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n────── 结果 ──────");
  console.log("耗时        :", dt + "s");
  console.log("产物        :", a.file, `(${(fs.statSync(a.absPath).size / 1024).toFixed(1)}KB)`);
  console.log("路径        :", a.redrawKind);
  console.log("提取到的主体:", a.redrawSubject || a.redrawNote);
  if (a.redrawPalette && a.redrawPalette.length) {
    console.log("重绘件色板  :", a.redrawPalette.join("  "));
  }
  console.log("视频素材    :", r.assets[1].file, "（应为 clip.mp4，未重绘）");

  // 保真度量化：重绘 SVG 的填充色是否与原图主色同源
  const svg = fs.readFileSync(a.absPath, "utf8");
  const fills = (svg.match(/fill=["'](#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|rgb\([^)]*\))["']/g) || [])
    .map((s) => s.replace(/^fill=["']/, "").replace(/["']$/, ""));
  const uniq = [...new Set(fills)];
  console.log("重绘件填充色数:", uniq.length);
  console.log("SVG 前 200 字  :", svg.slice(0, 200).replace(/\n/g, " "));

  if (keepPath) {
    const dest = path.resolve(keepPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(a.absPath, dest);
    console.log("产物已保留:", dest);
  }
  console.log("报告        :", JSON.stringify(r.report, null, 2));
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {}
})().catch((e) => {
  console.error("真实链路失败:", e);
  process.exit(1);
});
