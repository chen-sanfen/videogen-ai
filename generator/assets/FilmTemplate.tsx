import React from "react";
import { AbsoluteFill, Audio, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { config, FilmConfig, SceneConfig, ElementConfig } from "../config";

const C = config.theme;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const fade = (frame: number, a: number, b: number) => interpolate(frame, [a, a + 16, b - 16, b], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

function Background({ frame }: { frame: number }) {
  const drift = Math.sin(frame / 42) * 24;
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at ${54 + drift / 20}% 32%, ${C.glow1 || "rgba(115,92,255,.18)"}, transparent 30%), radial-gradient(circle at 80% 78%, ${C.glow2 || "rgba(44,167,217,.10)"}, transparent 29%)` }} />
      <div style={{ position: "absolute", inset: 0, opacity: 0.18, backgroundImage: "linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px)", backgroundSize: "48px 48px" }} />
    </AbsoluteFill>
  );
}

function WindowChrome({ title, x, y, w, h, children, accent }: { title: string; x: number; y: number; w: number; h: number; children: React.ReactNode; accent?: string }) {
  const a = accent || C.line;
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={w} height={h} rx="18" fill={C.panel} stroke={a} strokeWidth="2" />
      <rect width={w} height="48" rx="18" fill="#151821" />
      <rect y="32" width={w} height="16" fill="#151821" />
      <circle cx="23" cy="24" r="6" fill="#ff7770" /><circle cx="44" cy="24" r="6" fill="#ffca6a" /><circle cx="65" cy="24" r="6" fill="#62d497" />
      <text x="92" y="29" fill={C.muted} fontSize="16" fontFamily="Arial, sans-serif">{title}</text>
      {children}
    </g>
  );
}

function TitleEl({ frame, props }: { frame: number; props: any }) {
  const p = clamp(frame / (props.duration || 120));
  const lift = interpolate(p, [0, 1], [34, 0]);
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
      <div style={{ transform: `translateY(${lift}px)`, opacity: p }}>
        <div style={{ color: C.muted, fontSize: 17, letterSpacing: 5, textAlign: "center", marginBottom: 22 }}>{props.eyebrow || "FROM A THOUGHT"}</div>
        <div style={{ color: C.text, fontSize: props.fontSize || 60, letterSpacing: 2, fontFamily: props.fontFamily || 'Georgia, "Microsoft YaHei", serif', textAlign: "center" }}>{props.text || ""}</div>
        {props.accentBar !== false && <div style={{ margin: "32px auto 0", width: 500, height: 8, borderRadius: 4, background: `linear-gradient(90deg, transparent, ${C.purple}, transparent)`, opacity: 0.7 }} />}
      </div>
    </div>
  );
}

function SubtitleEl({ frame, props }: { frame: number; props: any }) {
  return <div style={{ position: "absolute", left: "50%", bottom: 74, transform: "translateX(-50%)", opacity: fade(frame, props.start || 0, props.end || 120), color: props.dark ? "#202228" : C.text, fontFamily: 'Arial, "Microsoft YaHei", sans-serif', fontSize: props.fontSize || 30, letterSpacing: 4, whiteSpace: "nowrap", textShadow: props.dark ? "none" : "0 3px 24px rgba(0,0,0,.55)" }}>{props.text || ""}</div>;
}

function CodeWindowEl({ frame, props }: { frame: number; props: any }) {
  const lines = props.lines || [];
  const reveal = clamp((frame + 12) / 52);
  const w = props.w || 650, h = props.h || 560;
  return (
    <WindowChrome title={props.title || "workspace"} x={props.x || 230} y={props.y || 190} w={w} h={h} accent={props.accent}>
      <rect x="0" y="48" width="62" height={h - 48} fill="#101219" />
      <rect x="62" y="48" width={w - 62} height={h - 48} fill="#0d0f15" />
      {lines.map((line: string, i: number) => {
        const alpha = clamp(reveal * 1.7 - i * 0.12);
        const ly = 88 + i * 42;
        const isAdded = line.startsWith("+");
        const isRemoved = line.startsWith("-");
        const lc = isAdded ? C.green : isRemoved ? C.orange : i === 0 ? C.purple : i === 3 ? C.orange : i === 4 ? C.blue : C.text;
        return <g key={i} opacity={alpha}><text x="85" y={ly} fill="#5f6779" fontSize="16" fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace">{String(i + 1).padStart(2, "0")}</text><text x="125" y={ly} fill={lc} fontSize="17" fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace">{line}</text></g>;
      })}
      <rect x="84" y="370" width={interpolate(frame, [0, 42], [0, 350], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} height="3" rx="2" fill={C.purple} opacity="0.8" />
    </WindowChrome>
  );
}

function AgentPanelEl({ frame, props }: { frame: number; props: any }) {
  const p = clamp((frame - 10) / 70);
  const pulse = 0.92 + Math.sin(frame / 13) * 0.04;
  const w = props.w || 570, h = props.h || 560;
  const files = props.files || [];
  return (
    <WindowChrome title={props.title || "Agent"} x={props.x || 1060} y={props.y || 190} w={w} h={h} accent="rgba(155,140,255,.38)">
      <rect x="26" y="74" width={w - 52} height="128" rx="12" fill="#1c1a2b" stroke="rgba(155,140,255,.38)" />
      <circle cx="57" cy="108" r="15" fill="rgba(155,140,255,.3)" /><path d="M50 108h14M57 101v14" stroke={C.purple} strokeWidth="2" />
      <text x="88" y="111" fill={C.text} fontSize="17" fontFamily="Arial, sans-serif">{props.request || ""}</text>
      <text x="52" y="153" fill={C.muted} fontSize="14" fontFamily="Arial, sans-serif">{props.subtext || ""}</text>
      <g opacity={clamp(p * 1.3)}>
        <circle cx="53" cy="238" r="11" fill="rgba(117,225,160,.2)" /><path d="M47 238l4 4 8-10" stroke={C.green} strokeWidth="3" fill="none" />
        <text x="83" y="244" fill={C.green} fontSize="16" fontFamily="Arial, sans-serif">{props.status || "Reading codebase"}</text>
        <rect x="52" y="270" width="420" height="7" rx="3" fill="#292c38" /><rect x="52" y="270" width={420 * clamp(p)} height="7" rx="3" fill={C.purple} />
        {files.map((f: string, i: number) => <text key={i} x="52" y={394 + i * 32} fill={C.text} fontSize="15" fontFamily="ui-monospace, monospace">{f}</text>)}
      </g>
      <circle cx={w - 72} cy="108" r={10 * pulse} fill={C.green} opacity="0.84" />
    </WindowChrome>
  );
}

function PreviewCardEl({ frame, props }: { frame: number; props: any }) {
  const p = clamp((frame - 10) / 75);
  const scale = interpolate(p, [0, 1], [0.86, 1]);
  return (
    <g transform={`translate(${props.x || 1030} ${props.y || 270}) scale(${scale})`} opacity={p}>
      <rect width="675" height="440" rx="22" fill="#f4f1ea" stroke="#d6d1c7" strokeWidth="3" />
      <rect width="675" height="55" rx="22" fill="#fffdf8" /><rect y="36" width="675" height="19" fill="#fffdf8" />
      <circle cx="28" cy="27" r="6" fill="#e79c90" /><circle cx="49" cy="27" r="6" fill="#e6c16f" /><circle cx="70" cy="27" r="6" fill="#9ac59d" />
      <rect x="118" y="17" width="400" height="22" rx="11" fill="#eee9df" />
      <rect x="50" y="108" width="575" height="88" rx="16" fill="#ded5f5" />
      <text x="82" y="157" fill="#413b65" fontSize="28" fontFamily="Georgia, serif">{props.heading || ""}</text>
      <rect x="50" y="232" width="270" height="18" rx="9" fill="#b8b0c7" />
      <rect x="50" y="267" width="420" height="12" rx="6" fill="#d7d0db" />
      <rect x="50" y="293" width="370" height="12" rx="6" fill="#d7d0db" />
      <rect x="50" y="342" width="156" height="46" rx="23" fill="#4f456e" />
      <text x="91" y="371" fill="#fff" fontSize="16" fontFamily="Arial, sans-serif">{props.button || "Begin"}</text>
      <text x="487" y="372" fill="#82798b" fontSize="15" fontFamily="Arial, sans-serif">{props.eyebrow || ""}</text>
    </g>
  );
}

function CodeFlowEl({ frame, props }: { frame: number; props: any }) {
  const offset = (frame * (props.speed || 5)) % 52;
  const count = props.count || 8;
  return (
    <g opacity="0.92">
      {Array.from({ length: count }).map((_, i) => {
        const y = 190 + i * 57 - offset;
        const width = 170 + ((i * 53) % 230);
        return <g key={i} opacity={i % 3 === 0 ? 0.95 : 0.62}>
          <rect x={200 + (i % 2) * 42} y={y} width={width} height="8" rx="4" fill={i % 3 === 0 ? C.purple : i % 3 === 1 ? C.blue : C.green} />
          <rect x={200 + width + (i % 2) * 42 + 24} y={y} width={85 + i * 8} height="8" rx="4" fill="#414756" />
        </g>;
      })}
    </g>
  );
}

function ParticlesEl({ frame, props }: { frame: number; props: any }) {
  const p = clamp(frame / (props.duration || 140));
  const burst = interpolate(p, [0, 0.5, 1], [0, 1, 0.35]);
  const count = props.count || 18;
  const cx = props.cx || 1365, cy = props.cy || 490, r = props.radius || 260;
  return (
    <g opacity={burst}>
      {Array.from({ length: count }).map((_, i) => {
        const angle = (i / count) * Math.PI * 2;
        const radius = r + Math.sin(frame / 20 + i) * 20;
        return <circle key={i} cx={cx + Math.cos(angle) * radius} cy={cy + Math.sin(angle) * radius} r="3" fill={i % 2 ? C.blue : C.purple} />;
      })}
    </g>
  );
}

function CalloutEl({ frame, props }: { frame: number; props: any }) {
  const p = clamp(frame / (props.duration || 150));
  return <div style={{ position: "absolute", left: "50%", top: props.top || 90, transform: "translateX(-50%)", color: C.text, fontSize: props.fontSize || 27, letterSpacing: 3, opacity: p }}>{props.text || ""}</div>;
}

function BrandEndEl({ frame, props }: { frame: number; props: any }) {
  const p = clamp(frame / (props.duration || 115));
  const scale = spring({ frame, fps: 30, config: { damping: 18, stiffness: 80 } });
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center", opacity: p, transform: `scale(${0.94 + scale * 0.06})` }}>
      <div>
        <div style={{ color: C.muted, fontSize: 16, letterSpacing: 6, marginBottom: 24 }}>{props.brand || ""}</div>
        <div style={{ color: C.text, fontSize: 74, letterSpacing: 5, fontFamily: 'Georgia, "Microsoft YaHei", serif' }}>{props.heading || ""}</div>
        <div style={{ color: C.muted, fontSize: 21, letterSpacing: 3, marginTop: 28 }}>{props.subtext || ""}</div>
        <div style={{ margin: "36px auto 0", width: 170, height: 5, borderRadius: 3, background: `linear-gradient(90deg, ${C.purple}, ${C.blue})` }} />
      </div>
    </div>
  );
}

const RENDERERS: Record<string, React.FC<{ frame: number; props: any }>> = {
  title: TitleEl, subtitle: SubtitleEl, codeWindow: CodeWindowEl, agentPanel: AgentPanelEl,
  previewCard: PreviewCardEl, codeFlow: CodeFlowEl, particles: ParticlesEl,
  callout: CalloutEl, brandEnd: BrandEndEl,
};

const SVG_TYPES = new Set(["codeWindow", "agentPanel", "previewCard", "codeFlow", "particles"]);

function SceneEl({ scene, localFrame }: { scene: SceneConfig; localFrame: number }) {
  return (
    <AbsoluteFill>
      <Background frame={localFrame} />
      <svg viewBox={`0 0 ${config.width} ${config.height}`} width="100%" height="100%" style={{ position: "absolute", inset: 0, display: "block" }}>
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

export function computeTimeline(scenes: SceneConfig[]): { name: string; from: number; durationInFrames: number }[] {
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
      {config.title && <div style={{ position: "absolute", left: 44, top: 32, color: "rgba(244,244,246,.46)", fontSize: 13, letterSpacing: 3, fontFamily: "Arial, sans-serif" }}>{config.title}</div>}
      <div style={{ position: "absolute", right: 44, top: 32, color: "rgba(244,244,246,.38)", fontSize: 13, letterSpacing: 2, fontFamily: "Arial, sans-serif" }}>{String(Math.floor(frame / fps / 60)).padStart(2, "0")}:{String(Math.floor((frame / fps) % 60)).padStart(2, "0")}</div>
    </AbsoluteFill>
  );
};
