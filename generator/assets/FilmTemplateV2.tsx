import React from "react";
import { AbsoluteFill, Audio, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { config, SceneConfig } from "../config";

// SUNRISE PAPER 风格 — 与 classic 完全独立的第二套视觉系统
// 浅色暖纸底 + 特粗无衬线 + 非对称大字排版 + 手机样机/雷达/跑马灯等全新元素
const C = config.theme;
const clamp = (x: number) => Math.max(0, Math.min(1, x));

function Background({ frame }: { frame: number }) {
  const drift = Math.sin(frame / 55) * 34;
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at ${16 + drift / 7}% 84%, ${C.orange}16, transparent 36%), radial-gradient(circle at 87% 10%, ${C.teal}14, transparent 30%)` }} />
      <div style={{ position: "absolute", left: -110, bottom: 96, width: 460, height: 460, borderRadius: "50%", background: C.soft, transform: `translateX(${drift}px)` }} />
      <div style={{ position: "absolute", right: -80, top: -110, width: 560, height: 560, borderRadius: "50%", background: C.soft, opacity: 0.65 }} />
    </AbsoluteFill>
  );
}

// 1. kicker — 左对齐特大标题，逐字错落滑入 + 橙色扫入下划线（替代 classic 的居中衬线 title）
function KickerEl({ frame, props }: { frame: number; props: any }) {
  const chars = String(props.text || "").split("");
  const fontSize = props.fontSize || 96;
  return (
    <div style={{ position: "absolute", left: props.x ?? 140, top: props.y ?? 340 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 28 }}>
        <span style={{ width: 48, height: 10, background: C.orange, display: "inline-block" }} />
        <span style={{ color: C.teal, fontSize: 24, letterSpacing: 8, fontWeight: 700, fontFamily: '"Microsoft YaHei", sans-serif' }}>{props.eyebrow || ""}</span>
      </div>
      <div style={{ display: "flex", color: C.ink, fontWeight: 900, fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif', lineHeight: 1.12 }}>
        {chars.map((ch, i) => {
          const t = clamp((frame - 6 - i * 3) / 14);
          const up = interpolate(t, [0, 1], [72, 0]);
          return <span key={i} style={{ fontSize, opacity: t, transform: `translateY(${up}px)`, whiteSpace: "pre" }}>{ch}</span>;
        })}
      </div>
      <div style={{ marginTop: 32, height: 12, width: interpolate(clamp(frame / 40), [0, 1], [0, 660]), background: `linear-gradient(90deg, ${C.orange}, ${C.amber})` }} />
    </div>
  );
}

// 2. caption — 底部墨色圆角胶囊，spring 弹入（替代 classic 的悬浮发光字幕）
function CaptionEl({ frame, props }: { frame: number; props: any }) {
  const pop = spring({ frame: Math.max(0, frame - (props.start ?? 8)), fps: 30, config: { damping: 200 } });
  const out = interpolate(frame, [(props.end ?? 200) - 12, props.end ?? 200], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: "50%", bottom: 64, transform: `translateX(-50%) scale(${0.86 + pop * 0.14})`, opacity: clamp(pop * 2) * out, background: C.ink, color: "#fff", borderRadius: 999, padding: "18px 46px", fontSize: props.fontSize || 32, letterSpacing: 3, fontFamily: '"Microsoft YaHei", sans-serif', whiteSpace: "nowrap", boxShadow: `0 18px 40px ${C.ink}30` }}>{props.text || ""}</div>
  );
}

// 3. phoneMock — 手机样机：底部 spring 升起 + 轻微倾斜，应用内开关逐个点亮（全新元素）
function PhoneMockEl({ frame, props }: { frame: number; props: any }) {
  const w = props.w || 400;
  const h = Math.round(w * 2.05);
  const rise = spring({ frame, fps: 30, config: { damping: 16, stiffness: 60 } });
  const yOff = interpolate(rise, [0, 1], [580, 0]);
  const tilt = interpolate(rise, [0, 1], [11, -4]);
  const x = props.x ?? 1150, y = props.y ?? 170;
  const dot = [C.orange, C.teal, C.amber, C.teal];
  return (
    <g transform={`translate(${x} ${y}) rotate(${tilt}) translate(0 ${yOff})`}>
      <rect x="0" y="0" width={w} height={h} rx="54" fill="#221f1a" />
      <rect x="10" y="10" width={w - 20} height={h - 20} rx="44" fill={C.card} />
      <rect x={w / 2 - 70} y="26" width="140" height="26" rx="13" fill="#221f1a" />
      <rect x="38" y="88" width={w - 76} height="118" rx="20" fill={C.soft} />
      <text x="62" y="128" fill={C.ink} fontSize="26" fontWeight="700" fontFamily='"Microsoft YaHei", sans-serif'>全屋总览</text>
      <text x="62" y="168" fill={C.teal} fontSize="20" fontFamily='"Microsoft YaHei", sans-serif'>12 台设备在线</text>
      {[0, 1, 2, 3].map((i) => {
        const t = clamp((frame - 18 - i * 12) / 10);
        const yy = 234 + i * 116;
        const on = t > 0.55;
        return (
          <g key={i} opacity={t}>
            <rect x="38" y={yy} width={w - 76} height="94" rx="18" fill="#fff" stroke={C.line} strokeWidth="2" />
            <circle cx="72" cy={yy + 47} r="17" fill={dot[i]} opacity={0.85} />
            <rect x="104" y={yy + 24} width="150" height="14" rx="7" fill={C.soft} />
            <rect x="104" y={yy + 54} width="104" height="10" rx="5" fill={C.line} />
            <rect x={w - 98} y={yy + 32} width="52" height="30" rx="15" fill={on ? C.orange : C.line} />
            <circle cx={w - 98 + (on ? 35 : 17)} cy={yy + 47} r="11" fill="#fff" />
          </g>
        );
      })}
    </g>
  );
}

// 4. statBlock — 巨型滚动数字 + 单位 + 标签，spring 缩放进入（全新元素）
function StatBlockEl({ frame, props }: { frame: number; props: any }) {
  const pop = spring({ frame: Math.max(0, frame - 4), fps: 30, config: { damping: 14 } });
  const target = props.value ?? 100;
  const raw = interpolate(clamp(frame / 50), [0, 1], [0, target]);
  const shown = target < 10 ? raw.toFixed(1) : String(Math.round(raw));
  return (
    <div style={{ position: "absolute", left: props.x ?? 150, top: props.y ?? 360, transform: `scale(${0.8 + pop * 0.2})`, opacity: clamp(pop * 2), transformOrigin: "left bottom" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <span style={{ color: C.orange, fontSize: 200, fontWeight: 900, fontFamily: '"Arial Black", Arial, sans-serif', lineHeight: 1 }}>{shown}</span>
        <span style={{ color: C.ink, fontSize: 66, fontWeight: 900, fontFamily: '"Microsoft YaHei", sans-serif' }}>{props.unit || ""}</span>
      </div>
      <div style={{ color: C.ink, fontSize: 30, letterSpacing: 6, fontWeight: 700, fontFamily: '"Microsoft YaHei", sans-serif', marginTop: 10 }}>{props.label || ""}</div>
    </div>
  );
}

// 5. waveBars — 竖向律动条（classic 的 codeFlow 是横向左对齐条，这里完全不同）
function WaveBarsEl({ frame, props }: { frame: number; props: any }) {
  const count = props.count || 22, x = props.x ?? 170, y = props.y ?? 660, w = props.w ?? 940, h = props.h || 220, speed = props.speed || 8;
  const gap = w / count;
  const bw = gap * 0.62;
  const colors = [C.orange, C.teal, C.amber];
  return (
    <g>
      {Array.from({ length: count }).map((_, i) => {
        const phase = frame / speed + i * 0.7;
        const bh = h * (0.16 + 0.40 * (0.5 + 0.5 * Math.sin(phase)) + 0.28 * (0.5 + 0.5 * Math.sin(phase * 1.7 + 2)));
        return <rect key={i} x={x + i * gap} y={y + (h - bh)} width={bw} height={bh} rx={bw / 2} fill={colors[i % 3]} opacity={0.88} />;
      })}
    </g>
  );
}

// 6. radarRings — 扩散雷达波 + 旋转扫描扇区 + 巡游点（classic 的 particles 是静态点环）
function RadarRingsEl({ frame, props }: { frame: number; props: any }) {
  const cx = props.cx ?? 1330, cy = props.cy ?? 470, count = props.count || 4, speed = props.speed || 7;
  const sweep = (frame * 2.2) % 360;
  const rings = [0, 1, 2, 3].slice(0, count);
  return (
    <g>
      {rings.map((i) => {
        const t = (frame / speed + i / count) % 1;
        const r = 60 + t * 330;
        const op = (1 - t) * 0.75;
        return <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={C.teal} strokeWidth={5} opacity={op} />;
      })}
      <circle cx={cx} cy={cy} r="46" fill={C.orange} />
      <g transform={`rotate(${sweep} ${cx} ${cy})`} opacity={0.45}>
        <path d={`M ${cx} ${cy} L ${cx + 340} ${cy - 62} A 346 346 0 0 1 ${cx + 340} ${cy + 62} Z`} fill={C.teal} />
      </g>
      {[0, 1, 2].map((i) => {
        const a = frame / 30 + i * 2.1;
        const px = cx + Math.cos(a) * (150 + i * 62);
        const py = cy + Math.sin(a) * (148 + i * 46);
        return <circle key={"d" + i} cx={px} cy={py} r="10" fill={C.ink} opacity={0.8} />;
      })}
    </g>
  );
}

// 7. marquee — 墨色横幅无限跑马灯（全新元素，classic 没有）
function MarqueeEl({ frame, props }: { frame: number; props: any }) {
  const items: string[] = props.items || ["SMART HOME"];
  const text = items.join("  •  ") + "  •  ";
  const speed = props.speed || 9;
  const offset = frame * speed;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: props.y ?? 150, background: C.ink, color: C.bg, overflow: "hidden", padding: "16px 0", fontSize: 26, letterSpacing: 6, fontFamily: '"Microsoft YaHei", Arial, sans-serif', fontWeight: 700 }}>
      <div style={{ display: "flex", whiteSpace: "nowrap", transform: `translateX(${-offset}px)` }}>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((k) => <span key={k}>{text.repeat(2)}</span>)}
      </div>
    </div>
  );
}

// 8. splitDiag — 对角双色块对向滑入（全新元素）
function SplitDiagEl({ frame, props }: { frame: number; props: any }) {
  const t1 = clamp(frame / 26);
  const t2 = clamp((frame - 8) / 26);
  const o1 = interpolate(t1, [0, 1], [-1300, 0]);
  const o2 = interpolate(t2, [0, 1], [1500, 0]);
  return (
    <g>
      <path d={`M 0 ${640 + o1} L 1920 ${400 + o1} L 1920 1080 L 0 1080 Z`} fill={C.orange} opacity={0.16} />
      <path d={`M 0 ${770 + o2} L 1920 ${530 + o2} L 1920 1080 L 0 1080 Z`} fill={C.teal} opacity={0.14} />
    </g>
  );
}

// 9. finaleBlock — 满屏橙色色块 + 白色品牌字 spring 弹入（classic 的 brandEnd 是暗底居中衬线）
function FinaleBlockEl({ frame, props }: { frame: number; props: any }) {
  const grow = clamp(frame / 22);
  const pop = spring({ frame: Math.max(0, frame - 8), fps: 30, config: { damping: 15 } });
  return (
    <div style={{ position: "absolute", inset: 0, background: C.orange, opacity: grow, display: "grid", placeItems: "center" }}>
      <div style={{ textAlign: "center", transform: `scale(${0.9 + pop * 0.1})`, opacity: clamp(pop * 2) }}>
        <div style={{ color: "#fff", opacity: 0.85, fontSize: 26, letterSpacing: 12, fontWeight: 700, fontFamily: "Arial, sans-serif" }}>{props.brand || ""}</div>
        <div style={{ color: "#fff", fontSize: 112, fontWeight: 900, letterSpacing: 8, fontFamily: '"Microsoft YaHei", sans-serif', marginTop: 26 }}>{props.heading || ""}</div>
        <div style={{ width: 220, height: 6, background: "#fff", margin: "34px auto 0", opacity: 0.9 }} />
        <div style={{ color: "#fff", opacity: 0.8, fontSize: 22, letterSpacing: 6, marginTop: 30, fontFamily: "Arial, sans-serif" }}>{props.subtext || ""}</div>
      </div>
    </div>
  );
}

const RENDERERS: Record<string, React.FC<{ frame: number; props: any }>> = {
  kicker: KickerEl, caption: CaptionEl, phoneMock: PhoneMockEl, statBlock: StatBlockEl,
  waveBars: WaveBarsEl, radarRings: RadarRingsEl, marquee: MarqueeEl, splitDiag: SplitDiagEl,
  finaleBlock: FinaleBlockEl,
};

const SVG_TYPES = new Set(["phoneMock", "waveBars", "radarRings", "splitDiag"]);

function SceneEl({ scene, localFrame }: { scene: SceneConfig; localFrame: number }) {
  return (
    <AbsoluteFill>
      <Background frame={localFrame} />
      <svg viewBox="0 0 1920 1080" width="100%" height="100%" style={{ position: "absolute", inset: 0, display: "block" }}>
        {scene.elements.map((el, i) => { const R = RENDERERS[el.type]; return R !== undefined && SVG_TYPES.has(el.type) ? <R key={i} frame={localFrame} props={el.props ?? el} /> : null; })}
      </svg>
      {scene.elements.map((el, i) => { const R = RENDERERS[el.type]; return R !== undefined && !SVG_TYPES.has(el.type) ? <R key={i} frame={localFrame} props={el.props ?? el} /> : null; })}
    </AbsoluteFill>
  );
}

function VoiceTrack({ src, from, duration }: { src: string; from: number; duration: number }) {
  const frame = useCurrentFrame();
  const local = frame - from;
  const volume = interpolate(local, [0, 8, duration - 12, duration], [0, 0.9, 0.9, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <Sequence from={from} durationInFrames={duration} name={"voice-" + src}><Audio src={staticFile("voice/" + src)} volume={volume} /></Sequence>;
}

function computeTimeline(scenes: SceneConfig[]): { name: string; from: number; durationInFrames: number }[] {
  let cursor = 0;
  return scenes.map((scene, i) => { const from = i === 0 ? 0 : cursor - (scenes[i - 1].overlap || 0); cursor = from + scene.durationInFrames; return { name: scene.name, from, durationInFrames: scene.durationInFrames }; });
}

export const Film: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timeline = computeTimeline(config.scenes);
  const voiceTracks = config.voice.enabled ? config.voice.tracks.map((track, i) => {
    const st = timeline.find((t) => t.name === track.scene);
    return { file: String(i + 1).padStart(2, "0") + "-" + track.scene + ".wav", from: st ? st.from : 0, duration: st ? Math.max(30, st.durationInFrames - 15) : 60 };
  }) : [];
  return (
    <AbsoluteFill style={{ background: C.bg, overflow: "hidden" }}>
      {timeline.map((t, i) => <Sequence key={t.name} from={t.from} durationInFrames={t.durationInFrames} name={t.name}><SceneEl scene={config.scenes[i]} localFrame={frame - t.from} /></Sequence>)}
      {voiceTracks.map((v) => <VoiceTrack key={v.file} src={v.file} from={v.from} duration={v.duration} />)}
    </AbsoluteFill>
  );
};
