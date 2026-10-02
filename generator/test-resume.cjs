// generator/test-resume.cjs — 断点续跑 + 网络类失败不占配额的离线测试（本地 mock 网关）
// 用法: node generator/test-resume.cjs
// 注意：codegen.js 在模块加载时读取这些环境变量，必须在 require 之前设好。
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CKPT = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-test-"));
// 素材文件要放在检查点目录之外：checkpointClear() 会把检查点整目录删掉
const ASSETS = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-assets-"));
process.env.LLM_CHECKPOINT_DIR = CKPT;
process.env.LLM_URL = "http://127.0.0.1:8898/v1/chat/completions";
process.env.STYLE_PACK = "swiss-grid"; // 固定风格包，方便构造带指定字体的组件
process.env.LLM_CONNECT_TIMEOUT_MS = "1200"; // 缩短，便于测"链路抖动"
process.env.LLM_MAX_RETRY = "1"; // 不测退避，直接暴露到上层
process.env.LLM_CONNECT_FAIL_LIMIT = "1";
process.env.LLM_NET_RETRY = "2";
process.env.LLM_NET_RETRY_WAIT_MS = "300";

const http = require("node:http");
const { generateAiFilm } = require("./codegen.js");
const { STYLE_PACKS } = require("./style-packs.js");

const FONT = STYLE_PACKS.find((p) => p.id === "swiss-grid").requiredFonts[0];

const MANIFEST = {
  id: "ResumeDemo",
  title: "续跑测试片",
  styleTags: ["极简", "网格", "黑白"],
  scenes: [
    { name: "scene-one", durationInFrames: 120, overlap: 15, subtitle: "第一幕开场点题字幕" },
    { name: "scene-two", durationInFrames: 130, overlap: 18, subtitle: "第二幕讲一个具体卖点" },
    { name: "scene-three", durationInFrames: 140, overlap: 20, subtitle: "第三幕继续推进信息量" },
    { name: "scene-four", durationInFrames: 150, overlap: 16, subtitle: "第四幕收束情绪与主张" },
    { name: "scene-five", durationInFrames: 110, overlap: 0, subtitle: "第五幕点出品牌与收尾" },
  ],
};

// assetFile 非空 = 本次是「直接使用素材」模式，组件里要真的引用 staticFile("assets/…")；
// 为空 = 仅参考模式，绝不能出现 staticFile（该模式下它是禁止 API）
function sceneCode(name, assetFile) {
  const remImports = assetFile
    ? `AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Img, staticFile`
    : `AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring`;
  const media = assetFile
    ? `\n      <Img src={staticFile("assets/${assetFile}")} style={{ position: "absolute", left: 80, top: 140, width: 900, height: 600, objectFit: "cover" }} />`
    : "";
  return `import React from "react";
import { ${remImports} } from "remotion";

export default function ${name.replace(/-/g, "_")}({ subtitle }: { subtitle: string }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  const rise = spring({ frame, fps, config: { damping: 14, stiffness: 90 } });
  return (
    <AbsoluteFill style={{ backgroundColor: "#0d0d12", justifyContent: "center", alignItems: "center" }}>${media}
      <div style={{ transform: \`translateY(\${(1 - rise) * 60}px)\`, opacity }}>
        <span style={{ fontFamily: '${FONT}', fontSize: 84, color: "#f5f5f7", letterSpacing: 2 }}>{subtitle}</span>
      </div>
      <div style={{ width: width * 0.6, height: 4, backgroundColor: "#f5f5f7", opacity: opacity * 0.5 }} />
      <span style={{ fontFamily: '${FONT}', fontSize: 22, color: "#8a8a93" }}>{String(height)}px</span>
    </AbsoluteFill>
  );
}
`;
}

function backdropCode(assetFile) {
  const remImports = assetFile
    ? `AbsoluteFill, useCurrentFrame, interpolate, Img, staticFile`
    : `AbsoluteFill, useCurrentFrame, interpolate`;
  // 直用模式下背景层同样要参与素材呈现（校验对 Backdrop 与分镜一视同仁）
  const media = assetFile
    ? `\n      <Img src={staticFile("assets/${assetFile}")} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.18 }} />`
    : "";
  return `import React from "react";
import { ${remImports} } from "remotion";

export default function Backdrop() {
  const frame = useCurrentFrame();
  const shift = interpolate(frame, [0, 600], [0, 120], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: "#08080c" }}>${media}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} style={{ position: "absolute", left: (i * 320 + shift) % 1920, top: 90 + i * 150, width: 2, height: 700, backgroundColor: "rgba(255,255,255,0.08)" }} />
      ))}
    </AbsoluteFill>
  );
}
`;
}

// ---------------- mock 网关 ----------------
const calls = { planner: 0, scene: 0, backdrop: 0 };
const hangOnce = new Set(); // 这些场景名的第一次请求挂起不响应（模拟链路抖动）

function sse(res, content) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

const T0 = Date.now();
const dbg = (...a) => { if (process.env.MOCK_DEBUG === "1") console.error(`  [mock ${Date.now() - T0}ms]`, ...a); };

const server = http.createServer((req, res) => {
  let body = "";
  const cid = `c${req.socket.remotePort}`;
  dbg(`请求头到达 ${cid}`);
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    dbg(`请求体读完 ${cid} (${body.length}B)`);
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const sys = (parsed.messages || []).find((m) => m.role === "system")?.content || "";
    const usr = (parsed.messages || []).find((m) => m.role === "user")?.content || "";
    // 直用模式下从素材简报里取出真实文件名，才能产出「引用真实素材」的组件代码
    let assetFile = "";
    if (usr.includes("必须直接作为画面内容使用")) {
      const ma = usr.match(/【图片】([^\n]+)/) || usr.match(/主图已作为素材下载: ([^\s（]+)/);
      if (ma) assetFile = ma[1].trim();
    }

    if (!sys) { // 预检的 ping（无 system prompt）
      dbg("→ preflight");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }
    if (sys.includes("只输出一个 JSON 对象")) {
      calls.planner++;
      dbg("→ planner");
      return sse(res, JSON.stringify(MANIFEST));
    }
    if (sys.includes("全局环境背景组件")) {
      calls.backdrop++;
      dbg(`→ backdrop${assetFile ? ` (asset=${assetFile})` : ""}`);
      return sse(res, backdropCode(assetFile));
    }
    const m = usr.match(/- 场景名: ([a-z0-9-]+)/);
    const name = m ? m[1] : "unknown";
    if (hangOnce.delete(`${name}-first`)) return dbg(`→ ${name} 挂起（模拟链路抖动）`); // 挂起不响应 → 触发连接超时
    calls.scene++;
    dbg(`→ scene ${name}${assetFile ? ` (asset=${assetFile})` : ""}`);
    return sse(res, sceneCode(name, assetFile));
  });
});

// ---------------- 断言 ----------------
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const ckptComponents = () => (fs.existsSync(path.join(CKPT, "components")) ? fs.readdirSync(path.join(CKPT, "components")) : []);

server.listen(8898, "127.0.0.1", async () => {
  const prompt = "断点续跑测试：一个便签应用";
  // 记下开跑前已存在的目录，结束后只清本次新产生的（见结尾的兜底清理）
  const preExisting = new Set(fs.readdirSync(ROOT));

  // ---- 第 1 轮：全量生成（预览模式，不落工程目录） ----
  try {
    const r1 = await generateAiFilm({ apiKey: "test-key", prompt, previewOnly: true });
    check("第 1 轮：全量生成成功", r1.summary.sceneCount === 5 && Object.keys(r1.files).length === 6, `场景=${r1.summary.sceneCount}, 文件=${Object.keys(r1.files).length}`);
    check("第 1 轮：调用了 1 次规划 + 5 场景 + 1 背景", calls.planner === 1 && calls.scene === 5 && calls.backdrop === 1, JSON.stringify(calls));
    check("第 1 轮：检查点落盘 6 个组件", ckptComponents().length === 6, ckptComponents().join(","));
  } catch (e) {
    check("第 1 轮：全量生成成功", false, String(e.message).split("\n")[0]);
  }

  // ---- 第 2 轮：模拟"两个组件还没生成就断线了" ----
  for (const f of ["Scene1.tsx", "Backdrop.tsx"]) {
    const p = path.join(CKPT, "components", f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  const before = { ...calls };
  try {
    const r2 = await generateAiFilm({ apiKey: "test-key", prompt, previewOnly: true });
    const d = { planner: calls.planner - before.planner, scene: calls.scene - before.scene, backdrop: calls.backdrop - before.backdrop };
    check("第 2 轮：仍然成功产出全部 6 个文件", Object.keys(r2.files).length === 6, `文件=${Object.keys(r2.files).length}`);
    check("第 2 轮：规划没有重跑（复用检查点）", d.planner === 0, `planner 增量=${d.planner}`);
    check("第 2 轮：只补生成缺失的 2 个组件", d.scene + d.backdrop === 2, `场景增量=${d.scene}, 背景增量=${d.backdrop}`);
    check("第 2 轮：检查点重新补齐 6 个", ckptComponents().length === 6, ckptComponents().join(","));
  } catch (e) {
    check("第 2 轮：仍然成功产出全部 6 个文件", false, String(e.message).split("\n")[0]);
  }

  // ---- 第 3 轮：链路抖动（某组件第一次调用挂起）→ 网络重试不占用校验配额 ----
  const c1 = path.join(CKPT, "components", "Scene2.tsx");
  if (fs.existsSync(c1)) fs.unlinkSync(c1);
  hangOnce.add("scene-two-first");
  const errLines = [];
  const origErr = console.error;
  console.error = (...a) => { errLines.push(a.join(" ")); origErr(...a); };
  try {
    const r3 = await generateAiFilm({ apiKey: "test-key", prompt, previewOnly: true });
    console.error = origErr;
    check("第 3 轮：链路抖动后仍成功", Object.keys(r3.files).length === 6, `文件=${Object.keys(r3.files).length}`);
    check("第 3 轮：走了「网络重试」且没消耗校验配额", errLines.some((l) => l.includes("不占用校验重试配额")), errLines.find((l) => l.includes("不占用校验重试配额"))?.slice(0, 90));
    check("第 3 轮：没有出现「代码不合格」类报错", !errLines.some((l) => l.includes("未通过")), "无");
  } catch (e) {
    console.error = origErr;
    check("第 3 轮：链路抖动后仍成功", false, String(e.message).split("\n")[0]);
  }

  // ---- 第 4~8 轮：素材直用（回归用户报的「勾了直接使用素材，画面里还是没有素材」） ----
  const diff = (before) => ({
    planner: calls.planner - before.planner,
    scene: calls.scene - before.scene,
    backdrop: calls.backdrop - before.backdrop,
  });
  const ckptState = () => JSON.parse(fs.readFileSync(path.join(CKPT, "state.json"), "utf8"));

  const assetA = path.join(ASSETS, "demo-a.png");
  const assetB = path.join(ASSETS, "demo-b.jpg");
  fs.writeFileSync(assetA, Buffer.alloc(4096, 7));
  fs.writeFileSync(assetB, Buffer.alloc(4096, 9));
  const imgAsset = (file, absPath) => ({
    kind: "image",
    file,
    absPath,
    label: file,
    width: 1200,
    height: 800,
    palette: ["#101018", "#f0eee8"],
    brightness: 0.24,
  });

  // 前 3 轮留下的检查点是「没有素材」那一版：本轮开了直用，必须整体重来
  let mark = { ...calls };
  try {
    const r4 = await generateAiFilm({ apiKey: "test-key", prompt, previewOnly: true, assets: [imgAsset("demo-a.png", assetA)], assetMode: "direct" });
    const d = diff(mark);
    check("第 4 轮：素材参数变了 → 不复用旧组件，整体重新生成", d.planner === 1 && d.scene === 5 && d.backdrop === 1, JSON.stringify(d));
    const code = Object.values(r4.files).join("\n");
    check('第 4 轮：组件真的引用了 staticFile("assets/demo-a.png")', /staticFile\("assets\/demo-a\.png"\)/.test(code), "命中");
    check("第 4 轮：检查点记录了素材签名", String(ckptState().assetKey || "").includes("demo-a.png"), ckptState().assetKey);
  } catch (e) {
    check("第 4 轮：素材参数变了 → 不复用旧组件，整体重新生成", false, String(e.message).split("\n")[0]);
  }

  // 同参数重跑：正常复用（不烧额度）
  mark = { ...calls };
  try {
    const r5 = await generateAiFilm({ apiKey: "test-key", prompt, previewOnly: true, assets: [imgAsset("demo-a.png", assetA)], assetMode: "direct" });
    const d = diff(mark);
    check("第 5 轮：素材参数一致 → 规划与组件全部复用", d.planner === 0 && d.scene === 0 && d.backdrop === 0, JSON.stringify(d));
    check('第 5 轮：复用出来的组件仍然引用素材', /staticFile\("assets\/demo-a\.png"\)/.test(Object.values(r5.files).join("\n")), "命中");
  } catch (e) {
    check("第 5 轮：素材参数一致 → 规划与组件全部复用", false, String(e.message).split("\n")[0]);
  }

  // 换一件素材：签名又变了，必须重新生成，且不能再引用旧素材
  mark = { ...calls };
  try {
    const r6 = await generateAiFilm({ apiKey: "test-key", prompt, previewOnly: true, assets: [imgAsset("demo-b.jpg", assetB)], assetMode: "direct" });
    const d = diff(mark);
    const code = Object.values(r6.files).join("\n");
    check("第 6 轮：换素材 → 重新生成", d.planner === 1 && d.scene === 5 && d.backdrop === 1, JSON.stringify(d));
    check("第 6 轮：引用的是新素材、旧素材已消失", /staticFile\("assets\/demo-b\.jpg"\)/.test(code) && !/demo-a\.png/.test(code), "命中");
  } catch (e) {
    check("第 6 轮：换素材 → 重新生成", false, String(e.message).split("\n")[0]);
  }

  // 检查点里混进「引用不存在素材」的组件：必须被判为不可复用并重新生成，
  // 否则这类脏组件会被原样搬进新工程（渲染 404 → 用户看到素材没出现）
  fs.writeFileSync(path.join(CKPT, "components", "Scene3.tsx"), sceneCode("scene-three", "not-exist.png"), "utf8");
  mark = { ...calls };
  const errLines7 = [];
  console.error = (...a) => { errLines7.push(a.join(" ")); origErr(...a); };
  try {
    const r7 = await generateAiFilm({ apiKey: "test-key", prompt, previewOnly: true, assets: [imgAsset("demo-b.jpg", assetB)], assetMode: "direct" });
    console.error = origErr;
    const d = diff(mark);
    check("第 7 轮：不合格的检查点组件被判不可复用", errLines7.some((l) => l.includes("复用被拒") && l.includes("Scene3")), errLines7.find((l) => l.includes("复用被拒"))?.slice(0, 110));
    check("第 7 轮：只重新生成这一个组件", d.scene === 1 && d.backdrop === 0 && d.planner === 0, JSON.stringify(d));
    check("第 7 轮：最终产物引用的是真实素材", /staticFile\("assets\/demo-b\.jpg"\)/.test(r7.files["Scene3.tsx"] || ""), "命中");
  } catch (e) {
    console.error = origErr;
    check("第 7 轮：不合格的检查点组件被判不可复用", false, String(e.message).split("\n")[0]);
  }

  // 真实落盘一次：素材要真的被拷进 public/assets/，配置里也要记下来
  try {
    const r8 = await generateAiFilm({ apiKey: "test-key", prompt, previewOnly: false, withSmoke: false, assets: [imgAsset("demo-b.jpg", assetB)], assetMode: "direct" });
    const projDir = path.join(ROOT, r8.projectPath);
    check("第 8 轮：素材已拷进工程 public/assets/", fs.existsSync(path.join(projDir, "public", "assets", "demo-b.jpg")), r8.projectPath);
    const cfg = JSON.parse(fs.readFileSync(path.join(projDir, "film.config.json"), "utf8"));
    check("第 8 轮：工程配置记录了素材", (cfg.assets || []).includes("demo-b.jpg"), (cfg.assets || []).join(","));
    check("第 8 轮：工程产出后检查点被清理", !fs.existsSync(path.join(CKPT, "state.json")), "已清理");
    fs.rmSync(projDir, { recursive: true, force: true });
  } catch (e) {
    check("第 8 轮：素材已拷进工程 public/assets/", false, String(e.message).split("\n")[0]);
  }

  server.close();
  fs.rmSync(CKPT, { recursive: true, force: true });
  fs.rmSync(ASSETS, { recursive: true, force: true });
  // 兜底清理：第 8 轮会真的落盘一个工程（resumedemo*），中途抛错就会留下垃圾。
  // 只删「本次运行新出现的、以 resumedemo 开头」的目录，不碰其它任何东西。
  try {
    for (const d of fs.readdirSync(ROOT)) {
      if (!preExisting.has(d) && d.startsWith("resumedemo")) {
        fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
        console.error(`[cleanup] 清掉测试残留目录 ${d}`);
      }
    }
  } catch {}
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
});
