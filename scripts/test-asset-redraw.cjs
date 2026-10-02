#!/usr/bin/env node
// scripts/test-asset-redraw.cjs
// 素材「AI 重绘」的离线回归：断言不依赖真实网络与 LLM 额度。
//
// 覆盖：
//   1) 三态解析（reference / direct / redraw，非法值回落 reference）
//   2) 特征提取输入（九宫格 → 文本描述）
//   3) brief 解析与清洗（含非法 JSON / 缺字段 / 颜色不合法的兜底）
//   4) SVG 校验闸：畸形、带脚本、带外链、图形过少都要被拦（反向用例是本测试的重点）
//   5) 位图路径：配了 IMAGE_API_BASE 才走；失败要能降级
//   6) 批量重绘：图片被替换、视频与无文件素材 passthrough、失败回退原素材
//   7) codegen 侧：redraw 模式同样允许素材进画面（allowMedia 等价 direct）

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("../generator/asset-redraw.js");

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
};
// 异步断言：主体包在 async IIFE 里，调用处逐个 await，否则统计会在断言跑完前就打印
const ta = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "redraw-"));

(async () => {
/* ============================================================
 * 1. 三态解析（与 server.mjs 的 parseAssetMode 同逻辑）
 * ============================================================ */
function parseAssetMode(v) {
  return v === "direct" || v === "redraw" ? v : "reference";
}

console.log("\n[1] 素材用法三态解析");
t("direct → direct", () => assert.strictEqual(parseAssetMode("direct"), "direct"));
t("redraw → redraw", () => assert.strictEqual(parseAssetMode("redraw"), "redraw"));
t("reference → reference", () => assert.strictEqual(parseAssetMode("reference"), "reference"));
t("未传 / 非法值回落 reference", () => {
  assert.strictEqual(parseAssetMode(undefined), "reference");
  assert.strictEqual(parseAssetMode(null), "reference");
  assert.strictEqual(parseAssetMode(""), "reference");
  assert.strictEqual(parseAssetMode("REDRAW"), "reference"); // 大小写敏感，非法即回落
  assert.strictEqual(parseAssetMode({}), "reference");
});

/* ============================================================
 * 2. 特征提取输入
 * ============================================================ */
console.log("\n[2] 特征 → 提取输入");
t("九宫格描述含位置与明暗", () => {
  const g = Array.from({ length: 9 }, (_, i) => ({ color: i === 4 ? "#ff8800" : "#101418", lum: i === 4 ? 0.8 : 0.2, sat: i === 4 ? 0.9 : 0.1 }));
  const s = R.describeGrid(g);
  assert.ok(s.includes("正中:#ff8800"), `正中格没描述出来: ${s}`);
  assert.ok(s.includes("亮") && s.includes("暗"), `缺少明暗描述: ${s}`);
  assert.ok(s.includes("高饱和"), `缺少饱和度描述: ${s}`);
});
t("网格缺失 / 长度不对时返回空串而不是崩", () => {
  assert.strictEqual(R.describeGrid(null), "");
  assert.strictEqual(R.describeGrid([]), "");
  assert.strictEqual(R.describeGrid([{ color: "#fff" }]), "");
});
t("提取输入包含尺寸 / 主色 / 明度 / 网址信息", () => {
  const s = R.buildExtractionInput({
    kind: "url",
    url: "https://example.com/p/1",
    host: "example.com",
    title: "一杯手冲咖啡",
    width: 1200,
    height: 800,
    palette: ["#333333", "#c89b6a"],
    brightness: 0.42,
    grid: Array.from({ length: 9 }, () => ({ color: "#333", lum: 0.4, sat: 0.3 })),
  });
  assert.ok(s.includes("1200x800"), s);
  assert.ok(s.includes("#c89b6a"), s);
  assert.ok(s.includes("0.42"), s);
  assert.ok(s.includes("一杯手冲咖啡"), s);
});
t("视频 / 无特征的素材也能产出非空输入", () => {
  const s = R.buildExtractionInput({ kind: "image", label: "logo.png", file: "a-1.png" });
  assert.ok(s.includes("logo.png"), s);
});

/* ============================================================
 * 3. brief 解析与清洗
 * ============================================================ */
console.log("\n[3] 元素提取结果解析");
t("纯 JSON 可解析", () => {
  const b = R.parseBrief('{"subject":"一杯咖啡","palette":["#111111"]}');
  assert.strictEqual(b.subject, "一杯咖啡");
});
t("带 markdown 围栏可解析", () => {
  const b = R.parseBrief('```json\n{"subject":"相机"}\n```');
  assert.strictEqual(b.subject, "相机");
});
t("前后有废话可解析", () => {
  const b = R.parseBrief('好的，分析结果如下：\n{"subject":"相机"}\n希望有帮助');
  assert.strictEqual(b.subject, "相机");
});
t("完全非法 → null（上层会走兜底）", () => {
  assert.strictEqual(R.parseBrief("我不是 JSON"), null);
  assert.strictEqual(R.parseBrief(""), null);
  assert.strictEqual(R.parseBrief(null), null);
});
t("缺字段时用兜底补上 subject / palette / redrawPrompt", () => {
  const b = R.sanitizeBrief({ composition: "居中" }, { label: "x.png" });
  assert.ok(b.subject && b.subject.length > 0, "subject 缺失");
  assert.ok(b.palette.length >= 3, "palette 缺失");
  assert.ok(b.redrawPrompt.length > 20, "redrawPrompt 缺失");
  assert.strictEqual(b.composition, "居中");
});
t("非法颜色被过滤、超长文案被截断", () => {
  const b = R.sanitizeBrief(
    { subject: "猫".repeat(500), palette: ["#zzzzzz", "#123456", "rgb(1,2,3)"], elements: ["a".repeat(200)] },
    { label: "cat.png" }
  );
  assert.ok(b.subject.length <= 200, `subject 没截断: ${b.subject.length}`);
  assert.deepStrictEqual(b.palette, ["#123456"]);
  assert.ok(b.elements[0].length <= 60);
});
t("兜底 brief 自带英文绘图提示词", () => {
  const fb = R.fallbackBrief({ kind: "image", label: "desk.png", palette: ["#222222", "#dddddd"] });
  assert.ok(/Flat vector illustration/.test(fb.redrawPrompt), fb.redrawPrompt);
  assert.ok(fb.redrawPrompt.includes("#222222"), fb.redrawPrompt);
  assert.strictEqual(fb.degraded, true);
});

/* ============================================================
 * 4. SVG 校验闸（反向用例）
 * ============================================================ */
console.log("\n[4] 矢量重绘校验（重点是反向用例）");
const goodSvg = (extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="1600" height="900">${extra}` +
  `<rect x="0" y="0" width="1600" height="900" fill="#11131a"/>` +
  `<circle cx="800" cy="450" r="220" fill="#9b8cff"/>` +
  `<path d="M100 800 L400 700 L700 800 Z" fill="#6dd8ff"/>` +
  `<rect x="120" y="120" width="300" height="180" fill="#75e1a0"/>` +
  `<ellipse cx="1300" cy="600" rx="180" ry="120" fill="#ffbd7c"/>` +
  `<polygon points="900,200 1100,300 900,400" fill="#f59ee1"/>` +
  `</svg>`;

t("合法 SVG 通过", () => assert.strictEqual(R.sanitizeSvg(goodSvg()).ok, true));
t("带 markdown 围栏的合法 SVG 通过", () =>
  assert.strictEqual(R.sanitizeSvg("```svg\n" + goodSvg() + "\n```").ok, true));
t("XML 声明 + 前缀噪声也能通过", () =>
  assert.strictEqual(R.sanitizeSvg('<?xml version="1.0"?>\n说明：如下\n' + goodSvg()).ok, true));
t("缺 xmlns 时自动补上", () => {
  const r = R.sanitizeSvg(goodSvg().replace('<svg xmlns="http://www.w3.org/2000/svg"', "<svg"));
  assert.strictEqual(r.ok, true);
  assert.ok(r.svg.includes("xmlns="));
});
// —— 反向用例：这些必须被拦下，否则 <Img> 会裂图或引入外链 ——
t("拦下：没有 svg 根元素", () => assert.strictEqual(R.sanitizeSvg("<html></html>").ok, false));
t("拦下：未闭合", () => assert.strictEqual(R.sanitizeSvg(goodSvg().replace("</svg>", "")).ok, false));
t("拦下：缺 viewBox", () =>
  assert.strictEqual(R.sanitizeSvg(goodSvg().replace('viewBox="0 0 1600 900" ', "")).ok, false));
t("拦下：含 <script>", () =>
  assert.strictEqual(R.sanitizeSvg(goodSvg("<script>alert(1)</script>")).ok, false));
t("拦下：含事件属性", () =>
  assert.strictEqual(R.sanitizeSvg(goodSvg('<rect onclick="x" width="10" height="10"/>')).ok, false));
t("拦下：含外部 URL", () => {
  assert.strictEqual(R.sanitizeSvg(goodSvg('<image href="https://x.com/a.png"/>')).ok, false);
  assert.strictEqual(R.sanitizeSvg(goodSvg('<rect fill="url(https://x.com/a.svg#g)"/>')).ok, false);
});
t("拦下：foreignObject", () =>
  assert.strictEqual(R.sanitizeSvg(goodSvg("<foreignObject><div/></foreignObject>")).ok, false));
t("拦下：图形元素过少（空壳画面）", () =>
  assert.strictEqual(
    R.sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="10" height="10"/></svg>').ok,
    false
  ));
t("拦下：体积过大", () => {
  const big = goodSvg(Array.from({ length: 9000 }, (_, i) => `<circle cx="${i % 1600}" cy="10" r="2" fill="#fff"/>`).join(""));
  const r = R.sanitizeSvg(big);
  assert.strictEqual(r.ok, false);
  assert.ok(/体积过大/.test(r.reason), r.reason);
});
t("拦下：空内容 / 非字符串", () => {
  assert.strictEqual(R.sanitizeSvg("").ok, false);
  assert.strictEqual(R.sanitizeSvg("   ").ok, false);
  assert.strictEqual(R.sanitizeSvg(null).ok, false);
  assert.strictEqual(R.sanitizeSvg(123).ok, false);
});

/* ============================================================
 * 5. 位图路径
 * ============================================================ */
console.log("\n[5] 位图路径（外部图像 API）");
const brief = { redrawPrompt: "flat vector coffee cup" };
await ta("未配置 IMAGE_API_BASE 时不发请求（走矢量降级）", async () => {
  const cfg = R.config();
  if (cfg.IMAGE_API_BASE) {
    console.log("      （本机配置了 IMAGE_API_BASE，跳过此断言）");
    return;
  }
  let called = false;
  const r = await R.generateBitmap(brief, { fetchImpl: async () => { called = true; throw new Error("不该被调用"); }, apiKey: "k" });
  assert.strictEqual(r, null);
  assert.strictEqual(called, false);
});
await ta("返回 b64_json 时能解出 buffer", async () => {
  // 直接调内部函数需要配置，这里用注入的方式模拟：临时改写环境变量后重新加载模块
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const out = await R.generateBitmap(brief, {
    apiKey: "k",
    base: "https://img.test",
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ b64_json: png.toString("base64") }] }) }),
  });
  assert.ok(out && out.buffer && out.buffer.equals(png), "b64 解码不对");
  assert.strictEqual(out.ext, ".png");
});
await ta("返回 url 时下载并落盘 content-type 对应扩展名", async () => {
  const bytes = Buffer.alloc(2048, 7);
  const out = await R.generateBitmap(brief, {
    apiKey: "k",
    base: "https://img.test",
    fetchImpl: async (u) =>
      u.includes("/generations")
        ? { ok: true, json: async () => ({ data: [{ url: "https://img.test/f.png" }] }) }
        : { ok: true, headers: { get: () => "image/webp" }, arrayBuffer: async () => bytes },
  });
  assert.strictEqual(out.ext, ".webp");
  assert.strictEqual(out.buffer.length, 2048);
});
await ta("HTTP 400 时去掉 size 重试一次，仍失败返回 null", async () => {
  const seen = [];
  const out = await R.generateBitmap(brief, {
    apiKey: "k",
    base: "https://img.test",
    fetchImpl: async (u, o) => {
      seen.push(JSON.parse(o.body).size ? "with-size" : "no-size");
      return { ok: false, status: 400, text: async () => "bad size" };
    },
  });
  assert.deepStrictEqual(seen, ["with-size", "no-size"]);
  assert.strictEqual(out, null);
});
await ta("非 400 的错误直接放弃（不重试）", async () => {
  let calls = 0;
  const out = await R.generateBitmap(brief, {
    apiKey: "k",
    base: "https://img.test",
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 401, text: async () => "unauthorized" };
    },
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(out, null);
});

/* ============================================================
 * 6. 批量重绘：替换 / passthrough / 回退
 * ============================================================ */
console.log("\n[6] 批量重绘行为");
const svgOut = goodSvg();
const mkAssets = () => [
  { kind: "image", file: "cat-1.png", absPath: path.join(tmp, "cat-1.png"), label: "cat.png", palette: ["#333"], width: 800, height: 600 },
  { kind: "video", file: "clip-2.mp4", absPath: path.join(tmp, "clip-2.mp4"), label: "clip.mp4" },
  { kind: "url", file: "", absPath: "", url: "https://a.com", title: "无主图的网页" },
];
fs.writeFileSync(path.join(tmp, "cat-1.png"), Buffer.alloc(4096, 1));
fs.writeFileSync(path.join(tmp, "clip-2.mp4"), Buffer.alloc(4096, 2));

const mockLLM = (mapFn) => async (apiKey, system, user) => {
  const fake = mapFn(system, user);
  if (fake === undefined) throw new Error("mock: 不该调用");
  return fake;
};

await ta("矢量路径：图片被重绘件替换，视频与无文件素材原样保留", async () => {
  const r = await R.redrawAssets(mkAssets(), {
    apiKey: "k",
    outDir: path.join(tmp, "out1"),
    styleContext: "视频主题：一杯咖啡",
    callLLM: mockLLM((system) => (system.includes("视觉素材分析师") ? JSON.stringify({ subject: "一只猫", palette: ["#333333"], redrawPrompt: "flat cat" }) : svgOut)),
  });
  const [img, video, url] = r.assets;
  assert.strictEqual(img.redrawn, true, "图片应被重绘");
  assert.strictEqual(img.redrawKind, "vector");
  assert.strictEqual(img.originalFile, "cat-1.png", "要保留原始素材名");
  assert.notStrictEqual(img.file, "cat-1.png");
  assert.ok(/\.svg$/.test(img.file), img.file);
  assert.ok(fs.existsSync(img.absPath), "重绘件必须落盘");
  assert.ok(img.redrawNote.includes("一只猫"), img.redrawNote);
  assert.strictEqual(video.file, "clip-2.mp4", "视频不应被改");
  assert.strictEqual(video.redrawn, undefined);
  assert.strictEqual(url.file, "", "无文件素材保持原样");
  assert.deepStrictEqual(
    r.report.map((x) => x.kind),
    ["vector", "passthrough-video", "passthrough-nofile"]
  );
});
await ta("位图优先：配了图像 API 就出位图，不再生成 SVG", async () => {
  const png = Buffer.alloc(8192, 9);
  let svgAsked = false;
  const r = await R.redrawAssets(mkAssets(), {
    apiKey: "k",
    imageApiBase: "https://img.test",
    outDir: path.join(tmp, "out2"),
    callLLM: mockLLM((system) => {
      if (system.includes("视觉素材分析师")) return JSON.stringify({ subject: "一只猫", redrawPrompt: "flat cat" });
      svgAsked = true;
      return svgOut;
    }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ b64_json: png.toString("base64") }] }) }),
  });
  assert.strictEqual(r.assets[0].redrawKind, "bitmap");
  assert.ok(/\.png$/.test(r.assets[0].file), r.assets[0].file);
  assert.strictEqual(svgAsked, false, "走了位图就不该再调 SVG");
});
await ta("位图失败 → 自动降级矢量", async () => {
  const r = await R.redrawAssets(mkAssets(), {
    apiKey: "k",
    imageApiBase: "https://img.test",
    outDir: path.join(tmp, "out3"),
    callLLM: mockLLM((system) => (system.includes("视觉素材分析师") ? JSON.stringify({ subject: "一只猫", redrawPrompt: "flat cat" }) : svgOut)),
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }),
  });
  assert.strictEqual(r.assets[0].redrawKind, "vector", "位图失败应降级矢量");
});
await ta("SVG 不合法 → 回退原素材（不阻断生成）", async () => {
  const r = await R.redrawAssets(mkAssets(), {
    apiKey: "k",
    outDir: path.join(tmp, "out4"),
    callLLM: mockLLM((system) => (system.includes("视觉素材分析师") ? JSON.stringify({ subject: "一只猫", redrawPrompt: "flat cat" }) : "```svg\n<svg>坏掉的</svg>\n```")),
  });
  assert.strictEqual(r.assets[0].file, "cat-1.png", "应回退原素材");
  assert.strictEqual(r.assets[0].redrawFailed, true);
  assert.strictEqual(r.report[0].kind, "fallback");
});
await ta("提取 LLM 挂了 → 用实测特征兜底，仍继续重绘", async () => {
  const r = await R.redrawAssets(mkAssets(), {
    apiKey: "k",
    outDir: path.join(tmp, "out5"),
    callLLM: mockLLM((system) => {
      if (system.includes("视觉素材分析师")) throw new Error("LLM 500");
      return svgOut;
    }),
  });
  assert.strictEqual(r.assets[0].redrawn, true);
  assert.strictEqual(r.report[0].subject.length > 0, true);
});
await ta("整件素材异常 → 回退且不牵连其它素材", async () => {
  const r = await R.redrawAssets(mkAssets(), {
    apiKey: "k",
    outDir: path.join(tmp, "out6"),
    callLLM: mockLLM(() => {
      throw new Error("全挂了");
    }),
  });
  assert.strictEqual(r.assets[0].file, "cat-1.png");
  assert.strictEqual(r.assets[1].file, "clip-2.mp4");
  assert.strictEqual(r.assets.length, 3, "素材数量不能变");
});
await ta("空素材列表安全返回", async () => {
  const r = await R.redrawAssets([], { apiKey: "k", outDir: path.join(tmp, "out7"), callLLM: mockLLM(() => "") });
  assert.deepStrictEqual(r.assets, []);
  assert.deepStrictEqual(r.report, []);
});

/* ============================================================
 * 7. codegen 侧：redraw 与 direct 一样允许素材进画面
 * ============================================================ */
console.log("\n[7] codegen 侧模式判定");
const cgSrc = fs.readFileSync(path.join(__dirname, "..", "generator", "codegen.js"), "utf8");
t("allowMedia 同时接受 direct 与 redraw", () => {
  assert.ok(/assetMode === "direct" \|\| assetMode === "redraw"/.test(cgSrc), "allowMedia 没有覆盖 redraw");
});
t("assetsBrief 的进画面分支覆盖 redraw", () => {
  assert.ok(/if \(mode === "direct" \|\| mode === "redraw"\) \{\n    const noFileUrl/.test(cgSrc), "直用/重绘分支没合并");
});
t("重绘件在简报里带出原始素材与提取结果", () => {
  assert.ok(/这是 AI 重绘件/.test(cgSrc), "简报没说明重绘件来源");
});
t("重绘模式的文案要求模型不要弃用重绘件", () => {
  assert.ok(/重绘件的用法/.test(cgSrc), "缺少重绘件使用约束");
});
t("server 侧三态解析存在", () => {
  const s = fs.readFileSync(path.join(__dirname, "..", "web", "server.mjs"), "utf8");
  assert.ok(/function parseAssetMode/.test(s), "server.mjs 缺 parseAssetMode");
  assert.ok(/assetMode === "redraw" && assets\.length/.test(s), "server.mjs 没接重绘流程");
});
t("前端已换成三态分段并提交 grid", () => {
  const g = fs.readFileSync(path.join(__dirname, "..", "web", "Generator.tsx"), "utf8");
  assert.ok(/assetMode,/.test(g), "前端没提交 assetMode");
  assert.ok(/grid: a\.meta\?\.grid/.test(g), "前端没提交九宫格特征");
  assert.ok(/ASSET_MODES/.test(g), "前端没有三态定义");
  assert.ok(!/assetDirect/.test(g), "还残留 assetDirect 开关");
});
t("前端没有残留二态开关的文案", () => {
  const g = fs.readFileSync(path.join(__dirname, "..", "web", "Generator.tsx"), "utf8");
  assert.ok(!/gen-mode/.test(g), "还残留 gen-mode 类");
});

  console.log(`\n${"=".repeat(46)}\n  通过 ${pass} 项，失败 ${fail} 项\n${"=".repeat(46)}`);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  process.exit(fail ? 1 : 0);
})();
