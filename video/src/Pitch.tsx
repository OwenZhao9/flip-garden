import { AbsoluteFill, Audio, Easing, Img, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CSSProperties, ReactNode } from 'react';
import scenes from './pitch.json';
import { Phone, PhoneVid, PHONE_H, PHONE_W } from './Phone';

export const pitchFrames = scenes.reduce((a, s) => a + s.frames, 0);
const GREEN = '#9be564', VIOLET = '#8b7cff', INK = '#14122a';
const font = 'Helvetica Neue, Arial, sans-serif';

export const useSpring = (delay = 0, damping = 14) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: f - delay, fps, config: { damping, stiffness: 120 } });
};

// A phone that enters with a spring and floats, placed by its visual box.
const FloatPhone = ({ rec, from = 0, zoom = 1, fx = 0.5, fy = 0.5, src = '', x, y, scale = 0.6, rot = 0, tilt = 0, delay = 0, scrollFrom = 0, scrollTo = 0, dur = 300 }: { rec?: string; from?: number; zoom?: number; fx?: number; fy?: number; src?: string; x: number; y: number; scale?: number; rot?: number; tilt?: number; delay?: number; scrollFrom?: number; scrollTo?: number; dur?: number }) => {
  const f = useCurrentFrame();
  const p = useSpring(delay, 13);
  const float = Math.sin((f + delay * 3) / 28) * 10;
  const sy = interpolate(f, [0, dur], [scrollFrom, scrollTo], { extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });
  return (
    <div style={{ position: 'absolute', left: x, top: y + (1 - p) * 700 + float, width: PHONE_W * scale, height: PHONE_H * scale, perspective: 1800, opacity: Math.min(1, p * 1.5) }}>
      <div style={{ transform: `rotateY(${tilt}deg) rotateZ(${rot}deg)`, transformStyle: 'preserve-3d', transformOrigin: 'center' }}>
        {rec ? <PhoneVid rec={rec} from={from} scale={scale} zoom={zoom} fx={fx} fy={fy} /> : <Phone src={src} scale={scale} scrollY={sy} />}
      </div>
    </div>
  );
};

const Word = ({ children, delay, color = 'white', size = 110 }: { children: ReactNode; delay: number; color?: string; size?: number }) => {
  const p = useSpring(delay, 12);
  return <span style={{ display: 'inline-block', marginRight: 28, color, fontSize: size, fontWeight: 800, opacity: p, transform: `translateY(${(1 - p) * 70}px) scale(${0.8 + 0.2 * p})` }}>{children}</span>;
};

export const Eyebrow = ({ children }: { children: ReactNode }) => {
  const p = useSpring(0);
  return <div style={{ color: GREEN, fontSize: 30, letterSpacing: 7, textTransform: 'uppercase', opacity: p, transform: `translateX(${(1 - p) * -40}px)` }}>{children}</div>;
};

const Sprout = ({ size = 260, delay = 0 }: { size?: number; delay?: number }) => {
  const f = useCurrentFrame() - delay;
  const g = interpolate(f, [0, 40], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const sway = Math.sin(f / 18) * 3;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ transform: `rotate(${sway}deg)`, transformOrigin: '50% 100%' }}>
      <path d="M50 95 C50 70 50 55 50 40" stroke={GREEN} strokeWidth="5" fill="none" strokeLinecap="round" strokeDasharray="60" strokeDashoffset={60 * (1 - g)} />
      <g opacity={g} transform={`translate(50 42) scale(${g}) translate(-50 -42)`}>
        <path d="M50 42 C30 42 22 28 24 16 C38 16 50 24 50 42Z" fill={GREEN} />
        <path d="M50 52 C70 52 80 38 78 26 C62 26 50 34 50 52Z" fill={VIOLET} />
      </g>
    </svg>
  );
};

export const Bg = () => {
  const f = useCurrentFrame();
  const dots = Array.from({ length: 28 }, (_, i) => i);
  return (
    <AbsoluteFill style={{ background: `radial-gradient(circle at ${60 + Math.sin(f / 90) * 15}% 40%, #2c2366 0%, ${INK} 55%, #07060f 100%)` }}>
      <svg width="1920" height="1080" style={{ position: 'absolute', opacity: 0.35 }}>
        {dots.map((i) => {
          const x = (i * 347) % 1920, y = ((i * 211 + f * (0.3 + (i % 5) * 0.15)) % 1200) - 60;
          return <circle key={i} cx={x} cy={1080 - y} r={2 + (i % 4)} fill={i % 3 ? VIOLET : GREEN} />;
        })}
      </svg>
    </AbsoluteFill>
  );
};

export const Subtitle = ({ s }: { s: (typeof scenes)[number] }) => {
  const f = useCurrentFrame();
  const words = s.text.split(' ');
  const per = 8;
  const prog = Math.min(1, f / (s.seconds * 30));
  const idx = Math.min(Math.floor((prog * words.length) / per), Math.ceil(words.length / per) - 1);
  const t = words.slice(idx * per, idx * per + per).join(' ');
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 56, display: 'flex', justifyContent: 'center' }}>
      <div style={{ maxWidth: 1500, background: 'rgba(8,6,20,.72)', color: 'white', fontSize: 40, padding: '14px 34px', borderRadius: 20, textAlign: 'center', fontFamily: font }}>{t}</div>
    </div>
  );
};

/* ---- Scenes ---- */
const S1 = () => (
  <>
    <div style={{ position: 'absolute', left: 120, top: 190 }}>
      <Eyebrow>Monad · Kuru</Eyebrow>
      <div style={{ marginTop: 30, width: 1000, lineHeight: 1.05 }}>
        <Word delay={6}>Liquidity</Word><Word delay={12}>that</Word><br /><Word delay={18} color={GREEN} size={150}>grows.</Word>
      </div>
      <div style={{ marginTop: 20 }}><Sprout delay={22} /></div>
    </div>
    <FloatPhone rec="tour45_s.mp4" from={8} x={1130} y={60} scale={0.62} tilt={-14} rot={4} delay={10} />
    <FloatPhone rec="tour45_s.mp4" from={0} x={1440} y={230} scale={0.5} tilt={-14} rot={8} delay={18} />
  </>
);

const S2 = () => {
  const f = useCurrentFrame();
  const items = ['Fills', 'Fees', 'Gas'];
  const q = useSpring(60, 8);
  return (
    <>
      <div style={{ position: 'absolute', left: 140, top: 150 }}><Eyebrow>The problem</Eyebrow></div>
      <div style={{ position: 'absolute', left: 140, top: 250, display: 'flex', gap: 40 }}>
        {items.map((t, i) => {
          const p = useSpring(14 + i * 14, 11);
          return <div key={t} style={{ opacity: p, transform: `translateY(${(1 - p) * 120}px) rotate(${(1 - p) * -8}deg)`, background: 'rgba(139,124,255,.18)', border: '2px solid #8b7cff', borderRadius: 28, padding: '34px 56px', color: 'white', fontSize: 70, fontWeight: 700 }}>{t}</div>;
        })}
      </div>
      <div style={{ position: 'absolute', left: 140, top: 520, fontSize: 340, fontWeight: 900, lineHeight: 1, color: GREEN, transform: `scale(${0.3 + 0.7 * q}) rotate(${Math.sin(f / 9) * 4}deg)`, opacity: q, transformOrigin: 'left center' }}>= ?</div>
      <div style={{ position: 'absolute', right: 150, top: 330, color: 'white', fontSize: 62, fontWeight: 700, width: 560, lineHeight: 1.15, opacity: useSpring(75) }}>What did you really earn?</div>
    </>
  );
};

const S3 = () => {
  const f = useCurrentFrame();
  const cyc = (f % 150) / 150;
  const filled = cyc > 0.4;
  const flip = interpolate(cyc, [0.4, 0.55], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <>
      <div style={{ position: 'absolute', left: 120, top: 150 }}><Eyebrow>Plant</Eyebrow></div>
      <div style={{ position: 'absolute', left: 120, top: 220, color: 'white', fontSize: 96, fontWeight: 800, width: 900, lineHeight: 1.05 }}>A few dollars.<br /><span style={{ color: GREEN }}>Flip orders.</span></div>
      <div style={{ position: 'absolute', left: 120, top: 520, display: 'flex', alignItems: 'center', gap: 36 }}>
        <div style={{ width: 280, padding: 30, borderRadius: 24, background: filled ? '#3d3010' : 'rgba(155,229,100,.18)', border: `3px solid ${filled ? '#ffc93c' : GREEN}`, color: 'white', fontSize: 40, fontWeight: 700 }}>BUY<div style={{ fontSize: 28, fontWeight: 500, color: '#c9c3ff' }}>{filled ? 'Filled' : 'Resting'}</div></div>
        <svg width="140" height="60"><path d="M5 30 H110 M90 10 L112 30 L90 50" stroke={filled ? '#ffc93c' : '#6a62a8'} strokeWidth="6" fill="none" strokeLinecap="round" /></svg>
        <div style={{ width: 280, padding: 30, borderRadius: 24, background: 'rgba(139,124,255,.2)', border: `3px dashed ${VIOLET}`, color: 'white', fontSize: 40, fontWeight: 700, opacity: 0.25 + 0.75 * flip, transform: `scale(${0.9 + 0.1 * flip})` }}>SELL<div style={{ fontSize: 28, fontWeight: 500, color: '#c9c3ff' }}>{flip > 0.5 ? 'Placed by itself' : 'Waiting'}</div></div>
      </div>
      <FloatPhone rec="real_s.mp4" from={86} x={1180} y={50} scale={0.62} tilt={12} rot={-3} />
    </>
  );
};

const S4 = () => {
  const f = useCurrentFrame();
  const draw = interpolate(f, [10, 90], [0, 1], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const L = 900;
  const up = 'M0 300 C100 280 150 200 250 220 S400 90 500 120 S700 60 800 40';
  const down = 'M0 100 C100 120 150 200 250 180 S400 310 500 280 S700 340 800 360';
  return (
    <>
      <div style={{ position: 'absolute', left: 120, top: 150 }}><Eyebrow>Hedge</Eyebrow></div>
      <div style={{ position: 'absolute', left: 120, top: 220, color: 'white', fontSize: 90, fontWeight: 800, lineHeight: 1.05 }}>Long MON<br />meets <span style={{ color: VIOLET }}>a short.</span></div>
      <svg width="900" height="420" viewBox="0 0 800 400" style={{ position: 'absolute', left: 120, top: 500 }}>
        <path d={up} stroke={GREEN} strokeWidth="7" fill="none" strokeLinecap="round" strokeDasharray={L} strokeDashoffset={L * (1 - draw) * 1.2} />
        <path d={down} stroke={VIOLET} strokeWidth="7" fill="none" strokeLinecap="round" strokeDasharray={L} strokeDashoffset={L * (1 - draw) * 1.2} />
        <line x1="0" y1="200" x2={800 * interpolate(f, [70, 120], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })} y2="200" stroke="white" strokeWidth="8" strokeDasharray="14 10" />
        <text x="10" y="40" fill={GREEN} fontSize="28" fontFamily={font}>MON inventory</text>
        <text x="10" y="390" fill={VIOLET} fontSize="28" fontFamily={font}>Short on Perpl</text>
      </svg>
      <FloatPhone rec="tour45_s.mp4" from={30} x={1200} y={50} scale={0.62} tilt={-12} rot={3} delay={6} />
    </>
  );
};

const chains = ['Base', 'Arbitrum', 'Ethereum', 'Optimism', 'Polygon'];
const S5 = () => {
  const f = useCurrentFrame();
  const pulse = (f % 45) / 45;
  return (
    <>
      <div style={{ position: 'absolute', left: 120, top: 150 }}><Eyebrow>Deposit · sign in</Eyebrow></div>
      <div style={{ position: 'absolute', left: 120, top: 220, color: 'white', fontSize: 90, fontWeight: 800, lineHeight: 1.05 }}>Any chain in.<br /><span style={{ color: GREEN }}>One passkey.</span></div>
      <svg width="1000" height="520" style={{ position: 'absolute', left: 90, top: 480 }}>
        {chains.map((c, i) => {
          const p = interpolate(f, [12 + i * 8, 70 + i * 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });
          const sx = 90 + i * 70, sy = 40 + (i % 2) * 70;
          const x = sx + (800 - sx) * p, y = sy + (260 - sy) * p - Math.sin(p * Math.PI) * 60;
          return <g key={c} opacity={1 - Math.max(0, p - 0.92) * 12} transform={`translate(${x} ${y})`}><rect x="-60" y="-24" width="120" height="48" rx="24" fill="rgba(139,124,255,.25)" stroke={VIOLET} strokeWidth="2" /><text textAnchor="middle" y="9" fill="white" fontSize="24" fontFamily={font}>{c}</text></g>;
        })}
        <circle cx="860" cy="260" r={70 + pulse * 40} fill="none" stroke={GREEN} strokeWidth="4" opacity={1 - pulse} />
        <circle cx="860" cy="260" r="64" fill={VIOLET} />
        <text x="860" y="270" textAnchor="middle" fill="white" fontSize="26" fontWeight="700" fontFamily={font}>Monad</text>
      </svg>
      <FloatPhone src="deposit.png" x={1200} y={50} scale={0.62} tilt={12} rot={-3} />
    </>
  );
};

const S6 = () => {
  const f = useCurrentFrame();
  const n = Math.round(interpolate(f, [20, 80], [0, 6], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  return (
    <>
      <FloatPhone rec="tour45_s.mp4" from={0} x={110} y={50} scale={0.62} tilt={12} rot={-2} />
      <FloatPhone rec="tour45_s.mp4" from={8.5} zoom={1.9} fx={0.5} fy={0.42} x={560} y={190} scale={0.5} tilt={12} rot={4} delay={14} />
      <div style={{ position: 'absolute', right: 130, top: 190, width: 760 }}>
        <Eyebrow>Ledger</Eyebrow>
        <div style={{ color: 'white', fontSize: 84, fontWeight: 800, lineHeight: 1.05, marginTop: 24 }}>Matches<br /><span style={{ color: GREEN }}>the chain.</span></div>
        <div style={{ marginTop: 40, display: 'flex', gap: 24 }}>
          {[['Checks', `${n}`], ['Difference', '0']].map(([k, v]) => (
            <div key={k} style={{ background: 'rgba(155,229,100,.14)', border: `2px solid ${GREEN}`, borderRadius: 24, padding: '20px 40px', color: 'white' }}>
              <div style={{ fontSize: 26, color: '#c9c3ff' }}>{k}</div><div style={{ fontSize: 110, fontWeight: 800, color: GREEN }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

const S7 = () => {
  const rows = ['0x39fd…da38', 'Join with an address'];
  return (
    <>
      <div style={{ position: 'absolute', left: 120, top: 140 }}><Eyebrow>Board · Gardener</Eyebrow></div>
      <div style={{ position: 'absolute', left: 120, top: 210 }}>
        {rows.map((r, i) => {
          const p = useSpring(10 + i * 10, 12);
          return <div key={r} style={{ opacity: p, transform: `translateX(${(1 - p) * -300}px)`, display: 'flex', gap: 30, alignItems: 'center', width: 760, margin: '0 0 20px', padding: '24px 34px', borderRadius: 24, background: i === 0 ? 'rgba(155,229,100,.18)' : 'rgba(139,124,255,.16)', border: `2px solid ${i === 0 ? GREEN : VIOLET}`, color: 'white', fontSize: 44, fontWeight: 700 }}><span style={{ color: GREEN, width: 60 }}>{i === 0 ? '#1' : '+'}</span>{r}<span style={{ marginLeft: 'auto', fontSize: 28, color: '#c9c3ff', fontWeight: 500 }}>{i === 0 ? 'round trips' : 'no signature'}</span></div>;
        })}
        {(() => { const p = useSpring(50, 12); return (
          <div style={{ marginTop: 40, opacity: p, transform: `scale(${0.85 + 0.15 * p})`, transformOrigin: 'left', width: 760, padding: 34, borderRadius: 28, background: 'rgba(8,6,20,.7)', border: `3px solid ${GREEN}`, color: 'white' }}>
            <div style={{ fontSize: 28, color: GREEN, letterSpacing: 4 }}>GARDENER MANDATE</div>
            <div style={{ fontSize: 56, fontWeight: 800, marginTop: 8 }}>Confirm once. It tends the rest.</div>
          </div>); })()}
      </div>
      <FloatPhone rec="tour45_s.mp4" from={39} x={1210} y={50} scale={0.62} tilt={-12} rot={3} delay={8} />
    </>
  );
};

const S8 = () => {
  const f = useCurrentFrame();
  return (
    <>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 150, textAlign: 'center' }}><div style={{ display: 'inline-block' }}><Eyebrow>Why Monad</Eyebrow></div></div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 230, textAlign: 'center', lineHeight: 1.05 }}>
        <Word delay={6} size={130}>Fast.</Word><Word delay={16} size={130} color={GREEN}>Cheap.</Word><Word delay={26} size={130} color={VIOLET}>Small.</Word>
      </div>
      <svg width="1920" height="300" style={{ position: 'absolute', top: 520 }}>
        {Array.from({ length: 16 }, (_, i) => {
          const x = ((i * 150 - f * 9) % 2400 + 2400) % 2400 - 240;
          return <g key={i} transform={`translate(${x} ${60 + (i % 3) * 14})`}><rect width="120" height="120" rx="22" fill={i % 2 ? 'rgba(139,124,255,.3)' : 'rgba(155,229,100,.28)'} stroke={i % 2 ? VIOLET : GREEN} strokeWidth="3" /><text x="60" y="70" textAnchor="middle" fill="white" fontSize="26" fontFamily={font}>block</text></g>;
        })}
      </svg>
    </>
  );
};

const S9 = () => {
  const p = useSpring(4, 10);
  return (
    <>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 120, display: 'flex', justifyContent: 'center', transform: `scale(${0.5 + 0.5 * p})`, opacity: p }}><Sprout size={320} /></div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 470, textAlign: 'center' }}>
        <Word delay={14} size={140}>Flip</Word><Word delay={20} size={140} color={GREEN}>Garden</Word>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 660, textAlign: 'center', color: '#c9c3ff', fontSize: 52, opacity: useSpring(38) }}>Plant. Grow. Hedge. Read the ledger.</div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 760, textAlign: 'center', color: 'white', fontSize: 44, opacity: useSpring(52) }}>owenzhao9.github.io/flip-garden</div>
    </>
  );
};

// The app's own 3D garden, cut from a phone recording of the Plant page.
const SG = () => {
  const f = useCurrentFrame();
  const p = useSpring(4, 14);
  return (
    <>
      <div style={{ position: 'absolute', left: 120, top: 150 }}><Eyebrow>The garden</Eyebrow></div>
      <div style={{ position: 'absolute', left: 120, top: 220, color: 'white', fontSize: 96, fontWeight: 800, width: 560, lineHeight: 1.05 }}>Your garden,<br /><span style={{ color: GREEN }}>in 3D.</span></div>
      <div style={{ position: 'absolute', right: 110, top: 120 + (1 - p) * 300, width: 1080, height: 700, borderRadius: 48, overflow: 'hidden', opacity: p, boxShadow: '0 40px 120px rgba(0,0,0,.6), inset 0 0 0 3px #3a3a4a', transform: `scale(${1 + f * 0.0004})` }}>
        <OffthreadVideo src={staticFile('broll/garden3d.mp4')} playbackRate={0.33} muted style={{ width: 1080, height: 700, objectFit: 'cover' }} />
      </div>
    </>
  );
};
const map: Record<string, () => JSX.Element> = { p3g: SG, p1: S1, p2: S2, p3: S3, p4: S4, p5: S5, p6: S6, p7: S7, p8: S8, p9: S9 };

const BROLL_SECONDS: Record<string, number> = { 'shot1.mp4': 6.6, 'shot2.mp4': 6.6, 'shot3.mp4': 6.6, 'shot4.mp4': 5.16, 'shot5.mp4': 6.6 };
const Broll = ({ s }: { s: { broll: string; frames: number; logo?: boolean } }) => {
  const f = useCurrentFrame();
  const fade = Math.min(interpolate(f, [0, 10], [0, 1], { extrapolateRight: 'clamp' }), interpolate(f, [s.frames - 10, s.frames], [1, 0], { extrapolateLeft: 'clamp' }));
  const logoIn = s.logo ? interpolate(f, [s.frames - 100, s.frames - 60], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 0;
  return (
    <AbsoluteFill style={{ opacity: fade, fontFamily: font }}>
      <OffthreadVideo src={staticFile(`broll/${s.broll}`)} playbackRate={Math.min(1, BROLL_SECONDS[s.broll] / (s.frames / 30))} muted style={{ width: 1920, height: 1080, objectFit: 'cover' }} />
      {s.logo ? (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-start', paddingTop: 170, opacity: logoIn, background: `linear-gradient(180deg, rgba(8,6,20,${0.55 * logoIn}) 0%, rgba(8,6,20,0) 60%)` }}>
          <Img src={staticFile('logo.png')} style={{ width: 260, height: 260, borderRadius: 56 }} />
          <div style={{ marginTop: 28, color: 'white', fontSize: 72, fontWeight: 800 }}>Flip Garden</div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};

const SceneWrap = ({ s }: { s: (typeof scenes)[number] }) => {
  const f = useCurrentFrame();
  const C = map[s.id];
  const fade = Math.min(interpolate(f, [0, 10], [0, 1], { extrapolateRight: 'clamp' }), interpolate(f, [s.frames - 10, s.frames], [1, 0], { extrapolateLeft: 'clamp' }));
  const zoom = 1 + f * 0.00035;
  return (
    <AbsoluteFill style={{ fontFamily: font, opacity: fade }}>
      <Bg />
      <Audio src={staticFile(s.audio)} />
      <AbsoluteFill style={{ transform: `scale(${zoom})` }}><C /></AbsoluteFill>
      <Subtitle s={s} />
    </AbsoluteFill>
  );
};

export const Pitch = () => {
  let start = 0;
  return (
    <AbsoluteFill style={{ background: '#07060f' }}>
      <Audio src={staticFile('audio/music-soft-circuit.mp3')} volume={(fr) => 0.448 * Math.min(1, fr / 30, (pitchFrames - fr) / 60)} />
      {scenes.map((s) => {
        const b = s as unknown as { broll?: string; frames: number; logo?: boolean };
        const el = <Sequence key={s.id} from={start} durationInFrames={s.frames}>{b.broll ? <Broll s={b as { broll: string; frames: number; logo?: boolean }} /> : <SceneWrap s={s} />}</Sequence>;
        start += s.frames;
        return el;
      })}
    </AbsoluteFill>
  );
};
