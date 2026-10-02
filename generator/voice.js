/**
 * 配音与配乐合成模块（纯离线工具，不做任何 LLM 调用）
 *
 * 两个能力：
 *   1. TTS —— 优先用微软神经语音（edge-tts，免密钥、免费、音色自带性格），
 *      网络不可用时回落到 Windows SAPI + SSML（离线但机械）。
 *      逐「句」合成，每句单独给 rate / pitch / volume，从而得到真实的语调起伏。
 *   2. BGM —— 用纯 JS 逐样本合成一段程序化配乐写成 WAV（不依赖任何音频素材）。
 *      由「音乐情绪」映射到速度 / 调式 / 和声进行 / 织体，再按影片时长编排段落。
 *
 * ⚠️ 全部子进程调用都必须用异步 spawn —— 本环境里 spawnSync 会以 EBUSY 失败。
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SR = 44100;

// ============================================================
//  通用：异步跑一个子进程（spawnSync 在本环境不可用）
// ============================================================
function run(cmd, args, { input, timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, code: -1, stdout: "", stderr: String(e.message) });
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      resolve(r);
    };
    const killer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ ok: false, code: -1, stdout: out, stderr: "超时" });
    }, timeout);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) => finish({ ok: false, code: -1, stdout: out, stderr: String(e.message) }));
    child.on("close", (code) => finish({ ok: code === 0, code, stdout: out, stderr: err }));
    if (input != null) {
      try {
        child.stdin.write(input);
      } catch {}
    }
    try {
      child.stdin.end();
    } catch {}
  });
}

/** 有限并发跑一批任务 */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        try {
          out[i] = await worker(items[i], i);
        } catch (e) {
          out[i] = { ok: false, error: String((e && e.message) || e) };
        }
      }
    })
  );
  return out;
}

// ============================================================
//  一、音色表：中文神经语音（edge-tts 提供）
//  音色本身就带性格，选对音色比调参数更能去掉「AI 味」
// ============================================================
const NEURAL_VOICES = [
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓", gender: "女", traits: "温暖 亲切 娓娓道来", fit: "温暖治愈 / 生活化叙事 / 情感独白" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊", gender: "女", traits: "活泼 俏皮 上扬", fit: "轻松活泼 / 潮玩 / 年轻化产品" },
  { id: "zh-CN-YunxiNeural", name: "云希", gender: "男", traits: "阳光 清朗 自然", fit: "年轻男声 / 活力 / 生活方式" },
  { id: "zh-CN-YunjianNeural", name: "云健", gender: "男", traits: "激昂 热血 有推力", fit: "运动 / 性能 / 燃向叙事" },
  { id: "zh-CN-YunyangNeural", name: "云扬", gender: "男", traits: "专业 沉稳 可信", fit: "科技 / 企业级 / 发布会 / 金融" },
  { id: "zh-CN-YunxiaNeural", name: "云夏", gender: "男", traits: "少年 萌趣", fit: "萌趣 / 游戏 / 儿童向" },
  { id: "zh-CN-liaoning-XiaobeiNeural", name: "晓北", gender: "女", traits: "东北口音 幽默", fit: "接地气 / 搞笑 / 方言梗" },
  { id: "zh-CN-shaanxi-XiaoniNeural", name: "晓妮", gender: "女", traits: "陕西口音 明亮", fit: "西北风情 / 烟火气" },
];

const NEURAL_VOICE_IDS = NEURAL_VOICES.map((v) => v.id);

// 离线兜底的 SAPI 音色
const SAPI_VOICES = ["Microsoft Huihui Desktop", "Microsoft Yaoyao Desktop", "Microsoft Kangkang Desktop"];

// ============================================================
//  二、情绪 → 语调轮廓
//  shape(t) 里 t 是「这一句在分镜内的归一化位置」（0 = 第一句，1 = 最后一句），
//  返回该句应叠加的音高(Hz) / 语速(%) / 音量(%) 偏移。这样一整段话就有起伏曲线。
// ============================================================
const EMOTIONS = {
  沉稳叙事: { label: "沉稳叙事", shape: (t) => ({ pitch: -2 + 3 * t, rate: -3 + 1 * t, volume: 0 }), pause: 0.28 },
  温暖治愈: { label: "温暖治愈", shape: (t) => ({ pitch: -1 + 2 * t, rate: -6 + 3 * t, volume: -3 + 6 * t }), pause: 0.34 },
  激昂热血: { label: "激昂热血", shape: (t) => ({ pitch: 1 + 9 * t, rate: 5 + 9 * t, volume: 5 * t }), pause: 0.14 },
  悬念铺陈: { label: "悬念铺陈", shape: (t) => ({ pitch: -6 + 11 * t * t, rate: -11 + 9 * t, volume: -6 + 8 * t }), pause: 0.46 },
  轻快明亮: { label: "轻快明亮", shape: (t) => ({ pitch: 3 + 4 * t, rate: 7 + 3 * t, volume: 2 }), pause: 0.16 },
  动情收束: { label: "动情收束", shape: (t) => ({ pitch: -2 - 5 * t, rate: -4 - 9 * t, volume: -2 - 4 * t }), pause: 0.5 },
  专业可信: { label: "专业可信", shape: (t) => ({ pitch: -1 + t, rate: -1, volume: 0 }), pause: 0.22 },
  惊叹抓人: { label: "惊叹抓人", shape: (t) => ({ pitch: 5 + 7 * t, rate: 8 + 4 * t, volume: 3 }), pause: 0.12 },
};

const DEFAULT_EMOTION = "沉稳叙事";

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(hi, Math.max(lo, v));
}

/** 归一化 AI 给的情绪名（可能写成「温暖」「热血」这种简称） */
function normalizeEmotion(raw) {
  const s = String(raw || "").trim();
  if (!s) return DEFAULT_EMOTION;
  if (EMOTIONS[s]) return s;
  const keys = Object.keys(EMOTIONS);
  for (const k of keys) if (s.includes(k) || k.includes(s)) return k;
  const alias = [
    [["温暖", "治愈", "柔", "亲切", "生活"], "温暖治愈"],
    [["燃", "激昂", "热血", "力量", "运动", "高潮"], "激昂热血"],
    [["悬", "紧张", "压抑", "神秘", "暗", "铺垫"], "悬念铺陈"],
    [["轻快", "活泼", "明快", "可爱", "欢"], "轻快明亮"],
    [["动情", "深情", "收束", "落", "感动", "结尾"], "动情收束"],
    [["专业", "可信", "正式", "发布", "商务"], "专业可信"],
    [["惊", "抓人", "开", "震撼", "冲击"], "惊叹抓人"],
    [["沉", "稳", "叙事", "介绍", "说明"], "沉稳叙事"],
  ];
  for (const [words, emo] of alias) if (words.some((w) => s.includes(w))) return emo;
  return DEFAULT_EMOTION;
}

/** 取某一句该用的韵律参数（已夹取到 edge-tts 的安全区间） */
function prosodyFor(emotion, index, count) {
  const emo = EMOTIONS[normalizeEmotion(emotion)] || EMOTIONS[DEFAULT_EMOTION];
  const t = count <= 1 ? 1 : index / (count - 1);
  const raw = emo.shape(t);
  return {
    // edge-tts 的 pitch 单位是 Hz 偏移：±28Hz 以内才自然，再大就变怪腔
    pitch: Math.round(clamp(raw.pitch, -28, 28)),
    rate: Math.round(clamp(raw.rate, -35, 35)),
    volume: Math.round(clamp(raw.volume, -25, 20)),
    pause: clamp(emo.pause, 0, 0.9),
    emotion: emo.label,
  };
}

// ============================================================
//  三、音乐情绪 → 编曲参数
// ============================================================
const CHORDS = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  add9: [0, 4, 7, 14],
  m9: [0, 3, 7, 14],
};

// root 为 MIDI 音高（60 = C4）；progression 是 {deg 相对根音的半音, chord 和弦类型}
const MUSIC_MOODS = {
  科技冷峻: {
    label: "科技冷峻", bpm: 98, root: 57, scale: [0, 2, 3, 5, 7, 8, 10],
    progression: [{ deg: 0, chord: "min7" }, { deg: 8, chord: "maj7" }, { deg: 3, chord: "maj7" }, { deg: 5, chord: "min7" }],
    pad: 0.5, bass: 0.5, arp: { level: 0.16, div: 8 }, drums: { kick: 0.3, hat: 0.05 }, brightness: 0.3,
  },
  温暖治愈: {
    label: "温暖治愈", bpm: 80, root: 60, scale: [0, 2, 4, 5, 7, 9, 11],
    progression: [{ deg: 0, chord: "maj7" }, { deg: 9, chord: "min7" }, { deg: 5, chord: "maj7" }, { deg: 7, chord: "add9" }],
    pad: 0.55, bass: 0.4, arp: { level: 0.2, div: 4 }, drums: { kick: 0, hat: 0.03 }, brightness: 0.5,
  },
  激昂燃向: {
    label: "激昂燃向", bpm: 124, root: 50, scale: [0, 2, 3, 5, 7, 8, 10],
    progression: [{ deg: 0, chord: "min" }, { deg: 10, chord: "maj" }, { deg: 8, chord: "maj" }, { deg: 7, chord: "maj" }],
    pad: 0.42, bass: 0.65, arp: { level: 0.18, div: 8 }, drums: { kick: 0.5, hat: 0.09 }, brightness: 0.45,
  },
  悬念低压: {
    label: "悬念低压", bpm: 72, root: 52, scale: [0, 1, 3, 5, 6, 8, 10],
    progression: [{ deg: 0, chord: "min" }, { deg: 1, chord: "maj" }, { deg: 0, chord: "sus2" }, { deg: 8, chord: "min" }],
    pad: 0.6, bass: 0.42, arp: { level: 0.08, div: 4 }, drums: { kick: 0.12, hat: 0 }, brightness: 0.2,
  },
  轻快灵动: {
    label: "轻快灵动", bpm: 114, root: 55, scale: [0, 2, 4, 5, 7, 9, 11],
    progression: [{ deg: 0, chord: "maj" }, { deg: 9, chord: "min7" }, { deg: 5, chord: "maj" }, { deg: 7, chord: "add9" }],
    pad: 0.34, bass: 0.5, arp: { level: 0.24, div: 8 }, drums: { kick: 0.24, hat: 0.08 }, brightness: 0.7,
  },
  极简氛围: {
    label: "极简氛围", bpm: 66, root: 62, scale: [0, 2, 4, 7, 9],
    progression: [{ deg: 0, chord: "sus2" }, { deg: 5, chord: "add9" }],
    pad: 0.62, bass: 0.3, arp: { level: 0.07, div: 2 }, drums: { kick: 0, hat: 0 }, brightness: 0.35,
  },
  复古电子: {
    label: "复古电子", bpm: 108, root: 53, scale: [0, 2, 3, 5, 7, 8, 10],
    progression: [{ deg: 0, chord: "min7" }, { deg: 10, chord: "maj7" }, { deg: 5, chord: "min7" }, { deg: 3, chord: "maj7" }],
    pad: 0.4, bass: 0.58, arp: { level: 0.22, div: 8 }, drums: { kick: 0.34, hat: 0.1 }, brightness: 0.55,
  },
};

const DEFAULT_MOOD = "科技冷峻";
const MUSIC_MOOD_NAMES = Object.keys(MUSIC_MOODS);

/** 把 AI 给的音乐情绪归一到已知情绪表 */
function normalizeMood(raw) {
  const s = String(raw || "").trim();
  if (MUSIC_MOODS[s]) return s;
  for (const k of MUSIC_MOOD_NAMES) {
    if (s.includes(k.slice(0, 2)) || k.includes(s.slice(0, 2))) return k;
  }
  const hint = s.toLowerCase();
  const aliasMap = [
    [["科技", "冷", "未来", "赛博", "数位", "tech", "极客"], "科技冷峻"],
    [["温暖", "治愈", "柔和", "疗愈", "生活", "暖", "亲切"], "温暖治愈"],
    [["燃", "激昂", "运动", "力量", "热血", "epic", "激烈"], "激昂燃向"],
    [["悬", "紧张", "压抑", "神秘", "暗", "thriller"], "悬念低压"],
    [["轻快", "活泼", "明快", "pop", "可爱", "欢快"], "轻快灵动"],
    [["极简", "氛围", "空灵", "禅", "ambient", "安静"], "极简氛围"],
    [["复古", "合成", "synth", "retro", "电子", "怀旧"], "复古电子"],
  ];
  for (const [words, mood] of aliasMap) if (words.some((w) => hint.includes(w))) return mood;
  return DEFAULT_MOOD;
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// ============================================================
//  四、程序化配乐合成（逐样本，写到 WAV）
// ============================================================

/** 一个振荡器 + ADSR 包络，把一段音叠加进左右缓冲 */
function addVoice(L, R, { start, dur, freq, amp, wave = "sine", attack = 0.02, decay = 0.25, sustain = 0.7, release = 0.35, pan = 0, detune = 0, lowpass = 0 }) {
  const n = L.length;
  const i0 = Math.max(0, Math.floor(start * SR));
  const i1 = Math.min(n, Math.ceil((start + dur) * SR));
  if (i1 <= i0 || amp <= 0) return;
  const inc = (freq * (1 + detune / 1200)) / SR;
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  const expD = 1 - Math.exp(-4);
  let phase = 0;
  let lp = 0;
  const lpA = lowpass > 0 ? 1 - Math.exp((-2 * Math.PI * lowpass) / SR) : 0;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    // 包络：attack 线性上升 → decay 指数衰减到 sustain → release 线性归零
    let env;
    if (t < attack) env = t / attack;
    else if (t < attack + decay) {
      const k = (t - attack) / decay;
      env = 1 + (sustain - 1) * (1 - Math.exp(-4 * k)) / expD;
    } else {
      const k = Math.min(1, (t - attack - decay) / Math.max(0.001, release));
      env = sustain * (1 - k);
    }
    if (env <= 0) continue;
    const p = phase * 2 * Math.PI;
    let s;
    if (wave === "sine") s = Math.sin(p);
    else if (wave === "tri") s = (2 / Math.PI) * Math.asin(Math.sin(p));
    else if (wave === "saw") s = 2 * (phase - Math.floor(phase + 0.5));
    else if (wave === "square") s = Math.sin(p) >= 0 ? 1 : -1;
    else s = Math.sin(p) * 0.7 + Math.sin(p * 2) * 0.3;
    phase += inc;
    if (phase > 1e6) phase = 0;
    let v = s * env * amp;
    if (lpA > 0) {
      lp += lpA * (v - lp);
      v = lp;
    }
    L[i] += v * gl;
    R[i] += v * gr;
  }
}

/** 噪声（踩镲 / 气声），用确定性伪随机，保证同参数结果可复现 */
function addNoise(L, R, { start, dur, amp, pan = 0, lowpass = 6000, decay = 0.08, seed = 1 }) {
  const n = L.length;
  const i0 = Math.max(0, Math.floor(start * SR));
  const i1 = Math.min(n, Math.ceil((start + dur) * SR));
  if (i1 <= i0 || amp <= 0) return;
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  const lpA = 1 - Math.exp((-2 * Math.PI * lowpass) / SR);
  let s = seed | 0;
  let lp = 0;
  for (let i = i0; i < i1; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const r = s / 0x3fffffff - 1;
    const v = r * amp * Math.exp(-(i - i0) / SR / decay);
    lp += lpA * (v - lp);
    L[i] += lp * gl;
    R[i] += lp * gr;
  }
}

/** 底鼓：正弦下扫 */
function addKick(L, R, start, amp) {
  const dur = 0.22;
  const i0 = Math.max(0, Math.floor(start * SR));
  const i1 = Math.min(L.length, Math.ceil((start + dur) * SR));
  let phase = 0;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    const f = 120 * Math.exp(-t * 22) + 42;
    phase += f / SR;
    const env = Math.exp(-t * 13) * (t < 0.004 ? t / 0.004 : 1);
    const v = Math.sin(phase * 2 * Math.PI) * env * amp;
    L[i] += v;
    R[i] += v;
  }
}

/**
 * 按编曲参数合成整段配乐。
 * 段落编排：前 ~14% 渐入（织体稀疏），中段满配，最后 ~18% 收束淡出。
 */
function renderMusicBuffer(spec, durationSec) {
  const n = Math.max(SR, Math.ceil(durationSec * SR));
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const mood = MUSIC_MOODS[spec.mood] || MUSIC_MOODS[DEFAULT_MOOD];
  const root = Number.isFinite(spec.root) ? spec.root : mood.root;
  const bpm = clamp(spec.bpm || mood.bpm, 50, 160);
  const barDur = (60 / bpm) * 4;
  const totalBars = Math.max(1, Math.ceil(durationSec / barDur));
  const intensity = clamp(spec.intensity == null ? 1 : spec.intensity, 0.2, 1.4);
  const prog = mood.progression;
  const scale = mood.scale;

  const sectionGain = (bar) => {
    const p = totalBars <= 1 ? 1 : bar / (totalBars - 1);
    if (p < 0.14) return 0.38 + (p / 0.14) * 0.5;
    if (p > 0.82) return 1 - ((p - 0.82) / 0.18) * 0.75;
    return 1;
  };

  for (let bar = 0; bar < totalBars; bar++) {
    const barStart = bar * barDur;
    if (barStart >= durationSec) break;
    const gain = sectionGain(bar) * intensity;
    const ch = prog[bar % prog.length];
    const chordRoot = root + ch.deg;
    const tones = (CHORDS[ch.chord] || CHORDS.maj).map((iv) => chordRoot + iv);

    // —— 铺底和声：长音，左右两路轻微失谐叠出厚度 ——
    for (const t of tones) {
      const f = midiToFreq(t);
      addVoice(L, R, { start: barStart, dur: barDur * 1.02, freq: f, amp: 0.075 * mood.pad * gain, wave: "tri", attack: 0.5, decay: 0.9, sustain: 0.75, release: 0.7, pan: -0.45, lowpass: 2200 });
      addVoice(L, R, { start: barStart, dur: barDur * 1.02, freq: f, amp: 0.065 * mood.pad * gain, wave: "tri", attack: 0.7, decay: 1.0, sustain: 0.7, release: 0.7, pan: 0.45, detune: 7, lowpass: 2200 });
    }

    // —— 低音 ——
    const bassF = midiToFreq(chordRoot - 12);
    const bassHits = bpm > 100 ? 4 : 2;
    for (let b = 0; b < bassHits; b++) {
      const st = barStart + (barDur / bassHits) * b;
      if (st >= durationSec) break;
      addVoice(L, R, { start: st, dur: Math.min((barDur / bassHits) * 0.92, durationSec - st), freq: bassF, amp: 0.16 * mood.bass * gain, wave: "sine", attack: 0.012, decay: 0.18, sustain: 0.4, release: 0.22, lowpass: 420 });
    }

    // —— 琶音：在调内音游走，制造流动感（索引确定性递推） ——
    if (mood.arp.level > 0) {
      const steps = Math.max(4, Math.round((barDur / (60 / bpm)) * (mood.arp.div / 4)) * 4);
      const stepDur = barDur / steps;
      let idx = (bar * 3 + 1) % scale.length;
      for (let s = 0; s < steps; s++) {
        const st = barStart + s * stepDur;
        if (st >= durationSec) break;
        idx = (idx + (s % 3 === 0 ? 2 : 1)) % scale.length;
        const octave = s % 8 >= 4 ? 12 : 0;
        const f = midiToFreq(root + scale[idx] + octave + 12);
        addVoice(L, R, {
          start: st,
          dur: stepDur * 1.7,
          freq: f,
          amp: 0.062 * mood.arp.level * 6 * gain * (0.55 + (0.45 * ((s * 7 + bar) % 5)) / 4),
          wave: mood.brightness > 0.5 ? "tri" : "sine",
          attack: 0.004,
          decay: 0.12,
          sustain: 0.18,
          release: 0.3,
          pan: ((s % 2) * 2 - 1) * 0.4,
          lowpass: 3000 + mood.brightness * 5000,
        });
      }
    }

    // —— 鼓组：只在节奏感强的情绪里出现 ——
    if (mood.drums.kick > 0) {
      for (let b = 0; b < 4; b++) {
        const st = barStart + (barDur / 4) * b;
        if (st >= durationSec) break;
        addKick(L, R, st, 0.5 * mood.drums.kick * gain * (b % 2 === 0 ? 1 : 0.62));
      }
    }
    if (mood.drums.hat > 0) {
      for (let s = 0; s < 8; s++) {
        const st = barStart + (barDur / 8) * s;
        if (st >= durationSec) break;
        addNoise(L, R, { start: st, dur: 0.06, amp: 0.5 * mood.drums.hat * gain * (s % 2 === 0 ? 0.7 : 1), lowpass: 8000, decay: 0.03, pan: s % 2 ? 0.3 : -0.3, seed: s * 31 + bar });
      }
    }
  }

  // 主输出：软削波 + 首尾淡入淡出（避免起止爆音）
  const fadeIn = Math.min(0.35 * SR, n);
  const fadeOut = Math.min(1.6 * SR, n * 0.2);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let g = 1;
    if (i < fadeIn) g *= i / fadeIn;
    if (i > n - fadeOut) g *= (n - i) / fadeOut;
    outL[i] = Math.tanh(L[i] * 1.1) * 0.92 * g;
    outR[i] = Math.tanh(R[i] * 1.1) * 0.92 * g;
  }
  // 峰值归一化到 -1dB 左右：合成出来的原始信号峰值很低（约 0.12），
  // 不归一会白白浪费 3 位分辨率，也让播放端的 volume 参数失去绝对参照。
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(outL[i]);
    const b = Math.abs(outR[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  if (peak > 0.001) {
    const k = 0.89 / peak;
    for (let i = 0; i < n; i++) {
      outL[i] *= k;
      outR[i] *= k;
    }
  }
  return { L: outL, R: outR, bars: totalBars, bpm, mood: mood.label, peak: peak > 0.001 ? 0.89 : peak };
}

/** 把左右浮点缓冲写成 16bit PCM 立体声 WAV */
function writeWav(file, L, R) {
  const n = L.length;
  const dataBytes = n * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i]));
    const r = Math.max(-1, Math.min(1, R[i]));
    buf.writeInt16LE(Math.round(l * 32767), off);
    buf.writeInt16LE(Math.round(r * 32767), off + 2);
    off += 4;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

/** 对外：按情绪合成一段配乐写到 outFile */
function synthesizeBgm(outFile, { mood, durationSec, intensity, root, bpm }) {
  const spec = { mood: normalizeMood(mood), durationSec, intensity, root, bpm };
  const t0 = Date.now();
  const { L, R, bars, bpm: usedBpm, mood: usedMood } = renderMusicBuffer(spec, durationSec);
  const bytes = writeWav(outFile, L, R);
  return { file: path.basename(outFile), bytes, mood: usedMood, bpm: usedBpm, bars, ms: Date.now() - t0 };
}

// ============================================================
//  五、音频时长解析（纯 JS，格式已知时比起 ffprobe 快且稳）
// ============================================================
const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG1_SR = [44100, 48000, 32000];
const MPEG2_SR = [22050, 24000, 16000];
const MPEG25_SR = [11025, 12000, 8000];

function wavDuration(buf) {
  if (buf.length < 44 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") return null;
  let p = 12;
  let byteRate = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString("latin1", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(p + 16);
    else if (id === "data") {
      if (byteRate > 0) return size / byteRate;
    }
    p += 8 + size + (size % 2);
  }
  return null;
}

function mp3Duration(buf) {
  let off = 0;
  if (buf.length > 10 && buf.toString("latin1", 0, 3) === "ID3") {
    off = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f));
  }
  let h = -1;
  const limit = Math.min(buf.length - 4, off + 400000);
  for (let i = off; i < limit; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const b1 = buf[i + 1];
    const b2 = buf[i + 2];
    const verBits = (b1 >> 3) & 3;
    const layer = (b1 >> 1) & 3;
    const brIdx = (b2 >> 4) & 15;
    const srIdx = (b2 >> 2) & 3;
    if (verBits === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    h = i;
    break;
  }
  if (h < 0) return null;
  const b1 = buf[h + 1];
  const b2 = buf[h + 2];
  const verBits = (b1 >> 3) & 3;
  const brIdx = (b2 >> 4) & 15;
  const srIdx = (b2 >> 2) & 3;
  const isV1 = verBits === 3;
  const bitrate = (isV1 ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES)[brIdx] * 1000;
  const sampleRate = (isV1 ? MPEG1_SR : verBits === 2 ? MPEG2_SR : MPEG25_SR)[srIdx];
  const samplesPerFrame = isV1 ? 1152 : 576;
  const mono = ((b1 >> 6) & 3) === 3;
  const sideInfoLen = isV1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const tagOff = h + 4 + sideInfoLen;
  if (tagOff + 12 <= buf.length) {
    const tag = buf.toString("latin1", tagOff, tagOff + 4);
    if (tag === "Xing" || tag === "Info") {
      const flags = buf.readUInt32BE(tagOff + 4);
      if (flags & 1) {
        const frames = buf.readUInt32BE(tagOff + 8);
        if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
      }
    }
  }
  if (bitrate > 0) return ((buf.length - off) * 8) / bitrate;
  return null;
}

/** 探测音频时长（秒）；失败返回 null */
function probeAudioDuration(file) {
  try {
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    if (ext === ".wav") return wavDuration(buf);
    if (ext === ".mp3") return mp3Duration(buf);
    return wavDuration(buf) || mp3Duration(buf);
  } catch {
    return null;
  }
}

// ============================================================
//  六、TTS
// ============================================================

/** 找 edge-tts 入口：环境变量 → 已知 venv → PATH → python -m */
async function resolveEdgeTts() {
  const cands = [];
  if (process.env.EDGE_TTS_BIN) cands.push({ cmd: process.env.EDGE_TTS_BIN, args: [] });
  cands.push({ cmd: "C:/Users/15359/.workbuddy/binaries/python/envs/default/Scripts/edge-tts.exe", args: [] });
  cands.push({ cmd: "edge-tts", args: [] });
  for (const py of ["C:/Users/15359/.workbuddy/binaries/python/envs/default/Scripts/python.exe", "python", "python3"]) {
    cands.push({ cmd: py, args: ["-m", "edge_tts"] });
  }
  for (const c of cands) {
    const r = await run(c.cmd, [...c.args, "--version"], { timeout: 25000 });
    if (r.ok) return c;
  }
  return null;
}

let edgeTtsCache;
async function edgeTts() {
  if (edgeTtsCache === undefined) edgeTtsCache = await resolveEdgeTts();
  return edgeTtsCache;
}

// 负值必须写成 --rate=-4%：argparse 会把 "-4%" 当成另一个选项
const pct = (k, n) => `${k}=${n >= 0 ? "+" : ""}${Math.round(n)}%`;
const hz = (n) => `--pitch=${n >= 0 ? "+" : ""}${Math.round(n)}Hz`;

/** 神经语音合成一句（文本走 stdin，规避命令行长度与转义问题） */
async function ttsNeural({ text, voice, rate, pitch, volume, outFile }) {
  const bin = await edgeTts();
  if (!bin) return { ok: false, error: "未找到 edge-tts（可用 EDGE_TTS_BIN 指定路径）" };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const args = [
    ...bin.args,
    "-f", "-",
    "--voice", voice,
    pct("--rate", rate),
    hz(pitch),
    pct("--volume", volume),
    "--write-media", outFile,
  ];
  const r = await run(bin.cmd, args, { input: String(text), timeout: 90000 });
  if (!r.ok || !fs.existsSync(outFile) || fs.statSync(outFile).size < 512) {
    return { ok: false, error: `edge-tts 失败: ${(r.stderr || r.stdout || "").toString().slice(0, 300) || "未知错误"}` };
  }
  return { ok: true };
}

/**
 * 离线兜底：Windows SAPI + SSML。
 * SpeakSsml 支持 <prosody rate/pitch/volume>，逐句给韵律也能出起伏；
 * 音质不如神经语音，但断网时至少不哑。
 */
async function ttsSapiSsml({ items, outDir }) {
  const psFile = path.join(outDir, "_sapi.ps1");
  const voice = SAPI_VOICES[0];
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const bodies = items
    .map((it) => {
      // SAPI 的 rate/pitch 是 -10..10 档位，跟 edge-tts 的百分比不是一回事，按经验折算
      const r = Math.round(clamp(it.rate / 3.5, -10, 10));
      const p = Math.round(clamp(it.pitch / 3, -10, 10));
      const v = Math.round(clamp(100 + it.volume, 0, 100));
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><prosody rate="${r >= 0 ? "+" : ""}${r}" pitch="${p >= 0 ? "+" : ""}${p}" volume="${v}">${esc(it.text)}</prosody></speak>`;
      return `@{ file = '${it.file}'; ssml = '${ssml.replace(/'/g, "''")}' }`;
    })
    .join(",\n");
  const ps = `Add-Type -AssemblyName System.Speech
$out = '${outDir.replace(/\\/g, "\\\\")}'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$voice = '${voice}'
$items = @(
${bodies}
)
foreach ($item in $items) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try { $synth.SelectVoice($voice) } catch {}
  $path = Join-Path $out $item.file
  $synth.SetOutputToWaveFile($path)
  $synth.SpeakSsml($item.ssml)
  $synth.Dispose()
  Write-Output ("ok " + $path)
}
`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(psFile, "\uFEFF" + ps, "utf-8");
  const r = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psFile], { timeout: 300000 });
  const missing = items.filter((it) => !fs.existsSync(path.join(outDir, it.file)));
  if (missing.length) {
    return { ok: false, error: `SAPI 兜底失败（缺 ${missing.length} 个文件）: ${String(r.stderr || "").slice(0, 200)}` };
  }
  return { ok: true };
}

// ============================================================
//  七、对外主入口：把「配音方案」变成一组音频文件
// ============================================================
/**
 * plan 结构（由 codegen 里的 AI 调用产出，这里只做兜底与合成）：
 * {
 *   provider: "neural" | "sapi",
 *   voice: "zh-CN-YunyangNeural",
 *   scenes: [ { scene, emotion, lines: ["第一句", "第二句"] } ]
 * }
 * 返回 { ok, provider, files: [{ file, scene, index, text, seconds, pause }], error }
 */
async function synthesizeVoiceover(plan, outDir) {
  const items = [];
  for (let si = 0; si < plan.scenes.length; si++) {
    const sc = plan.scenes[si];
    const lines = (sc.lines || []).map((s) => String(s).trim()).filter(Boolean);
    for (let li = 0; li < lines.length; li++) {
      const pros = prosodyFor(sc.emotion, li, lines.length);
      const base = `${String(si + 1).padStart(2, "0")}-${String(li + 1).padStart(2, "0")}-${sc.scene}`;
      items.push({ text: lines[li], scene: sc.scene, index: li, pros, base });
    }
  }
  if (!items.length) return { ok: false, error: "配音方案里没有任何句子" };

  const useNeural = plan.provider !== "sapi" && (await edgeTts());

  // 神经语音
  if (useNeural) {
    for (const it of items) it.file = `${it.base}.mp3`;
    const results = await mapLimit(items, 4, async (it) => {
      const r = await ttsNeural({
        text: it.text,
        voice: plan.voice,
        rate: it.pros.rate,
        pitch: it.pros.pitch,
        volume: it.pros.volume,
        outFile: path.join(outDir, it.file),
      });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    });
    const failed = results.filter((r) => !r || !r.ok).length;
    // 全军覆没（通常是断网）→ 换 SAPI 重来一遍
    if (failed === items.length) {
      const why = (results.find((r) => r && r.error) || {}).error || "未知错误";
      console.error(`[voice] 神经语音全部失败（${why}），回落到 Windows SAPI`);
      for (const it of items) it.file = `${it.base}.wav`;
      const fb = await ttsSapiSsml({ items, outDir });
      if (!fb.ok) return { ok: false, error: `${why}；${fb.error}` };
      return { ok: true, provider: "sapi", files: withDurations(items, outDir) };
    }
    if (failed) console.error(`[voice] 神经语音部分失败（${failed}/${items.length}），保留成功的部分`);
    return { ok: true, provider: "neural", files: withDurations(items, outDir) };
  }

  // 直接走 SAPI
  for (const it of items) it.file = `${it.base}.wav`;
  const fb = await ttsSapiSsml({ items, outDir });
  if (!fb.ok) return { ok: false, error: fb.error };
  return { ok: true, provider: "sapi", files: withDurations(items, outDir) };
}

/** 给每句补上真实时长（解析不到就按中文约 4.6 字/秒估算） */
function withDurations(items, outDir) {
  return items
    .map((it) => {
      const abs = path.join(outDir, it.file);
      if (!fs.existsSync(abs)) return null;
      const probed = probeAudioDuration(abs);
      const est = Math.max(0.6, String(it.text).length / 4.6);
      return {
        file: it.file,
        scene: it.scene,
        index: it.index,
        text: it.text,
        seconds: probed || est,
        emotion: it.pros.emotion,
        prosody: { rate: it.pros.rate, pitch: it.pros.pitch, volume: it.pros.volume },
        pause: it.pros.pause,
      };
    })
    .filter(Boolean);
}

module.exports = {
  NEURAL_VOICES,
  NEURAL_VOICE_IDS,
  SAPI_VOICES,
  EMOTIONS,
  MUSIC_MOODS,
  MUSIC_MOOD_NAMES,
  DEFAULT_EMOTION,
  DEFAULT_MOOD,
  normalizeMood,
  normalizeEmotion,
  prosodyFor,
  synthesizeBgm,
  renderMusicBuffer,
  writeWav,
  synthesizeVoiceover,
  probeAudioDuration,
  resolveEdgeTts,
  mapLimit,
  SR,
};
