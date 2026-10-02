// 快速验证「网址素材」抓取：标题 / 摘要 / 小标题 / 主图候选
// 用法: node scripts/probe-url-assets.cjs [网址...]
// 默认取几个典型站点：有 og:image 的、只有 <img> 的
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

// 模拟「直接使用素材」模式下后端逐个候选图兜底下载的逻辑
async function pickDownloadable(candidates) {
  for (const [i, url] of candidates.entries()) {
    try {
      const bin = await fetchBinary(url);
      const ext = extFromContentType(bin.contentType) || path.extname(new URL(url).pathname).toLowerCase();
      const kb = Math.round(bin.buffer.length / 1024);
      const usable = bin.status < 400 && bin.buffer.length >= 8 * 1024 && IMAGE_EXT.has(ext);
      console.log(`    ${i + 1}. HTTP ${bin.status} ${kb}KB ${bin.contentType || "?"} → ${usable ? `✅ 可用（${ext}）` : "✗ 跳过"}`);
      if (usable) return url;
    } catch (e) {
      console.log(`    ${i + 1}. ✗ ${e.message}`);
    }
  }
  return "";
}

const DEFAULT_URLS = [
  "https://www.remotion.dev/",
  "https://cursor.com/cn",
  "https://www.apple.com.cn/",
];

(async () => {
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;
  for (const url of urls) {
    console.log(`\n=== ${url}`);
    try {
      const info = await inspectUrl(url);
      console.log(`  host     : ${info.host}`);
      console.log(`  title    : ${info.title || "(无)"}`);
      console.log(`  desc     : ${(info.description || "(无)").slice(0, 80)}`);
      console.log(`  headings : ${info.headings.length} 个${info.headings.length ? ` — ${info.headings.slice(0, 3).join(" / ")}` : ""}`);
      console.log(`  主图候选 : ${info.images.length} 张`);
      info.images.forEach((u, i) => console.log(`    ${i + 1}. ${u.slice(0, 110)}`));
      console.log(`  首个(兼容字段 image): ${info.image ? info.image.slice(0, 110) : "(无)"}`);
      if (!info.images.length) {
        console.log("  ⚠️ 没有任何主图候选：直用模式下只能用文字信息");
      } else {
        console.log("  —— 直用模式会把哪一张真的下下来（逐个候选兜底）:");
        const picked = await pickDownloadable(info.images.slice(0, 5));
        console.log(`  → ${picked ? `会下载：${picked.slice(0, 100)}` : "❌ 全部候选都不可用（直用模式拿不到文件）"}`);
      }
    } catch (e) {
      console.log(`  ✗ 抓取失败: ${e.message}`);
    }
  }
})();
