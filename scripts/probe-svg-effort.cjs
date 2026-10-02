#!/usr/bin/env node
// 量一下「矢量重绘」在不同思考档位下的耗时与产出质量，给默认值定档。
// 会真实调用 LLM（每个档位一次）。
const fs = require("fs");
const path = require("path");
const { callLLM } = require("../generator/codegen.js");
const R = require("../generator/asset-redraw.js");

const apiKey = process.env.DEEPSEEK_API_KEY || fs.readFileSync(path.join(__dirname, "..", "generator", ".deepseek-key"), "utf8").trim();
const brief = {
  subject: "一个以深蓝色为背景的几何边框，正中央放置着明黄色的几何形状",
  elements: ["深蓝背景", "明黄几何主体", "撞色点缀"],
  composition: "主体居中，四周留白",
  palette: ["#f2c14e", "#2b3a67", "#e94f37"],
  mood: "活泼、几何感",
};
const userMsg = `【素材分析结果】\n主体：${brief.subject}\n主要元素：${brief.elements.join("、")}\n构图：${brief.composition}\n色板：${brief.palette.join(", ")}\n气质：${brief.mood}\n\n【视频调性】\nMemphis 风格玩具品牌\n\n请按要求输出 SVG 源码。`;
// 与 asset-redraw.js 里的 SVG_SYSTEM 同款要求（这里只关心档位差异，用同一份 system）
const svgSystem = fs
  .readFileSync(path.join(__dirname, "..", "generator", "asset-redraw.js"), "utf8")
  .split("const SVG_SYSTEM = `")[1]
  .split("`;")[0];

const efforts = process.argv.slice(2).length ? process.argv.slice(2) : ["minimal", "low"];

(async () => {
  for (const effort of efforts) {
    const tokens = Number(process.env.PROBE_TOKENS) || 16384;
    const t0 = Date.now();
    let raw = "";
    try {
      raw = await callLLM(apiKey, svgSystem, userMsg, tokens, 0.8, null, effort);
    } catch (e) {
      console.log(`\n[${effort}] 调用失败: ${e.message}`);
      continue;
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const chk = R.sanitizeSvg(raw);
    const shapes = (String(raw).match(/<(rect|circle|ellipse|path|polygon|polyline|line)\b/gi) || []).length;
    console.log(
      `\n[${effort}] ${dt}s · ${raw.length} 字符 · 图形 ${shapes} 个 · 校验 ${chk.ok ? "通过" : "拦下（" + chk.reason + "）"}`
    );
  }
})();
