// 极简 PNG 解码（zlib 内置，够用于 remotion 渲染出的 8bit RGB/RGBA 图）+ 像素差异比对。
// 只做一件事：判断「换掉素材后画面到底变了多少像素」——素材看不见时这个数就是 0。
const zlib = require("node:zlib");

function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  let pos = 8;
  let w = 0,
    h = 0,
    bd = 0,
    ct = 0;
  const idat = [];
  let plte = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bd = data[8];
      ct = data[9];
      if (data[12] !== 0) throw new Error("不支持隔行扫描 PNG");
    } else if (type === "PLTE") {
      plte = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  const channels = ct === 6 ? 4 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : 1;
  const bytesPerSample = bd === 8 ? 1 : bd === 16 ? 2 : 1;
  const bpp = channels * bytesPerSample;
  if (bd !== 8 && bd !== 16) throw new Error(`不支持的位深 ${bd}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    if (rp + stride > raw.length) break;
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
  }
  // 统一成 RGBA（索引色展开调色板），比对时只看前 3 个通道
  if (ct === 3) {
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const idx = out[i] * 3;
      rgba[i * 4] = plte[idx];
      rgba[i * 4 + 1] = plte[idx + 1];
      rgba[i * 4 + 2] = plte[idx + 2];
      rgba[i * 4 + 3] = 255;
    }
    return { w, h, bpp: 4, data: rgba };
  }
  return { w, h, bpp, data: out };
}

// 两张同尺寸图：返回变化像素占比（0~1）
function diffRatio(a, b) {
  if (a.w !== b.w || a.h !== b.h) return 1;
  const n = a.w * a.h;
  let changed = 0;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const o = i * a.bpp;
    const dr = Math.abs(a.data[o] - b.data[o]);
    const dg = Math.abs(a.data[o + 1] - b.data[o + 1]);
    const db = Math.abs(a.data[o + 2] - b.data[o + 2]);
    d += dr + dg + db;
    if (dr + dg + db > 24) changed += 1;
  }
  return { ratio: changed / n, avgDelta: d / (n * 3) };
}

module.exports = { decodePng, diffRatio };
