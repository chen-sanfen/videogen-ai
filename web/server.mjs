// web/server.mjs — Express 后端
//
// 生成与渲染彻底分离（两段式）：
//   POST /api/generate/stream  ① 生成预览：AI 写分镜 + 写组件 + 落盘工程（+配音），
//                              不跑冒烟、不渲染 MP4 → 前端用 @remotion/player 直接播放
//                              NDJSON 流：{type:'stage'|'log'|'result'|'error'}
//   POST /api/render           ② 渲染导出：按需补配音 → bundle → renderMedia → out/film.mp4
//                              NDJSON 流：{type:'log'|'progress'|'result'|'error'}
//   GET  /api/projects         已生成工程列表（含预览载荷，可直接播放/导出）
//   GET  /api/media/:project/  工程内的静态资源（public/voice/*.wav、out/*.mp4）
//
// 生成阶段的工程文件是预览与导出共同的唯一源码：预览所见 = 最终渲染所得。
//
// 「编辑」是直接在 Remotion Studio 里改这份源码：
//   POST /api/studio/open     启动（或复用）某个已生成工程的 Studio 会话
//   POST /api/studio/close    回收会话与端口
//   GET  /api/studio/list     当前会话
// Studio 跑在自己的端口上（3111 起），前端用 iframe 直连 —— 它的页面资源是 /bundle.js
// 这类绝对路径，只有独立 origin 才取得到，塞到子路径代理下会加载失败（白屏）。
// 因为编辑的就是源码本身，改完直接重新导出，不存在需要格式转换的中间产物。

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const { generateAiFilm, buildPreviewPayload, renderProjectMp4, optimizePrompt, inspectUrl, fetchBinary, mergeStyleRefs, callLLM } = require(
  path.join(ROOT, "generator", "codegen.js")
);
// 素材「AI 重绘」：提取主要元素 + 按视频风格重绘（位图优先，无图像 API 时降级矢量 SVG）
const { redrawAssets, extractBrief } = require(path.join(ROOT, "generator", "asset-redraw.js"));

const app = express();
app.use(express.json({ limit: "2mb" }));

// 托管预览版：沙箱无 ffmpeg/Chromium，禁用 MP4 渲染与 Studio 在线编辑。
// 设为 "true" 才开放（完整版在本机运行）。
const ENABLE_HEAVY = process.env.ENABLE_RENDER === "true";

// 托管预览版：在 Express 内嵌 Vite 中间件（单进程单端口），
// 同时保留 /@fs/ 按需转译——浏览器内预览「生成出来的 .tsx 组件」依赖它（静态构建版没有这层转译）。
// 触发条件：显式 ENABLE_VITE_MW=1，或部署目录含 .hosting 标记（双保险，避免托管平台忽略 env 前缀）。
const ENABLE_VITE_MW = process.env.ENABLE_VITE_MW === "1" || fs.existsSync(path.join(ROOT, ".hosting"));

// 静态托管仅在「构建产物存在 且 非 dev 且 未启用 Vite 中间件」时作为兜底（避免与 Vite 中间件冲突）。
const DIST = path.join(ROOT, "public-built");
const hasDist = fs.existsSync(DIST);
const isProdStatic = hasDist && process.env.NODE_ENV !== "development" && !ENABLE_VITE_MW;
if (isProdStatic) app.use(express.static(DIST));

// ============================================================
//  素材（图片 / 视频 / 网址）——生成时的参考或直接素材
//  上传落盘到 generator/.uploads/，生成时按需拷进工程 public/assets/
// ============================================================
const UPLOAD_DIR = path.join(ROOT, "generator", ".uploads");
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);
const IMAGE_MAX = 15 * 1024 * 1024;
const VIDEO_MAX = 80 * 1024 * 1024;
const MAX_ASSETS = 12;

// 素材用法三态：
//   reference（默认）——只当气质 / 色调 / 内容方向的参考，画面全部原创绘制
//   direct        ——素材原样进画面
//   redraw        ——先提取素材主要元素，再按视频风格重绘一张，重绘件进画面
function parseAssetMode(v) {
  return v === "direct" || v === "redraw" ? v : "reference";
}

function assetKindOf(ext) {
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return "";
}

// 色彩网格图：重绘保真的核心依据（LLM 看不到原图，只能照这张色块地图重建）。
// 只收严格合法的 hex，尺寸卡在 32x18 以内——防止前端异常或被篡改时把提示词撑爆。
function normalizeColorMap(m) {
  if (!m || typeof m !== "object") return null;
  const cols = Math.max(1, Math.min(32, Math.floor(Number(m.cols) || 0)));
  const rows = Math.max(1, Math.min(18, Math.floor(Number(m.rows) || 0)));
  if (!cols || !rows || !Array.isArray(m.cells)) return null;
  const cells = m.cells
    .slice(0, cols * rows)
    .map((c) => String(c || "").trim())
    .filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));
  if (cells.length !== cols * rows) return null;
  return { cols, rows, cells };
}

// 主体（显著区域）边界框：百分比坐标，用于约束重绘时主体必须画在原位置
function normalizeSubjectBox(s) {
  if (!s || typeof s !== "object") return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  };
  const x = num(s.x);
  const y = num(s.y);
  const w = num(s.w);
  const h = num(s.h);
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
  return { x, y, w, h, cx: num(s.cx) ?? x + w / 2, cy: num(s.cy) ?? y + h / 2 };
}

// 落盘名：时间戳 + 随机串 + 原文 slug —— 全 ASCII、可安全用于 URL 与文件系统
function storedNameFor(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const base = path
    .basename(originalName, ext)
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .toLowerCase();
  const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `${base || "asset"}-${uniq}${ext}`;
}

app.post("/api/asset/upload", express.raw({ type: () => true, limit: VIDEO_MAX + 1024 * 1024 }), (req, res) => {
  try {
    const raw = typeof req.query.name === "string" ? req.query.name : "";
    const originalName = decodeURIComponent(raw || "asset");
    const ext = path.extname(originalName).toLowerCase();
    const kind = assetKindOf(ext);
    if (!kind) return res.status(400).json({ error: `不支持的文件格式 ${ext || "(无扩展名)"}，图片支持 png/jpg/webp/gif/avif，视频支持 mp4/webm/mov` });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: "上传内容为空" });
    const cap = kind === "image" ? IMAGE_MAX : VIDEO_MAX;
    if (buf.length > cap) {
      return res.status(413).json({ error: `${kind === "image" ? "图片" : "视频"}超过 ${Math.round(cap / 1048576)}MB 上限` });
    }
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const storedName = storedNameFor(originalName);
    fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buf);
    res.json({ storedName, kind, bytes: buf.length, originalName });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/api/asset/url", async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!url) return res.status(400).json({ error: "url 是必填字段" });
  try {
    const info = await inspectUrl(url);
    res.json(info);
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

// 照片「完全读取完毕」（前端已上传 + canvas 采样出色调 / 主体框 / 色彩网格图）后，
// 立刻让 AI 解析它：提取主体 / 构图 / 配色，存进缓存并返回 brief。
// 这样点「AI 优化描述」时直接复用这份解析结果——不必再现场等 LLM 逐件看懂素材
// （以前每次点优化都要先走一段「正在读取素材…」的等待，体验上像卡住了）。
// 网址素材自带标题 / 摘要 / 正文等可信文字，不需要 AI 看图，直接返回空。
app.post("/api/asset/analyze", async (req, res) => {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const kind = payload.kind === "image" || payload.kind === "video" ? payload.kind : "";
  if (!kind) return res.json({ brief: null });
  const apiKey = getApiKey();
  if (!apiKey) return res.json({ brief: null, skipped: "no-api-key" });
  const assets = normalizeOptimizeAssets([payload]);
  const a = assets[0];
  if (!a) return res.json({ brief: null });
  // brief 是素材本身固有的（主体 / 构图 / 配色），与「要生成什么描述」无关，
  // 所以用不含 prompt 的缓存键——同一张图换不同描述也复用，不会重复烧额度。
  const cacheKey = `${a.kind}|${a.file || a.label}|`;
  const cached = OPTIMIZE_BRIEF_CACHE.get(cacheKey);
  if (cached) return res.json({ brief: cached, cached: true });
  try {
    const b = await extractBrief(a, {
      apiKey,
      callLLM,
      styleContext: "", // 解析阶段还没有产品描述，按素材自身气质理解
      log: (l) => console.error(`[asset-analyze] ${l}`),
    });
    if (b) {
      if (OPTIMIZE_BRIEF_CACHE.size >= OPTIMIZE_BRIEF_CACHE_MAX) OPTIMIZE_BRIEF_CACHE.clear();
      OPTIMIZE_BRIEF_CACHE.set(cacheKey, b);
    }
    res.json({ brief: b || null });
  } catch (e) {
    res.json({ brief: null, error: e?.message || String(e) });
  }
});

function extFromContentType(ct) {
  const t = String(ct || "").toLowerCase();
  if (t.includes("image/png")) return ".png";
  if (t.includes("image/webp")) return ".webp";
  if (t.includes("image/gif")) return ".gif";
  if (t.includes("image/avif")) return ".avif";
  if (t.includes("image/jpeg") || t.includes("image/jpg")) return ".jpg";
  return "";
}

// 前端只提交「storedName + 前端算出来的尺寸/主色调」，这里统一校验并还原成生成器要的结构
async function normalizeAssets(list, mode) {
  const out = [];
  for (const a of (Array.isArray(list) ? list : []).slice(0, MAX_ASSETS)) {
    if (!a || typeof a !== "object") continue;
    if (a.kind === "url") {
      const url = typeof a.url === "string" ? a.url.trim() : "";
      if (!/^https?:\/\//.test(url)) continue;
      const item = {
        kind: "url",
        url,
        host: typeof a.host === "string" ? a.host : "",
        title: typeof a.title === "string" ? a.title.slice(0, 200) : "",
        description: typeof a.description === "string" ? a.description.slice(0, 400) : "",
        headings: Array.isArray(a.headings) ? a.headings.slice(0, 8).map(String) : [],
        text: typeof a.text === "string" ? a.text.slice(0, 800) : "",
        file: "",
        absPath: "",
      };
      // 直用 / 重绘模式：把网页主图也拉下来当素材，视频里才会真的出现这个网址的内容。
      // 候选图逐个兜底：很多站点没有 og:image，或者 og:image 是防盗链 / 返回 403，
      // 只试第一张的话「直接使用网址素材」就会经常什么都拿不到。
      if (mode === "direct" || mode === "redraw") {
        const candidates = [
          ...(typeof a.imageUrl === "string" ? [a.imageUrl] : []),
          ...(Array.isArray(a.images) ? a.images : []),
        ]
          .map((u) => (typeof u === "string" ? u.trim() : ""))
          .filter((u) => /^https?:\/\//.test(u))
          .filter((u, i, arr) => arr.indexOf(u) === i)
          .slice(0, 5);
        // 并行试几个候选，再从能用的里面挑「最大的一张」：
        // og:image 经常只是十几 KB 的品牌卡 / logo，而真正的主视觉（英雄图 / 产品图）通常几百 KB。
        // 只认顺序第一张的话，直用模式下用户看到的就是一张 logo 铺满画面。
        const fetched = (
          await Promise.all(
            candidates.map(async (candidate) => {
              try {
                const bin = await fetchBinary(candidate);
                const ext = extFromContentType(bin.contentType) || path.extname(new URL(candidate).pathname).toLowerCase();
                if (bin.status >= 400 || !bin.buffer.length || !IMAGE_EXT.has(ext)) {
                  console.log(`  [asset] 主图候选不可用（HTTP ${bin.status} / ${bin.contentType || "未知类型"}）: ${candidate}`);
                  return null;
                }
                if (bin.buffer.length < 8 * 1024) {
                  console.log(`  [asset] 主图候选过小（${Math.round(bin.buffer.length / 1024)}KB），跳过: ${candidate}`);
                  return null;
                }
                return { candidate, ext, buffer: bin.buffer };
              } catch (e) {
                console.log(`  [asset] 主图候选下载失败（跳过）: ${e.message}`);
                return null;
              }
            })
          )
        ).filter(Boolean);
        if (fetched.length) {
          const best = fetched.reduce((a, b) => (b.buffer.length > a.buffer.length ? b : a));
          fs.mkdirSync(UPLOAD_DIR, { recursive: true });
          const storedName = storedNameFor(`${item.host || "web"}${best.ext}`);
          fs.writeFileSync(path.join(UPLOAD_DIR, storedName), best.buffer);
          item.file = storedName;
          item.absPath = path.join(UPLOAD_DIR, storedName);
          console.log(
            `  [asset] 已抓取网页主图 ${storedName}（${Math.round(best.buffer.length / 1024)}KB，共 ${fetched.length}/${candidates.length} 张候选中最大）`
          );
        }
        if (!item.file) {
          console.log(`  [asset] ${item.host || url} 没有抓到可用的主图——本次该网址只提供文字信息`);
        }
      }
      out.push(item);
      continue;
    }
    const storedName = typeof a.storedName === "string" ? a.storedName : "";
    if (!/^[A-Za-z0-9._-]+$/.test(storedName)) continue;
    const abs = path.join(UPLOAD_DIR, storedName);
    if (!fs.existsSync(abs)) continue;
    out.push({
      kind: a.kind === "video" ? "video" : "image",
      file: storedName,
      absPath: abs,
      label: typeof a.label === "string" ? a.label.slice(0, 120) : storedName,
      width: Number(a.width) || 0,
      height: Number(a.height) || 0,
      palette: Array.isArray(a.palette) ? a.palette.slice(0, 8).map(String) : [],
      brightness: Number.isFinite(Number(a.brightness)) ? Number(a.brightness) : undefined,
      // 3x3 网格采样（明暗 / 饱和度分布）
      grid: Array.isArray(a.grid)
        ? a.grid.slice(0, 9).map((c) => ({
            color: typeof c?.color === "string" ? c.color.slice(0, 9) : "",
            lum: Number.isFinite(Number(c?.lum)) ? Number(c.lum) : undefined,
            sat: Number.isFinite(Number(c?.sat)) ? Number(c.sat) : undefined,
          }))
        : [],
      // 「重绘不偏离原图」的三件套：色彩网格图 / 主体框 / 细节密度。
      // 后端没有视觉模型，LLM 看不到图，这三样就是它重建画面的全部依据。
      paletteRatio: Array.isArray(a.paletteRatio)
        ? a.paletteRatio.slice(0, 8).map((v) => Math.max(0, Math.min(1, Number(v) || 0)))
        : [],
      map: normalizeColorMap(a.map),
      subject: normalizeSubjectBox(a.subject),
      detail: Array.isArray(a.detail)
        ? a.detail.slice(0, 200).map((v) => Math.max(0, Math.min(1, Number(v) || 0)))
        : [],
      note: typeof a.note === "string" ? a.note.slice(0, 200) : "",
    });
  }
  return out;
}

// ---- 读取 AI API key ----
function getApiKey() {
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;
  const keyFile = path.join(ROOT, "generator", ".deepseek-key");
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, "utf8").trim();
  return null;
}

// ---- 工程创建时间：用于「新生成的排在最前」 ----
// 目录 birthtime 在 Windows/NTFS 上稳定不变（渲染导出只改 mtime，不会把老工程顶上来）；
// 少数文件系统拿不到 birthtime 时，退回 preview.json / film.config.json 的 mtime。
function projectCreatedAt(name) {
  const dir = path.join(ROOT, name);
  try {
    const st = fs.statSync(dir);
    if (st.birthtimeMs && st.birthtimeMs > 0) return st.birthtimeMs;
  } catch {}
  for (const f of ["preview.json", "film.config.json"]) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs) return st.mtimeMs;
    } catch {}
  }
  return 0;
}

// ---- 单飞锁：同一时间只跑一个生成；每个工程只跑一个渲染；优化同理 ----
let generating = null;
let generatingSince = 0;
// 生成硬上限：超过即视为上一次已卡死（托管沙箱可能连不上 LLM、或流式连接挂住不返回），
// 强制释放全局锁，避免永久 409「已有生成任务在进行中」。
const MAX_GENERATION_MS = 8 * 60 * 1000;
let optimizing = false;
const renderingProjects = new Set();

// ---- NDJSON 流式响应 ----
function openStream(res) {
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  return {
    send(obj) {
      if (closed) return;
      try {
        res.write(JSON.stringify(obj) + "\n");
      } catch {
        closed = true;
      }
    },
    end() {
      if (closed) return;
      try {
        res.end();
      } catch {}
    },
  };
}

// 把 console.error 的实时日志转发给前端（仍然照常打印到终端）。
// filter 用来区分「生成」与「渲染」两路日志，避免并发时串台。
function captureStderr(filter, emit) {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    const text = String(chunk);
    if (filter(text)) {
      for (const line of text.split("\n")) {
        if (line.trim()) emit(line.replace(/\s+$/, ""));
      }
    }
    return original(chunk, ...args);
  };
  return () => {
    process.stderr.write = original;
  };
}

// ============================================================
//  ① 生成预览（不渲染 MP4）
// ============================================================
app.post("/api/generate/stream", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) return res.status(400).json({ error: "prompt 是必填字段" });
  // 自定义时长（秒）：不填 / 0 → 交给 AI 自行决定；填写则按目标时长规划分镜
  const rawSeconds = Number(req.body?.seconds);
  let seconds = 0;
  if (Number.isFinite(rawSeconds) && rawSeconds > 0) {
    if (rawSeconds < 4 || rawSeconds > 120) {
      return res.status(400).json({ error: "视频时长须在 4~120 秒之间" });
    }
    seconds = Math.round(rawSeconds * 10) / 10;
  }

  // 素材用法：reference（默认，只作灵感参考）/ direct（原样进画面）/ redraw（提取元素后 AI 重绘再进画面）
  const assetMode = parseAssetMode(req.body?.assetMode);
  // 「参考已生成工程的风格」：可多选。兼容旧的单值 styleRef 字段。
  const styleRefNames = [
    ...(Array.isArray(req.body?.styleRefs) ? req.body.styleRefs : []),
    ...(typeof req.body?.styleRef === "string" ? [req.body.styleRef] : []),
  ]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  let styleRef = null;
  if (styleRefNames.length) {
    try {
      styleRef = mergeStyleRefs(styleRefNames.slice(0, 4));
    } catch (e) {
      return res.status(400).json({ error: `风格参考不可用：${e.message}` });
    }
  }

  // 字幕 / 配音 / 配乐开关（默认：有字幕、无配音、无配乐）
  const subtitles = req.body?.subtitles !== false;
  const voice = req.body?.voice === true;
  const bgm = req.body?.bgm === true;

  const apiKey = getApiKey();
  if (!apiKey) {
    return res.status(500).json({ error: "AI API key 未配置（generator/.deepseek-key 或 DEEPSEEK_API_KEY）" });
  }
  if (generating) {
    if (Date.now() - generatingSince > MAX_GENERATION_MS) {
      console.warn(`[gen] 检测到超过 ${Math.round(MAX_GENERATION_MS / 60000)} 分钟的残留生成锁，强制释放`);
      generating = null;
    } else {
      return res.status(409).json({ error: `已有生成任务在进行中，请等待它完成后再试` });
    }
  }

  let assets = [];
  try {
    assets = await normalizeAssets(req.body?.assets, assetMode);
  } catch (e) {
    console.error("素材处理失败:", e);
  }

  const s = openStream(res);
  generating = prompt.slice(0, 40);
  generatingSince = Date.now();
  const release = captureStderr((line) => line.startsWith("[codegen]") || line.startsWith("  [resume]"), (line) => s.send({ type: "log", line }));

  // 「AI 重绘」模式：先把素材降维成元素描述并重绘，再把这些重绘件当作「直接进画面」的素材交下去。
  // 放在生成之前做，是为了让分镜规划时就拿到重绘件（AI 知道画面主体长什么样，文案才能对上）。
  let redrawReport = null;
  if (assetMode === "redraw" && assets.length) {
    const t0 = Date.now();
    s.send({ type: "stage", stage: "redraw", status: "start", count: assets.length });
    try {
      const r = await redrawAssets(assets, {
        apiKey,
        outDir: UPLOAD_DIR,
        // 重绘不是凭空画：让它贴着这支视频要表达的东西走
        styleContext: `视频主题：${prompt}${seconds ? `\n时长约 ${seconds} 秒。` : ""}`,
        onLog: (line) => s.send({ type: "log", line: `[redraw] ${line}` }),
      });
      assets = r.assets;
      redrawReport = r.report;
      s.send({
        type: "stage",
        stage: "redraw",
        status: "done",
        elapsedSec: Math.round(((Date.now() - t0) / 1000) * 10) / 10,
        items: redrawReport.map((x) => ({ kind: x.kind, file: x.file, subject: x.subject })),
      });
    } catch (e) {
      // 重绘是锦上添花，绝不能因为它挂掉整次生成：失败就退回「原素材直接进画面」
      console.error("素材重绘失败，本次改用原始素材:", e);
      s.send({ type: "stage", stage: "redraw", status: "fail", error: e?.message || String(e) });
    }
  }

  let genTimer = null;
  try {
    const genTimeout = new Promise((_, rej) => {
      genTimer = setTimeout(
        () =>
          rej(
            new Error(
              `生成超时（约 ${Math.round(MAX_GENERATION_MS / 60000)} 分钟），已自动终止。若持续超时，请检查运行环境是否能访问 AI 网关（api.evomap.ai）。`
            )
          ),
        MAX_GENERATION_MS
      );
    });
    const result = await Promise.race([
      generateAiFilm({
        apiKey,
        prompt,
        previewOnly: false, // 落盘：预览需要真实工程文件
        withSmoke: false, // 不跑运行时冒烟（那是导出前的兜底，预览阶段交给浏览器直接暴露）
        voiceOptional: true,
        subtitles,
        voice,
        bgm,
        targetSeconds: seconds,
        assets,
        assetMode,
        styleRef,
        onEvent: (ev) => s.send({ type: "stage", ...ev }),
      }),
      genTimeout,
    ]);
    if (genTimer) clearTimeout(genTimer);
    const preview = buildPreviewPayload(result.projectPath);
    s.send({
      type: "result",
      projectPath: result.projectPath,
      stylePack: result.stylePack,
      codeStats: result.codeStats,
      voiceReady: result.voiceReady,
      voiceInfo: result.voiceInfo || null,
      subtitles,
      voice,
      bgm,
      summary: result.summary,
      targetSeconds: seconds,
      assetMode,
      assets: assets.map((a) => ({ kind: a.kind, file: a.file, label: a.label || a.url })),
      // 「AI 重绘」模式下每件素材的实际去向（位图 / 矢量 / 回退原图 / 视频不重绘）
      redrawReport,
      styleRef: styleRef ? { projectNames: styleRef.projectNames, packId: styleRef.packId } : null,
      preview,
    });
  } catch (err) {
    if (genTimer) clearTimeout(genTimer);
    s.send({ type: "error", error: err?.message || String(err) });
  } finally {
    release();
    generating = null;
    s.end();
  }
});

// ============================================================
//  ② 渲染导出 MP4
// ============================================================
app.post("/api/render", async (req, res) => {
  const project = typeof req.body?.project === "string" ? req.body.project.trim() : "";
  if (!project) return res.status(400).json({ error: "project 是必填字段" });
  if (!ENABLE_HEAVY) {
    return res.status(503).json({
      error:
        "当前托管预览版不含 MP4 渲染导出。请在本机运行完整版（npm run server + npm run studio）导出成片。",
    });
  }
  if (renderingProjects.has(project)) {
    return res.status(409).json({ error: `该工程正在渲染中，请稍候` });
  }

  const s = openStream(res);
  renderingProjects.add(project);
  // 渲染阶段自己的日志通过 onLog 直发（避免与 stderr 转发重复），
  // 这里只转发 bundler / renderer / 浏览器控制台等第三方输出
  const release = captureStderr(
    (line) => !line.startsWith("[codegen]") && !line.startsWith("  [resume]") && !line.startsWith("[render]"),
    (line) => s.send({ type: "log", line })
  );

  try {
    const info = await renderProjectMp4({
      projectName: project,
      onLog: (line) => s.send({ type: "log", line }),
      onProgress: (p) =>
        s.send({
          type: "progress",
          progress: p.progress,
          renderedFrames: p.renderedFrames,
          encodedFrames: p.encodedFrames,
          stitchStage: p.stitchStage,
        }),
    });
    s.send({
      type: "result",
      project,
      mp4: `/api/media/${encodeURIComponent(project)}/out/${info.file}`,
      fileName: info.file,
      fileAbs: info.fileAbs,
      sizeBytes: info.sizeBytes,
      durationInFrames: info.durationInFrames,
      fps: info.fps,
      width: info.width,
      height: info.height,
      elapsedSec: info.elapsedSec,
    });
  } catch (err) {
    s.send({ type: "error", error: err?.message || String(err) });
  } finally {
    release();
    renderingProjects.delete(project);
    s.end();
  }
});

// ============================================================
//  提示词优化（把一句含糊描述扩写成可执导的产品简报）
//  两个入口：JSON（脚本/调试用）与 NDJSON 流式（前端用，边生成边显示）
// ============================================================
// 校验 + 单飞锁：两个入口共用
// ============================================================
//  优化描述时的素材处理
//  以前「AI 优化描述」只拿到一句文本，用户传的产品图 / 视频完全不参与，
//  优化出来的描述自然跟素材无关。这里补齐两件事：
//   ① 轻量归一化：把前端的素材项收敛成优化器要的字段（不下载网页主图，那是生成阶段的事）
//   ② 素材理解：让 LLM 把图片 / 视频看懂（主体 / 元素 / 构图 / 气质），
//      简报里才有「素材里到底是什么」可写。带缓存——连点几次「换一版」不必重复提取。
// ============================================================
const OPTIMIZE_BRIEF_CACHE = new Map();
const OPTIMIZE_BRIEF_CACHE_MAX = 80;
// 每件提取约 15~20s：只取前 3 件，再多用户等不起（并发 2 → 两波约 40s 上限）
const OPTIMIZE_BRIEF_ITEMS = 3;
const OPTIMIZE_BRIEF_CONCURRENCY = 2;

function strField(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function normalizeOptimizeAssets(list) {
  const out = [];
  for (const a of (Array.isArray(list) ? list : []).slice(0, MAX_ASSETS)) {
    if (!a || typeof a !== "object") continue;
    const kind = a.kind === "url" ? "url" : a.kind === "video" ? "video" : "image";
    const meta = a.meta && typeof a.meta === "object" ? a.meta : {};
    out.push({
      kind,
      label: strField(a.label, 80),
      file: strField(a.storedName, 120),
      url: strField(a.url, 300),
      host: strField(a.host, 80),
      title: strField(a.title, 200),
      description: strField(a.description, 400),
      headings: Array.isArray(a.headings) ? a.headings.slice(0, 8).map((s) => String(s).slice(0, 80)) : [],
      text: strField(a.text, 800),
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      palette: Array.isArray(meta.palette) ? meta.palette.slice(0, 8).map((s) => String(s).slice(0, 24)) : [],
      brightness: Number.isFinite(Number(meta.brightness)) ? Number(meta.brightness) : undefined,
      grid: Array.isArray(meta.grid)
        ? meta.grid.slice(0, 9).map((c) => ({
            color: strField(c && c.color, 24),
            lum: Number(c && c.lum),
            sat: Number(c && c.sat),
          }))
        : [],
      // 与生成路径同一套「保真三件套」，优化描述时也能据此说中素材内容
      paletteRatio: Array.isArray(meta.paletteRatio)
        ? meta.paletteRatio.slice(0, 8).map((v) => Math.max(0, Math.min(1, Number(v) || 0)))
        : [],
      map: normalizeColorMap(meta.map),
      subject: normalizeSubjectBox(meta.subject),
      detail: Array.isArray(meta.detail)
        ? meta.detail.slice(0, 200).map((v) => Math.max(0, Math.min(1, Number(v) || 0)))
        : [],
      // 前端在「照片读取完毕」时已让 AI 解析好并回传的 brief（主体理解）。
      // 有就直接复用，optimize 不必再现场等 LLM 提取；没有（脚本/旧前端）才走兜底提取。
      brief: a.brief && typeof a.brief === "object" ? a.brief : undefined,
    });
  }
  return out;
}

async function attachAssetBriefs(assets, { apiKey, prompt, onLog }) {
  // 网址素材不用提取：它的标题 / 摘要 / 正文就是可信的文字信息，再让模型推断一次反而会编
  const targets = assets.filter((a) => a.kind === "image" || a.kind === "video").slice(0, OPTIMIZE_BRIEF_ITEMS);
  for (let k = 0; k < targets.length; k += OPTIMIZE_BRIEF_CONCURRENCY) {
    const batch = targets.slice(k, k + OPTIMIZE_BRIEF_CONCURRENCY);
    await Promise.all(
      batch.map(async (a) => {
        // 缓存键不含 prompt：画面理解是素材本身固有的，换不同描述也复用，不重复烧额度
        const cacheKey = `${a.kind}|${a.file || a.label}|`;
        // ① 前端已在「照片读取完毕」时让 AI 解析好并回传 → 直接复用，不再等 LLM
        if (a.brief && typeof a.brief === "object") {
          if (OPTIMIZE_BRIEF_CACHE.size >= OPTIMIZE_BRIEF_CACHE_MAX) OPTIMIZE_BRIEF_CACHE.clear();
          OPTIMIZE_BRIEF_CACHE.set(cacheKey, a.brief);
          return;
        }
        // ② 本会话已解析过（同一张图重复优化）→ 命中缓存
        const cached = OPTIMIZE_BRIEF_CACHE.get(cacheKey);
        if (cached) {
          a.brief = cached;
          return;
        }
        // ③ 兜底：前端没传 brief（旧前端 / 脚本 / 解析失败）→ 现场让 LLM 提取
        try {
          const b = await extractBrief(a, {
            apiKey,
            callLLM,
            styleContext: `视频主题：${String(prompt).slice(0, 200)}`,
            log: onLog,
          });
          if (b) {
            a.brief = b;
            if (OPTIMIZE_BRIEF_CACHE.size >= OPTIMIZE_BRIEF_CACHE_MAX) OPTIMIZE_BRIEF_CACHE.clear();
            OPTIMIZE_BRIEF_CACHE.set(cacheKey, b);
          }
        } catch (e) {
          // 理解素材失败不阻断优化：没有 brief 时优化器只会依据实测色彩与文字，不会瞎编
          onLog?.(`素材理解失败，本次只用实测特征: ${e?.message || String(e)}`);
        }
      })
    );
  }
  return { assets };
}

function prepareOptimize(req, res) {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) {
    res.status(400).json({ error: "prompt 是必填字段" });
    return null;
  }
  if (prompt.length > 4000) {
    res.status(400).json({ error: "描述过长（上限 4000 字），请精简后再优化" });
    return null;
  }
  const apiKey = getApiKey();
  if (!apiKey) {
    res.status(500).json({ error: "AI API key 未配置（generator/.deepseek-key 或 DEEPSEEK_API_KEY）" });
    return null;
  }
  if (optimizing) {
    res.status(409).json({ error: "正在优化上一条描述，请稍候" });
    return null;
  }
  return {
    prompt,
    apiKey,
    // 用户素材：优化出来的描述必须跟素材对得上（以前完全没传，等于白上传）
    assets: normalizeOptimizeAssets(req.body?.assets),
    assetMode: parseAssetMode(req.body?.assetMode),
    // avoid：已生成过的版本，用于要求这一版与之前明显不同（每次点击都要不一样）
    opts: {
      angle: typeof req.body?.angle === "string" ? req.body.angle : undefined,
      avoid: Array.isArray(req.body?.avoid) ? req.body.avoid.map((s) => String(s)) : [],
    },
  };
}

app.post("/api/optimize-prompt", async (req, res) => {
  const prepared = prepareOptimize(req, res);
  if (!prepared) return;
  optimizing = true;
  try {
    const { assets } = await attachAssetBriefs(prepared.assets, {
      apiKey: prepared.apiKey,
      prompt: prepared.prompt,
      onLog: (line) => console.error(`[optimize] ${line}`),
    });
    const { optimized, angle } = await optimizePrompt(prepared.apiKey, prepared.prompt, {
      ...prepared.opts,
      assets,
      assetMode: prepared.assetMode,
    });
    res.json({ original: prepared.prompt, optimized, angle });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  } finally {
    optimizing = false;
  }
});

app.post("/api/optimize-prompt/stream", async (req, res) => {
  const prepared = prepareOptimize(req, res);
  if (!prepared) return;

  const s = openStream(res);
  optimizing = true;
  try {
    let assets = prepared.assets;
    // 只有「确实有素材没在上传时解析过」才需要现场让 LLM 看懂；否则直接复用已解析结果，
    // 不再发「正在读取素材…」阶段，避免明明已经解析好了却还让人等一段。
    const needExtract = assets
      .filter((a) => (a.kind === "image" || a.kind === "video") && !a.brief)
      .slice(0, OPTIMIZE_BRIEF_ITEMS);
    if (assets.length && needExtract.length) {
      s.send({ type: "stage", stage: "assets", status: "start", count: needExtract.length });
      const t0 = Date.now();
      assets = (await attachAssetBriefs(assets, {
        apiKey: prepared.apiKey,
        prompt: prepared.prompt,
        onLog: (line) => s.send({ type: "log", line: `[optimize] ${line}` }),
      })).assets;
      s.send({
        type: "stage",
        stage: "assets",
        status: "done",
        elapsedSec: Math.round(((Date.now() - t0) / 1000) * 10) / 10,
        understood: assets.filter((a) => a.brief && !a.brief.degraded).length,
      });
    } else if (assets.length) {
      // 全部素材已在「读取照片」阶段由 AI 解析好，直接复用，无需等待
      assets = (await attachAssetBriefs(assets, {
        apiKey: prepared.apiKey,
        prompt: prepared.prompt,
        onLog: (line) => s.send({ type: "log", line: `[optimize] ${line}` }),
      })).assets;
    }
    const { optimized, angle } = await optimizePrompt(prepared.apiKey, prepared.prompt, {
      ...prepared.opts,
      assets,
      assetMode: prepared.assetMode,
      onDelta: (text) => s.send({ type: "delta", text }),
    });
    s.send({ type: "result", original: prepared.prompt, optimized, angle });
  } catch (err) {
    s.send({ type: "error", error: err?.message || String(err) });
  } finally {
    optimizing = false;
    s.end();
  }
});

// ============================================================
//  工程静态资源（预览配音、已导出的成片）
// ============================================================
app.use("/api/media/:project", (req, res, next) => {
  const name = req.params.project;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return res.status(400).json({ error: "非法工程名" });
  const dir = path.join(ROOT, name);
  if (!dir.startsWith(ROOT) || !fs.existsSync(dir)) return res.status(404).json({ error: "工程不存在" });
  const opts = {
    index: false,
    fallthrough: true,
    acceptRanges: true,
    setHeaders: (r) => r.setHeader("Cache-Control", "no-store"),
  };
  // 先找工程的 public/（配音 voice/*.wav 等静态资源），找不到再退到工程根（out/film.mp4 等）
  express.static(path.join(dir, "public"), opts)(req, res, () => {
    express.static(dir, opts)(req, res, next);
  });
});

// ============================================================
//  已生成工程列表（含预览载荷）
// ============================================================
app.get("/api/projects", (req, res) => {
  try {
    const projects = fs
      .readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => fs.existsSync(path.join(ROOT, name, "film.config.json")) || fs.existsSync(path.join(ROOT, name, "preview.json")))
      .map((name) => {
        try {
          const payload = buildPreviewPayload(name);
          return {
            name,
            id: payload.compositionId,
            title: payload.title,
            sceneCount: payload.scenes.length,
            duration: payload.totalFrames ? (payload.totalFrames / payload.fps).toFixed(1) + "s" : "",
            styleTags: payload.styleTags || [],
            stylePack: payload.stylePack || "",
            palette: payload.palette || [],
            assets: payload.assets || [],
            subtitles: payload.subtitles !== false,
            hasVoice: Boolean(payload.voice && payload.voice.enabled && payload.voice.tracks.length),
            hasBgm: Boolean(payload.voice && payload.voice.bgm),
            voiceName: (payload.voice && payload.voice.voiceName) || "",
            bgmMood: (payload.voice && payload.voice.bgm && payload.voice.bgm.mood) || "",
            hasMp4: Boolean(payload.mp4),
            mp4: payload.mp4 ? `/api/media/${encodeURIComponent(name)}/out/${payload.mp4}` : null,
            ready: payload.ready,
            createdAt: projectCreatedAt(name),
            preview: payload,
          };
        } catch (e) {
          return { name, id: name, title: "", sceneCount: 0, duration: "", hasMp4: false, mp4: null, ready: false, createdAt: 0, error: e.message };
        }
      })
      // 新生成的工程排在最前（用目录创建时间，渲染导出不会改变它）
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || a.name.localeCompare(b.name));
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  Remotion Studio 编辑（把 Studio 当可调度的进程用）
//    POST /api/studio/open    { project }  启动（或复用）该工程的 Studio 会话
//    POST /api/studio/close   { project }  关闭会话、回收端口
//    GET  /api/studio/list                 当前会话
//    /studio/<sessionId>/*                 反代到 Studio，让 iframe 与页面同源
//  编辑的就是工程源码本身，所以「在 Studio 里改完」=「下一次导出就是改后版本」，无需中间格式。
// ============================================================
const studioSessions = new Map(); // sessionId -> session
const STUDIO_PORT_BASE = 3111;
const STUDIO_PORT_RANGE = 60;
const STUDIO_MAX_SESSIONS = 3;
const STUDIO_READY_TIMEOUT = 150000; // Studio 首包要打包，给足时间
const STUDIO_IDLE_MS = 60 * 60 * 1000; // 会话空转 1 小时自动回收，避免残留进程吃内存

function isKnownProjectDir(project) {
  if (!project || project.includes("/") || project.includes("\\") || project === "." || project === "..") return false;
  const dir = path.join(ROOT, project);
  return fs.existsSync(path.join(dir, "film.config.json")) || fs.existsSync(path.join(dir, "preview.json"));
}

function resolveStudioEntry(projectDir) {
  for (const f of ["src/index.ts", "src/index.tsx"]) {
    if (fs.existsSync(path.join(projectDir, f))) return f;
  }
  return "";
}

function resolveStudioBin(projectDir) {
  const suffix = process.platform === "win32" ? "remotion.cmd" : "remotion";
  for (const base of [path.join(projectDir, "node_modules", ".bin"), path.join(ROOT, "node_modules", ".bin")]) {
    const p = path.join(base, suffix);
    if (fs.existsSync(p)) return p;
  }
  return "";
}

// 只靠 listen 探测在 Windows 上不可靠：Node 在 Windows 上默认给所有 socket 设 SO_REUSEADDR，
// 于是「0.0.0.0 已被别的 Studio 占着」时，用 127.0.0.1 去 bind 依然会成功（实测返回 ok），
// 于是第二个 Studio 以为端口是空的拿到 3111、启动即崩，而前端探活探到的其实是那第一个 Studio ——
// 用户点开的编辑页会串成另一个工程。探测必须打在 0.0.0.0 上才能撞出 EADDRINUSE。
// 另外「不传 host」等价于 0.0.0.0，但那样可读性好差，显式写出来。
function isPortBindable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    let settled = false;
    probe.once("error", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    probe.once("listening", () => {
      probe.close(() => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });
    });
    // 注意：打 127.0.0.1 探不出占在 0.0.0.0 上的僵尸 Studio，详见上面注释
    probe.listen(port, "0.0.0.0");
  });
}

async function findFreePort(start, count) {
  const busy = new Set([...studioSessions.values()].map((s) => s.port).filter(Boolean));
  for (let i = 0; i < count; i++) {
    const port = start + i;
    if (busy.has(port)) continue;
    if (await isPortBindable(port)) return port;
  }
  return 0;
}

function probeStudioPort(port, onFail) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 || res.statusCode === 304);
    });
    req.on("error", (e) => {
      if (onFail) onFail(e.code || e.message);
      resolve(false);
    });
    req.on("timeout", () => {
      req.destroy();
      if (onFail) onFail("timeout");
      resolve(false);
    });
  });
}

function killStudio(s) {
  if (!s || s.dead) return;
  s.dead = true;
  clearTimeout(s.idleTimer);
  try {
    s.proc.kill("SIGKILL");
  } catch {}
  // Windows 上 cmd.exe 未必跟着死，按命令行把整棵子树清掉，避免留下占端口的孤儿
  try {
    const out = execFileSync("taskkill", ["/pid", String(s.proc.pid), "/t", "/f"], { stdio: "ignore" });
    void out;
  } catch {}
  try {
    fs.closeSync(s.logFd);
  } catch {}
  studioSessions.delete(s.id);
}

function spawnStudio(projectName, port) {
  const projectDir = path.join(ROOT, projectName);
  const entry = resolveStudioEntry(projectDir);
  if (!entry) throw new Error(`工程 ${projectName} 缺少 src/index.ts，无法启动 Studio`);
  const bin = resolveStudioBin(projectDir);
  if (!bin) throw new Error(`工程 ${projectName} 缺少 remotion CLI，请先 npm install`);

  const sid = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Studio 输出直接落盘：管道事件不可靠时仍能排错，也方便用户自己看启动过程。
  // 按工程覆盖写（一个工程最多一个会话），不然每次开编辑都留一份日志会越积越多。
  const logPath = path.join(ROOT, ".studio-logs", `${projectName}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "w");
  const log = [];
  const pushLog = (line) => {
    const t = String(line).slice(0, 300);
    log.push(t);
    if (t.trim()) console.log(`[studio:${projectName}] ${t.trim()}`);
    if (log.length > 200) log.shift();
  };
  const appendLog = (line) => {
    pushLog(line);
    try {
      fs.appendFileSync(logFd, `${line}\n`);
    } catch {}
  };

  // Windows 上 remotion.cmd 不是可直接 exec 的二进制，必须交给 shell；
  // 用 Node 自己的 shell: true 去拼命令串，避免外层 shell 把引号吃掉。
  // 端口必须空格分隔传：cmd 会吃掉 `--port=3111` 里的等号，Remotion 拿到 undefined 后直接崩。
  // 同时不要开 windowsVerbatimArguments —— 它会让参数再次被 cmd 吞掉，同样变成 undefined。
  const args = ["studio", entry, "--port", String(port), "--no-open", "--force-new", "--log=info"];
  const child = spawn(bin, args, {
    cwd: projectDir,
    env: process.env,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    shell: process.platform === "win32",
  });

  const s = {
    id: sid,
    project: projectName,
    projectDir,
    entry,
    port: 0,
    proc: child,
    ready: false,
    dead: false,
    startedAt: Date.now(),
    log,
    logPath,
    logFd,
  };
  child.on("error", (err) => appendLog(`[spawn] ${err.message}`));
  child.on("exit", (code) => {
    appendLog(`[exit] code=${code}`);
    // Studio 异常退出（端口被占、依赖缺失等）时必须把会话摘掉，
    // 否则前端会拿到一个指向死进程的链接，甚至串到别的工程的 Studio 上。
    if (!s.dead) {
      s.ready = false;
      s.failed = s.failed || `Studio 进程退出（code=${code}）`;
      try {
        fs.closeSync(s.logFd);
      } catch {}
      studioSessions.delete(s.id);
    }
  });
  appendLog(`[spawn] ${bin} studio ${entry} --port ${port} (cwd=${projectDir})`);

  s.idleTimer = setTimeout(() => killStudio(s), STUDIO_IDLE_MS);

  s.probeCount = 0;
  s.probeLast = "";
  const startAt = Date.now();
  const waitReady = async () => {
    s.probeCount++;
    const ok = await probeStudioPort(s.port, (why) => {
      s.probeLast = why;
    });
    if (s.dead || !studioSessions.has(s.id)) return;
    if (ok) {
      s.ready = true;
      pushLog(`[ready] http://127.0.0.1:${s.port}/ (${((Date.now() - startAt) / 1000).toFixed(1)}s)`);
      return;
    }
    if (Date.now() - startAt > STUDIO_READY_TIMEOUT) {
      s.failed = `Studio 未能在 ${Math.round(STUDIO_READY_TIMEOUT / 1000)}s 内就绪：${s.probeCount} 次探活，最后 ${s.probeLast || "无响应"}`;
      pushLog(`[timeout] ${s.failed}`);
      s.ready = false;
      killStudio(s);
      return;
    }
    setTimeout(waitReady, 600);
  };
  setTimeout(waitReady, 300);

  studioSessions.set(sid, s);
  return s;
}

app.post("/api/studio/open", async (req, res) => {
  const project = typeof req.body?.project === "string" ? req.body.project.trim() : "";
  if (!ENABLE_HEAVY) {
    return res.status(503).json({ error: "当前托管预览版不含 Studio 在线编辑。请在本机使用完整版。" });
  }
  if (!isKnownProjectDir(project)) return res.status(400).json({ error: "未知的已生成工程" });

  // 同一工程只留一个 Studio 实例：重复点「编辑」复用，避免反复打包
  const existing = [...studioSessions.values()].find((s) => s.project === project && !s.dead && s.ready);
  if (existing) return res.json({ ok: true, session: publicStudio(existing, requestHostName(req)) });

  if (studioSessions.size >= STUDIO_MAX_SESSIONS) {
    const oldest = [...studioSessions.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    killStudio(oldest);
    if (studioSessions.size >= STUDIO_MAX_SESSIONS) {
      return res.status(409).json({ error: `同时最多编辑 ${STUDIO_MAX_SESSIONS} 个工程，请先关闭其它编辑窗口` });
    }
  }

  const port = await findFreePort(STUDIO_PORT_BASE, STUDIO_PORT_RANGE);
  if (!port) return res.status(500).json({ error: "没有可用端口了，请稍后重试" });

  try {
    const s = spawnStudio(project, port);
    s.port = port;
    const startAt = Date.now();
    // 前端要的是一个能打开的 URL，所以这里同步等到就绪（首包约 3~10s，最坏 150s）
    while (Date.now() - startAt < STUDIO_READY_TIMEOUT) {
      if (s.ready) break;
      // dead = 被主动回收；不在 sessions 里 = 子进程自己退了。两种都要立刻报错，别干等 150s
      if (s.dead || !studioSessions.has(s.id)) {
        return res.status(500).json({ error: `Studio 启动失败：${s.failed || s.log.slice(-3).join(" | ") || "未知错误"}`, log: s.log.slice(-25) });
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!s.ready) {
      killStudio(s);
      return res.status(500).json({ error: s.failed || `Studio 未就绪（${Math.round(STUDIO_READY_TIMEOUT / 1000)}s 超时）`, log: s.log.slice(-30) });
    }
    // 「就绪」是靠探活判定的，而 responder 未必是我们的子进程。万一僵尸 Studio 先答了、我们的子进程
    // 紧接着退出，上面那轮 while 就会拿一个死会话发给前端（用户看到的是另一个工程的编辑页）。
    // 返回之前再确认一次进程确实还活着。
    if (s.dead || s.proc.exitCode !== null) {
      killStudio(s);
      return res.status(500).json({ error: `Studio 启动后立即退出：${s.failed || s.log.slice(-3).join(" | ") || "未知错误"}`, log: s.log.slice(-30) });
    }
    res.json({ ok: true, session: publicStudio(s, requestHostName(req)) });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

function publicStudio(s, hostName) {
  const host = hostName || "localhost";
  return {
    sessionId: s.id,
    project: s.project,
    entry: s.entry,
    port: s.port,
    ready: s.ready,
    // Studio 页面里的 /bundle.js、/favicon.ico 都是绝对路径，只有让浏览器直接访问
    // Studio 自己的 origin 才能取到（放到 /studio/xxx/ 子路径下会被解析到站点根）。
    // 所以这里给的是直连地址，iframe 直接用它。
    url: `http://${host}:${s.port}/`,
    startedAt: s.startedAt,
    elapsedSec: Math.round((Date.now() - s.startedAt) / 1000),
  };
}

function requestHostName(req) {
  const raw = req.headers.host || "localhost";
  const host = raw.split(":")[0];
  return host || "localhost";
}

app.post("/api/studio/close", (req, res) => {
  const project = typeof req.body?.project === "string" ? req.body.project.trim() : "";
  if (!project) return res.json({ ok: true });
  const s = [...studioSessions.values()].find((x) => x.project === project && !x.dead);
  if (!s) return res.json({ ok: true, closed: false });
  killStudio(s);
  res.json({ ok: true, closed: true });
});

app.get("/api/studio/list", (req, res) => {
  const host = requestHostName(req);
  res.json({ sessions: [...studioSessions.values()].filter((s) => !s.dead).map((s) => publicStudio(s, host)) });
});

// ---- 进程退出时清掉 Studio 子进程，别在后台留孤儿 ----
process.on("exit", () => {
  for (const s of studioSessions.values()) {
    try {
      s.proc.kill("SIGKILL");
    } catch {}
  }
});

// ============================================================
//  旧接口（兼容：不落盘的一次性生成）
// ============================================================
app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, generateProject } = req.body;
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt 是必填字段" });
    }
    const apiKey = getApiKey();
    if (!apiKey) return res.status(500).json({ error: "AI API key 未配置" });

    const result = await generateAiFilm({ apiKey, prompt, previewOnly: !generateProject, withSmoke: Boolean(generateProject) });
    res.json({
      success: true,
      config: result.manifest,
      summary: result.summary,
      projectPath: result.projectPath,
      direction: result.direction,
      codeStats: result.codeStats,
      voiceReady: result.voiceReady,
    });
  } catch (err) {
    console.error("Generate error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---- 托管单进程模式：内嵌 Vite 中间件，保留 /@fs/ 转译以支撑浏览器内预览 ----
let viteHandler = null;
if (ENABLE_VITE_MW) {
  try {
    const { createServer: createVite } = await import("vite");
    const vite = await createVite({
      root: path.join(ROOT, "web"),
      appType: "spa",
      logLevel: "warn",
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
        fs: { allow: [ROOT, path.join(ROOT, "web")] },
      },
      // 显式预打包核心依赖，确保 react-dom/client 等子路径也能拿到具名导出
      optimizeDeps: {
        include: [
          "react",
          "react-dom",
          "react-dom/client",
          "remotion",
          "@remotion/player",
        ],
      },
    });
    viteHandler = vite.middlewares;
    console.log("  │  Vite 中间件已挂载（浏览器内预览 TSX 转译就绪）      │");
  } catch (e) {
    console.error("  ✗ Vite 中间件启动失败，回退静态托管:", e?.message || e);
  }
}

// ---- 前端托管（仅处理非 /api 的 GET）----
if (viteHandler) {
  // Vite 中间件：dev 态按需转译（含 /@fs/ 下的生成组件），让浏览器内 @remotion/player 能加载
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api/")) return viteHandler(req, res, next);
    next();
  });
} else if (hasDist) {
  // 兜底：无 Vite 时回 index.html（SPA fallback）
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api/")) return res.sendFile(path.join(DIST, "index.html"));
    next();
  });
}

// ---- 兜底 404 ----
app.use((req, res) => {
  res.status(404).json({ error: `未找到: ${req.method} ${req.originalUrl}` });
});

// ---- 启动 ----
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  ┌────────────────────────────────────────────┐`);
  console.log(`  │  Promix · AI Video Generator                │`);
  console.log(`  │  模式     ${ENABLE_VITE_MW ? "托管(内嵌Vite, 预览可用)" : "API 服务"}`.padEnd(48) + "│");
  console.log(`  │  访问     http://localhost:${PORT}             │`);
  console.log(`  │  API      http://localhost:${PORT}/api           │`);
  console.log(`  └────────────────────────────────────────────┘\n`);
});
// 生成 / 渲染可能跑十几分钟，关掉 Node 18+ 的请求与连接超时
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

// Studio 直连自己的端口，热更新 websocket 由 iframe 自己连，不需要在这里转发。
