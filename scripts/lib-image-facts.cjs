// scripts/lib-image-facts.cjs
// 「素材里到底有什么」的事实提取 —— 与前端 web/Generator.tsx 的 sampleCanvasMeta 同一套算法，
// 只是输入从浏览器 canvas 换成 Node 端解码后的像素（decodePng 给的是 {w,h,bpp,data}）。
//
// 为什么要单独一份：真实链路探针（probe-redraw-live.cjs）在 Node 里跑，拿不到 canvas；
// 而重绘的效果取决于喂给模型的事实是否准确，所以探针必须用**真实**特征，
// 不能像以前那样硬编码几个假色值——那样验证出来的结论没有意义。
//
// 输出：palette(+占比) / brightness / 3x3 grid / 16x9 色彩网格图 / 主体显著区域 / 细节密度

function pixelAt(data, w, bpp, x, y) {
  const i = (y * w + x) * bpp;
  return [data[i], data[i + 1], data[i + 2]];
}

// 区域平均色（等价于浏览器 canvas 的平滑降采样）
function downsample(data, w, h, bpp, cols, rows) {
  const out = [];
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor((rx * w) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * w) / cols));
      const y0 = Math.floor((ry * h) / rows);
      const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * h) / rows));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y += Math.max(1, Math.floor((y1 - y0) / 8))) {
        for (let x = x0; x < x1; x += Math.max(1, Math.floor((x1 - x0) / 8))) {
          const p = pixelAt(data, w, bpp, x, y);
          r += p[0];
          g += p[1];
          b += p[2];
          n++;
        }
      }
      out.push(n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0]);
    }
  }
  return out;
}

const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
const hexOf = (c) => `#${toHex(c[0])}${toHex(c[1])}${toHex(c[2])}`;
const lumOf = (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;

// 主色（带占比）：按 4bit/通道量化后取前 5
function paletteOf(data, w, h, bpp, topN = 5) {
  const buckets = new Map();
  let n = 0;
  let step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000))); // 大图抽样，别逐像素跑
  let lum = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const [r, g, b] = pixelAt(data, w, bpp, x, y);
      lum += lumOf([r, g, b]);
      n++;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const cur = buckets.get(key) || { r: 0, g: 0, b: 0, c: 0 };
      cur.r += r;
      cur.g += g;
      cur.b += b;
      cur.c += 1;
      buckets.set(key, cur);
    }
  }
  const top = [...buckets.values()].sort((a, b) => b.c - a.c).slice(0, topN);
  return {
    palette: top.map((v) => hexOf([v.r / v.c, v.g / v.c, v.b / v.c])),
    paletteRatio: top.map((v) => Math.round((v.c / (n || 1)) * 100) / 100),
    brightness: n ? Math.round((lum / n) * 100) / 100 : 0.5,
  };
}

/**
 * 从解码后的像素提取全部事实。
 * @param {{w:number,h:number,bpp:number,data:Buffer}} img
 * @param {{width?:number,height?:number}} [orig] 原始尺寸（用于输出 width/height）
 */
function extractFacts(img, orig = {}) {
  const w = img.w;
  const h = img.h;
  const bpp = img.bpp || 3;
  const data = img.data;
  const { palette, paletteRatio, brightness } = paletteOf(data, w, h, bpp);

  // 3x3 网格
  const g3 = downsample(data, w, h, bpp, 3, 3);
  const grid = g3.map((c) => {
    const mx = Math.max(...c);
    const mn = Math.min(...c);
    return {
      color: hexOf(c),
      lum: Math.round(lumOf(c) * 100) / 100,
      sat: Math.round((mx === 0 ? 0 : (mx - mn) / mx) * 100) / 100,
    };
  });

  // 16x9 色彩网格图
  const MAP_COLS = 16;
  const MAP_ROWS = 9;
  const mapCells = downsample(data, w, h, bpp, MAP_COLS, MAP_ROWS).map(hexOf);
  const map = { cols: MAP_COLS, rows: MAP_ROWS, cells: mapCells };

  // 32x18 中精度图：算显著区域与细节密度
  const DCOLS = 32;
  const DROWS = 18;
  const mid = downsample(data, w, h, bpp, DCOLS, DROWS);
  const N = DCOLS * DROWS;
  const avg = mid.reduce((a, c) => [a[0] + c[0] / N, a[1] + c[1] / N, a[2] + c[2] / N], [0, 0, 0]);
  const sal = mid.map(
    (c) => Math.sqrt((c[0] - avg[0]) ** 2 + (c[1] - avg[1]) ** 2 + (c[2] - avg[2]) ** 2) / 441.673
  );
  const lums = mid.map(lumOf);
  const detail = [];
  for (let ry = 0; ry < MAP_ROWS; ry++) {
    for (let rx = 0; rx < MAP_COLS; rx++) {
      let acc = 0;
      let cnt = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const x = rx * 2 + dx;
          const y = ry * 2 + dy;
          if (x + 1 < DCOLS) (acc += Math.abs(lums[y * DCOLS + x] - lums[y * DCOLS + x + 1])), cnt++;
          if (y + 1 < DROWS) (acc += Math.abs(lums[y * DCOLS + x] - lums[(y + 1) * DCOLS + x])), cnt++;
        }
      }
      detail.push(Math.round(Math.min(1, (cnt ? acc / cnt : 0) / 0.25) * 100) / 100);
    }
  }
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
  const subject =
    maxX >= 0 && wsum > 0
      ? {
          x: Math.round((minX / DCOLS) * 100) / 100,
          y: Math.round((minY / DROWS) * 100) / 100,
          w: Math.round(((maxX - minX + 1) / DCOLS) * 100) / 100,
          h: Math.round(((maxY - minY + 1) / DROWS) * 100) / 100,
          cx: Math.round((cx / wsum / DCOLS) * 100) / 100,
          cy: Math.round((cy / wsum / DROWS) * 100) / 100,
        }
      : { x: 0.2, y: 0.2, w: 0.6, h: 0.6, cx: 0.5, cy: 0.5 };

  return {
    width: orig.width || w,
    height: orig.height || h,
    palette,
    paletteRatio,
    brightness,
    grid,
    map,
    subject,
    detail,
  };
}

module.exports = { extractFacts, downsample, paletteOf };
