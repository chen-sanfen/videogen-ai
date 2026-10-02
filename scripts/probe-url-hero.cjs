// 验证「网址 + 直接使用」下主图的挑选结果（真实网络，不调用 LLM）
// 逻辑与 web/server.mjs 的 normalizeAssets 保持一致：并行试候选 → 从可用里挑最大的一张
// 用法: node scripts/probe-url-hero.cjs [网址...]
const path = require("node:path");
const { inspectUrl, fetchBinary } = require("../generator/codegen.js");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp"]);

function extFromContentType(ct) {
  const t = String(ct || "").toLowerCase();
  if (t.includes("image/png")) return ".png";
  if (t.includes("image/webp")) return ".webp";
  if (t.includes("image/gif")) return ".gif";
  if (t.includes("image/avif")) return ".avif";
  if (t.includes("image/jpeg") || t.includes("image/jpg")) return ".jpg";
  return "";
}

(async () => {
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : ["https://www.apple.com.cn/", "https://cursor.com/cn", "https://www.remotion.dev/"];
  for (const url of urls) {
    console.log(`\n=== ${url}`);
    let info;
    try {
      info = await inspectUrl(url);
    } catch (e) {
      console.log(`  ✗ 抓取失败: ${e.message}`);
      continue;
    }
    const candidates = [...(info.image ? [info.image] : []), ...(info.images || [])]
      .filter((u, i, a) => a.indexOf(u) === i)
      .slice(0, 5);
    const fetched = (
      await Promise.all(
        candidates.map(async (c) => {
          try {
            const bin = await fetchBinary(c);
            const ext = extFromContentType(bin.contentType) || path.extname(new URL(c).pathname).toLowerCase();
            if (bin.status >= 400 || !bin.buffer.length || !IMAGE_EXT.has(ext)) return null;
            if (bin.buffer.length < 8 * 1024) return null;
            return { c, kb: Math.round(bin.buffer.length / 1024) };
          } catch {
            return null;
          }
        })
      )
    ).filter(Boolean);
    fetched.sort((a, b) => b.kb - a.kb);
    console.log(`  可用候选: ${fetched.map((f) => `${f.kb}KB`).join(", ") || "(无)"}`);
    console.log(`  → 会作为素材: ${fetched[0] ? `${fetched[0].kb}KB  ${fetched[0].c.slice(0, 90)}` : "❌ 无（直用模式只能拿文字信息）"}`);
  }
})();
