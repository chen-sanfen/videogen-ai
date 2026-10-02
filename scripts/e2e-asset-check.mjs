// 端到端验证：素材（图片 / 网址）在「直接使用」模式下是否真的进了画面。
// 用法: node scripts/e2e-asset-check.mjs [--url https://...] [--prompt "..."] [--seconds 8]
// 流程: 上传素材 → /api/generate/stream(direct) → 落盘后核对
//   1) 工程 public/assets/ 里有没有文件
//   2) 场景组件里有没有 staticFile("assets/…")
//   3) 该静态 URL 能不能真的取到（模拟浏览器预览）
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT || 3001;
const API = `http://127.0.0.1:${PORT}`;

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

function pickUpload() {
  const dir = path.join(ROOT, "generator", ".uploads");
  if (!fs.existsSync(dir)) return null;
  const imgs = fs.readdirSync(dir).filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
  return imgs.length ? path.join(dir, imgs.sort().pop()) : null;
}

async function upload(file) {
  const buf = fs.readFileSync(file);
  const res = await fetch(`${API}/api/asset/upload?name=${encodeURIComponent(path.basename(file))}`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: buf,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`上传失败 ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function gen(assets, prompt, seconds) {
  const res = await fetch(`${API}/api/generate/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      seconds,
      assetMode: "direct",
      subtitles: true,
      voice: false,
      bgm: false,
      assets,
    }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`生成请求失败 ${res.status}: ${t.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let result = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "result") result = ev;
      else if (ev.type === "error") throw new Error(`后端报错: ${ev.error}`);
      else if (ev.type === "log") process.stdout.write(`    ${ev.line}\n`);
    }
  }
  return result;
}

function verify(projectPath) {
  const dir = path.join(ROOT, projectPath);
  const out = { project: projectPath, assetFiles: [], refs: {}, missing: [], staticOk: null };
  const assetsDir = path.join(dir, "public", "assets");
  out.assetFiles = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const sceneDir = path.join(dir, "src", "scenes");
  for (const f of fs.existsSync(sceneDir) ? fs.readdirSync(sceneDir).filter((x) => x.endsWith(".tsx")) : []) {
    const code = fs.readFileSync(path.join(sceneDir, f), "utf8");
    const refs = [...code.matchAll(/staticFile\s*\(\s*["'`]assets\/([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
    if (refs.length) out.refs[f] = refs;
    for (const r of refs) if (!out.assetFiles.includes(r)) out.missing.push(`${f} → ${r}`);
  }
  return out;
}

(async () => {
  const urlTarget = flag("url", "");
  const prompt = flag("prompt", "一支手冲咖啡的沉浸式宣传片");
  const seconds = Number(flag("seconds", "8"));
  const assets = [];

  if (urlTarget) {
    const res = await fetch(`${API}/api/asset/url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlTarget }),
    });
    const info = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`网址解析失败 ${res.status}: ${JSON.stringify(info)}`);
    console.log("网址素材:", JSON.stringify({ url: urlTarget, title: info.title, hasImageUrl: !!info.imageUrl, images: (info.images || []).length, file: info.file }));
    assets.push({ kind: "url", url: urlTarget, host: info.host, title: info.title, description: info.description, headings: info.headings, text: info.text, imageUrl: info.imageUrl, images: info.images });
  } else {
    const f = pickUpload();
    if (!f) throw new Error("没有可用的测试图片，请先上传一张");
    const up = await upload(f);
    console.log("上传结果:", JSON.stringify(up));
    assets.push({ kind: "image", storedName: up.storedName, label: path.basename(f), width: 1200, height: 800, palette: [], brightness: 0.5 });
  }

  console.log(`\n开始生成（direct 模式，${seconds}s）…\n`);
  const result = await gen(assets, prompt, seconds);
  if (!result) throw new Error("生成没有返回结果");
  const v = verify(result.projectPath);
  console.log("\n===== 落盘核对 =====");
  console.log("工程:", v.project);
  console.log("public/assets 里的文件:", v.assetFiles.length ? v.assetFiles.join(", ") : "(空)");
  console.log("组件引用素材的情况:", Object.keys(v.refs).length ? JSON.stringify(v.refs, null, 2) : "❌ 没有任何场景引用素材");
  if (v.missing.length) console.log("⚠ 引用了不存在的文件:", v.missing.join(" | "));

  // 模拟浏览器预览：staticFile 会解析到 /api/media/<工程>/assets/xxx
  const first = v.assetFiles[0] || Object.values(v.refs)[0]?.[0];
  if (first) {
    const url = `${API}/api/media/${encodeURIComponent(v.project)}/assets/${encodeURIComponent(first)}`;
    const r = await fetch(url);
    const body = await r.arrayBuffer();
    console.log(`静态取图 ${url} → HTTP ${r.status}, ${body.byteLength} 字节`);
    v.staticOk = r.status === 200 && body.byteLength > 0;
  }

  const ok = v.assetFiles.length > 0 && Object.keys(v.refs).length > 0 && v.missing.length === 0 && v.staticOk !== false;
  console.log(ok ? "\n✅ 素材链路通：文件在盘上、组件引用了、URL 可取。" : "\n❌ 素材链路断了。");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("测试失败:", e.message || e);
  process.exit(2);
});
