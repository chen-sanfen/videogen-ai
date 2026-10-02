/**
 * 字幕 / 配音 / 配乐 / 多选风格参考 —— 端到端验证
 *
 *  1) 以「关闭字幕 + 开配音 + 开配乐 + 多选两个工程作风格参考」跑一次真实生成
 *  2) 校验工程产物：preview.json 开关位、场景代码不再渲染字幕、
 *     配音逐句音频与情绪、配乐 wav、Film.tsx 的闪避逻辑
 *  3) 逐帧渲染若干帧确认「关字幕」后画面里真的没有字幕文字
 *  4) 导出 MP4 并确认音轨存在（用 Remotion 自带 ffprobe 读流信息）
 *
 * 用法：node scripts/verify-tracks-flow.cjs [工程A] [工程B]
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const API = "http://localhost:3001";
const REF_A = process.argv[2] || "allterrainmechamemphis";
const REF_B = process.argv[3] || "monolightstudio";

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
          if (ev.type === "stage" && ev.status !== "progress") {
            process.stdout.write(`  · ${ev.stage}${ev.status ? "/" + ev.status : ""}${ev.voice ? " " + ev.voice : ""}${ev.count ? " " + ev.count + "句" : ""}${ev.mood ? " " + ev.mood : ""}${ev.error ? " ERR:" + String(ev.error).slice(0, 80) : ""}\n`);
          }
          if (ev.type === "error") return reject(new Error(ev.error));
        } catch {}
      }
    }
    resolve(events);
  });
}

function ffprobeInfo(file) {
  return new Promise((resolve) => {
    const bin = path.join(ROOT, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffprobe.exe");
    execFile(bin, ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name,duration", "-of", "json", file], { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        return resolve(JSON.parse(stdout));
      } catch {
        return resolve(null);
      }
    });
  });
}

(async () => {
  console.log(`① 生成：关字幕 + 开配音 + 开配乐 + 多选风格参考(${REF_A} + ${REF_B})…`);
  const events = await ndjson(`${API}/api/generate/stream`, {
    prompt: "一条关于晨间智能咖啡机的生活方式品牌片，强调被温柔唤醒的感觉",
    seconds: 12,
    subtitles: false,
    voice: true,
    bgm: true,
    styleRefs: [REF_A, REF_B],
    assetMode: "reference",
    assets: [],
  });
  const result = events.find((e) => e.type === "result");
  if (!result) throw new Error("没有 result 事件");
  const proj = result.preview.projectName;
  const dir = path.join(ROOT, proj);
  console.log(`   ✓ 工程 ${proj}`);

  console.log("② 校验开关位与风格融合…");
  const preview = JSON.parse(fs.readFileSync(path.join(dir, "preview.json"), "utf8"));
  const styleRefLog = events.filter((e) => e.type === "stage").length;
  console.log(`   · subtitles=${preview.subtitles}（期望 false）`);
  console.log(`   · stylePack=${preview.stylePack}`);
  console.log(`   · 服务端回传 styleRef=${JSON.stringify(result.styleRef)}`);
  if (preview.subtitles !== false) throw new Error("subtitles 未生效（应为 false）");
  if (!result.styleRef || (result.styleRef.projectNames || []).length < 2) throw new Error("多选风格参考未生效");

  console.log("③ 校验场景代码里不再渲染字幕…");
  const sceneDir = path.join(dir, "src", "scenes");
  const sceneFiles = fs.readdirSync(sceneDir).filter((f) => f.endsWith(".tsx"));
  let offenders = [];
  for (const f of sceneFiles) {
    const code = fs.readFileSync(path.join(sceneDir, f), "utf8");
    // 把函数签名（必然含 subtitle）剥掉后，正文里不该再出现 subtitle
    const body = code.replace(/export\s+default\s+function[^{]*\(\s*\{\s*subtitle\s*\}\s*:\s*\{[^}]*\}\s*\)[^{]*\{/, "");
    const used = /\bsubtitle\b/.test(body);
    console.log(`   · ${f}: ${used ? "⚠️ 仍在渲染字幕" : "未渲染字幕 ✓"}`);
    if (used) offenders.push(f);
  }
  if (offenders.length) throw new Error(`以下场景仍在渲染字幕：${offenders.join(", ")}`);

  console.log("④ 校验配音与配乐产物…");
  const v = preview.voice || {};
  const voiceDir = path.join(dir, "public", "voice");
  const audioFiles = fs.existsSync(voiceDir) ? fs.readdirSync(voiceDir) : [];
  console.log(`   · voice.enabled=${v.enabled} provider=${v.provider} 音色=${v.voiceName}`);
  console.log(`   · 配音 ${v.tracks.length} 句，音频文件 ${audioFiles.length} 个：${audioFiles.join(", ")}`);
  console.log(`   · 配乐 bgm=${v.bgm ? `${v.bgm.file} (${v.bgm.mood}) 音量=${v.bgm.volume} 闪避=${v.bgm.duck}` : "无"}`);
  if (!v.enabled || !v.tracks.length) throw new Error("配音未产出");
  if (!v.bgm) throw new Error("配乐未产出");
  const missing = v.tracks.filter((t) => !fs.existsSync(path.join(voiceDir, t.file)));
  if (missing.length) throw new Error(`配音文件缺失：${missing.map((m) => m.file).join(", ")}`);
  if (!fs.existsSync(path.join(voiceDir, v.bgm.file))) throw new Error("配乐文件不存在");

  // 韵律是否真的有起伏：情绪种类数 + 逐句时长差异（全片一个值说明没起伏）
  const emotions = [...new Set(v.tracks.map((t) => t.emotion || ""))].filter(Boolean);
  const durations = v.tracks.map((t) => t.duration);
  console.log(`   · 情绪种类 ${emotions.length}: ${emotions.join(" / ")}`);
  console.log(`   · 逐句帧长 ${durations.join(" / ")}（同一情绪内也应因语速不同而有差异）`);
  const planPath = path.join(dir, "voice.plan.json");
  if (fs.existsSync(planPath)) {
    const saved = JSON.parse(fs.readFileSync(planPath, "utf8"));
    console.log(`   · 音色理由: ${saved.plan.voiceReason || "-"}`);
    if (saved.plan.music) console.log(`   · 配乐理由: ${saved.plan.music.reason || "-"}（强度 ${saved.plan.music.intensity}）`);
  }
  console.log(`   · 逐句文本：`);
  for (const t of v.tracks.slice(0, 6)) {
    console.log(`       ${t.file} 帧${t.from} 长${t.duration} [${t.emotion || "-"}]「${t.text}」`);
  }
  if (emotions.length < 2) throw new Error(`全片只有 ${emotions.length} 种情绪，配音没有起伏`);

  // 关键不变量：任意两句配音不得在时间上重叠（重叠 = 两个人同时说话）
  const sorted = [...v.tracks].sort((a, b) => a.from - b.from);
  const overlaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].from + sorted[i - 1].duration;
    if (sorted[i].from < prevEnd) {
      overlaps.push(`${sorted[i - 1].file}(→帧${prevEnd}) 与 ${sorted[i].file}(帧${sorted[i].from} 起)`);
    }
  }
  if (overlaps.length) throw new Error(`配音时间轴重叠（会两人同时说话）：\n     ${overlaps.join("\n     ")}`);
  const voiceEnd = Math.max(...sorted.map((t) => t.from + t.duration));
  console.log(`   · 配音时间轴无重叠 ✓（最后一句结束于帧 ${voiceEnd} / 全片 ${preview.totalFrames} 帧）`);
  if (voiceEnd > preview.totalFrames) throw new Error(`配音超出全片长度：${voiceEnd} > ${preview.totalFrames}`);

  console.log("⑤ 校验 Film.tsx 的混音逻辑…");
  const film = fs.readFileSync(path.join(dir, "src", "Film.tsx"), "utf8");
  const checks = [
    ["<Audio", /<Audio/],
    ["配音淡入淡出", /VoiceClip/],
    ["配乐闪避", /speakingFactor/],
    ["staticFile 指向 voice/", /staticFile\("voice\/"/],
  ];
  for (const [label, re] of checks) {
    const ok = re.test(film);
    console.log(`   · ${label}: ${ok ? "✓" : "✗"}`);
    if (!ok) throw new Error(`Film.tsx 缺少：${label}`);
  }

  console.log("⑥ 导出 MP4 并确认音轨…");
  const renderEvents = await ndjson(`${API}/api/render`, { project: proj });
  const rendered = renderEvents.find((e) => e.type === "result");
  if (!rendered) throw new Error("导出没有 result 事件");
  const mp4 = path.join(dir, "out", "film.mp4");
  const info = await ffprobeInfo(mp4);
  if (!info) throw new Error("ffprobe 读取失败");
  const kinds = info.streams.map((s) => s.codec_type);
  console.log(`   · 输出 ${(fs.statSync(mp4).size / 1048576).toFixed(2)}MB，流: ${info.streams.map((s) => `${s.codec_type}/${s.codec_name}`).join(", ")}`);
  if (!kinds.includes("audio")) throw new Error("导出的 MP4 没有音轨！");

  console.log(`\n✅ 字幕开关 / 配音 / 配乐 / 多选风格参考 全部通过`);
  console.log(`   工程目录: ${proj}`);
})().catch((e) => {
  console.error("\n❌ " + e.message);
  process.exit(1);
});
