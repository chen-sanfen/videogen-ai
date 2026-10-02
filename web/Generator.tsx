// web/Generator.tsx — AI 视频生成器前端（两段式流程）
//   ① 点「生成预览视频」→ AI 写分镜 + 写组件 + 落盘工程（含配音）
//      → 用 @remotion/player 在浏览器里直接播放这些 AI 组件：不渲染、不产出 MP4，秒级看到画面
//   ② 满意后点「渲染导出 MP4」→ 服务端逐帧渲染 → out/film.mp4，带真实进度
// 预览与导出消费同一份组件源码，预览所见即最终渲染所得。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { AbsoluteFill, Audio, Sequence, interpolate, useCurrentFrame } from 'remotion';
import './generator.css';

/* ---------------- 类型 ---------------- */
interface SceneMeta {
  name: string;
  file: string;
  subtitle: string;
  from: number;
  durationInFrames: number;
}
interface VoiceTrackMeta {
  file: string;
  scene: string;
  from: number;
  duration: number;
  text?: string;
  emotion?: string;
}
interface BgmMeta {
  file: string;
  mood: string;
  bpm: number;
  volume: number;
  duck: number;
}
interface VoiceConfig {
  enabled: boolean;
  declared?: boolean;
  provider?: string;
  voiceName?: string;
  voiceReason?: string;
  bgm?: BgmMeta | null;
  tracks: VoiceTrackMeta[];
}
interface PreviewPayload {
  projectName: string;
  dirAbs: string;
  compositionId: string;
  title: string;
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
  styleTags?: string[];
  /** 本次用的风格包 id（点「参考这个工程」时按它复用整套设计令牌） */
  stylePack?: string;
  /** 本工程引用的用户素材（直用模式下组件会用到 public/assets/ 里的这些文件） */
  assets?: string[];
  /** 是否在画面里渲染字幕（false = 字幕只作配音文案） */
  subtitles?: boolean;
  backdrop: string;
  scenes: SceneMeta[];
  /** 配音（逐句音频，绝对帧号）+ 背景音乐；与导出的 Film.tsx 消费同一份时间轴 */
  voice?: VoiceConfig;
  voiceFiles: string[];
  mp4: string | null;
  ready: boolean;
  missing?: string[];
}
interface ProjectInfo {
  name: string;
  id: string;
  title: string;
  sceneCount: number;
  duration: string;
  styleTags?: string[];
  stylePack?: string;
  palette?: string[];
  assets?: string[];
  hasMp4: boolean;
  mp4: string | null;
  subtitles?: boolean;
  hasVoice?: boolean;
  hasBgm?: boolean;
  voiceName?: string;
  bgmMood?: string;
  ready: boolean;
  createdAt?: number;
  preview?: PreviewPayload;
  error?: string;
}
interface ExportInfo {
  url: string;
  sizeBytes: number;
  elapsedSec: number;
}

/* ---------------- 用户素材 ---------------- */
type AssetKind = 'image' | 'video' | 'url';
interface AssetMeta {
  width: number;
  height: number;
  /** 带占比的主色（从多到少），重绘配色必须照抄这个比例关系 */
  palette: string[];
  paletteRatio?: number[];
  brightness: number;
  /** 3x3 网格采样：色彩 / 明暗 / 饱和度分布（保留，优化描述仍在用） */
  grid?: { color: string; lum: number; sat: number }[];
  /**
   * 降采样色彩网格图（行优先，每行 cols 个 hex）——重绘保真的核心依据。
   * 后端没有视觉模型，LLM 看不到图；这张「色块地图」就是它能拿到的最接近看图的东西。
   */
  map?: { cols: number; rows: number; cells: string[] };
  /** 显著区域（主体）边界框，百分比坐标，0~1 */
  subject?: { x: number; y: number; w: number; h: number; cx: number; cy: number };
  /** 每格细节密度（0~1）：判断主体是简洁块面还是复杂纹理 */
  detail?: number[];
}
interface AssetItem {
  id: string;
  kind: AssetKind;
  label: string;
  status: 'probing' | 'ready' | 'error';
  error?: string;
  // 图片 / 视频
  storedName?: string;
  bytes?: number;
  previewUrl?: string;
  meta?: AssetMeta;
  // 网址
  url?: string;
  host?: string;
  title?: string;
  description?: string;
  headings?: string[];
  text?: string;
  /** 抓到的网页主图（第一候选） */
  imageUrl?: string;
  /** 主图候选列表：直用模式下后端会逐个兜底下载 */
  images?: string[];
  /** 照片「完全读取完毕」后由 AI 解析出的主体理解（提取主体 / 构图 / 配色） */
  brief?: {
    subject?: string;
    elements?: string[];
    composition?: string;
    mood?: string;
    degraded?: boolean;
  } | null;
  /** 正在让 AI 解析这张照片 */
  parsing?: boolean;
}

// 组件文件名 → 人话。Backdrop.tsx 是背景层而不是分镜，直接显示文件名会让人以为漏了一个分镜
function compLabel(file: string) {
  if (file === 'Backdrop.tsx') return '背景层';
  return file.replace(/\.tsx$/, '');
}

const MAX_ASSETS = 12;
// 风格参考最多选几个：再多上下文会被样例代码淹没，融合反而变糊
const MAX_STYLE_REFS = 4;
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'];
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v'];

/* 素材用法三态：怎么用用户给的素材 */
type AssetMode = 'reference' | 'direct' | 'redraw';
const ASSET_MODES: { id: AssetMode; label: string; tip: string }[] = [
  { id: 'reference', label: '仅参考', tip: '素材只用于理解风格与内容方向，画面仍是 AI 原创绘制' },
  { id: 'direct', label: '直接使用', tip: '照片 / 视频 / 网址主图原样出现在视频画面里' },
  {
    id: 'redraw',
    label: 'AI 重绘',
    tip: '先提取素材里的主体、构图与配色，再由 AI 按本片风格重新绘制一张，重绘件作为画面主体进片',
  },
];
const ASSET_MODE_HINT: Record<AssetMode, string> = {
  reference: '「仅参考」：素材只用于把握色调与内容方向，画面依旧由 AI 原创绘制。',
  direct:
    '「直接使用」：照片与视频会作为画面主体出现在成片里；网址会尝试抓取主图，抓不到主图时改用它的标题 / 摘要作为文案。',
  redraw:
    '「AI 重绘」：先提取每件素材的主体、构图与配色，再由 AI 按本片风格重绘一张（配了图像接口就出位图，否则出矢量插画），重绘件作为画面主体进片；重绘失败会自动退回原素材。',
};

const EXAMPLES = [
  '做一个智能家居APP的产品宣传片',
  '做一个在线教育平台的产品视频',
  '做一个健身追踪应用的宣传片',
  '做一个音乐播放器APP的宣传片',
  '做一个金融理财应用的产品视频',
];

type Phase = 'idle' | 'generating' | 'preview' | 'rendering' | 'exported';

// 已生成项目：一页 3 行 × 4 列 = 12 个，翻页查看后面的
const PAGE_SIZE = 12;

// Player 预先挂载的 <audio> 标签池大小。
// ⚠️ 必须是常量：Remotion 只在 Player 首次挂载时读取这个值，之后再变就抛
// "The number of shared audio tags has changed dynamically"，且该错误发生在其内部
// 错误边界之外，会把整个 React 根节点卸载掉 —— 表现就是整页黑屏。
// 配音/配乐上线后，一屏可能同时挂着十几条 <Audio>（逐句配音 + 配乐）。
// Remotion 会复用这些共享标签，池子给足余量即可；组件契约仍禁止分镜里使用 <Audio>。
const AUDIO_TAG_POOL = 16;

// 自定义视频时长（秒）：留空 = 交给 AI 自行决定
const DURATION_MIN = 6;
const DURATION_MAX = 90;
const DURATION_PRESETS = [15, 30, 45, 60];

/* ---------------- 工具 ---------------- */
// 把后端返回的工程绝对路径转成 Vite 能转译的模块地址（dev 下 /@fs 可读工作区内的任意文件）
function fsPathToUrl(abs: string) {
  return '/@fs/' + abs.replace(/\\/g, '/');
}

// 读取 NDJSON 流（POST 也能流式拿进度；不像 EventSource 会自动重连重复触发生成）
async function streamNdjson(url: string, body: unknown, onEvent: (ev: any) => void) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `请求失败（HTTP ${res.status}）`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  if (!res.body) throw new Error('服务端未返回数据流');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {}
    }
  }
  const tail = buf.trim();
  if (tail) {
    try {
      onEvent(JSON.parse(tail));
    } catch {}
  }
}

function fmtSize(bytes: number) {
  if (!bytes) return '';
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1048576).toFixed(2)}MB`;
}

/* ---------------- 素材元数据探测 ----------------
 * 参考模式不需要把文件传给模型，但「这张图什么色调、什么比例」必须让模型知道，
 * 否则"参考素材"就成了一句空话。这里在浏览器里用 canvas 采样：
 *   - 尺寸 / 宽高比
 *   - 主色调（4bit/通道量化后取前 5）
 *   - 平均明度
 * 视频则抽第一帧当图片处理。
 * ------------------------------------------------- */
const toHex = (n: number) => n.toString(16).padStart(2, '0');

function sampleCanvasMeta(canvas: HTMLCanvasElement, w: number, h: number): AssetMeta {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { width: w, height: h, palette: [], brightness: 0.5 };
  const cw = canvas.width;
  const ch = canvas.height;
  const { data } = ctx.getImageData(0, 0, cw, ch);
  type Bucket = { r: number; g: number; b: number; c: number };
  const buckets = new Map<string, Bucket>();
  // 3x3 网格：每格累计 RGB / 明度 / 饱和度。重绘时这是「主体在画面哪个位置」的唯一线索，
  // 因为后端拿不到视觉模型，只能靠这些实测数字推断构图。
  type Cell = { r: number; g: number; b: number; lum: number; sat: number; c: number };
  const cells: Cell[] = Array.from({ length: 9 }, () => ({ r: 0, g: 0, b: 0, lum: 0, sat: 0, c: 0 }));
  let sum = 0;
  let n = 0;
  for (let y = 0; y < ch; y++) {
    const gy = y < ch / 3 ? 0 : y < (ch * 2) / 3 ? 1 : 2;
    for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      const a = data[i + 3];
      if (a < 128) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      sum += lum;
      n += 1;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const cur = buckets.get(key) || { r: 0, g: 0, b: 0, c: 0 };
      cur.r += r;
      cur.g += g;
      cur.b += b;
      cur.c += 1;
      buckets.set(key, cur);
      const cell = cells[gy * 3 + (x < cw / 3 ? 0 : x < (cw * 2) / 3 ? 1 : 2)];
      cell.r += r;
      cell.g += g;
      cell.b += b;
      cell.lum += lum;
      cell.sat += sat;
      cell.c += 1;
    }
  }
  const top = [...buckets.values()]
    .sort((a, b) => b.c - a.c)
    .slice(0, 5)
    .map((v) => `#${toHex(Math.round(v.r / v.c))}${toHex(Math.round(v.g / v.c))}${toHex(Math.round(v.b / v.c))}`);
  const grid = cells.map((c) =>
    c.c
      ? {
          color: `#${toHex(Math.round(c.r / c.c))}${toHex(Math.round(c.g / c.c))}${toHex(Math.round(c.b / c.c))}`,
          lum: Math.round((c.lum / c.c) * 100) / 100,
          sat: Math.round((c.sat / c.c) * 100) / 100,
        }
      : { color: '#000000', lum: 0, sat: 0 }
  );
  // ---- 主色的「占比」：重绘时配色不只要对，还得是同样的比例关系，
  //      否则模型会把点缀色画成主色（实测最常见的偏离就是配色权重反了）。
  const sortedBuckets = [...buckets.values()].sort((a, b) => b.c - a.c).slice(0, 5);
  const paletteRatio = sortedBuckets.map((v) => Math.round((v.c / (n || 1)) * 100) / 100);

  // ---- 降采样色彩网格图：这是「重绘不偏离原图」的关键依据。
  //      后端没有视觉模型，LLM 永远看不到这张图；把画面压成 16x9 的色块地图给它，
  //      它就能照着重建——主体在哪、什么颜色、明暗怎么分布，都写在这张表里。
  //      缩放本身就是在做区域平均（浏览器 downscale 自带平滑），一行代码胜过手搓采样。
  const MAP_COLS = 16;
  const MAP_ROWS = 9;
  let map: AssetMeta['map'];
  try {
    const small = document.createElement('canvas');
    small.width = MAP_COLS;
    small.height = MAP_ROWS;
    const sctx = small.getContext('2d');
    if (sctx) {
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(canvas, 0, 0, MAP_COLS, MAP_ROWS);
      const sd = sctx.getImageData(0, 0, MAP_COLS, MAP_ROWS).data;
      const cells: string[] = [];
      for (let i = 0; i < MAP_COLS * MAP_ROWS; i++) {
        cells.push(`#${toHex(sd[i * 4])}${toHex(sd[i * 4 + 1])}${toHex(sd[i * 4 + 2])}`);
      }
      map = { cols: MAP_COLS, rows: MAP_ROWS, cells };
    }
  } catch {
    /* 拿不到就算了，后面的兜底会处理 */
  }

  // ---- 主体在哪 / 画面细节密度：在 32x18 的中精度图上算，够用且便宜。
  //      显著度 = 该格与全图均色的偏离；偏离最大的那片区域就是视觉主体。
  let subject: AssetMeta['subject'];
  const detail: number[] = [];
  try {
    const DCOLS = 32;
    const DROWS = 18;
    const mid = document.createElement('canvas');
    mid.width = DCOLS;
    mid.height = DROWS;
    const mctx = mid.getContext('2d');
    if (mctx) {
      mctx.imageSmoothingEnabled = true;
      mctx.drawImage(canvas, 0, 0, DCOLS, DROWS);
      const md = mctx.getImageData(0, 0, DCOLS, DROWS).data;
      const px: { r: number; g: number; b: number; lum: number }[] = [];
      let ar = 0;
      let ag = 0;
      let ab = 0;
      for (let i = 0; i < DCOLS * DROWS; i++) {
        const r = md[i * 4];
        const g = md[i * 4 + 1];
        const b = md[i * 4 + 2];
        ar += r;
        ag += g;
        ab += b;
        px.push({ r, g, b, lum: (0.299 * r + 0.587 * g + 0.114 * b) / 255 });
      }
      const N = DCOLS * DROWS;
      ar /= N;
      ag /= N;
      ab /= N;
      const sal = px.map(
        (p) => Math.sqrt((p.r - ar) ** 2 + (p.g - ag) ** 2 + (p.b - ab) ** 2) / 441.7
      );
      // 细节密度：相邻格的明度落差，归并到 16x9 网格
      for (let ry = 0; ry < MAP_ROWS; ry++) {
        for (let rx = 0; rx < MAP_COLS; rx++) {
          let acc = 0;
          let cnt = 0;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const x = rx * 2 + dx;
              const y = ry * 2 + dy;
              if (x + 1 < DCOLS) acc += Math.abs(px[y * DCOLS + x].lum - px[y * DCOLS + x + 1].lum), cnt++;
              if (y + 1 < DROWS) acc += Math.abs(px[y * DCOLS + x].lum - px[(y + 1) * DCOLS + x].lum), cnt++;
            }
          }
          // 归一化到 0~1：落差 0.25 已属强对比纹理
          detail.push(Math.round(Math.min(1, (cnt ? acc / cnt : 0) / 0.25) * 100) / 100);
        }
      }
      // 取显著度前 25% 的格子当作主体区域，求包围盒 + 质心
      const ranked = [...sal].sort((a, b) => b - a);
      const cut = Math.max(ranked[Math.floor(ranked.length * 0.25)] || 0, 0.08);
      let minX = DCOLS;
      let minY = DROWS;
      let maxX = -1;
      let maxY = -1;
      let wsum = 0;
      let cx = 0;
      let cy = 0;
      for (let y = 0; y < DROWS; y++) {
        for (let x = 0; x < DCOLS; x++) {
          const s = sal[y * DCOLS + x];
          if (s < cut) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          wsum += s;
          cx += (x + 0.5) * s;
          cy += (y + 0.5) * s;
        }
      }
      if (maxX >= 0 && wsum > 0) {
        subject = {
          x: Math.round((minX / DCOLS) * 100) / 100,
          y: Math.round((minY / DROWS) * 100) / 100,
          w: Math.round(((maxX - minX + 1) / DCOLS) * 100) / 100,
          h: Math.round(((maxY - minY + 1) / DROWS) * 100) / 100,
          cx: Math.round((cx / wsum / DCOLS) * 100) / 100,
          cy: Math.round((cy / wsum / DROWS) * 100) / 100,
        };
      }
    }
  } catch {
    /* 同上：拿不到就交给兜底 */
  }
  // 纯色 / 极端低对比的图没有显著区域，退化成「主体居中占大半」的通用构图
  if (!subject) subject = { x: 0.2, y: 0.2, w: 0.6, h: 0.6, cx: 0.5, cy: 0.5 };

  return {
    width: w,
    height: h,
    palette: top,
    paletteRatio,
    brightness: n ? sum / n : 0.5,
    grid,
    map,
    subject,
    detail: detail.length ? detail : undefined,
  };
}

function drawToCanvas(src: HTMLImageElement | HTMLVideoElement): { canvas: HTMLCanvasElement; w: number; h: number } {
  const w = src instanceof HTMLVideoElement ? src.videoWidth : src.naturalWidth;
  const h = src instanceof HTMLVideoElement ? src.videoHeight : src.naturalHeight;
  // 采样到 72px 长边：足够做色调统计，又几乎不花时间
  const scale = 72 / Math.max(1, Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(src as any, 0, 0, canvas.width, canvas.height);
  return { canvas, w, h };
}

function probeImage(file: File): Promise<AssetMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const { canvas, w, h } = drawToCanvas(img);
        resolve(sampleCanvasMeta(canvas, w, h));
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败'));
    };
    img.src = url;
  });
}

function probeVideo(file: File): Promise<AssetMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    const done = (fn: () => void) => {
      URL.revokeObjectURL(url);
      fn();
    };
    v.onloadeddata = () => {
      try {
        // 往后拉一点，避开纯黑的开场帧
        const t = Math.min(1, (v.duration || 1) / 2);
        v.currentTime = Number.isFinite(t) ? t : 0;
      } catch {
        done(() => resolve({ width: v.videoWidth, height: v.videoHeight, palette: [], brightness: 0.5 }));
      }
    };
    v.onseeked = () => {
      try {
        const { canvas, w, h } = drawToCanvas(v);
        done(() => resolve(sampleCanvasMeta(canvas, w, h)));
      } catch (e) {
        done(() => reject(e instanceof Error ? e : new Error('视频取帧失败')));
      }
    };
    v.onerror = () => done(() => reject(new Error('无法读取这个视频（浏览器不支持该编码）')));
    v.src = url;
  });
}

async function uploadAsset(file: File): Promise<{ storedName: string; kind: 'image' | 'video'; bytes: number }> {
  let res: Response;
  try {
    res = await fetch(`/api/asset/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
  } catch {
    throw new Error('连不上后端服务（http://127.0.0.1:3001）。请在项目目录运行 npm run server 后再上传。');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 后端没起时响应体不是 JSON，data.error 为空 —— 只报一个状态码等于没说原因
    if (data?.error) throw new Error(data.error);
    throw new Error(
      res.status >= 500
        ? `上传失败：后端服务未响应（HTTP ${res.status}）。请确认后端在跑（npm run server）。`
        : `上传失败（HTTP ${res.status}）`
    );
  }
  return data;
}

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// 照片读取完毕后让 AI 解析是「每个素材一次 LLM 调用」，上传一批图时若全并发会把网关打爆
// （实测单件约 15~20s）。这里用一个小令牌池，全局最多 2 路同时在解析，其余排队。
const AI_PARSE_MAX = 2;
let aiParseSlots = 0;
const aiParseWaiters: (() => void)[] = [];
function acquireAiParseSlot() {
  return new Promise<void>((resolve) => {
    if (aiParseSlots < AI_PARSE_MAX) {
      aiParseSlots++;
      resolve();
    } else {
      aiParseWaiters.push(resolve);
    }
  });
}
function releaseAiParseSlot() {
  aiParseSlots--;
  const next = aiParseWaiters.shift();
  if (next) {
    aiParseSlots++;
    next();
  }
}

// 工程创建时间：今天只显示时分，其它日期显示月-日
function fmtTime(ms?: number) {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `今天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ---------------- 动态加载 AI 生成的组件 ---------------- */
interface LoadedFilm {
  scenes: React.ComponentType<{ subtitle: string }>[];
  backdrop: React.ComponentType | null;
  preview: PreviewPayload;
}

function useFilmBundle(preview: PreviewPayload | null) {
  const [state, setState] = useState<{ loading: boolean; film: LoadedFilm | null; error: string }>({
    loading: false,
    film: null,
    error: '',
  });

  useEffect(() => {
    if (!preview) {
      setState({ loading: false, film: null, error: '' });
      return;
    }
    if (!preview.ready) {
      setState({
        loading: false,
        film: null,
        error: `工程文件不完整，缺少：${(preview.missing || []).join(', ') || preview.backdrop}`,
      });
      return;
    }
    let alive = true;
    setState({ loading: true, film: null, error: '' });
    // 素材直用模式：组件里写的是 staticFile("assets/x.jpg")。
    // 渲染时会解析到工程的 public/（publicDir），但浏览器内预览没有那个静态根，
    // 于是把它指到后端的 media 路由（该路由正是挂载工程的 public/）。
    // remotion 的 staticFile 优先读 window.remotion_staticBase，所以这里一句话就够，组件代码无需改动。
    (window as any).remotion_staticBase = `/api/media/${encodeURIComponent(preview.projectName)}`;
    (async () => {
      try {
        const urls = [
          ...preview.scenes.map((s) => fsPathToUrl(`${preview.dirAbs}/src/scenes/${s.file}`)),
          fsPathToUrl(`${preview.dirAbs}/src/${preview.backdrop || 'Backdrop.tsx'}`),
        ];
        // 交给 Vite 转译 TSX 并复用应用自己的 react / remotion 实例（同一个 Player 上下文）
        const mods = await Promise.all(urls.map((u) => import(/* @vite-ignore */ u)));
        if (!alive) return;
        const backdrop = (mods[mods.length - 1]?.default as React.ComponentType) ?? null;
        const scenes = mods.slice(0, -1).map((m) => (m?.default as React.ComponentType<{ subtitle: string }>) ?? null) as LoadedFilm['scenes'];
        setState({ loading: false, film: { scenes, backdrop, preview }, error: '' });
      } catch (e) {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState({ loading: false, film: null, error: `预览加载失败：${msg}` });
      }
    })();
    return () => {
      alive = false;
    };
  }, [preview]);

  return state;
}

// 背景音乐闪避：说话时把音乐压下去，说完抬回来（前后各留渐变，避免抽气感）。
// 数值与工程 Film.tsx 里的胶水保持一致——预览听到的就是导出听到的。
const BGM_LEAD = 8;
const BGM_TAIL = 14;

function speakingFactor(frame: number, intervals: { from: number; to: number }[]) {
  let best = 0;
  for (const iv of intervals) {
    const a = iv.from - BGM_LEAD;
    const b = iv.to + BGM_TAIL;
    if (frame <= a || frame >= b) continue;
    const up = interpolate(frame, [a, iv.from], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const down = interpolate(frame, [iv.to, b], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const v = Math.min(up, down);
    if (v > best) best = v;
  }
  return best;
}

// 组装与工程 Film.tsx 一致的合成：背景层 + 各分镜 Sequence + 逐句配音 + 带闪避的配乐。
function createFilm(film: LoadedFilm) {
  const { scenes: sceneComps, backdrop: Backdrop, preview } = film;

  const voiceCfg = preview.voice;
  const tracks = voiceCfg && voiceCfg.enabled ? voiceCfg.tracks : [];
  const bgm = voiceCfg ? voiceCfg.bgm : null;
  const intervals = tracks.map((t) => ({ from: t.from, to: t.from + t.duration }));
  const totalFrames = preview.totalFrames;
  // 音频走后端 media 路由（那里正好挂着工程的 public/），与 staticFile 的指向一致
  const previewBase = (rel: string) => `/api/media/${encodeURIComponent(preview.projectName)}/${rel}`;

  // 单句配音：句首尾各一次短淡入淡出，避免爆音（与工程 Film.tsx 完全一致）
  const VoiceClip: React.FC<{ file: string; from: number; duration: number }> = ({ file, from, duration }) => {
    const frame = useCurrentFrame();
    const local = frame - from;
    const fade = Math.max(3, Math.min(10, Math.floor(duration / 4)));
    const volume = interpolate(
      local,
      [0, fade, Math.max(fade + 1, duration - fade), duration],
      [0, 1, 1, 0],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
    return (
      <Sequence from={from} durationInFrames={duration} name={`voice-${file}`}>
        <Audio src={previewBase('voice/' + file)} volume={volume} />
      </Sequence>
    );
  };

  const Film: React.FC = () => (
    <AbsoluteFill style={{ background: '#000', overflow: 'hidden' }}>
      {Backdrop ? <Backdrop /> : null}
      {preview.scenes.map((s, i) => {
        const Comp = sceneComps[i];
        return (
          <Sequence key={s.name} from={s.from} durationInFrames={s.durationInFrames} name={s.name}>
            {Comp ? React.createElement(Comp, { subtitle: s.subtitle }) : null}
          </Sequence>
        );
      })}
      {bgm ? (
        <Audio
          src={previewBase('voice/' + bgm.file)}
          volume={(f: number) => {
            const base = Number(bgm.volume) || 0.22;
            const duck = Number(bgm.duck) || 0.07;
            const speak = speakingFactor(f, intervals);
            const head = interpolate(f, [0, 24], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            const tail = interpolate(
              f,
              [Math.max(1, totalFrames - 50), totalFrames],
              [1, 0],
              { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
            );
            return (base + (duck - base) * speak) * head * tail;
          }}
        />
      ) : null}
      {tracks.map((t, i) => (
        <VoiceClip key={`${i}-${t.file}`} file={t.file} from={t.from} duration={t.duration} />
      ))}
    </AbsoluteFill>
  );
  return Film;
}

// 播放器级错误边界：
// Remotion 的 numberOfSharedAudioTags 校验、AudioContext、媒体解码等错误发生在
// <Player> 自带的 errorFallback 之外，一旦抛出就会把整个 React 根卸载 → 黑屏。
// 这里兜住它，只让预览区显示错误卡片，页面其余部分照常可用。
class PreviewBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[preview] 播放器渲染出错：', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="gen-player-error">
          <strong>预览播放器出错（已拦截，页面不会黑屏）</strong>
          <p>{this.state.error.message}</p>
          <button className="gen-btn gen-btn-ghost" onClick={() => this.setState({ error: null })}>
            重新加载预览
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ---------------- 主组件 ---------------- */
export function Generator({ jumpToProjects = 0 }: { jumpToProjects?: number }) {
  const [prompt, setPrompt] = useState('');
  // 自定义时长：输入框里的原始文本（'' = 自动）
  const [secondsText, setSecondsText] = useState('');
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projPage, setProjPage] = useState(1);
  const [phase, setPhase] = useState<Phase>('idle');
  const [stage, setStage] = useState<{ label: string; done: number; total: number } | null>(null);
  // 卡住提示：生成期间若长时间收不到任何新事件，明确告诉用户「还在等、会自动重试」，
  // 而不是让进度条一动不动（那看起来跟崩了没区别）
  const [stalled, setStalled] = useState(false);
  const lastTickRef = useRef(0);
  const [stylePack, setStylePack] = useState('');
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [previewFrom, setPreviewFrom] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [errorScope, setErrorScope] = useState<'optimize' | 'generate' | 'render'>('generate');
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderFrames, setRenderFrames] = useState({ rendered: 0, total: 0 });
  const [exported, setExported] = useState<ExportInfo | null>(null);
  const [showJson, setShowJson] = useState(false);
  // 提示词优化
  const [optimizing, setOptimizing] = useState(false);
  // 优化的前置阶段：后端正在逐件「看懂」上传的素材（比正文扩写更早，也要等更久）
  const [optimizeReading, setOptimizeReading] = useState(false);
  const [originalPrompt, setOriginalPrompt] = useState<string | null>(null);
  const [optimizedNote, setOptimizedNote] = useState('');
  // 同一条原始描述下已生成的多个版本 —— 再次点击时提交给后端，要求本版与之前不重复
  const [optimizeHistory, setOptimizeHistory] = useState<string[]>([]);
  // 组件生成的实时进度（文件名 → 已写代码字符数 / 思考字符数），避免几分钟的进度条看起来卡死
  const [compStream, setCompStream] = useState<Record<string, { chars: number; thinking: number }>>({});
  // 用户素材（图片 / 视频 / 网址）
  const [assets, setAssets] = useState<AssetItem[]>([]);
  // 素材用法：reference=仅参考（默认）/ direct=原样进画面 / redraw=提取主要元素后由 AI 重绘再进画面
  const [assetMode, setAssetMode] = useState<'reference' | 'direct' | 'redraw'>('reference');
  // 后端服务（:3001）不可达：所有 /api 都会失败，早点说清楚，别让人对着 500 猜
  const [backendDown, setBackendDown] = useState(false);
  // 网址输入
  const [urlText, setUrlText] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
  // 「参考已生成工程的风格」：可多选，空数组 = 自行生成
  const [styleRefProjects, setStyleRefProjects] = useState<string[]>([]);
  // 字幕开关：关闭时画面里不出现字幕文字（旁白不受影响）
  const [subtitlesOn, setSubtitlesOn] = useState(true);
  // 配音 / 背景音乐开关
  const [voiceOn, setVoiceOn] = useState(false);
  const [bgmOn, setBgmOn] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const projectsRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PlayerRef>(null);

  /* ---------------- 素材：添加 / 删除 ---------------- */

  // 照片「完全读取完毕」（已上传 + canvas 采好色调/主体框/色彩网格图）后，立刻让 AI 解析它，
  // 把提取出的主体/构图/配色存到 asset.brief——之后点「AI 优化描述」直接复用，不必再等 LLM 看一遍图。
  const analyzeAsset = useCallback(
    async (id: string, kind: AssetKind, label: string, storedName: string, meta?: AssetMeta) => {
      if (kind === 'url') return; // 网址自带标题/摘要/正文等可信文字，不需要 AI 看图
      setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, parsing: true } : a)));
      await acquireAiParseSlot();
      try {
        const res = await fetch('/api/asset/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, label, storedName, meta }),
        });
        const data = await res.json().catch(() => ({}));
        setAssets((prev) =>
          prev.map((a) => (a.id === id ? { ...a, parsing: false, brief: data?.brief || null } : a))
        );
      } catch {
        // 解析失败不阻断：优化时后端会兜底现场提取（或只用实测特征），不会报错卡死
        setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, parsing: false, brief: null } : a)));
      } finally {
        releaseAiParseSlot();
      }
    },
    []
  );

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      const accepted: { item: AssetItem; file: File }[] = [];
      let rejected = '';
      for (const f of list) {
        const ext = (f.name.split('.').pop() || '').toLowerCase();
        const kind: AssetKind | '' = IMAGE_EXT.includes(ext) ? 'image' : VIDEO_EXT.includes(ext) ? 'video' : '';
        if (!kind) {
          rejected = `${f.name}：不支持的格式（图片 png/jpg/webp/gif/avif，视频 mp4/webm/mov）`;
          continue;
        }
        accepted.push({
          item: {
            id: uid(),
            kind,
            label: f.name,
            status: 'probing',
            bytes: f.size,
            previewUrl: kind === 'image' ? URL.createObjectURL(f) : undefined,
          },
          file: f,
        });
      }
      if (rejected) {
        setErrorScope('generate');
        setErrorMsg(rejected);
      }
      if (!accepted.length) return;

      setAssets((prev) => {
        const room = MAX_ASSETS - prev.length;
        if (accepted.length > room) {
          setErrorMsg(`素材最多 ${MAX_ASSETS} 件，超出的已忽略`);
        }
        return [...prev, ...accepted.slice(0, Math.max(0, room)).map((a) => a.item)];
      });

      // 逐件探测元数据 + 上传（互不阻塞，单件失败只影响这一件）
      for (const { item, file } of accepted) {
        (async () => {
          let meta: AssetMeta | undefined;
          try {
            meta = item.kind === 'image' ? await probeImage(file) : await probeVideo(file);
          } catch (e) {
            meta = undefined;
          }
          try {
            const up = await uploadAsset(file);
            setAssets((prev) =>
              prev.map((a) => (a.id === item.id ? { ...a, storedName: up.storedName, bytes: up.bytes, meta, status: 'ready' } : a))
            );
            // 照片读取完毕 → 立刻让 AI 解析它；这一步是后台的，不阻塞 UI。优化描述时直接复用结果。
            analyzeAsset(item.id, item.kind, item.label, up.storedName, meta);
          } catch (e) {
            setAssets((prev) =>
              prev.map((a) =>
                a.id === item.id
                  ? { ...a, meta, status: 'error', error: e instanceof Error ? e.message : String(e) }
                  : a
              )
            );
          }
        })();
      }
    },
    []
  );

  const removeAsset = useCallback((id: string) => {
    setAssets((prev) => {
      const hit = prev.find((a) => a.id === id);
      if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const addUrlAsset = useCallback(async () => {
    const raw = urlText.trim();
    if (!raw) return;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (assets.length >= MAX_ASSETS) {
      setErrorMsg(`素材最多 ${MAX_ASSETS} 件`);
      return;
    }
    if (assets.some((a) => a.kind === 'url' && a.url === url)) {
      setErrorMsg('这个网址已经添加过了');
      return;
    }
    setUrlBusy(true);
    setErrorScope('generate');
    setErrorMsg('');
    const id = uid();
    setAssets((prev) => [...prev, { id, kind: 'url', label: url, url, status: 'probing' }]);
    try {
      const res = await fetch('/api/asset/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `读取失败（HTTP ${res.status}）`);
      setAssets((prev) =>
        prev.map((a) =>
          a.id === id
            ? {
                ...a,
                status: 'ready',
                url: data.url || url,
                host: data.host || '',
                title: data.title || '',
                description: data.description || '',
                headings: data.headings || [],
                text: data.text || '',
                imageUrl: data.image || '',
                images: Array.isArray(data.images) ? data.images : data.image ? [data.image] : [],
                label: data.title || data.host || url,
              }
            : a
        )
      );
      setUrlText('');
    } catch (e) {
      setAssets((prev) => prev.filter((a) => a.id !== id));
      setErrorMsg(`网址读取失败：${e instanceof Error ? e.message : String(e)}`);
    }
    setUrlBusy(false);
  }, [urlText, assets]);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json().catch(() => ({}));
      // 后端没起时 vite 代理会回 503 + { backendDown: true }（见 vite.config.ts 的 configure 钩子）。
      // 以前这里是静默 catch：页面照常渲染、只在控制台留一个 500，用户完全不知道后端没开。
      setBackendDown(!!data?.backendDown || !res.ok);
      if (data.projects) setProjects(data.projects as ProjectInfo[]);
    } catch {
      setBackendDown(true);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  /* ---- 已生成项目：分页（一页 3 行 × 4 列 = 12 个） ---- */
  const totalPages = Math.max(1, Math.ceil(projects.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, projPage), totalPages);
  const pageItems = useMemo(
    () => projects.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [projects, safePage]
  );

  useEffect(() => {
    if (projPage > totalPages) setProjPage(totalPages);
  }, [projPage, totalPages]);

  const scrollToProjects = useCallback((smooth = true) => {
    projectsRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  }, []);

  const goPage = useCallback(
    (n: number) => {
      setProjPage((prev) => {
        const next = Math.min(Math.max(1, n), totalPages);
        return next === prev ? prev : next;
      });
      scrollToProjects();
    },
    [totalPages, scrollToProjects]
  );

  // 顶栏点「Studio 预览」→ 回到生成页并跳到已生成项目（先刷新列表，避免刚生成的还没出现）
  useEffect(() => {
    if (!jumpToProjects) return;
    let alive = true;
    loadProjects().finally(() => {
      if (!alive) return;
      setProjPage(1); // 回到第一页才能看到最新生成的工程
      requestAnimationFrame(() => scrollToProjects());
    });
    return () => {
      alive = false;
    };
  }, [jumpToProjects, loadProjects, scrollToProjects]);

  const { loading: filmLoading, film, error: filmError } = useFilmBundle(preview);
  const FilmComponent = useMemo(() => (film ? createFilm(film) : null), [film]);
  // 换工程时让 Player 整体重挂，避免复用旧实例留下脏状态 —— 这是黑屏的另一个诱因
  const playerKey = preview ? `${preview.projectName}::${preview.totalFrames}` : 'none';

  // 浏览器可能因为自动播放策略挡住带声音的播放：表现是停在第一帧（通常是黑场），
  // 看着和「黑屏」一模一样。这里探测一下，没播起来就给一个「点击播放」浮层。
  const [needTap, setNeedTap] = useState(false);

  useEffect(() => {
    setNeedTap(false);
    if (!preview || !FilmComponent) return;
    const t = window.setTimeout(() => {
      const p = playerRef.current;
      if (!p) return;
      if (!p.isPlaying() && p.getCurrentFrame() === 0) setNeedTap(true);
    }, 1500);
    return () => window.clearTimeout(t);
  }, [preview, FilmComponent, playerKey]);

  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onPlay = () => setNeedTap(false);
    p.addEventListener('play', onPlay);
    return () => p.removeEventListener('play', onPlay);
  }, [playerKey, FilmComponent]);

  const busy = phase === 'generating' || phase === 'rendering';

  // 目标时长（秒）：0 表示「自动」
  const secondsValue = useMemo(() => {
    const t = secondsText.trim();
    if (!t) return 0;
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [secondsText]);

  // 校验用户填的时长；通过返回目标秒数，不通过返回错误文案
  const readTargetSeconds = useCallback((): { ok: true; seconds: number } | { ok: false; error: string } => {
    const t = secondsText.trim();
    if (!t) return { ok: true, seconds: 0 };
    const n = Number(t);
    if (!Number.isFinite(n)) {
      return { ok: false, error: `视频时长要填数字（${DURATION_MIN}~${DURATION_MAX} 秒），或留空让 AI 自行决定` };
    }
    const rounded = Math.round(n);
    if (rounded < DURATION_MIN || rounded > DURATION_MAX) {
      return { ok: false, error: `视频时长请填 ${DURATION_MIN}~${DURATION_MAX} 秒之间的整数，或留空让 AI 自行决定` };
    }
    return { ok: true, seconds: rounded };
  }, [secondsText]);

  /* ---- ⓪ 提示词优化：把含糊描述扩写成可执导的产品简报（流式，边生成边显示） ---- */
  const handleOptimize = useCallback(async () => {
    // 续点优化时以「最初那句原始描述」为基准，这样每次点击都是同一句话的另一个版本
    const base = (originalPrompt ?? prompt).trim();
    if (!base) {
      setErrorScope('optimize');
      setErrorMsg('请先写一句产品描述，再点「AI 优化描述」');
      return;
    }
    setOptimizing(true);
    setErrorMsg('');
    setErrorScope('optimize');
    setOptimizeReading(false);
    setPrompt(''); // 清空，让 AI 的增量输出从零开始逐字出现（首字 1~3s 就能看到）
    let buf = '';
    let failed: string | null = null;

    // 有素材就把素材一起交上去：否则优化出来的描述跟你传的产品图 / 视频毫无关系
    const readyAssets = assets.filter((a) => a.status === 'ready');
    const payloadAssets = readyAssets.map((a) => ({
      kind: a.kind,
      label: a.label,
      storedName: a.storedName,
      url: a.url,
      host: a.host,
      title: a.title,
      description: a.description,
      headings: a.headings,
      text: a.text,
      // 照片读取完毕时已经让 AI 解析好的结果：直接交给后端复用，优化描述立刻就能据此生成
      brief: a.brief || undefined,
      meta: a.meta
        ? {
            width: a.meta.width,
            height: a.meta.height,
            palette: a.meta.palette,
            paletteRatio: a.meta.paletteRatio,
            brightness: a.meta.brightness,
            grid: a.meta.grid,
            map: a.meta.map,
            subject: a.meta.subject,
            detail: a.meta.detail,
          }
        : undefined,
    }));

    try {
      await streamNdjson(
        '/api/optimize-prompt/stream',
        { prompt: base, avoid: optimizeHistory.slice(-3), assets: payloadAssets, assetMode },
        (ev) => {
          // 后端在正式扩写前会先逐件「看懂素材」（调 LLM 提取主体），这一步有等待，先说清楚在干嘛
          if (ev.type === 'stage' && ev.stage === 'assets') {
            setOptimizeReading(ev.status === 'start');
            return;
          }
          if (ev.type === 'delta') {
            buf += String(ev.text || '');
            setPrompt(buf);
            return;
          }
          if (ev.type === 'result') {
            const optimized = String(ev.optimized || '').trim();
            if (!optimized) {
              failed = 'AI 没有返回可用的描述，请重试';
              return;
            }
            setPrompt(optimized);
            setOriginalPrompt(base);
            setOptimizeHistory((h) => [...h, optimized].slice(-5));
            setOptimizedNote(ev.angle ? `已优化 · ${ev.angle}` : '已优化');
            return;
          }
          if (ev.type === 'error') failed = ev.error || '优化失败';
        }
      );
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
    setOptimizing(false);
    setOptimizeReading(false);
    if (failed) {
      // 已经流出来的部分内容留着，用户不至于看到一片空白
      if (!buf) setPrompt(base);
      setErrorMsg(failed);
    }
  }, [prompt, originalPrompt, optimizeHistory, assets, assetMode]);

  const handleUndoOptimize = useCallback(() => {
    if (originalPrompt === null) return;
    setPrompt(originalPrompt);
    setOriginalPrompt(null);
    setOptimizedNote('');
    setErrorMsg('');
    // 保留 optimizeHistory：再次点击优化时仍然会给出与之前不同的版本
  }, [originalPrompt]);

  // 手动改动后就不再是「AI 优化结果」，撤掉还原入口，避免误把用户自己改的内容覆盖掉；
  // 同时把「原句 + 历史版本」重置，之后再把改好的这句当作新的优化基准
  const handlePromptChange = useCallback((value: string) => {
    setPrompt(value);
    if (optimizedNote || originalPrompt !== null) {
      setOptimizedNote('');
      setOriginalPrompt(null);
      setOptimizeHistory([]);
    }
  }, [optimizedNote, originalPrompt]);

  /* ---- ① 生成预览（不渲染 MP4） ---- */
  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) {
      setErrorScope('generate');
      setErrorMsg('请输入产品描述');
      return;
    }
    const target = readTargetSeconds();
    if (!target.ok) {
      setErrorScope('generate');
      setErrorMsg(target.error);
      return;
    }
    setPhase('generating');
    setErrorScope('generate');
    setErrorMsg('');
    setStage({ label: '准备中…', done: 0, total: 0 });
    setPreview(null);
    setPreviewFrom(prompt.trim());
    setExported(null);
    setStylePack('');
    setRenderProgress(0);
    setRenderFrames({ rendered: 0, total: 0 });
    setCompStream({});
    setStalled(false);
    lastTickRef.current = Date.now();

    let failed: string | null = null;
    try {
      await streamNdjson(
        '/api/generate/stream',
        {
          prompt: prompt.trim(),
          seconds: target.seconds || undefined,
          assetMode,
          styleRefs: styleRefProjects,
          subtitles: subtitlesOn,
          voice: voiceOn,
          bgm: bgmOn,
          assets: assets
            .filter((a) => a.status === 'ready')
            .map((a) =>
              a.kind === 'url'
                ? {
                    kind: 'url',
                    url: a.url,
                    host: a.host,
                    title: a.title,
                    description: a.description,
                    headings: a.headings,
                    text: a.text,
                    imageUrl: a.imageUrl,
                    images: a.images,
                  }
                : {
                    kind: a.kind,
                    storedName: a.storedName,
                    label: a.label,
                    width: a.meta?.width,
                    height: a.meta?.height,
                    palette: a.meta?.palette,
                    paletteRatio: a.meta?.paletteRatio,
                    brightness: a.meta?.brightness,
                    grid: a.meta?.grid,
                    // 重绘保真三件套：色彩网格图 + 主体框 + 细节密度
                    map: a.meta?.map,
                    subject: a.meta?.subject,
                    detail: a.meta?.detail,
                  }
            ),
        },
        (ev) => {
        if (ev.type === 'log') return; // 终端里有完整日志，页面不再堆日志区
        lastTickRef.current = Date.now(); // 只要后端还在说话，就没卡住
        if (ev.type === 'stage') {
          switch (ev.stage) {
            // 重绘阶段在分镜规划之前：先拿到重绘件，AI 才知道画面主体长什么样
            case 'redraw':
              setStage({
                label:
                  ev.status === 'start'
                    ? `AI 提取素材元素并重绘（${ev.count || 0} 件）…`
                    : ev.status === 'fail'
                      ? '素材重绘失败，已改用原始素材继续生成'
                      : `素材重绘完成：${(ev.items || [])
                          .map((x: any) => (x.kind === 'bitmap' ? '位图' : x.kind === 'vector' ? '矢量' : '原素材'))
                          .join(' / ')}`,
                done: 0,
                total: 0,
              });
              break;
            case 'preflight':
              setStage({ label: '连通性预检（网络 / 模型）', done: 0, total: 0 });
              break;
            case 'plan':
              setStage(
                ev.status === 'start'
                  ? { label: 'AI 规划分镜脚本…', done: 0, total: 0 }
                  : { label: `分镜规划完成：${ev.scenes} 个场景`, done: 0, total: 0 }
              );
              break;
            case 'components':
              setStage({ label: 'AI 逐场景编写 TSX 组件', done: 0, total: ev.total || 0 });
              break;
            case 'component':
              setCompStream((prev) => {
                const next = { ...prev };
                delete next[ev.file];
                return next;
              });
              setStage((prev) => ({
                label:
                  ev.status === 'done'
                    ? `组件完成 ${ev.done}/${ev.total} · ${compLabel(ev.file)}${ev.reused ? '（复用）' : ''}`
                    : ev.status === 'fallback'
                      ? `${compLabel(ev.file)}生成失败，已用兜底版本继续（不影响成片）`
                      : `组件失败 ${compLabel(ev.file)}`,
                done: ev.done || 0,
                total: ev.total || prev?.total || 0,
              }));
              break;
            // 单个组件调用可能跑几分钟，这里把「正在思考 / 已写多少代码」实时显示出来
            case 'component-progress':
              setCompStream((prev) => ({
                ...prev,
                [ev.file]: { chars: ev.chars || 0, thinking: ev.thinking || 0 },
              }));
              break;
            case 'assemble':
              setStage({ label: '装配 Remotion 工程…', done: 0, total: 0 });
              break;
          }
          return;
        }
        if (ev.type === 'result') {
          setPreview(ev.preview as PreviewPayload);
          setStylePack(ev.stylePack || '');
          setPhase('preview');
          setShowJson(false);
          setProjPage(1); // 新工程按时间排在最前，翻回第一页才看得到
          loadProjects();
          setTimeout(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
          return;
        }
        if (ev.type === 'error') failed = ev.error || '生成失败';
      });
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
    if (failed) {
      setErrorMsg(failed);
      setPhase(preview ? 'preview' : 'idle');
      setStage(null);
    }
  }, [prompt, loadProjects, preview, readTargetSeconds, assets, assetMode, styleRefProjects, subtitlesOn, voiceOn, bgmOn]);

  /* ---- ② 渲染导出 MP4 ---- */
  const handleRender = useCallback(
    async (projectName?: string) => {
      const target = projectName || preview?.projectName;
      if (!target) {
        setErrorScope('render');
        setErrorMsg('请先生成预览，再渲染导出');
        return;
      }
      setPhase('rendering');
      setErrorScope('render');
      setErrorMsg('');
        setExported(null);
      setRenderProgress(0);
      setRenderFrames({ rendered: 0, total: preview?.totalFrames || 0 });
      setStage(null);

      let failed: string | null = null;
      try {
        await streamNdjson('/api/render', { project: target }, (ev) => {
          if (ev.type === 'log') return; // 终端已有完整日志：按要求不再在页面里堆日志区
          if (ev.type === 'progress') {
            setRenderProgress(typeof ev.progress === 'number' ? ev.progress : 0);
            setRenderFrames((prev) => ({ rendered: ev.renderedFrames ?? prev.rendered, total: prev.total }));
            return;
          }
          if (ev.type === 'result') {
            setExported({ url: ev.mp4 as string, sizeBytes: ev.sizeBytes || 0, elapsedSec: ev.elapsedSec || 0 });
            return;
          }
          if (ev.type === 'error') failed = ev.error || '渲染失败';
        });
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e);
      }
      if (failed) {
        setErrorMsg(failed);
        setPhase('preview');
      } else {
        setPhase('exported');
        loadProjects();
      }
    },
    [preview, loadProjects]
  );

  /* ---- Remotion Studio 编辑（打开/关闭都是对后端会话的操作，Studio 本身是独立进程） ---- */
  const [studio, setStudio] = useState<{ sessionId: string; project: string; url: string } | null>(null);
  const [studioOpening, setStudioOpening] = useState(false);
  const [studioClosing, setStudioClosing] = useState(false);
  const [studioError, setStudioError] = useState('');
  // Studio 首次启动要为整个工程打包（实测 4~6s），这段 iframe 里是一块纯黑，必须给加载态
  const [studioFrameReady, setStudioFrameReady] = useState(false);
  // 「重新加载」用：换 key 把 iframe 整个重新挂载（Studio 前端卡死只能靠这个救回来）
  const [studioFrameKey, setStudioFrameKey] = useState(0);
  // 收起是「保留会话地关掉覆盖层」，必须告诉用户，否则会被当成把 Studio 关了
  const [studioNotice, setStudioNotice] = useState('');
  const studioFrameTimer = useRef(0);

  // 提示条自动消失
  useEffect(() => {
    if (!studioNotice) return;
    const t = window.setTimeout(() => setStudioNotice(''), 4600);
    return () => window.clearTimeout(t);
  }, [studioNotice]);

  // iframe 卸载 / 组件卸载时别让定时器去 setState
  useEffect(() => () => window.clearTimeout(studioFrameTimer.current), []);

  // 卡住检测：生成过程中每 5 秒看一眼「最后一次收到后端消息的时刻」。
  // 后端模型偶发静默，此时进度条会长时间不动；与其让人以为崩了，不如明说在等。
  useEffect(() => {
    if (phase !== 'generating') return;
    const id = window.setInterval(() => {
      setStalled(Date.now() - lastTickRef.current > 45000);
    }, 5000);
    return () => window.clearInterval(id);
  }, [phase]);

  const closeStudioOverlay = useCallback(() => setStudio(null), []);

  // onLoad 只代表文档加载完，Studio 还要挂 React 树；立刻撤遮罩会闪一下黑，留点缓冲
  const handleStudioFrameLoad = useCallback(() => {
    window.clearTimeout(studioFrameTimer.current);
    studioFrameTimer.current = window.setTimeout(() => setStudioFrameReady(true), 320);
  }, []);

  const reloadStudioFrame = useCallback(() => {
    window.clearTimeout(studioFrameTimer.current);
    setStudioFrameReady(false);
    setStudioFrameKey((k) => k + 1);
  }, [studio]);

  // 收起（Esc）：只关覆盖层，后端会话留着，下次再点「编辑」还是热的，省掉重新打包
  const minimizeStudio = useCallback(() => {
    const cur = studio;
    setStudio(null);
    setStudioFrameReady(false);
    if (cur) setStudioNotice(`「${cur.project}」的编辑层已收起，Studio 会话还在运行 —— 点这张卡片上的「编辑中」就能立刻回来。`);
  }, [studio]);

  // 「返回」：比 Esc 多一步 —— 收起编辑层后把项目列表滚回视野，
  // 编辑层是全屏的，不滚回去用户还得自己往上滑才能点到别的卡片。
  const leaveStudio = useCallback(() => {
    minimizeStudio();
    projectsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [minimizeStudio]);

  const requestCloseStudio = useCallback(async () => {
    const cur = studio;
    setStudio(null);
    setStudioFrameReady(false);
    if (!cur) return;
    setStudioClosing(true);
    try {
      await fetch('/api/studio/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: cur.project }),
      });
    } catch {
    } finally {
      setStudioClosing(false);
    }
  }, [studio]);

  const openStudio = useCallback(
    async (name: string) => {
      if (studio) await requestCloseStudio();
      setStudioError('');
      setStudioNotice('');
      setStudioOpening(true);
      window.clearTimeout(studioFrameTimer.current);
      setStudioFrameReady(false);
      try {
        const res = await fetch('/api/studio/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: name }),
        });
        const data = await res.json();
        if (data.ok && data.session) {
          setStudio({ sessionId: data.session.sessionId, project: data.session.project, url: data.session.url });
          setStudioFrameKey((k) => k + 1);
        } else {
          setStudioError(data.error || 'Studio 启动失败');
        }
      } catch (e) {
        setStudioError(e instanceof Error ? e.message : String(e));
      } finally {
        setStudioOpening(false);
      }
    },
    [studio, requestCloseStudio]
  );

  // 编辑层是全屏 fixed，但它挂在 <main> 底下，而 <main> 的 z-index 会新开层叠上下文，
  // 结果这层盖不住吸顶顶栏（.topbar-bar z-index:40）—— 顶栏压住编辑层顶栏，
  // 左上角「返回」正好在品牌 logo 底下点不到。打开期间给 <html> 挂个标记把顶栏压下去。
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('gen-studio-open', !!studio);
    return () => root.classList.remove('gen-studio-open');
  }, [studio]);

  // Esc = 收起编辑层（保留后端会话），不是关闭会话
  useEffect(() => {
    if (!studio) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      minimizeStudio();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [studio, minimizeStudio]);

  /* ---- 直接播放已有工程（不调用 AI） ---- */
  const handleOpenProject = useCallback((p: ProjectInfo) => {
    if (!p.preview) {
      setErrorMsg(`工程 ${p.name} 缺少可预览的元数据`);
      return;
    }
    setPreview(p.preview);
    setPreviewFrom('');
    setStylePack((p.styleTags || []).join(', '));
    setPhase('preview');
    setErrorMsg('');
    setStage(null);
    setRenderProgress(0);
    setExported(p.hasMp4 && p.mp4 ? { url: p.mp4, sizeBytes: 0, elapsedSec: 0 } : null);
    setTimeout(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !busy) handleGenerate();
  };

  const genPct = stage && stage.total > 0 ? Math.round((stage.done / stage.total) * 100) : null;
  const showPanel = Boolean(preview) && (phase === 'preview' || phase === 'rendering' || phase === 'exported');
  // 组件实时输出统计（并发生成时把各文件的字符数汇总起来）
  const fmtK = (n: number) => (n > 999 ? `${(n / 1000).toFixed(1)}K` : String(n));
  const liveEntries = Object.entries(compStream).sort(
    (a, b) => b[1].chars + b[1].thinking - (a[1].chars + a[1].thinking)
  );
  const liveChars = liveEntries.reduce((sum, [, v]) => sum + v.chars, 0);
  const liveThinking = liveEntries.reduce((sum, [, v]) => sum + v.thinking, 0);

  // 翻页控件（顶部 / 底部各一份，页码不多时直接给数字）
  const renderPager = (pos: 'top' | 'bottom') => {
    if (totalPages <= 1) return null;
    return (
      <div className={`gen-pager ${pos}`}>
        <button className="gen-page-btn" onClick={() => goPage(safePage - 1)} disabled={safePage <= 1}>
          ‹ 上一页
        </button>
        {totalPages <= 8 ? (
          Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              className={`gen-page-num ${n === safePage ? 'active' : ''}`}
              onClick={() => goPage(n)}
              aria-current={n === safePage ? 'page' : undefined}
            >
              {n}
            </button>
          ))
        ) : (
          <span className="gen-page-at">第 {safePage} / {totalPages} 页</span>
        )}
        <button className="gen-page-btn" onClick={() => goPage(safePage + 1)} disabled={safePage >= totalPages}>
          下一页 ›
        </button>
      </div>
    );
  };

  return (
    <div className="gen-container">
      {backendDown && (
        <div className="gen-backend-down" role="alert">
          <span className="gen-backend-dot" aria-hidden="true" />
          <span>
            后端服务未启动：<code>127.0.0.1:3001</code> 连不上，生成 / 上传素材都会失败。
            请在项目目录另开一个终端运行 <code>npm run server</code>，然后
            <button className="gen-backend-retry" onClick={() => loadProjects()}>
              点此重试
            </button>
          </span>
        </div>
      )}
      <div className="gen-hero">
        <div className="gen-kicker"><span className="gen-kicker-line" />AI VIDEO GENERATOR</div>
        <h1 className="gen-title">输入想法<br /><em>生成视频</em></h1>
      </div>

      {/* ---------- 输入区 ---------- */}
      <div className="gen-input-section">
        <div className="gen-input-box">
          <label className="gen-label">产品描述</label>
          <div className={`gen-prompt-wrap ${busy ? 'is-busy' : ''}`}>
            {/* 旋转渐变描边 + 底部呼吸背光：都是装饰，别让读屏器念出来 */}
            <span className="gen-prompt-glow" aria-hidden="true" />
            <span className="gen-prompt-ring" aria-hidden="true" />
            <textarea
              className="gen-textarea"
              placeholder="例如：做一个智能家居APP的产品宣传片，展示用自然语言控制灯光、温度和安防的过程"
              value={prompt}
              onChange={(e) => handlePromptChange(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={4}
              disabled={busy}
            />
          </div>
          <div className="gen-examples">
            <span className="gen-ex-label">试试：</span>
            {EXAMPLES.map((ex, i) => (
              <button key={i} className="gen-ex-chip" onClick={() => handlePromptChange(ex)} disabled={busy}>
                {ex}
              </button>
            ))}
          </div>

          {/* 素材：图片 / 视频 / 网址。三态决定素材怎么用：仅参考 / 原样进画面 / AI 重绘后进画面 */}
          <div className="gen-assets">
            <div className="gen-assets-head">
              <span className="gen-label">
                素材
                <span className="gen-assets-opt">可选 · 最多 {MAX_ASSETS} 件</span>
              </span>
              <div className="gen-asseg" role="group" aria-label="素材用法">
                {ASSET_MODES.map((m) => (
                  <button
                    key={m.id}
                    className={`gen-asseg-btn ${assetMode === m.id ? 'on' : ''}`}
                    onClick={() => setAssetMode(m.id)}
                    disabled={busy}
                    title={m.tip}
                    aria-pressed={assetMode === m.id}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-assets-add">
              <input
                ref={fileInputRef}
                className="gen-assets-file"
                type="file"
                accept={[...IMAGE_EXT, ...VIDEO_EXT].map((e) => `.${e}`).join(',')}
                multiple
                disabled={busy || assets.length >= MAX_ASSETS}
                onChange={(e) => {
                  if (e.target.files?.length) addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                className="gen-btn gen-btn-ghost gen-assets-pick"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || assets.length >= MAX_ASSETS}
              >
                <span className="gen-assets-ic">＋</span>上传图片 / 视频
              </button>
              <div className="gen-assets-url">
                <input
                  className="gen-assets-input"
                  type="text"
                  placeholder="粘贴网址，例如 https://example.com/product"
                  value={urlText}
                  disabled={busy || urlBusy}
                  onChange={(e) => setUrlText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addUrlAsset();
                    }
                  }}
                />
                <button className="gen-assets-urlbtn" onClick={addUrlAsset} disabled={busy || urlBusy || !urlText.trim()}>
                  {urlBusy ? '读取中…' : '添加网址'}
                </button>
              </div>
            </div>

            {assets.length > 0 && (
              <div className="gen-assets-list">
                {assets.map((a) => (
                  <div className={`gen-asset ${a.status}`} key={a.id}>
                    {a.kind === 'image' && a.previewUrl ? (
                      <img className="gen-asset-thumb" src={a.previewUrl} alt="" />
                    ) : a.kind === 'url' && a.imageUrl ? (
                      // 把抓到的网页主图直接露出来，用户才知道「这个网址到底抓到了什么」。
                      // 微软/B站这类站会防盗链，加载失败就退回链图标。
                      <span className="gen-asset-thumbwrap">
                        <span className="gen-asset-thumb gen-asset-thumb-ic">🔗</span>
                        <img
                          className="gen-asset-thumb"
                          src={a.imageUrl}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                      </span>
                    ) : (
                      <span className="gen-asset-thumb gen-asset-thumb-ic">{a.kind === 'video' ? '▶' : '🔗'}</span>
                    )}
                    <div className="gen-asset-body">
                      <div className="gen-asset-name" title={a.label}>{a.label}</div>
                      <div className="gen-asset-sub">
                        {a.status === 'probing' && (a.kind === 'url' ? '正在读取网页…' : '正在解析…')}
                        {a.status === 'error' && <span className="bad">{a.error || '处理失败'}</span>}
                        {a.status === 'ready' && a.kind === 'url' && (
                          <>
                            {a.host || a.url}
                            {a.headings?.length ? ` · 抓到 ${a.headings.length} 个小标题` : ''}
                            {a.imageUrl ? ' · 有主图' : ' · 无主图（仅文字）'}
                          </>
                        )}
                      {a.status === 'ready' && a.kind !== 'url' && (
                        <>
                          {a.meta?.width ? `${a.meta.width}×${a.meta.height}` : '尺寸未知'}
                          {a.bytes ? ` · ${fmtSize(a.bytes)}` : ''}
                        </>
                      )}
                      {a.status === 'ready' && a.kind !== 'url' && a.parsing && (
                        <span className="gen-asset-ai parsing"> · AI 解析中…</span>
                      )}
                      {a.status === 'ready' && a.kind !== 'url' && a.brief && !a.parsing && (
                        <span className="gen-asset-ai done" title={a.brief.subject || ''}>
                          {' · '}AI 已解析{a.brief.subject ? `：${a.brief.subject}` : ''}
                        </span>
                      )}
                      </div>
                      {a.status === 'ready' && a.kind === 'url' && (a.description || a.headings?.[0]) && (
                        <div className="gen-asset-desc" title={a.description || a.headings?.[0]}>
                          {a.description || a.headings?.[0]}
                        </div>
                      )}
                      {a.status === 'ready' && a.kind !== 'url' && (a.meta?.palette || []).length > 0 && (
                        <div className="gen-asset-palette">
                          {(a.meta?.palette || []).map((c) => (
                            <span className="gen-asset-swatch" key={c} style={{ background: c }} title={c} />
                          ))}
                        </div>
                      )}
                    </div>
                    <button className="gen-asset-del" onClick={() => removeAsset(a.id)} disabled={busy} title="移除">
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="gen-assets-hint">{ASSET_MODE_HINT[assetMode]}</div>
            {assetMode === 'redraw' && assets.some((a) => a.kind === 'video') && (
              <div className="gen-assets-hint warn">
                注意：视频素材不做重绘（重绘只针对图片），它们会保持原样进画面。
              </div>
            )}
            {assetMode !== 'reference' &&
              assets.some((a) => a.status === 'ready' && (a.kind === 'url' ? !a.imageUrl : !a.storedName)) && (
                <div className="gen-assets-hint warn">
                  注意：所选素材里没有能进画面的文件（该网页未提供可下载的主图，或文件没上传成功），
                  这部分只会作为文字信息影响文案与配色，不会出现在画面里。
                </div>
              )}
          </div>

          {/* 风格参考：可多选，选中的工程风格会被融合成一套新风格；不选就完全自行生成 */}
          {projects.length > 0 && (
            <div className="gen-styleref">
              <div className="gen-styleref-head">
                <span className="gen-label">
                  参考风格
                  <span className="gen-assets-opt">
                    可选 · 最多 {MAX_STYLE_REFS} 个，选中的风格会被融合成一套新风格
                  </span>
                </span>
                <button
                  className={`gen-styleref-clear ${styleRefProjects.length ? '' : 'active'}`}
                  onClick={() => setStyleRefProjects([])}
                  disabled={busy}
                >
                  {styleRefProjects.length ? `清空（已选 ${styleRefProjects.length}）` : '不参考 · 自行生成'}
                </button>
              </div>
              <div className="gen-styleref-row">
                {projects.slice(0, 36).map((p) => {
                  const pickedIdx = styleRefProjects.indexOf(p.name);
                  const picked = pickedIdx >= 0;
                  const full = !picked && styleRefProjects.length >= MAX_STYLE_REFS;
                  return (
                    <button
                      key={p.name}
                      className={`gen-styleref-chip ${picked ? 'active' : ''} ${full ? 'full' : ''}`}
                      onClick={() =>
                        setStyleRefProjects((cur) =>
                          cur.includes(p.name) ? cur.filter((n) => n !== p.name) : cur.length >= MAX_STYLE_REFS ? cur : [...cur, p.name]
                        )
                      }
                      disabled={busy}
                      title={
                        `${p.name}${p.title ? ` · ${p.title}` : ''}` +
                        `${(p.styleTags || []).length ? ` · ${(p.styleTags || []).join(' / ')}` : ''}` +
                        `${p.stylePack ? ` · 风格包 ${p.stylePack}` : ''}`
                      }
                    >
                      <span
                        className="gen-styleref-swatch"
                        style={
                          (p.palette || []).length
                            ? { background: `linear-gradient(135deg, ${(p.palette || []).slice(0, 4).join(', ')})` }
                            : undefined
                        }
                      />
                      <span className="gen-styleref-name">{p.title || p.name}</span>
                      {/* 多选时给出选中顺序：视觉上也能看出谁是被重点参考的那个 */}
                      {picked && <span className="gen-styleref-order">{pickedIdx + 1}</span>}
                      {p.stylePack && <span className="gen-styleref-pack">{p.stylePack}</span>}
                    </button>
                  );
                })}
              </div>
              {styleRefProjects.length > 1 && (
                <div className="gen-styleref-hint">
                  已选 {styleRefProjects.length} 个（按顺序融合）：{styleRefProjects.join(' → ')}
                </div>
              )}
            </div>
          )}

          {/* 字幕 / 配音 / 配乐：三个独立开关 */}
          <div className="gen-tracks">
            <div className="gen-tracks-label">
              声音与字幕
              <span className="gen-assets-opt">配音会按画面内容配情绪与音色，配乐会自动为旁白让路</span>
            </div>
            <div className="gen-tracks-row">
              <button
                className={`gen-switch ${subtitlesOn ? 'on' : ''}`}
                onClick={() => setSubtitlesOn((v) => !v)}
                disabled={busy}
                aria-pressed={subtitlesOn}
              >
                <span className="gen-switch-track">
                  <span className="gen-switch-knob" />
                </span>
                <span className="gen-switch-body">
                  <span className="gen-switch-name">字幕</span>
                  <span className="gen-switch-desc">{subtitlesOn ? '画面下方显示字幕' : '不生成字幕，画面更干净'}</span>
                </span>
              </button>
              <button
                className={`gen-switch ${voiceOn ? 'on' : ''}`}
                onClick={() => setVoiceOn((v) => !v)}
                disabled={busy}
                aria-pressed={voiceOn}
              >
                <span className="gen-switch-track">
                  <span className="gen-switch-knob" />
                </span>
                <span className="gen-switch-body">
                  <span className="gen-switch-name">配音</span>
                  <span className="gen-switch-desc">{voiceOn ? '神经语音 · 有情绪起伏' : '不生成配音'}</span>
                </span>
              </button>
              <button
                className={`gen-switch ${bgmOn ? 'on' : ''}`}
                onClick={() => setBgmOn((v) => !v)}
                disabled={busy}
                aria-pressed={bgmOn}
              >
                <span className="gen-switch-track">
                  <span className="gen-switch-knob" />
                </span>
                <span className="gen-switch-body">
                  <span className="gen-switch-name">背景音乐</span>
                  <span className="gen-switch-desc">{bgmOn ? '按内容自动配乐' : '不加配乐'}</span>
                </span>
              </button>
            </div>
            {bgmOn && !voiceOn && <div className="gen-tracks-hint">只加配乐、不配音：音乐会是纯粹的氛围衬底。</div>}
          </div>


          {/* 自定义时长：填了数字就按这个长度规划分镜，留空交给 AI */}
          <div className="gen-duration">
            <span className="gen-duration-label">视频时长</span>
            <div className="gen-duration-chips">
              <button
                className={`gen-duration-chip ${secondsValue === 0 ? 'active' : ''}`}
                onClick={() => setSecondsText('')}
                disabled={busy}
              >
                自动
              </button>
              {DURATION_PRESETS.map((s) => (
                <button
                  key={s}
                  className={`gen-duration-chip ${secondsValue === s ? 'active' : ''}`}
                  onClick={() => setSecondsText(String(s))}
                  disabled={busy}
                >
                  {s} 秒
                </button>
              ))}
            </div>
            <div className="gen-duration-custom">
              <input
                className="gen-duration-input"
                type="number"
                inputMode="numeric"
                min={DURATION_MIN}
                max={DURATION_MAX}
                step={1}
                placeholder="自定义"
                value={secondsText}
                disabled={busy}
                onChange={(e) => setSecondsText(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
              />
              <span className="gen-duration-unit">秒</span>
            </div>
            <span className="gen-duration-hint">
              {secondsValue > 0
                ? `将按 ${secondsValue} 秒规划分镜与时长`
                : `留空由 AI 自行决定（${DURATION_MIN}~${DURATION_MAX} 秒内）`}
            </span>
          </div>

          <div className="gen-actions">
            <button
              className="gen-btn gen-btn-optimize"
              onClick={handleOptimize}
              disabled={busy || optimizing || !prompt.trim()}
              title={
                assets.some((a) => a.status === 'ready')
                  ? '结合你上传的图片 / 视频 / 网址素材，把一句话扩写为含定位 / 卖点 / 场景 / 风格 / 叙事线索的完整描述'
                  : '把一句话扩写为含定位 / 卖点 / 场景 / 风格 / 叙事线索的完整描述'
              }
            >
              {optimizing ? (
                <><span className="gen-spinner light" />{optimizeReading ? '正在读取素材…' : '正在优化描述…'}</>
              ) : (
                <><span className="gen-optimize-ic">✦</span>AI 优化描述</>
              )}
            </button>
            <button className="gen-btn gen-btn-primary" onClick={handleGenerate} disabled={busy || !prompt.trim()}>
              {phase === 'generating' ? (
                <><span className="gen-spinner" />AI 生成中…</>
              ) : (
                <><span className="gen-play">▶</span>生成预览视频</>
              )}
            </button>
            <button
              className="gen-btn gen-btn-ghost"
              onClick={() => handleRender()}
              disabled={busy || !preview}
              title={preview ? `渲染导出 ${preview.projectName}` : '请先生成预览'}
            >
              <span className="gen-render-ic">⬇</span>渲染导出 MP4
            </button>
            {optimizedNote && originalPrompt !== null ? (
              <span className="gen-opt-note">
                <span className="gen-opt-dot">✓</span>{optimizedNote}
                <button className="gen-opt-undo" onClick={handleUndoOptimize} disabled={busy}>
                  还原原文
                </button>
              </span>
            ) : (
              <span className="gen-hint">Ctrl+Enter 生成预览</span>
            )}
          </div>
        </div>

        {/* 生成进度 */}
        {phase === 'generating' && (
          <div className="gen-progress">
            <div className="gen-progress-head">
              <span className="gen-progress-label">{stage?.label || '生成中…'}</span>
              {genPct !== null && <span className="gen-progress-pct">{genPct}%</span>}
            </div>
            <div className="gen-progress-track">
              <div
                className={`gen-progress-fill ${genPct === null ? 'indeterminate' : ''}`}
                style={genPct === null ? undefined : { width: `${genPct}%` }}
              />
            </div>
            {liveEntries.length > 0 && (
              <div className="gen-live">
                <span className="gen-live-dot" />
                <span className="gen-live-label">AI 正在写</span>
                <span className="gen-live-files">
                  {liveEntries.slice(0, 4).map(([file, v]) => (
                    <span className="gen-live-file" key={file}>
                      {file.replace(/\.tsx$/, ' ')}
                      {v.chars > 0 ? (
                        <b>{fmtK(v.chars)}</b>
                      ) : (
                        <b className="thinking">思考 {fmtK(v.thinking)}</b>
                      )}
                    </span>
                  ))}
                  {liveEntries.length > 4 ? <span className="gen-live-more">+{liveEntries.length - 4}</span> : null}
                </span>
                <span className="gen-live-total">
                  已写 {fmtK(liveChars)} 字符{liveThinking > 0 ? ` · 思考 ${fmtK(liveThinking)}` : ''}
                </span>
              </div>
            )}
            {stalled && (
              <div className="gen-stalled">
                模型响应变慢了，仍在等待（若持续无响应会自动重试，已完成的组件不会丢）
              </div>
            )}
          </div>
        )}

        {/* 错误 */}
        {errorMsg && (
          <div className="gen-error">
            <span className="gen-error-icon">✕</span>
            <div>
              <strong>
                {errorScope === 'optimize' ? '提示词优化失败' : errorScope === 'render' ? '渲染导出失败' : '生成失败'}
              </strong>
              <p>{errorMsg}</p>
            </div>
          </div>
        )}

        {/* ---------- 预览 / 导出面板 ---------- */}
        {showPanel && preview && (
          <div className="gen-result" ref={panelRef}>
            <div className="gen-result-header">
              <span className="gen-success-icon">✓</span>
              <span>预览已就绪 · {preview.title}</span>
              <span className="gen-result-badge">{preview.compositionId}</span>
            </div>

            {/* 只保留创意方向；分镜/时长/帧数/配音/画面/工程、场景时间轴按需求去掉 */}
            {(stylePack || (preview.styleTags || []).length > 0) && (
              <div className="gen-tags">
                <span className="gen-tags-label">创意方向</span>
                {(preview.styleTags || []).length > 0
                  ? (preview.styleTags || []).map((t) => <span className="gen-tag" key={t}>{t}</span>)
                  : <span className="gen-tag">{stylePack}</span>}
              </div>
            )}

            {/* 浏览器内播放器 */}
            <div className="gen-preview">
              <div className="gen-preview-head">
                <span className="gen-preview-title">浏览器内预览（实时播放 AI 组件，未渲染 MP4）</span>
                {filmLoading && <span className="gen-preview-status">加载组件…</span>}
                <span className="gen-preview-status">无声成片</span>
              </div>
              <div className="gen-player">
                {filmError ? (
                  <div className="gen-player-error">
                    <strong>组件加载失败</strong>
                    <p>{filmError}</p>
                    <p className="dim">预览依赖 Vite dev server（npm run dev）。若刚改过生成代码，刷新页面即可。</p>
                  </div>
                ) : FilmComponent ? (
                  <PreviewBoundary key={playerKey}>
                    <Player
                      key={playerKey}
                      ref={playerRef}
                      component={FilmComponent}
                      durationInFrames={preview.totalFrames}
                      fps={preview.fps}
                      compositionWidth={preview.width}
                      compositionHeight={preview.height}
                      style={{ width: '100%' }}
                      controls
                      loop
                      autoPlay
                      clickToPlay
                      allowFullscreen
                      acknowledgeRemotionLicense
                      // 每条配音是一个 <Audio>：Player 默认只预挂 5 个 audio 标签，
                      // 分镜数 ≥6 时会报 "Tried to simultaneously mount 6 <Html5Audio /> tags"。
                      // 这里给一个固定的充足上限 —— 绝不能写成随配音条数变化的值，
                      // 否则换工程时会抛 "shared audio tags has changed dynamically" 并整页黑屏。
                      numberOfSharedAudioTags={AUDIO_TAG_POOL}
                      errorFallback={({ error }) => (
                        <div className="gen-player-error">
                          <strong>该场景运行时出错</strong>
                          <p>{error.message}</p>
                          <p className="dim">可以回到输入框调整描述后重新生成，或直接渲染导出查看服务端表现。</p>
                        </div>
                      )}
                    />
                  </PreviewBoundary>
                ) : (
                  <div className="gen-player-skeleton">正在加载 AI 组件…</div>
                )}
                {needTap && !filmError && (
                  <button
                    className="gen-player-tap"
                    onClick={() => {
                      setNeedTap(false);
                      playerRef.current?.play();
                    }}
                  >
                    <span className="gen-player-tap-ic">▶</span>
                    浏览器拦住了自动播放，点这里开始
                  </button>
                )}
              </div>
            </div>

            {/* 导出区 */}
            <div className="gen-export">
              <div className="gen-export-left">
                <div className="gen-export-title">导出成片</div>
                <div className="gen-export-desc">
                  逐帧渲染 {preview.totalFrames} 帧 → H.264 MP4（1920×1080 · 30fps，无声成片）。
                </div>
              </div>
              <button
                className="gen-btn gen-btn-primary"
                onClick={() => handleRender()}
                disabled={busy}
              >
                {phase === 'rendering' ? (
                  <><span className="gen-spinner" />渲染中 {Math.round(renderProgress * 100)}%</>
                ) : (
                  <><span className="gen-render-ic">⬇</span>{exported ? '重新渲染导出' : '渲染导出 MP4'}</>
                )}
              </button>
            </div>

            {phase === 'rendering' && (
              <div className="gen-progress inside">
                <div className="gen-progress-head">
                  <span className="gen-progress-label">
                    逐帧渲染中… {renderFrames.rendered}/{renderFrames.total || preview.totalFrames} 帧
                  </span>
                  <span className="gen-progress-pct">{Math.round(renderProgress * 100)}%</span>
                </div>
                <div className="gen-progress-track">
                  <div className="gen-progress-fill" style={{ width: `${Math.round(renderProgress * 100)}%` }} />
                </div>
              </div>
            )}

            {exported && phase !== 'rendering' && (
              <div className="gen-export-ok">
                <div className="gen-export-ok-head">
                  <span className="gen-success-icon">✓</span>
                  <span>MP4 已导出</span>
                  {exported.sizeBytes > 0 && <span className="gen-export-meta">{fmtSize(exported.sizeBytes)}</span>}
                  {exported.elapsedSec > 0 && <span className="gen-export-meta">用时 {exported.elapsedSec}s</span>}
                </div>
                <video className="gen-export-video" src={exported.url} controls preload="metadata" />
                <div className="gen-export-actions">
                  <a className="gen-btn gen-btn-primary" href={exported.url} download={`${preview.projectName}.mp4`}>
                    <span className="gen-render-ic">⬇</span>下载 MP4
                  </a>
                  <span className="gen-export-path mono">{preview.dirAbs}\out\film.mp4</span>
                </div>
              </div>
            )}

            <div className="gen-config-toggle">
              <button className="gen-toggle-btn" onClick={() => setShowJson(!showJson)}>
                {showJson ? '▾ 隐藏预览元数据 JSON' : '▸ 查看预览元数据 JSON'}
              </button>
              {showJson && <pre className="gen-json">{JSON.stringify(preview, null, 2)}</pre>}
            </div>
          </div>
        )}
      </div>

      {/* ---------- 已生成项目：一页 3 行 × 4 列 = 12 个，翻页看下一批；新生成的在最前 ---------- */}
      <div className="gen-projects" ref={projectsRef} id="projects">
        <div className="gen-projects-head">
          <div className="gen-projects-label">
            已生成项目
            <span className="gen-projects-count">{projects.length} 个</span>
          </div>
        </div>

        {projects.length === 0 ? (
          <div className="gen-projects-empty">
            还没有生成过工程 —— 在上方输入产品描述，点「生成预览视频」即可创建第一个。
          </div>
        ) : (
          <>
            <div className="gen-projects-grid">
              {pageItems.map((p, i) => (
                // 入场用 backwards 而不是 both：both 会把最后一帧的 transform 锁死，
                // 卡片 hover 抬起就再也生效不了。backwards 只管延迟期间，播完就交还给普通样式。
                <div
                  key={p.name}
                  className={`gen-project-card gen-pc-in ${p.hasMp4 ? 'has-mp4' : ''}`}
                  style={{ animationDelay: `${Math.min(i, 11) * 55}ms` }}
                >
                  <div className="gen-pc-top">
                    <span className="gen-pc-name" title={p.name}>{p.name}</span>
                    {projects[0]?.name === p.name && <span className="gen-pc-new">最新</span>}
                  </div>
                  <div className="gen-pc-title">{p.title || '（无标题）'}</div>
                  <div className="gen-pc-meta">
                    {p.sceneCount} 场景{p.duration ? ` · ${p.duration}` : ''}
                  </div>
                  <div className="gen-pc-meta">
                    {p.hasMp4 ? <span className="gen-pc-ok">✓ MP4 已渲染</span> : <span className="gen-pc-no">未渲染</span>}
                    <span className="gen-pc-time">{fmtTime(p.createdAt)}</span>
                  </div>
                  <div className="gen-pc-actions">
                    <button
                      className="gen-pc-btn"
                      onClick={() => handleOpenProject(p)}
                      disabled={!p.ready || busy}
                      title={!p.ready ? '工程文件不完整，无法预览' : busy ? '正在出片，等这次渲染结束' : '在页面内预览这个工程'}
                    >
                      预览
                    </button>
                    <button
                      className="gen-pc-btn"
                      onClick={() => {
                        handleOpenProject(p);
                        handleRender(p.name);
                      }}
                      disabled={!p.ready || busy}
                      title={!p.ready ? '工程文件不完整，无法导出' : busy ? '正在出片，等这次渲染结束' : '重新渲染并导出 MP4'}
                    >
                      导出
                    </button>
                    <button
                      className={`gen-pc-btn gen-pc-btn-edit ${studio?.project === p.name ? 'active' : ''}`}
                      onClick={() => openStudio(p.name)}
                      disabled={!p.ready || studioOpening || studioClosing}
                      title={
                        !p.ready
                          ? '工程文件不完整，无法编辑'
                          : studio?.project === p.name
                            ? '回到这个工程的 Studio 编辑界面（会话还是热的）'
                            : '在 Remotion Studio 里直接改这个工程的源码'
                      }
                    >
                      {studio?.project === p.name ? '编辑中' : '编辑'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {renderPager('bottom')}
          </>
        )}
      </div>

      {/* ---------- Remotion Studio 编辑层：iframe 直连 Studio 自己的端口 ---------- */}
      {studio && (
        <div className="gen-studio-wrap" role="dialog" aria-modal="true" aria-label={`编辑工程 ${studio.project}`}>
          <div className="gen-studio-top">
            <div className="gen-studio-left">
              <button
                className="gen-studio-btn gen-studio-btn-back"
                onClick={leaveStudio}
                title="收起编辑层并回到已生成项目列表（Studio 会话保留，随时再点「编辑」回去）"
              >
                <span className="gen-studio-ic" aria-hidden="true">←</span>返回
              </button>
              <div className="gen-studio-title">
                <span className="gen-studio-dot" aria-hidden="true" />
                Remotion Studio
                <span className="gen-studio-sep">·</span>
                <b>{studio.project}</b>
              </div>
            </div>
            <div className="gen-studio-actions">
              {/* 用真链接而不是 window.open：弹出被拦截时 window.open 会静默失败 */}
              <a className="gen-studio-btn" href={studio.url} target="_blank" rel="noreferrer" title="在浏览器新标签页里打开同一个 Studio">
                <span className="gen-studio-ic" aria-hidden="true">↗</span>新窗口打开
              </a>
              <button className="gen-studio-btn" onClick={reloadStudioFrame} title="重新加载 Studio 界面（前端卡住或改源码后没反应时用）">
                <span className="gen-studio-ic" aria-hidden="true">⟳</span>重新加载
              </button>
              <button
                className="gen-studio-btn gen-studio-btn-primary"
                onClick={() => {
                  // 收起覆盖层去看渲染进度，Studio 会话保留，随时能再点「编辑」回去
                  setStudio(null);
                  setStudioFrameReady(false);
                  handleRender(studio.project);
                }}
                disabled={busy}
                title={busy ? '正在出片，等这次渲染结束后再导' : '把当前源码渲染成 MP4'}
              >
                <span className="gen-studio-ic" aria-hidden="true">⬇</span>
                {busy ? '渲染中…' : '重新导出 MP4'}
              </button>
              <button
                className="gen-studio-btn gen-studio-btn-danger"
                onClick={requestCloseStudio}
                title="关闭 Studio 会话并释放端口（下次打开需要重新打包）"
              >
                关闭
              </button>
            </div>
          </div>
          <div className="gen-studio-hint">
            在 Studio 里改的就是这个工程的源码：分镜顺序、字幕文案、配色、时长、转场都在这里定。改完点
            <b>「重新导出 MP4」</b>出新片；<b>「返回」</b>（或按 <b>Esc</b>）是收起这一层并回到项目列表（Studio
            会话保留，随时回来），<b>「关闭」</b>才会真正结束会话。
          </div>
          <div className="gen-studio-stage">
            {!studioFrameReady && (
              <div className="gen-studio-loading" role="status" aria-live="polite">
                <span className="gen-studio-spinner" aria-hidden="true" />
                <strong>正在加载 Studio 编辑界面…</strong>
                <span className="gen-studio-bar" aria-hidden="true"><i /></span>
                <p>Studio 首次启动要先给 <b>{studio.project}</b> 打包，通常几秒；工程越大越久。</p>
              </div>
            )}
            <iframe
              key={studioFrameKey}
              className="gen-studio-frame"
              src={studio.url}
              title={`Remotion Studio - ${studio.project}`}
              allow="autoplay; fullscreen"
              aria-busy={!studioFrameReady}
              onLoad={handleStudioFrameLoad}
            />
          </div>
        </div>
      )}

      {studioNotice && (
        <div className="gen-studio-toast gen-studio-toast-ok" role="status" aria-live="polite">
          <span>{studioNotice}</span>
        </div>
      )}

      {studioOpening && (
        <div className="gen-studio-toast" role="status" aria-live="polite">
          <span className="gen-studio-spinner" aria-hidden="true" />
          正在启动 Remotion Studio（首次要为工程打包，约需几秒）…
        </div>
      )}

      {studioError && !studio && (
        <div className="gen-studio-toast gen-studio-toast-err" role="alert">
          <span>{studioError}</span>
          <button className="gen-studio-btn" onClick={() => setStudioError('')}>
            知道了
          </button>
        </div>
      )}
    </div>
  );
}
