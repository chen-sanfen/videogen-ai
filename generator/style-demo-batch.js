#!/usr/bin/env node
// generator/style-demo-batch.js
// 用途: 为指定风格包各生成一部风格对照成片（同一产品描述，隔离风格变量）。
//   node generator/style-demo-batch.js "<产品描述>" "<pack1,pack2,...>" "<起始编号>"
//   例: node generator/style-demo-batch.js "智能升降办公桌的产品宣传片" "ink-wash,neobrutal,newsprint,artdeco" 11
// 单个包失败不中断整批；成功一部即收集到 视频/filmN.mp4。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const { generateAiFilm } = require("./codegen");

const REMOTION_CLI = path.join(ROOT, "node_modules", "@remotion", "cli", "remotion-cli.js");
const VIDEOS_DIR = path.join(ROOT, "视频");
const KEY_FILE = path.join(__dirname, ".deepseek-key");

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, "utf8").trim();
  throw new Error("API key 未找到");
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), code: r.status };
}

async function onePack(prompt, pack, filmNumber) {
  const log = (m) => console.log(`[${pack} #${filmNumber}] ${m}`);
  log(`开始生成（prompt=${prompt.slice(0, 30)}…）`);
  process.env.STYLE_PACK = pack;
  const t0 = Date.now();
  const result = await generateAiFilm({ apiKey: apiKey(), prompt });
  const dir = result.projectPath;
  const compId = result.summary.compositionId;
  log(`生成完成: ${dir} / ${compId} / ${result.summary.totalFrames}帧 / ${result.stylePack} / ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const projAbs = path.join(ROOT, dir); // 盘符路径，避免 UNC cwd

  // 1) 生成中文配音
  const voice = path.join(projAbs, "scripts", "generate-voice.ps1");
  if (fs.existsSync(voice)) {
    log("生成配音 WAV …");
    const v = run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", voice], { cwd: projAbs });
    if (!v.ok) log(`配音告警: ${v.stderr.slice(0, 200)}`);
  }

  // 2) 渲染 MP4
  fs.mkdirSync(path.join(projAbs, "out"), { recursive: true });
  log("渲染中 …");
  const t1 = Date.now();
  const r = run("node", [REMOTION_CLI, "render", "src/index.ts", compId, "out/film.mp4", "--log=error"], { cwd: projAbs });
  if (!r.ok) {
    log(`渲染失败: ${r.stderr.slice(0, 300)}`);
    return { pack, ok: false, error: r.stderr.slice(0, 300) };
  }
  log(`渲染完成 ${((Date.now() - t1) / 1000).toFixed(0)}s`);

  // 3) 收集
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  const dest = path.join(VIDEOS_DIR, `film${filmNumber}.mp4`);
  fs.copyFileSync(path.join(projAbs, "out", "film.mp4"), dest);
  log(`已收集 → ${dest}`);
  return { pack, ok: true, compId, dir, dest };
}

async function main() {
  const prompt = process.argv[2];
  const packs = (process.argv[3] || "").split(",").map((s) => s.trim()).filter(Boolean);
  let n = parseInt(process.argv[4] || "11", 10);
  if (!prompt || !packs.length) {
    console.error('用法: node style-demo-batch.js "<产品描述>" "pack1,pack2,…" <起始编号>');
    process.exit(1);
  }
  console.log(`批次: ${packs.length} 风格包 / 起始 film${n} / 产品=${prompt.slice(0, 40)}`);
  const results = [];
  for (const pack of packs) {
    try {
      results.push(await onePack(prompt, pack, n));
    } catch (e) {
      console.log(`[${pack}] 异常: ${e.message.slice(0, 200)}`);
      results.push({ pack, ok: false, error: e.message.slice(0, 200) });
    }
    n += 1;
  }
  console.log("\n===== 批次汇总 =====");
  for (const r of results) {
    console.log(r.ok ? `✓ ${r.pack} → ${r.dest}` : `✗ ${r.pack} : ${r.error}`);
  }
  const ok = results.filter((r) => r.ok).length;
  console.log(`成功 ${ok}/${results.length}`);
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}

main().catch((e) => { console.error("致命错误:", e.message); process.exit(1); });
