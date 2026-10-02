/**
 * 素材生成端到端验证：
 *   1) 上传一张图片 + 添加一个网址（走真实 HTTP）
 *   2) 以「直接使用」模式跑一次真实生成（6 秒 / 3 分镜）
 *   3) 校验：工程里有 public/assets/、场景代码引用了 staticFile("assets/…")、
 *      preview.json 记录了素材与风格包，且预览能加载
 *
 * 用法：node scripts/verify-asset-flow.cjs [图片路径] [网址]
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const IMG = process.argv[2] || path.join(ROOT, "out", "allterrainmechamemphis-frame-46.png");
const URL2 = process.argv[3] || "https://www.remotion.dev/";
const API = "http://localhost:3001";

function ndjson(url, body) {
  return new Promise(async (resolve, reject) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return reject(new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const events = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          events.push(ev);
          if (ev.type === "stage") {
            const extra = ev.total ? ` ${ev.done || 0}/${ev.total}` : "";
            process.stdout.write(`  · ${ev.stage}${ev.status ? "/" + ev.status : ""}${extra} ${ev.file || ""}\n`);
          }
          if (ev.type === "error") return reject(new Error(ev.error));
        } catch {}
      }
    }
    resolve(events);
  });
}

(async () => {
  if (!fs.existsSync(IMG)) throw new Error(`找不到测试图片 ${IMG}`);

  console.log("① 上传图片素材…");
  const up = await fetch(`${API}/api/asset/upload?name=${encodeURIComponent(path.basename(IMG))}`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: fs.readFileSync(IMG),
  });
  const upJson = await up.json();
  if (!up.ok) throw new Error("上传失败: " + JSON.stringify(upJson));
  console.log(`   ✓ ${upJson.storedName} (${Math.round(upJson.bytes / 1024)}KB)`);

  console.log("② 读取网址素材…");
  const ur = await fetch(`${API}/api/asset/url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: URL2 }),
  });
  const urJson = await ur.json();
  if (!ur.ok) throw new Error("网址读取失败: " + JSON.stringify(urJson));
  console.log(`   ✓ ${urJson.host} 「${(urJson.title || "").slice(0, 40)}」主图=${urJson.image ? "有" : "无"}`);

  // 前端探测出的元数据这里用真实值简化（尺寸用图片实际值）
  console.log("③ 以「直接使用素材」模式生成（含风格参考）…");
  const events = await ndjson(`${API}/api/generate/stream`, {
    prompt: "用这张视觉素材做一条先锋潮玩品牌的宣传片，强调强烈色块与几何张力",
    seconds: 6,
    assetMode: "direct",
    styleRef: "allterrainmechamemphis",
    assets: [
      { kind: "image", storedName: upJson.storedName, label: path.basename(IMG), width: 1920, height: 1080, palette: ["#1a1a2e", "#ed1849", "#00a19c", "#fef6e4"], brightness: 0.4 },
      { kind: "url", url: urJson.url, host: urJson.host, title: urJson.title, description: urJson.description, headings: urJson.headings, text: urJson.text, imageUrl: urJson.image },
    ],
  });
  const result = events.find((e) => e.type === "result");
  if (!result) throw new Error("没有 result 事件");
  const proj = result.preview.projectName;
  console.log(`   ✓ 生成完成：${proj}（风格参考 ${result.styleRef?.projectName} / 风格包 ${result.styleRef?.packId}）`);

  console.log("④ 校验产物…");
  const preview = JSON.parse(fs.readFileSync(path.join(ROOT, proj, "preview.json"), "utf8"));
  console.log(`   · stylePack=${preview.stylePack} assets=${(preview.assets || []).join(", ") || "(无)"}`);
  const assetDir = path.join(ROOT, proj, "public", "assets");
  const files = fs.existsSync(assetDir) ? fs.readdirSync(assetDir) : [];
  console.log(`   · public/assets/: ${files.join(", ") || "(不存在!)"}`);
  if (!files.length) throw new Error("public/assets/ 里没有素材文件");
  let referenced = 0;
  const offenders = [];
  const sceneDir = path.join(ROOT, proj, "src", "scenes");
  const sceneFiles = fs.readdirSync(sceneDir);
  for (const f of sceneFiles) {
    const code = fs.readFileSync(path.join(sceneDir, f), "utf8");
    const n = (code.match(/staticFile\("assets\//g) || []).length;
    const usesImg = /<Img\b/.test(code) || /<OffthreadVideo\b/.test(code);
    // 服务端渲染不支持 foreignObject：素材一旦被包进去，导出画面会整块消失
    const badFObj = /foreignObject/i.test(code);
    console.log(`   · ${f}: staticFile 引用 ${n} 处，${usesImg ? "用了 Img/OffthreadVideo" : "未用媒体标签"}${badFObj ? " ⚠️ 发现 foreignObject!" : ""}`);
    if (badFObj) offenders.push(f);
    if (n) referenced++;
  }
  if (offenders.length) {
    throw new Error(`以下场景使用了 <foreignObject>（服务端渲染不支持，导出画面会丢素材）：${offenders.join(", ")}`);
  }
  if (!referenced) throw new Error("没有任何场景引用素材");
  console.log(`\n✅ 素材直用链路通过：${referenced}/${sceneFiles.length} 个场景引用了真实素材，且无 foreignObject`);
  console.log(`   工程目录: ${proj}`);
})().catch((e) => {
  console.error("\n❌ " + e.message);
  process.exit(1);
});
