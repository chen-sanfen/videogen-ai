import React from 'react';
import { AbsoluteFill, Audio, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

const C = { bg: '#08090d', panel: '#11131a', panel2: '#171a23', line: '#282c38', text: '#f4f4f6', muted: '#8d93a3', purple: '#9b8cff', blue: '#6dd8ff', green: '#75e1a0', orange: '#ffbd7c', pink: '#f59ee1' };
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const fade = (frame: number, a: number, b: number) => interpolate(frame, [a, a + 16, b - 16, b], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

function Background({ frame }: { frame: number }) {
  const drift = Math.sin(frame / 42) * 24;
  return <AbsoluteFill style={{ background: C.bg }}>
    <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(circle at ${54 + drift / 20}% 32%, rgba(115,92,255,.18), transparent 30%), radial-gradient(circle at 80% 78%, rgba(44,167,217,.10), transparent 29%)` }} />
    <div style={{ position: 'absolute', inset: 0, opacity: .18, backgroundImage: 'linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px)', backgroundSize: '48px 48px' }} />
  </AbsoluteFill>;
}

function WindowChrome({ title, x, y, w, h, children }: { title: string; x: number; y: number; w: number; h: number; children: React.ReactNode }) {
  return <g transform={`translate(${x} ${y})`}>
    <rect width={w} height={h} rx="18" fill={C.panel} stroke={C.line} strokeWidth="2" />
    <rect width={w} height="48" rx="18" fill="#151821" />
    <rect y="32" width={w} height="16" fill="#151821" />
    <circle cx="23" cy="24" r="6" fill="#ff7770" /><circle cx="44" cy="24" r="6" fill="#ffca6a" /><circle cx="65" cy="24" r="6" fill="#62d497" />
    <text x="92" y="29" fill={C.muted} fontSize="16" fontFamily="Arial, sans-serif">{title}</text>
    {children}
  </g>;
}

function CodePanel({ frame, compact = false }: { frame: number; compact?: boolean }) {
  const lines = compact ? ['export default function App() {', '  return <Workspace />;', '}'] : ['import { Agent } from "cursor";', '', 'export default function Workspace() {', '  const [idea, setIdea] = useState("");', '  return <ProductCanvas idea={idea} />;', '}'];
  const reveal = clamp((frame + 12) / 52);
  return <g>
    <rect x="0" y="48" width="62" height="402" fill="#101219" />
    {[0, 1, 2, 3].map((n) => <rect key={n} x="21" y={82 + n * 48} width="20" height="20" rx="5" fill={n === 1 ? 'rgba(155,140,255,.38)' : '#242936'} />)}
    <rect x="62" y="48" width="450" height="402" fill="#0d0f15" />
    {lines.map((line, i) => {
      const alpha = clamp(reveal * 1.7 - i * .12);
      const y = 88 + i * 42;
      return <g key={i} opacity={alpha}>
        <text x="85" y={y} fill="#5f6779" fontSize="16" fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace">{String(i + 1).padStart(2, '0')}</text>
        <text x="125" y={y} fill={i === 0 ? C.purple : i === 3 ? C.orange : i === 4 ? C.blue : C.text} fontSize="17" fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace">{line}</text>
      </g>;
    })}
    <rect x="84" y="370" width={interpolate(frame, [0, 42], [0, 350], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })} height="3" rx="2" fill={C.purple} opacity=".8" />
  </g>;
}

function AgentPanel({ frame }: { frame: number }) {
  const p = clamp((frame - 10) / 70);
  const pulse = .92 + Math.sin(frame / 13) * .04;
  return <WindowChrome title="Agent · workspace" x={1060} y={190} w={570} h={560}>
    <rect x="26" y="74" width="518" height="128" rx="12" fill="#1c1a2b" stroke="rgba(155,140,255,.38)" />
    <circle cx="57" cy="108" r="15" fill="rgba(155,140,255,.3)" /><path d="M50 108h14M57 101v14" stroke={C.purple} strokeWidth="2" />
    <text x="88" y="111" fill={C.text} fontSize="17" fontFamily="Arial, sans-serif">Build a calm focus dashboard</text>
    <text x="52" y="153" fill={C.muted} fontSize="14" fontFamily="Arial, sans-serif">with a timer, daily goal, and a soft visual rhythm.</text>
    <g opacity={clamp(p * 1.3)}>
      <circle cx="53" cy="238" r="11" fill="rgba(117,225,160,.2)" /><path d="M47 238l4 4 8-10" stroke={C.green} strokeWidth="3" fill="none" />
      <text x="83" y="244" fill={C.green} fontSize="16" fontFamily="Arial, sans-serif">Reading codebase</text>
      <rect x="52" y="270" width="420" height="7" rx="3" fill="#292c38" /><rect x="52" y="270" width={420 * clamp(p)} height="7" rx="3" fill={C.purple} />
      <text x="52" y="315" fill={C.muted} fontSize="14" fontFamily="Arial, sans-serif">Editing 3 files · checking the result</text>
      <rect x="52" y="350" width="466" height="1" fill={C.line} />
      <text x="52" y="394" fill={C.text} fontSize="15" fontFamily="ui-monospace, monospace">+ src/components/FocusCard.tsx</text>
      <text x="52" y="426" fill={C.text} fontSize="15" fontFamily="ui-monospace, monospace">+ src/styles/theme.css</text>
      <text x="52" y="458" fill={C.text} fontSize="15" fontFamily="ui-monospace, monospace">✓ npm test passed</text>
    </g>
    <circle cx="498" cy="108" r={10 * pulse} fill={C.green} opacity=".84" />
  </WindowChrome>;
}

function PreviewCard({ frame }: { frame: number }) {
  const p = clamp((frame - 10) / 75);
  const scale = interpolate(p, [0, 1], [.86, 1]);
  return <g transform={`translate(1030 270) scale(${scale})`} opacity={p}>
    <rect width="675" height="440" rx="22" fill="#f4f1ea" stroke="#d6d1c7" strokeWidth="3" />
    <rect width="675" height="55" rx="22" fill="#fffdf8" /><rect y="36" width="675" height="19" fill="#fffdf8" />
    <circle cx="28" cy="27" r="6" fill="#e79c90" /><circle cx="49" cy="27" r="6" fill="#e6c16f" /><circle cx="70" cy="27" r="6" fill="#9ac59d" />
    <rect x="118" y="17" width="400" height="22" rx="11" fill="#eee9df" />
    <rect x="50" y="108" width="575" height="88" rx="16" fill="#ded5f5" />
    <text x="82" y="157" fill="#413b65" fontSize="28" fontFamily="Georgia, serif">Your calm starts here.</text>
    <rect x="50" y="232" width="270" height="18" rx="9" fill="#b8b0c7" /><rect x="50" y="267" width="420" height="12" rx="6" fill="#d7d0db" /><rect x="50" y="293" width="370" height="12" rx="6" fill="#d7d0db" />
    <rect x="50" y="342" width="156" height="46" rx="23" fill="#4f456e" /><text x="91" y="371" fill="#fff" fontSize="16" fontFamily="Arial, sans-serif">Begin</text>
    <text x="487" y="372" fill="#82798b" fontSize="15" fontFamily="Arial, sans-serif">preview ready</text>
  </g>;
}

function CodeFlow({ frame }: { frame: number }) {
  const offset = (frame * 5) % 52;
  return <g opacity=".92">
    {Array.from({ length: 8 }).map((_, i) => {
      const y = 190 + i * 57 - offset;
      const width = 170 + ((i * 53) % 230);
      return <g key={i} opacity={i % 3 === 0 ? .95 : .62}>
        <rect x={200 + (i % 2) * 42} y={y} width={width} height="8" rx="4" fill={i % 3 === 0 ? C.purple : i % 3 === 1 ? C.blue : C.green} />
        <rect x={200 + width + (i % 2) * 42 + 24} y={y} width={85 + i * 8} height="8" rx="4" fill="#414756" />
      </g>;
    })}
  </g>;
}

function Subtitle({ children, frame, start, end, dark = false }: { children: React.ReactNode; frame: number; start: number; end: number; dark?: boolean }) {
  return <div style={{ position: 'absolute', left: '50%', bottom: 74, transform: 'translateX(-50%)', opacity: fade(frame, start, end), color: dark ? '#202228' : C.text, fontFamily: 'Arial, "Microsoft YaHei", sans-serif', fontSize: 30, letterSpacing: 4, whiteSpace: 'nowrap', textShadow: dark ? 'none' : '0 3px 24px rgba(0,0,0,.55)' }}>{children}</div>;
}

function SceneIdea({ frame }: { frame: number }) {
  const p = clamp(frame / 120);
  return <AbsoluteFill><Background frame={frame} /><div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}><div style={{ transform: "translateY(" + interpolate(p, [0, 1], [34, 0]) + "px)", opacity: p }}><div style={{ color: C.muted, fontSize: 17, letterSpacing: 5, textAlign: "center", marginBottom: 22 }}>FROM A THOUGHT</div><div style={{ color: C.text, fontSize: 60, letterSpacing: 2, fontFamily: "Georgia, Microsoft YaHei, serif", textAlign: "center" }}>“Build a calm place to focus.”</div><div style={{ margin: "32px auto 0", width: 500, height: 8, borderRadius: 4, background: "linear-gradient(90deg, transparent, #9b8cff, transparent)", opacity: 0.7 }} /></div></div><Subtitle frame={frame} start={20} end={110}>从一个想法开始</Subtitle></AbsoluteFill>;
}

function SceneAgent({ frame }: { frame: number }) {
  const p = clamp(frame / 150);
  return <AbsoluteFill><Background frame={frame} /><svg viewBox="0 0 1920 1080" width="100%" height="100%" style={{ position: 'absolute', inset: 0, display: 'block' }}><WindowChrome title="focus-dashboard · workspace" x={230} y={190} w={650} h={560}><CodePanel frame={frame} /><rect x="62" y="450" width="450" height="64" fill="#11141b" /><text x="84" y="489" fill={C.green} fontSize="16" fontFamily="ui-monospace, monospace">✓ Ready for the next idea</text></WindowChrome><AgentPanel frame={frame} /></svg><div style={{ position: 'absolute', left: '50%', top: 90, transform: 'translateX(-50%)', color: C.text, fontSize: 27, letterSpacing: 3, opacity: p }}>Agent understands the work.</div><Subtitle frame={frame} start={30} end={135}>Agent 理解代码库，帮你完成工作</Subtitle></AbsoluteFill>;
}

function SceneEdit({ frame }: { frame: number }) {
  const p = clamp(frame / 135);
  const scan = interpolate(p, [0, 1], [0, 1]);
  return <AbsoluteFill><Background frame={frame} /><svg viewBox="0 0 1920 1080" width="100%" height="100%" style={{ position: 'absolute', inset: 0, display: 'block' }}><WindowChrome title="src/components/FocusCard.tsx" x={310} y={152} w={1300} h={660}><CodePanel frame={frame + 32} /><rect x="710" y="120" width={670 * scan} height="4" fill={C.purple} opacity=".9" /><rect x="710" y="182" width="430" height="18" rx="9" fill="#242936" /><rect x="710" y="220" width="580" height="13" rx="6" fill="#3d4250" /><rect x="710" y="257" width="520" height="13" rx="6" fill="#3d4250" /><rect x="710" y="294" width="370" height="13" rx="6" fill="#3d4250" /><rect x="710" y="342" width="470" height="154" rx="16" fill="rgba(117,225,160,.08)" stroke="rgba(117,225,160,.4)" /><text x="742" y="390" fill={C.green} fontSize="18" fontFamily="ui-monospace, monospace">Applied across files</text><text x="742" y="430" fill={C.muted} fontSize="15" fontFamily="Arial, sans-serif">Review the diff. Keep what matters.</text></WindowChrome></svg><div style={{ position: 'absolute', left: '50%', top: 54, transform: 'translateX(-50%)', color: C.muted, fontSize: 16, letterSpacing: 4 }}>EDIT · REVIEW · ITERATE</div><Subtitle frame={frame} start={24} end={120}>快速编辑，清晰审查，每一次迭代都在你掌控中</Subtitle></AbsoluteFill>;
}

function ScenePreview({ frame }: { frame: number }) {
  const p = clamp(frame / 140);
  const burst = interpolate(p, [0, .5, 1], [0, 1, .35]);
  return <AbsoluteFill><Background frame={frame} /><svg viewBox="0 0 1920 1080" width="100%" height="100%" style={{ position: 'absolute', inset: 0, display: 'block' }}><CodeFlow frame={frame} /><PreviewCard frame={frame} /><g opacity={burst}>{Array.from({ length: 18 }).map((_, i) => { const a = i / 18 * Math.PI * 2; const r = 260 + Math.sin(frame / 20 + i) * 20; return <circle key={i} cx={1365 + Math.cos(a) * r} cy={490 + Math.sin(a) * r} r="3" fill={i % 2 ? C.blue : C.purple} />; })}</g></svg><div style={{ position: 'absolute', left: 190, top: 430, color: C.text, fontSize: 42, lineHeight: 1.35, fontFamily: 'Georgia, "Microsoft YaHei", serif' }}>See the idea<br /><span style={{ color: C.purple }}>come alive.</span></div><Subtitle frame={frame} start={24} end={124}>即时预览，让想法变成看得见的结果</Subtitle></AbsoluteFill>;
}

function SceneEnd({ frame }: { frame: number }) {
  const p = clamp(frame / 115);
  const scale = spring({ frame, fps: 30, config: { damping: 18, stiffness: 80 } });
  return <AbsoluteFill><Background frame={frame} /><div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', opacity: p, transform: `scale(${.94 + scale * .06})` }}><div><div style={{ color: C.muted, fontSize: 16, letterSpacing: 6, marginBottom: 24 }}>CURSOR</div><div style={{ color: C.text, fontSize: 74, letterSpacing: 5, fontFamily: 'Georgia, "Microsoft YaHei", serif' }}>Make it real.</div><div style={{ color: C.muted, fontSize: 21, letterSpacing: 3, marginTop: 28 }}>从想法到代码，始终更接近你的意图</div><div style={{ margin: '36px auto 0', width: 170, height: 5, borderRadius: 3, background: `linear-gradient(90deg, ${C.purple}, ${C.blue})` }} /></div></div><Subtitle frame={frame} start={15} end={100}>Cursor，让你专注于创造</Subtitle></AbsoluteFill>;
}

function VoiceTrack({ src, from, duration }: { src: string; from: number; duration: number }) {
  const frame = useCurrentFrame();
  const local = frame - from;
  const volume = interpolate(local, [0, 8, duration - 12, duration], [0, 0.9, 0.9, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <Sequence from={from} durationInFrames={duration} name={'voice-' + src}><Audio src={staticFile('voice/' + src)} volume={volume} /></Sequence>;
}

export const CursorProductFilm: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <AbsoluteFill style={{ background: C.bg, overflow: 'hidden' }}>
    <Sequence from={0} durationInFrames={120} name="idea"><SceneIdea frame={frame} /></Sequence>
    <Sequence from={105} durationInFrames={150} name="agent"><SceneAgent frame={frame - 105} /></Sequence>
    <Sequence from={240} durationInFrames={135} name="edit"><SceneEdit frame={frame - 240} /></Sequence>
    <Sequence from={360} durationInFrames={140} name="preview"><ScenePreview frame={frame - 360} /></Sequence>
    <Sequence from={480} durationInFrames={120} name="end"><SceneEnd frame={frame - 480} /></Sequence>
    <VoiceTrack src="01-idea.wav" from={0} duration={105} />
    <VoiceTrack src="02-agent.wav" from={105} duration={135} />
    <VoiceTrack src="03-edit.wav" from={240} duration={120} />
    <VoiceTrack src="04-preview.wav" from={360} duration={120} />
    <VoiceTrack src="05-end.wav" from={480} duration={90} />
    <div style={{ position: 'absolute', left: 44, top: 32, color: 'rgba(244,244,246,.46)', fontSize: 13, letterSpacing: 3, fontFamily: 'Arial, sans-serif' }}>CURSOR / PRODUCT FILM</div>
    <div style={{ position: 'absolute', right: 44, top: 32, color: 'rgba(244,244,246,.38)', fontSize: 13, letterSpacing: 2, fontFamily: 'Arial, sans-serif' }}>{String(Math.floor(frame / fps / 60)).padStart(2, '0')}:{String(Math.floor((frame / fps) % 60)).padStart(2, '0')}</div>
  </AbsoluteFill>;
};
