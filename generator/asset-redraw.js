#!/usr/bin/env node
// generator/asset-redraw.js
// 素材「AI 重绘」：把用户素材里的主要元素提取出来，再按视频风格重绘一张能直接进画面的图。
//
// 为什么需要这一层：
//   直接把用户照片铺进视频，常常和 AI 生成的矢量画面「两张皮」——写实照片 + 扁平插画，
//   色调、笔触、密度全不搭。重绘就是先把素材降维成「主体 / 构图 / 配色 / 气质」的描述，
//   再让 AI 用视频自己的风格重新画一遍，出来的东西既认得出是用户的素材，又长在片子里。
//
// 两条产出路径（用户可选「两者都要，优先位图」）：
//   1) 位图：配置了 IMAGE_API_BASE 就调外部图像生成 API（文生图 / 图生图），出 PNG。
//   2) 矢量：没配图像 API 时降级——让文本 LLM 直接产出一张自包含的 SVG 插画。
//      本平台画面本身就是代码绘制的，SVG 与视频风格天然同源，且不需要任何外部依赖。
//   两条都失败 → 回退成「直接使用原素材」，绝不阻断生成。
//
// 只处理图片（含网址抓下来的主图）。视频没法这样重绘（要抽帧 + 图生视频），保持直用。

const fs = require("fs");
const path = require("path");

// 图像 API（可选）：没配就自动走矢量降级
const IMAGE_API_BASE = String(process.env.IMAGE_API_BASE || "").replace(/\/+$/, "");
const IMAGE_API_KEY = process.env.IMAGE_API_KEY || "";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "";
const IMAGE_SIZE = process.env.IMAGE_SIZE || "1600x900";
// 视觉模型（可选）：配了就让它看图提取元素，比「特征 + 文字推断」准。默认关（网关无视觉模型）
const VISION_MODEL = process.env.IMAGE_VISION_MODEL || "";

const SVG_W = 1600;
const SVG_H = 900;
const SVG_MAX_BYTES = 200 * 1024;

/* ============================================================
 *  素材 → 结构化描述（给 LLM 看的输入）
 * ============================================================ */

// 色彩网格图 —— 「重绘不偏离原图」的核心依据。
// 后端没有视觉模型，LLM 永远看不到用户的照片；把原图压成 16x9 的色块地图喂给它，
// 它才能照着重建：主体在哪、什么颜色、明暗怎么分布，全都落在这张表里。
// 有了它，「重绘」才是重绘；没有它，模型只能靠文件名自由发挥，出来的就是另一张图。
function describeColorMap(map, detail) {
  if (!map || typeof map !== "object" || !Array.isArray(map.cells) || !map.cells.length) return "";
  const cols = Number(map.cols) || 0;
  const rows = Number(map.rows) || 0;
  if (cols <= 0 || rows <= 0 || map.cells.length !== cols * rows) return "";
  const lines = [`【原图色彩网格图】${cols} 列 × ${rows} 行，每格是该区域的平均色；坐标 (列,行) 从左上角 (0,0) 起：`];
  for (let y = 0; y < rows; y++) {
    lines.push(`  第${y}行 ${map.cells.slice(y * cols, (y + 1) * cols).join(" ")}`);
  }
  // 细节密度图：哪里是纹理密集的主体、哪里是干净的背景，一眼可辨
  if (Array.isArray(detail) && detail.length === cols * rows) {
    const dl = [];
    for (let y = 0; y < rows; y++) {
      dl.push(
        `  第${y}行 ` +
          detail
            .slice(y * cols, (y + 1) * cols)
            .map((v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 9))
            .join("")
      );
    }
    lines.push(`【细节密度图】同上网格，每格 0~9 表示纹理/边缘密度（0=平色块，9=强对比密集细节）：`);
    lines.push(...dl);
  }
  return lines.join("\n");
}

// 显著区域（主体）边界框 → 自然语言 + 九宫格方位
function describeSubjectBox(box) {
  if (!box || typeof box !== "object") return "";
  const pct = (v) => `${Math.round(Number(v) * 100)}%`;
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w);
  const h = Number(box.h);
  const cx = Number.isFinite(Number(box.cx)) ? Number(box.cx) : x + w / 2;
  const cy = Number.isFinite(Number(box.cy)) ? Number(box.cy) : y + h / 2;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return "";
  const zy = cy < 0.34 ? "上" : cy > 0.66 ? "下" : "中";
  const zx = cx < 0.34 ? "左" : cx > 0.66 ? "右" : "中";
  const zone = zy === "中" && zx === "中" ? "正中" : `${zx}${zy}`; // 中文习惯说「左下 / 中下」而非「下左 / 下中」
  return `主体显著区域（实测）：横向 ${pct(x)}~${pct(x + w)}、纵向 ${pct(y)}~${pct(y + h)}，` +
    `约占画面 ${pct(w * h)} 面积，重心在画面${zone}部（x=${pct(cx)}, y=${pct(cy)}）`;
}

// 3x3 网格（浏览器 canvas 采样得到）：用来推断「主体大概在画面哪个位置、明暗怎么分布」。
function describeGrid(grid) {
  if (!Array.isArray(grid) || grid.length !== 9) return "";
  const NAME = ["左上", "上中", "右上", "左中", "正中", "右中", "左下", "下中", "右下"];
  return grid
    .map((c, i) => {
      if (!c || typeof c !== "object") return null;
      const lum = Number(c.lum);
      const sat = Number(c.sat);
      if (!Number.isFinite(lum) && !Number.isFinite(sat)) return null;
      const l = Number.isFinite(lum) ? (lum < 0.33 ? "暗" : lum > 0.66 ? "亮" : "中调") : "?";
      const s = Number.isFinite(sat) ? (sat < 0.2 ? "低饱和" : sat > 0.5 ? "高饱和" : "中饱和") : "";
      return `${NAME[i]}:${c.color || "?"}(${l}${s ? "·" + s : ""})`;
    })
    .filter(Boolean)
    .join("，");
}

// 前端传来的素材 → 一段给提取模型看的事实描述。只陈述事实，不臆测。
function buildExtractionInput(asset) {
  const lines = [];
  const kindCn = asset.kind === "url" ? "网址素材（已抓取该网页主图）" : asset.kind === "video" ? "视频" : "图片";
  lines.push(`素材类型：${kindCn}`);
  if (asset.label) lines.push(`文件名 / 名称：${asset.label}`);
  if (asset.kind === "url") {
    if (asset.url) lines.push(`网址：${asset.url}`);
    if (asset.host) lines.push(`站点：${asset.host}`);
    if (asset.title) lines.push(`网页标题：${asset.title}`);
    if (asset.description) lines.push(`网页摘要：${asset.description}`);
    if (Array.isArray(asset.headings) && asset.headings.length) {
      lines.push(`网页小标题：${asset.headings.slice(0, 6).join(" / ")}`);
    }
    if (asset.text) lines.push(`网页正文摘录：${String(asset.text).slice(0, 400)}`);
  }
  if (asset.width && asset.height) {
    lines.push(`尺寸：${asset.width}x${asset.height}（宽高比 ${(asset.width / asset.height).toFixed(2)}）`);
  }
  if (Array.isArray(asset.palette) && asset.palette.length) {
    const ratio = Array.isArray(asset.paletteRatio) ? asset.paletteRatio : [];
    lines.push(
      `实测主色调（按占比从多到少）：${asset.palette
        .map((c, i) => `${c}${ratio[i] !== undefined ? ` ${Math.round(ratio[i] * 100)}%` : ""}`)
        .join(" / ")}`
    );
  }
  if (Number.isFinite(Number(asset.brightness))) {
    lines.push(`实测平均明度：${Number(asset.brightness).toFixed(2)}（0=纯黑 1=纯白）`);
  }
  const grid = describeGrid(asset.grid);
  if (grid) lines.push(`九宫格色彩 / 明暗分布：${grid}`);
  const box = describeSubjectBox(asset.subject);
  if (box) lines.push(box);
  const cmap = describeColorMap(asset.map, asset.detail);
  if (cmap) lines.push(cmap);
  return lines.join("\n");
}

const EXTRACT_SYSTEM = `你是视觉素材分析师，服务于「风格化重绘」——注意，是重绘，不是重新创作。

用户会给你一张素材的实测数据：真实色板（带占比）、主体显著区域的位置与大小、
以及一张把原图降采样后的【色彩网格图】和【细节密度图】。你没有原图，
这两张网格图就是你能拿到的最接近「看图」的东西，必须逐格读。

你的任务是回答：这张素材主要画的是什么、在画面哪个位置、什么颜色，供后续照着重建。

只输出纯 JSON（不要 markdown 代码块、不要解释），结构如下：
{
  "subject": "一句话说清主体在画面里呈现的样子（例如：画面偏下、约占宽度 45% 的一块深灰褐色不规则块状物，置于纯净白底之上，左上方有极淡的粉紫渐变）",
  "elements": ["元素1", "元素2", "元素3"],
  "composition": "构图：主体在画面的哪个区域、占多大、朝向 / 视线方向、留白在哪、景别",
  "layout": "用一句话锁定主体位置，例如：主体居中偏下，占画面宽度约 45%，上方留白约 30%",
  "palette": ["#RRGGBB", "#RRGGBB", "#RRGGBB"],
  "mood": "气质 / 情绪（例：温暖日常、科技冷峻、活泼童趣）",
  "redrawPrompt": "一段给绘图模型的英文提示词：主体 + 位置 + 大小 + 配色 + 风格化处理，80~200 单词，只描述画面，不要出现文字排版要求"
}

硬规则：
- 【保真第一】主体是什么、在哪个区域、多大、朝哪边，必须能被色彩网格图与显著区域支持。
  网格图能看出「一块深色区域压在下方、上方是浅色」这类事实，就照实说；
  看不出具体物件时，就说清可确认的色块构成与构图（例如「下方一块深色的矩形主体、上方大面积浅色背景」），
  **严禁凭文件名或想象编造画面里没有的物件、文字、品牌、型号**。
- 【只描述看得到的视觉特征】你从网格图只能确认形状、颜色、材质感与位置，就只描述这些。
  **不要臆测具体品类**（音箱 / 手机 / 手表 / 电器 / 化妆品…）——那是在没有视觉模型的情况下凭空脑补，
  只会让后续优化描述张冠李戴。主体写成「一块…的块状物 / 一片…的色域 / 一处…的光影」这类中性视觉指代即可。
- 【配色照抄】palette 必须沿用「实测主色调」，且顺序与占比一致（占比最大的放第一个）；
  只允许微调饱和度与明度，不允许换成另一套色系。
- 【位置照抄】layout 必须复述实测到的主体区域与占比，不要写成「居中」这种想当然的说法
  ——实测说在下方就是下方。
- redrawPrompt 必须用英文（绘图模型对英文更稳），其余字段用中文；
  英文提示词里要写清主体位置（in the lower-center / occupies about 45% of the width 之类）与配色占比。
- 绝对不要输出 JSON 以外的内容。`;

// 从 LLM 响应里抠出 JSON：模型偶尔会带 ```json 或前后废话
function parseBrief(text) {
  if (typeof text !== "string") return null;
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" ? v : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const v = tryParse(fence[1].trim());
    if (v) return v;
  }
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s !== -1 && e > s) {
    const v = tryParse(text.slice(s, e + 1));
    if (v) return v;
  }
  return null;
}

// 兜底 brief：LLM 不可用 / 返回非法时，用实测特征拼一个能用的版本——
// 宁可提示词朴素，也不要整个重绘流程垮掉。
function fallbackBrief(asset) {
  const palette = (Array.isArray(asset.palette) ? asset.palette : []).slice(0, 4);
  const subject = asset.kind === "url"
    ? `与「${asset.title || asset.host || asset.url || "该网页"}」相关的主视觉画面`
    : `素材「${asset.label || asset.file || "图片"}」的主体内容`;
  return {
    subject,
    elements: [],
    composition: "主体居中，四周留出呼吸空间",
    // LLM 挂了也要保住构图：用实测的显著区域兜底，别退回「居中」这种默认说法
    layout: describeSubjectBox(asset.subject) || "主体居中",
    palette: palette.length ? palette : ["#2b3040", "#8a93a8", "#e8ecf4"],
    mood: "与素材色调一致",
    redrawPrompt: `Flat vector illustration of: ${subject}. Clean geometric shapes, limited palette${
      palette.length ? ` (${palette.join(", ")})` : ""
    }, generous negative space, no text, 16:9 composition, modern editorial style.`,
    degraded: true,
  };
}

function sanitizeBrief(raw, asset) {
  const b = raw && typeof raw === "object" ? raw : null;
  if (!b) return fallbackBrief(asset);
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const colors = (Array.isArray(b.palette) ? b.palette : [])
    .map((c) => String(c || "").trim())
    .filter((c) => /^#[0-9a-fA-F]{6}$/.test(c))
    .slice(0, 6);
  const out = {
    subject: str(b.subject, 200) || fallbackBrief(asset).subject,
    elements: (Array.isArray(b.elements) ? b.elements : []).map((x) => str(x, 60)).filter(Boolean).slice(0, 8),
    composition: str(b.composition, 200) || "主体居中",
    // layout：锁定主体位置的一句话。模型没给就退回实测的显著区域，
    // 不能让它空着——空着等于又回到「模型自己决定主体放哪」，那正是偏离的来源。
    layout: str(b.layout, 200) || describeSubjectBox(asset.subject) || "主体居中",
    palette: colors.length ? colors : fallbackBrief(asset).palette,
    mood: str(b.mood, 80),
    redrawPrompt: str(b.redrawPrompt, 1200),
  };
  if (!out.redrawPrompt) {
    const fb = fallbackBrief(asset);
    out.redrawPrompt = fb.redrawPrompt;
    out.degraded = true;
  }
  return out;
}

/* ============================================================
 *  路径一：位图（外部图像生成 API）
 * ============================================================ */

// base 可注入：默认取环境变量 IMAGE_API_BASE，测试里可以传一个假网关
async function generateBitmap(brief, { fetchImpl, apiKey, log, base: imageApiBase }) {
  const apiBase = imageApiBase !== undefined ? imageApiBase : IMAGE_API_BASE;
  if (!apiBase) return null;
  const key = IMAGE_API_KEY || apiKey;
  const url = `${apiBase}/v1/images/generations`;
  const base = {
    model: IMAGE_MODEL || undefined,
    prompt: brief.redrawPrompt,
    n: 1,
    response_format: "b64_json",
  };
  // 尺寸各家支持度不一（有的只认 1024x1024）：先带 size 试，报 400 就去掉 size 重试一次
  for (const withSize of [true, false]) {
    const body = withSize ? { ...base, size: IMAGE_SIZE } : base;
    try {
      const res = await (fetchImpl || fetch)(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        if (withSize && (res.status === 400 || res.status === 422)) {
          log?.(`图像 API 不接受 size=${IMAGE_SIZE}（HTTP ${res.status}），去掉尺寸重试`);
          continue;
        }
        log?.(`图像 API 调用失败（HTTP ${res.status}）: ${String(txt).slice(0, 200)}`);
        return null;
      }
      const data = await res.json();
      const item = Array.isArray(data?.data) ? data.data[0] : null;
      if (!item) {
        log?.("图像 API 返回体里没有 data[0]");
        return null;
      }
      if (typeof item.b64_json === "string" && item.b64_json) {
        return { buffer: Buffer.from(item.b64_json, "base64"), ext: ".png" };
      }
      if (typeof item.url === "string" && /^https?:\/\//.test(item.url)) {
        const bin = await (fetchImpl || fetch)(item.url);
        if (!bin.ok) {
          log?.(`图像下载失败（HTTP ${bin.status}）`);
          return null;
        }
        const buf = Buffer.from(await bin.arrayBuffer());
        if (!buf.length) return null;
        const ct = String(bin.headers?.get?.("content-type") || "");
        const ext = ct.includes("webp") ? ".webp" : ct.includes("jpeg") || ct.includes("jpg") ? ".jpg" : ".png";
        return { buffer: buf, ext };
      }
      return null;
    } catch (e) {
      log?.(`图像 API 请求异常: ${e?.message || String(e)}`);
      return null;
    }
  }
  return null;
}

/* ============================================================
 *  路径二：矢量（文本 LLM 直接画 SVG）
 * ============================================================ */

const SVG_SYSTEM = `你是矢量插画师。你的工作是把用户的一张素材【风格化重绘】成 16:9 的扁平 SVG 插画。

重绘 ≠ 重新创作。用户要的是「还是那个东西、还是那个位置、还是那个色调」，
只是换成视频自己的矢量画风。偏离原图 = 任务失败。

输出要求（硬约束，违反就是失败）：
- 只输出纯 SVG 源码，不要 markdown 代码块、不要任何解释文字。
- 根元素必须是 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="1600" height="900">。
- 完全自包含：禁止 <script>、禁止 on* 事件属性、禁止任何外部资源引用（http:// 开头的 href / url() / <image>）。
- 可用元素：<defs> <linearGradient> <radialGradient> <g> <rect> <circle> <ellipse> <path> <polygon> <polyline> <line> <clipPath> <filter>(feGaussianBlur/feOffset/feBlend) <text>。
- 画面必须铺满整个画布：先画一个覆盖 0 0 1600 900 的背景 <rect>，再叠主体。
- 不要画任何文字（<text> 也不要用）——视频里的文案由其它图层负责。
- 元素数量控制在 30~120 个之间：太少显得空，太多渲染慢。

【保真四条 —— 这是本次任务的重点】
1. 主体位置与大小照抄：给定了【原图主体区域】的百分比坐标，就换算到 1600x900 画布上
   （例：横向 30%~75% → x 从 480 到 1200），主体必须落在那一带，大小也与实测占比相当。
   严禁把主体挪到画面正中间——那是想当然，不是原图。
2. 明暗分布照抄：【色彩网格图】逐格给出了原图每块区域的颜色。
   先按这张图铺大色块（上/中/下、左/中/右的明暗关系必须与网格一致），再在上面加细节。
   网格里上方是浅色，你画的背景上方就必须是浅色；下方是深色，主体就压在下方。
3. 配色照抄且占比一致：只能用给定色板里的颜色（允许同色系的深浅与渐变），
   占比最大的那个色要占画面最大的面积，点缀色只能做点缀，**不许把点缀色画成主色**。
4. 不新增元素：只画分析结果里提到的元素。原图没有的装饰、图标、人物、文字，一律不许加。

风格要求：现代编辑风插画（editorial flat illustration），几何化概括、色块明确、有层次（背景 / 中景 / 主体 / 点缀）；
把写实细节简化成几何形状是可以的（这正是重绘的意义），但轮廓关系、位置、配色不能变。`;

// AI 产出的 SVG 必须过这道闸：畸形或带外部引用的 SVG 会让 <Img> 直接裂图，
// 而预览期看不出来（浏览器容错高），导出时才 404——属于最恶劣的不一致。
function sanitizeSvg(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "空内容" };
  let s = raw.trim();
  // 去掉模型爱加的 markdown 围栏
  const fence = s.match(/```(?:svg|xml|html)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // 去掉 XML 声明与注释外的前置噪声，只保留从 <svg 开始的部分
  const start = s.search(/<svg[\s>]/i);
  if (start === -1) return { ok: false, reason: "没有 <svg> 根元素" };
  s = s.slice(start);
  const end = s.lastIndexOf("</svg>");
  if (end === -1) return { ok: false, reason: "SVG 未闭合" };
  s = s.slice(0, end + 6);

  if (!/<svg[^>]*viewBox=/i.test(s)) return { ok: false, reason: "缺少 viewBox" };
  if (!/<svg[^>]*xmlns=/i.test(s)) {
    s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  // 安全 / 自包含性。
  // 注意：不能用「出现 http:// 就拒绝」这种粗判——根目录的 xmlns="http://www.w3.org/2000/svg"
  // 是命名空间声明、不是资源引用，那样会把所有合法 SVG 全误杀（实测踩过）。
  // 只盯真正会发起外部请求的位置：href / src / url()。
  const BAD = [
    [/<script/i, "含 <script>"],
    [/\son[a-z]+\s*=/i, "含事件属性"],
    [/<image\b/i, "含 <image> 外链"],
    [/<foreignObject/i, "含 foreignObject"],
    [/(?:xlink:)?href\s*=\s*['"]https?:/i, "含外部 href"],
    [/\bsrc\s*=\s*['"]https?:/i, "含外部 src"],
    [/url\(\s*['"]?https?:/i, "含 url() 外链"],
    // 协议相对外链（//cdn.xxx/a.png）同样是外部请求
    [/(?:xlink:)?href\s*=\s*['"]\/\//i, "含协议相对外链"],
  ];
  for (const [re, why] of BAD) {
    if (re.test(s)) return { ok: false, reason: why };
  }
  // 画面不能是空的：至少得有背景 + 若干图形
  const shapes = (s.match(/<(rect|circle|ellipse|path|polygon|polyline|line)\b/gi) || []).length;
  if (shapes < 5) return { ok: false, reason: `图形元素过少（${shapes} 个）` };
  const buf = Buffer.from(s, "utf8");
  if (buf.length > SVG_MAX_BYTES) return { ok: false, reason: `体积过大（${Math.round(buf.length / 1024)}KB）` };
  return { ok: true, svg: s };
}

/* ============================================================
 *  保真度校验：重绘件到底还像不像原图
 *
 *  「重绘」最忌讳的就是画成另一张图。提示词里的约束再硬，模型也可能跑偏，
 *  所以这里用代码（不靠 LLM 自评）量一次：把重绘件用到的颜色抠出来，
 *  跟原图实测色板按占比加权比对，得出一个 0~1 的保真度。
 *  偏低就带着「你偏离了原图」的反馈重画一次 —— 这一步是可量化的，
 *  而不是「我觉得提示词写好了」。
 * ============================================================ */

function hexToRgb(hex) {
  const s = String(hex).replace("#", "");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

// 色距（0~1）：RGB 欧氏距离 / 最大距离
function colorDist(a, b) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2) / 441.673;
}

// 抠出 SVG 里实际用到的颜色（出现次数即粗略的面积权重）
function svgPalette(svg) {
  const hist = new Map();
  const bump = (hex) => {
    const k = String(hex).toLowerCase();
    hist.set(k, (hist.get(k) || 0) + 1);
  };
  const attr = /(?:fill|stroke|stop-color|flood-color)\s*=\s*["'](#[0-9a-fA-F]{6})["']/gi;
  const inline = /(?:fill|stroke|stop-color)\s*:\s*(#[0-9a-fA-F]{6})/gi;
  let m;
  while ((m = attr.exec(svg))) bump(m[1]);
  while ((m = inline.exec(svg))) bump(m[1]);
  return hist;
}

// 原图色板在重绘件里的保留程度（0~1）：按原图各主色的占比加权
function paletteFidelity(asset, svg) {
  const src = (Array.isArray(asset && asset.palette) ? asset.palette : [])
    .map((c) => String(c || "").trim().toLowerCase())
    .filter((c) => /^#[0-9a-f]{6}$/.test(c))
    .slice(0, 5);
  if (!src.length || typeof svg !== "string" || !svg) return null;
  const hist = svgPalette(svg);
  if (!hist.size) return 0;
  const ratio = Array.isArray(asset.paletteRatio) ? asset.paletteRatio.map((v) => Number(v) || 0) : [];
  const dst = [...hist.keys()];
  let score = 0;
  let wsum = 0;
  src.forEach((c, i) => {
    const w = ratio[i] > 0 ? ratio[i] : 1 / src.length;
    wsum += w;
    let best = 1;
    for (const d of dst) {
      const dd = colorDist(c, d);
      if (dd < best) best = dd;
    }
    // 色距 0.35 以内算「还在」，越近分越高；超过就是整套换色了
    score += w * Math.max(0, 1 - best / 0.35);
  });
  return Math.max(0, Math.min(1, score / (wsum || 1)));
}

// 低于这个保真度就判定「跑偏了」，带反馈重画一次
const FIDELITY_MIN = Number(process.env.REDRAW_FIDELITY_MIN || 0.45);

/* ============================================================
 *  主流程
 * ============================================================ */

function storedNameFor(prefix, ext) {
  const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `${prefix}-${uniq}${ext}`;
}

// 单件素材的「提取 → 重绘」。任何一步失败都返回 null，由上层决定回退。
/**
 * 只做「素材 → 结构化理解」，不重绘、不落盘。
 * 抽出来是为了给「AI 优化描述」复用：用户点了优化，得先把素材看懂，
 * 描述才可能对得上素材内容；否则只有一堆色块数字，模型只能瞎编。
 * LLM 不可用时用实测特征兜底（brief.degraded = true），绝不抛错阻断上游。
 */
async function extractBrief(asset, opts = {}) {
  const { apiKey, callLLM, log, styleContext = "" } = opts;
  const input = buildExtractionInput(asset);
  // 只有「素材类型」一行 = 这件素材没有任何可用信息。这时不能去问模型：
  // 它只能凭空编一个主体，反而污染后续的描述与重绘。直接返回 null，让调用方按「没看懂」处理。
  if (typeof callLLM !== "function" || input.trim().split("\n").length < 2) return null;
  try {
    const raw = await callLLM(
      apiKey,
      EXTRACT_SYSTEM,
      `${input}\n\n【这支视频要表达什么（理解素材时请往这个调性靠）】\n${styleContext || "（用户未额外说明，沿用素材自身气质）"}`,
      4096,
      0.7,
      null,
      // 提取是「照着客观描述归纳」，minimal 足够（实测 low 会把 token 预算耗在思考上）
      "minimal"
    );
    return sanitizeBrief(parseBrief(raw), asset);
  } catch (e) {
    log?.(`元素提取失败，改用实测特征兜底: ${e?.message || String(e)}`);
    return fallbackBrief(asset);
  }
}

// 画一版矢量重绘（不落盘）。extraFeedback 用于「上一版跑偏了」的返工。
async function drawVectorOnce(asset, brief, opts, extraFeedback = "") {
  const { apiKey, callLLM, styleContext } = opts;
  // 重绘的依据要原样递给绘图模型：光有一句「主体是什么」不够，
  // 必须把色彩网格图与主体坐标一起给它，否则它还是只能自己构图 = 偏离原图。
  const ratio = Array.isArray(asset.paletteRatio) ? asset.paletteRatio : [];
  const paletteLine = brief.palette
    .map((c, i) => `${c}${ratio[i] !== undefined ? `（占 ${Math.round(ratio[i] * 100)}%）` : ""}`)
    .join("、");
  const raw = await callLLM(
    apiKey,
    SVG_SYSTEM,
    `【素材分析结果】\n主体：${brief.subject}\n${
      brief.elements.length ? `主要元素：${brief.elements.join("、")}\n` : ""
    }构图：${brief.composition}\n主体位置：${brief.layout}\n色板（含实测占比）：${paletteLine}${
      Array.isArray(asset.palette) && asset.palette.length ? `\n原图实测色板：${asset.palette.join("、")}` : ""
    }\n气质：${brief.mood || "（未说明）"}\n${
      describeSubjectBox(asset.subject) ? `\n【原图主体区域（实测，必须照抄）】${describeSubjectBox(asset.subject)}` : ""
    }\n${
      describeColorMap(asset.map, asset.detail)
        ? `\n${describeColorMap(asset.map, asset.detail)}\n（先按这张网格图铺准大色块的明暗与位置，再加细节）`
        : ""
    }\n\n【视频调性】\n${styleContext || "（沿用素材自身气质）"}${
      extraFeedback ? `\n\n${extraFeedback}` : ""
    }\n\n请按要求输出 SVG 源码。`,
    16384,
    0.8,
    null,
    // 思考档位实测：minimal 29.7s / 85 个图形，low 209.7s / 34 个图形（思考把 token 预算吃光，
    // 首次还会 finish=length 空返回重试一次，合计 5 分钟）。画 SVG 是「照着描述码图形」，
    // 不需要长链推理，所以用 minimal——又快画面又更满。
    "minimal"
  );
  const checked = sanitizeSvg(raw);
  return checked.ok ? { svg: checked.svg } : { reason: checked.reason };
}

async function redrawOne(asset, opts) {
  const { apiKey, callLLM, fetchImpl, outDir, styleContext, log, imageApiBase } = opts;
  const brief = await extractBrief(asset, { apiKey, callLLM, styleContext, log });
  if (!brief) return null;
  log?.(`  · 提取到主体：${brief.subject}${brief.degraded ? "（降级：LLM 不可用）" : ""}`);

  // 路径一：位图
  const bitmap = await generateBitmap(brief, { fetchImpl, apiKey, log, base: imageApiBase });
  if (bitmap && bitmap.buffer && bitmap.buffer.length > 1024) {
    const name = storedNameFor("redraw", bitmap.ext);
    fs.writeFileSync(path.join(outDir, name), bitmap.buffer);
    log?.(`  · 位图重绘完成 ${name}（${Math.round(bitmap.buffer.length / 1024)}KB）`);
    return { file: name, absPath: path.join(outDir, name), kind: "bitmap", brief };
  }
  if (IMAGE_API_BASE) log?.("  · 位图重绘未成功，降级为矢量绘制");

  // 路径二：矢量（画完还要过一道「像不像原图」的实测）
  let best = null; // { svg, fidelity }
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const feedback =
        attempt === 0
          ? ""
          : `【你上一版跑偏了，这是最后一次机会】\n` +
            `实测：你画出来的画面与原图色板的吻合度只有 ${Math.round((best?.fidelity ?? 0) * 100)}%（低于 ${Math.round(
              FIDELITY_MIN * 100
            )}% 的保真门槛），也就是说配色被换掉了。\n` +
            `必须严格使用原图实测色板：${(asset.palette || []).join("、")}（按这个占比分配面积，第一个色占最大面积）。\n` +
            `同时再核对一遍上面的【色彩网格图】：各区域的明暗关系要一格一格对上，` +
            `并把主体放回【原图主体区域】给的位置。保持同样的元素，不要新增、不要改变构图。`;
      let res;
      try {
        res = await drawVectorOnce(asset, brief, opts, feedback);
      } catch (e) {
        log?.(`  · 矢量重绘失败，回退原素材: ${e?.message || String(e)}`);
        return null;
      }
      if (!res.svg) {
        // 结构性问题（含外链 / 未闭合 / 元素太少）重画大概率还是一样，直接放弃
        log?.(`  · 矢量重绘被校验拦下（${res.reason}），回退原素材`);
        return best ? writeVector(best, outDir, log, brief) : null;
      }
      const fidelity = paletteFidelity(asset, res.svg);
      log?.(
        `  · 第 ${attempt + 1} 版配色保真度 ${fidelity === null ? "（无原图色板，跳过）" : `${Math.round(fidelity * 100)}%`}`
      );
      if (!best || (fidelity !== null && (best.fidelity === null || fidelity > best.fidelity))) {
        best = { svg: res.svg, fidelity };
      }
      // 够像了就收手；没有原图色板可比时也只画一版（没有判据就不该反复烧额度）
      if (fidelity === null || fidelity >= FIDELITY_MIN) break;
    }
    if (!best) return null;
    if (best.fidelity !== null && best.fidelity < FIDELITY_MIN) {
      log?.(`  · 两版保真度都偏低（${Math.round(best.fidelity * 100)}%），仍采用更接近的一版`);
    }
    return writeVector(best, outDir, log, brief);
  } catch (e) {
    log?.(`  · 矢量重绘异常，回退原素材: ${e?.message || String(e)}`);
    return null;
  }
}

function writeVector(best, outDir, log, brief) {
  const name = storedNameFor("redraw", ".svg");
  fs.writeFileSync(path.join(outDir, name), Buffer.from(best.svg, "utf8"));
  log?.(
    `  · 矢量重绘完成 ${name}（${Math.round(Buffer.byteLength(best.svg) / 1024)}KB${
      best.fidelity !== null ? `，配色保真度 ${Math.round(best.fidelity * 100)}%` : ""
    }）`
  );
  return { file: name, absPath: path.join(outDir, name), kind: "vector", brief, fidelity: best.fidelity };
}

/**
 * 批量重绘。只动图片类素材；视频保持原样（不重绘，也不丢）。
 * 返回新的 assets 数组 + 一份报告（前端用来告诉用户每件素材发生了什么）。
 */
async function redrawAssets(assets, options = {}) {
  const {
    apiKey,
    outDir,
    styleContext = "",
    onLog = null,
    callLLM = null,
    fetchImpl = null,
    imageApiBase = undefined, // 测试 / 多租户场景可显式指定图像网关
  } = options;
  const log = (s) => {
    console.error(`[redraw] ${s}`);
    try {
      onLog?.(s);
    } catch {}
  };
  const llm =
    callLLM ||
    (() => {
      // 延迟 require：codegen 很重，只有真的要重绘时才加载
      return require("./codegen").callLLM;
    })();

  fs.mkdirSync(outDir, { recursive: true });
  const list = (assets || []).filter(Boolean);
  // 每件素材要两次 LLM（提取 + 绘制），串着跑十几件就是十几分钟。
  // 默认并发 2 路：总时长砍半，又不至于把网关打爆（REDRAW_CONCURRENCY=1 可退回串行）。
  const CONCURRENCY = Math.max(1, Number(process.env.REDRAW_CONCURRENCY) || 2);
  const out = new Array(list.length);
  const report = new Array(list.length);

  const handle = async (a, i) => {
    // 视频与「没有本地文件」的素材无法重绘：视频保持直用，无文件的按文字信息处理
    if (a.kind === "video" || !a.file || !a.absPath) {
      out[i] = a;
      report[i] = {
        original: a.file || a.url || a.label || "",
        file: a.file || "",
        kind: a.kind === "video" ? "passthrough-video" : "passthrough-nofile",
        subject: a.kind === "video" ? "视频素材不做重绘，直接进画面" : "该素材没有可用的图片文件",
      };
      return;
    }
    log(`重绘素材 ${a.file}${a.label ? `（${a.label}）` : ""}\u2026`);
    try {
      const r = await redrawOne(a, { apiKey, callLLM: llm, fetchImpl, outDir, styleContext, log, imageApiBase });
      if (!r) {
        out[i] = { ...a, redrawFailed: true };
        report[i] = { original: a.file, file: a.file, kind: "fallback", subject: "重绘失败，已改用原始素材" };
        return;
      }
      out[i] = {
        ...a,
        originalFile: a.file, // 重绘前的原始素材（简报里要说清「这是从哪张图重绘来的」）
        file: r.file,
        absPath: r.absPath,
        redrawn: true,
        redrawKind: r.kind,
        redrawSubject: r.brief.subject || "",
        redrawPalette: r.brief.palette || [],
        fidelity: typeof r.fidelity === "number" ? r.fidelity : undefined,
        redrawNote: [
          `AI 提取主体：${r.brief.subject}`,
          r.brief.elements?.length ? `主要元素：${r.brief.elements.join("、")}` : "",
          r.brief.composition ? `构图：${r.brief.composition}` : "",
          r.brief.mood ? `气质：${r.brief.mood}` : "",
          typeof r.fidelity === "number" ? `配色保真度 ${Math.round(r.fidelity * 100)}%（与原图实测色板比对）` : "",
        ]
          .filter(Boolean)
          .join("；"),
      };
      report[i] = {
        original: a.file,
        file: r.file,
        kind: r.kind,
        subject: r.brief.subject || "",
        fidelity: typeof r.fidelity === "number" ? Math.round(r.fidelity * 100) / 100 : undefined,
      };
    } catch (e) {
      log(`重绘异常，回退原素材: ${e?.message || String(e)}`);
      out[i] = { ...a, redrawFailed: true };
      report[i] = { original: a.file, file: a.file, kind: "fallback", subject: "重绘异常，已改用原始素材" };
    }
  };

  for (let k = 0; k < list.length; k += CONCURRENCY) {
    await Promise.all(list.slice(k, k + CONCURRENCY).map((a, j) => handle(a, k + j)));
  }
  return { assets: out, report };
}

module.exports = {
  redrawAssets,
  redrawOne,
  extractBrief,
  buildExtractionInput,
  describeGrid,
  parseBrief,
  sanitizeBrief,
  fallbackBrief,
  sanitizeSvg,
  generateBitmap,
  // 保真链路（测试用）：网格图描述 / 主体框描述 / 色板保真度
  describeColorMap,
  describeSubjectBox,
  svgPalette,
  paletteFidelity,
  // 配置快照（测试与日志用）
  config: () => ({ IMAGE_API_BASE, IMAGE_MODEL, VISION_MODEL, SVG_W, SVG_H }),
};
