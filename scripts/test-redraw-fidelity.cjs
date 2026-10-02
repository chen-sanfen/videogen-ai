/* ============================================================
 * 素材重绘「保真」回归
 *
 * 用户反馈：「重绘效果不好，应该是抽取照片里的关键核心元素再重造，
 * 不偏离原本元素及其大体方向」。
 *
 * 根因：后端没有视觉模型，LLM 看不到原图，之前只拿到「5 个主色 + 平均明度 + 3x3 网格」
 * 这种全局统计 —— 里面几乎没有「主体是什么、在哪、什么形状」的信息，
 * 模型只能靠文件名自由发挥，于是画成了另一张图。
 *
 * 修法：用代码做真正的图像分析（浏览器端 canvas），把原图压成
 * 「16x9 色彩网格图 + 显著区域主体框 + 细节密度图 + 带占比的色板」交给模型，
 * 让它照着重建；画完再用代码量一次配色保真度，跑偏就带反馈重画一版。
 *
 * 本脚本离线验证这条链路（mock 掉 LLM，不联网、不烧额度）。
 * ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");

const R = require(path.join(__dirname, "..", "generator", "asset-redraw.js"));

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "redraw-fid-"));

/* ---- 造数据 ---- */
function mkMap(cols, rows, fill) {
  const cells = [];
  for (let i = 0; i < cols * rows; i++) cells.push(typeof fill === "function" ? fill(i) : fill);
  return { cols, rows, cells };
}
function mkAsset(over = {}) {
  return {
    kind: "image",
    file: "src.png",
    absPath: path.join(tmp, "src.png"),
    label: "智能音箱产品图",
    width: 1600,
    height: 900,
    palette: ["#ff8800", "#1a1a2e", "#fef6e4"],
    paletteRatio: [0.5, 0.3, 0.2],
    brightness: 0.62,
    subject: { x: 0.3, y: 0.5, w: 0.4, h: 0.35, cx: 0.5, cy: 0.72 },
    map: mkMap(16, 9, "#fef6e4"),
    detail: new Array(144).fill(0.2),
    ...over,
  };
}
// 生成一张能通过 sanitizeSvg 的 SVG，颜色按给定数组轮换
function mkSvg(colors) {
  const rects = [];
  rects.push(`<rect x="0" y="0" width="1600" height="900" fill="${colors[0]}" />`);
  for (let i = 0; i < 12; i++) {
    const c = colors[(i + 1) % colors.length];
    rects.push(`<rect x="${100 + i * 110}" y="${200 + (i % 3) * 90}" width="80" height="60" fill="${c}" />`);
  }
  for (let i = 0; i < 6; i++) {
    const c = colors[i % colors.length];
    rects.push(`<circle cx="${150 + i * 240}" cy="${420}" r="34" fill="${c}" />`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="1600" height="900">\n${rects.join(
    "\n"
  )}\n</svg>`;
}
const BRIEF_JSON = JSON.stringify({
  subject: "画面偏下的一台橙色智能音箱",
  elements: ["音箱主体", "底座", "背景墙面"],
  composition: "主体居中偏下，上方留白",
  layout: "主体位于画面中下部，横向 30%~70%，纵向 50%~85%",
  palette: ["#ff8800", "#1a1a2e", "#fef6e4"],
  mood: "温暖科技",
  redrawPrompt: "flat vector illustration of an orange smart speaker in the lower-center",
});

(async () => {
  console.log("\n[1] 色彩网格图（LLM 看不到原图，这张表就是它的眼睛）");

  await t("16x9 网格按行输出，行列数对得上", () => {
    const s = R.describeColorMap(mkMap(16, 9, "#aabbcc"), null);
    if (!s) throw new Error("返回空");
    const rows = s.split("\n").filter((l) => /第\d+行/.test(l));
    if (rows.length !== 9) throw new Error(`行数 ${rows.length}，应为 9`);
    const first = rows[0].split(/\s+/).filter((x) => /^#[0-9a-f]{6}$/.test(x));
    if (first.length !== 16) throw new Error(`每行色块 ${first.length} 个，应为 16`);
  });

  await t("网格尺寸与 cells 数量不符 → 拒绝（防止畸形数据撑爆提示词）", () => {
    if (R.describeColorMap({ cols: 16, rows: 9, cells: ["#aabbcc"] }, null) !== "") throw new Error("没拦下");
    if (R.describeColorMap(null, null) !== "") throw new Error("null 没拦下");
    if (R.describeColorMap({ cols: 0, rows: 0, cells: [] }, null) !== "") throw new Error("零尺寸没拦下");
  });

  await t("细节密度图尺寸不对就不输出（宁缺毋错）", () => {
    const withDetail = R.describeColorMap(mkMap(4, 3, "#aabbcc"), new Array(12).fill(0.5));
    if (!/细节密度图/.test(withDetail)) throw new Error("密度图没输出");
    const bad = R.describeColorMap(mkMap(4, 3, "#aabbcc"), new Array(5).fill(0.5));
    if (/细节密度图/.test(bad)) throw new Error("密度尺寸不符却输出了");
  });

  console.log("\n[2] 主体显著区域（主体在哪、多大）");

  await t("输出百分比区间与九宫格方位", () => {
    const s = R.describeSubjectBox({ x: 0.3, y: 0.5, w: 0.4, h: 0.35, cx: 0.5, cy: 0.72 });
    if (!s) throw new Error("返回空");
    // 横向 30%~(30+40)=70%，纵向 50%~(50+35)=85%
    for (const need of ["30%", "70%", "50%", "85%"]) {
      if (!s.includes(need)) throw new Error(`缺少 ${need}：${s}`);
    }
    if (!/中下/.test(s)) throw new Error(`方位不对：${s}`);
  });

  await t("主体在正中时说「正中」，不说「中中」", () => {
    const s = R.describeSubjectBox({ x: 0.25, y: 0.25, w: 0.5, h: 0.5, cx: 0.5, cy: 0.5 });
    if (!/正中/.test(s)) throw new Error(`措辞不对：${s}`);
  });

  await t("非法 / 缺失的框返回空，不污染提示词", () => {
    if (R.describeSubjectBox(null) !== "") throw new Error("null 没拦下");
    if (R.describeSubjectBox({ x: 0, y: 0, w: 0, h: 0 }) !== "") throw new Error("零面积没拦下");
    if (R.describeSubjectBox({ x: "x", y: 0, w: 0.5, h: 0.5 }) !== "") throw new Error("NaN 没拦下");
  });

  console.log("\n[3] 配色保真度（代码判定，不靠模型自评）");

  await t("照抄原图配色 → 保真度高（≥0.9）", () => {
    const a = mkAsset();
    const f = R.paletteFidelity(a, mkSvg(["#ff8800", "#1a1a2e", "#fef6e4"]));
    if (f === null) throw new Error("返回 null");
    if (f < 0.9) throw new Error(`保真度只有 ${f.toFixed(2)}`);
    console.log(`      （${(f * 100).toFixed(0)}%）`);
  });

  await t("整套换色 → 保真度低（<0.2），必须能被判为跑偏", () => {
    const a = mkAsset();
    const f = R.paletteFidelity(a, mkSvg(["#0000ff", "#00ffff", "#ff00ff"]));
    if (f === null) throw new Error("返回 null");
    if (f >= 0.2) throw new Error(`保真度 ${f.toFixed(2)} 偏高，换色没被识别出来`);
    console.log(`      （${(f * 100).toFixed(0)}%）`);
  });

  await t("只保留主色、丢了次要色 → 中间值（按占比加权）", () => {
    const a = mkAsset();
    const f = R.paletteFidelity(a, mkSvg(["#ff8800", "#ff8800", "#ff8800"]));
    if (f === null) throw new Error("返回 null");
    // 主色占比 0.5 保住、另两个丢了 → 约 0.5
    if (f < 0.35 || f > 0.7) throw new Error(`保真度 ${f.toFixed(2)} 不在预期的中间区间`);
    console.log(`      （${(f * 100).toFixed(0)}%）`);
  });

  await t("没有原图色板 → 返回 null（没有判据就不该瞎打分）", () => {
    const a = mkAsset({ palette: [], paletteRatio: [] });
    if (R.paletteFidelity(a, mkSvg(["#ff8800"])) !== null) throw new Error("应当返回 null");
  });

  await t("SVG 颜色提取覆盖 fill / stroke / stop-color / 内联 style", () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">` +
      `<rect width="1600" height="900" fill="#aabbcc" />` +
      `<path d="M0 0" stroke="#112233" />` +
      `<stop stop-color="#445566" />` +
      `<rect width="10" height="10" style="fill:#778899" />` +
      `</svg>`;
    const h = R.svgPalette(svg);
    for (const c of ["#aabbcc", "#112233", "#445566", "#778899"]) {
      if (!h.has(c)) throw new Error(`没提取到 ${c}`);
    }
  });

  console.log("\n[4] 提示词：从「自由创作」改成「照图重建」");

  await t("提取提示词要求：照抄配色与位置、严禁编造画面里没有的东西", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "generator", "asset-redraw.js"), "utf8");
    const seg = src.slice(src.indexOf("const EXTRACT_SYSTEM"), src.indexOf("// 从 LLM 响应里抠出 JSON"));
    for (const need of ["风格化重绘", "保真第一", "配色照抄", "位置照抄", "严禁"]) {
      if (!seg.includes(need)) throw new Error(`提取提示词缺「${need}」`);
    }
  });

  await t("绘制提示词含保真四条 + 网格图 + 主体坐标", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "generator", "asset-redraw.js"), "utf8");
    const seg = src.slice(src.indexOf("const SVG_SYSTEM"), src.indexOf("// AI 产出的 SVG 必须过这道闸"));
    for (const need of ["重绘 ≠ 重新创作", "主体位置与大小照抄", "明暗分布照抄", "配色照抄", "不新增元素"]) {
      if (!seg.includes(need)) throw new Error(`绘制提示词缺「${need}」`);
    }
  });

  await t("给绘图模型的 userMessage 里真的带上了网格图与主体框", () => {
    const input = R.buildExtractionInput(mkAsset());
    if (!/原图色彩网格图/.test(input)) throw new Error("缺色彩网格图");
    if (!/细节密度图/.test(input)) throw new Error("缺细节密度图");
    if (!/主体显著区域（实测）/.test(input)) throw new Error("缺主体框");
    if (!/#ff8800 50%/.test(input)) throw new Error("主色占比没写进去");
  });

  console.log("\n[5] 跑偏就重画一版（mock LLM，不联网）");

  await t("第一版配色跑偏 → 自动带反馈重画，最终采用更接近的一版", async () => {
    const calls = [];
    const badSvg = mkSvg(["#0000ff", "#00ffff", "#ff00ff"]);
    const goodSvg = mkSvg(["#ff8800", "#1a1a2e", "#fef6e4"]);
    let drawCount = 0;
    const callLLM = async (key, system, user) => {
      calls.push({ system, user });
      if (/矢量插画师/.test(system)) {
        drawCount++;
        return drawCount === 1 ? badSvg : goodSvg;
      }
      return BRIEF_JSON;
    };
    const r = await R.redrawOne(mkAsset(), {
      apiKey: "k",
      callLLM,
      outDir: tmp,
      styleContext: "科技感",
      log: () => {},
    });
    if (!r) throw new Error("重绘返回 null");
    if (drawCount !== 2) throw new Error(`绘制调用了 ${drawCount} 次，期望 2（跑偏应触发一次返工）`);
    const second = calls.filter((c) => /矢量插画师/.test(c.system))[1];
    if (!/跑偏/.test(second.user)) throw new Error("返工那一版没带「跑偏」反馈");
    if (!/原图实测色板/.test(second.user)) throw new Error("返工反馈里没把原图色板再给它");
    if (typeof r.fidelity !== "number") throw new Error("没返回保真度");
    if (r.fidelity < 0.9) throw new Error(`最终版保真度只有 ${r.fidelity.toFixed(2)}，应当采用更好的那版`);
    // 落盘的必须是保真度更高的那版
    const written = fs.readFileSync(r.absPath, "utf8");
    if (!written.includes("#ff8800")) throw new Error("落盘的不是更好的那版");
    console.log(`      （第一版 ${Math.round(R.paletteFidelity(mkAsset(), badSvg) * 100)}% → 最终 ${Math.round(r.fidelity * 100)}%）`);
  });

  await t("第一版就够像 → 不返工（不白烧额度）", async () => {
    let drawCount = 0;
    const callLLM = async (key, system) => {
      if (/矢量插画师/.test(system)) {
        drawCount++;
        return mkSvg(["#ff8800", "#1a1a2e", "#fef6e4"]);
      }
      return BRIEF_JSON;
    };
    const r = await R.redrawOne(mkAsset(), { apiKey: "k", callLLM, outDir: tmp, log: () => {} });
    if (!r) throw new Error("重绘返回 null");
    if (drawCount !== 1) throw new Error(`绘制调用了 ${drawCount} 次，期望 1`);
  });

  await t("没有原图色板可比 → 只画一版（没有判据就不反复烧额度）", async () => {
    let drawCount = 0;
    const callLLM = async (key, system) => {
      if (/矢量插画师/.test(system)) {
        drawCount++;
        return mkSvg(["#123456", "#654321"]);
      }
      return BRIEF_JSON;
    };
    const r = await R.redrawOne(mkAsset({ palette: [], paletteRatio: [] }), {
      apiKey: "k",
      callLLM,
      outDir: tmp,
      log: () => {},
    });
    if (!r) throw new Error("重绘返回 null");
    if (drawCount !== 1) throw new Error(`绘制调用了 ${drawCount} 次，期望 1`);
  });

  await t("结构性不合格（非配色问题）不返工，直接回退", async () => {
    let drawCount = 0;
    const callLLM = async (key, system) => {
      if (/矢量插画师/.test(system)) {
        drawCount++;
        return "<svg viewBox='0 0 10 10'><rect/></svg>"; // 元素太少，会被 sanitizeSvg 拦下
      }
      return BRIEF_JSON;
    };
    const r = await R.redrawOne(mkAsset(), { apiKey: "k", callLLM, outDir: tmp, log: () => {} });
    if (r !== null) throw new Error("应返回 null（回退原素材）");
    if (drawCount !== 1) throw new Error(`绘制调用了 ${drawCount} 次，期望 1（结构问题重画也没用）`);
  });

  console.log(`\n${"=".repeat(46)}\n  通过 ${pass} 项，失败 ${fail} 项\n${"=".repeat(46)}`);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  process.exit(fail ? 1 : 0);
})();
