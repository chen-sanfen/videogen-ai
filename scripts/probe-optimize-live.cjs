#!/usr/bin/env node
// scripts/probe-optimize-live.cjs
// 真实链路验证：「AI 优化描述」到底有没有用上传的素材。
//
// 做法：拿一张真实图片（默认 generator/.uploads 下 Memphis 风格那张），
// 用 decodePng 算出真实的 palette + 3x3 网格特征（等价于浏览器 canvas 采样），
// 带上它真实请求一次 /api/optimize-prompt，打印耗时与优化后的正文。
//
// 要消耗 LLM 额度：优化前会先跑一次「素材理解」（约 15~20s），再扩写（约 10~15s）。
//
// 用法：node scripts/probe-optimize-live.cjs [图片路径] [--mode reference|direct|redraw] [--prompt "描述"]

const fs = require("fs");
const path = require("path");
const http = require("http");
const { decodePng } = require("./lib-png-diff.cjs");

const args = process.argv.slice(2);
// 取值本身不带 --，会被误当成位置参数（图片路径）—— 先把它和它的取值一起剔掉
const positional = [];
let mode = "direct";
let PROMPT = "做一个智能音箱的产品宣传片";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--mode") {
    if (args[i + 1]) mode = args[i + 1];
    i++;
    continue;
  }
  if (args[i] === "--prompt") {
    if (args[i + 1]) PROMPT = args[i + 1];
    i++;
    continue;
  }
  if (!args[i].startsWith("--")) positional.push(args[i]);
}
const SRC =
  positional[0] || path.join(__dirname, "..", "generator", ".uploads", "allterrainmechamemphis-f-mugqrr7e47ac.png");

// 与前端 sampleCanvasMeta 同款算法：主色（分桶取前 5）+ 3x3 网格（色彩/明度/饱和度）
function sampleMeta(file, sample = 120) {
  const buf = fs.readFileSync(file);
  // lib-png-diff 的 decodePng 返回的是 { w, h, bpp, data }（不是 width/height）
  const img = decodePng(buf);
  const { w: width, h: height, data } = img;
  if (!width || !height || !data) throw new Error("PNG 解码失败");
  // bpp 可能是 3（RGB）也可能 4（RGBA）：一律按 4 读会在三通道图上越界取到邻像素，
  // 症状是主色里冒出 #NaNNaNNaN —— 探针自己算错特征，会连累后面所有结论，必须按 bpp 取。
  return documentlessCanvas(sample, width, height, data, img.bpp || 4);
}

// 没有 DOM，这里自己按「缩放采样」实现：直接按目标网格取样点
function documentlessCanvas(sample, width, height, data, bpp) {
  const px = (x, y) => {
    const i = (y * width + x) * bpp;
    return bpp === 4 ? [data[i], data[i + 1], data[i + 2], data[i + 3]] : [data[i], data[i + 1], data[i + 2], 255];
  };
  const buckets = new Map();
  let sum = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / sample));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const [r, g, b, a] = px(x, y);
      if (a < 128) continue;
      sum += (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      n += 1;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const cur = buckets.get(key) || { r: 0, g: 0, b: 0, c: 0 };
      cur.r += r;
      cur.g += g;
      cur.b += b;
      cur.c += 1;
      buckets.set(key, cur);
    }
  }
  const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  const palette = [...buckets.values()]
    .sort((a, b) => b.c - a.c)
    .slice(0, 5)
    .map((v) => `#${toHex(v.r / v.c)}${toHex(v.g / v.c)}${toHex(v.b / v.c)}`);

  // 3x3 网格：每格取中心区域均值
  const grid = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let cnt = 0;
      let lum = 0;
      let sat = 0;
      const x0 = Math.floor((gx * width) / 3);
      const x1 = Math.floor(((gx + 1) * width) / 3);
      const y0 = Math.floor((gy * height) / 3);
      const y1 = Math.floor(((gy + 1) * height) / 3);
      const s = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 20));
      for (let y = y0; y < y1; y += s) {
        for (let x = x0; x < x1; x += s) {
          const p = px(x, y);
          if (p[3] < 128) continue;
          r += p[0];
          g += p[1];
          b += p[2];
          cnt += 1;
        }
      }
      if (!cnt) {
        grid.push({ color: "#000000", lum: 0, sat: 0 });
        continue;
      }
      r /= cnt;
      g /= cnt;
      b /= cnt;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      sat = mx === 0 ? 0 : (mx - mn) / mx;
      grid.push({
        color: `#${toHex(r)}${toHex(g)}${toHex(b)}`,
        lum: Math.round(lum * 100) / 100,
        sat: Math.round(sat * 100) / 100,
      });
    }
  }
  return { width, height, palette, brightness: n ? Math.round((sum / n) * 100) / 100 : 0.5, grid };
}

function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": payload.length } },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode, raw: buf.slice(0, 400) });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.log("找不到图片:", SRC);
    process.exit(1);
  }
  const meta = sampleMeta(SRC);
  const name = path.basename(SRC);
  console.log("源图:", name);
  console.log("  尺寸:", meta.width + "x" + meta.height, "明度:", meta.brightness);
  console.log("  主色:", meta.palette.join(" "));
  console.log("  九宫格首格:", JSON.stringify(meta.grid[0]), "中心:", JSON.stringify(meta.grid[4]));
  console.log("模式:", mode);
  console.log("原始描述:", PROMPT);

  // 素材项按前端提交格式构造（storedName 指向真实存在的文件）
  const assets = [{ kind: "image", label: name, storedName: name, meta }];
  const t0 = Date.now();
  const r = await post(3001, "/api/optimize-prompt", { prompt: PROMPT, assets, assetMode: mode });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 200) {
    console.log("请求失败:", r.status, r.json?.error || r.raw);
    process.exit(1);
  }
  console.log(`\n耗时 ${sec}s，视角: ${r.json.angle}`);
  console.log("\n--- 优化后的描述 ---");
  console.log(r.json.optimized);
})();
