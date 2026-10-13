// The pitch with the AI atmosphere shots (public/broll) full screen, alternating with the product's own screens.
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame } from 'remotion';
import raw from './pitch2.json';
import { PhoneVid, PHONE_H, PHONE_W } from './Phone';
import { Bg, Subtitle, useSpring } from './Pitch';

type Scene = { id: string; title: string; text: string; audio: string; seconds: number; frames: number; broll?: string; rec?: string; from?: number; to?: number; logo?: boolean };
const BROLL_SECONDS: Record<string, number> = { 'shot1.mp4': 6.6, 'shot2.mp4': 6.6, 'shot3.mp4': 6.6, 'shot4.mp4': 5.16, 'shot5.mp4': 6.6 };
// A scene lasts as long as its narration (at least 5 s); phone footage never runs faster than 2x, a shot never slower than half speed.
const scenes = (raw as Scene[]).map((s) => {
  let frames = Math.max(s.frames, 150);
  if (s.rec) frames = Math.max(frames, Math.ceil((((s.to ?? 0) - (s.from ?? 0)) / 2) * 30));
  if (s.broll) frames = Math.min(frames, Math.floor(BROLL_SECONDS[s.broll] * 2 * 30));
  return { ...s, frames };
});
export const pitch2Frames = scenes.reduce((a, s) => a + s.frames, 0);
const font = 'Helvetica Neue, Arial, sans-serif';

const Title = ({ children, left = 120, top = 120 }: { children: string; left?: number; top?: number }) => {
  const p = useSpring(6, 16);
  return <div style={{ position: 'absolute', left, top, color: 'white', fontSize: 84, fontWeight: 800, fontFamily: font, opacity: p, transform: `translateY(${(1 - p) * 30}px)`, textShadow: '0 6px 40px rgba(0,0,0,.6)' }}>{children}</div>;
};

const BrollScene = ({ s }: { s: (typeof scenes)[number] }) => {
  const f = useCurrentFrame();
  const rate = Math.min(1, BROLL_SECONDS[s.broll!] / (s.frames / 30));
  const logoIn = s.logo ? interpolate(f, [s.frames - 110, s.frames - 70], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 0;
  return (
    <AbsoluteFill>
      <OffthreadVideo src={staticFile(`broll/${s.broll}`)} playbackRate={rate} muted style={{ width: 1920, height: 1080, objectFit: 'cover' }} />
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(8,6,20,.35) 0%, rgba(8,6,20,0) 35%, rgba(8,6,20,0) 70%, rgba(8,6,20,.55) 100%)' }} />
      {s.logo ? null : <Title>{s.title}</Title>}
      {s.logo ? (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: logoIn }}>
          <Img src={staticFile('logo.png')} style={{ width: 260, height: 260, borderRadius: 56 }} />
          <div style={{ marginTop: 28, color: 'white', fontSize: 72, fontWeight: 800, fontFamily: font }}>Flip Garden</div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};

const PhoneScene = ({ s, i }: { s: (typeof scenes)[number]; i: number }) => {
  const p = useSpring(2, 14);
  const scale = 0.7;
  const rate = Math.max(0.5, ((s.to ?? 0) - (s.from ?? 0)) / (s.frames / 30));
  const left = i % 2 === 0;
  return (
    <AbsoluteFill>
      <Bg />
      <div style={{ position: 'absolute', left: left ? 150 : 1920 - 150 - PHONE_W * scale, top: 16 + (1 - p) * 500, width: PHONE_W * scale, height: PHONE_H * scale, transform: `rotateY(${left ? 8 : -8}deg)` }}>
        <PhoneVid rec={s.rec!} from={s.from ?? 0} rate={rate} scale={scale} />
      </div>
      <Title left={left ? 160 + PHONE_W * scale + 60 : 160} top={380}>{s.title}</Title>
    </AbsoluteFill>
  );
};

const SceneWrap = ({ s, i }: { s: (typeof scenes)[number]; i: number }) => {
  const f = useCurrentFrame();
  const fade = Math.min(interpolate(f, [0, 10], [0, 1], { extrapolateRight: 'clamp' }), interpolate(f, [s.frames - 10, s.frames], [1, 0], { extrapolateLeft: 'clamp' }));
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <Audio src={staticFile(s.audio)} />
      {s.broll ? <BrollScene s={s} /> : <PhoneScene s={s} i={i} />}
      <Subtitle s={s as never} />
    </AbsoluteFill>
  );
};

export const Pitch2 = () => {
  let start = 0;
  return (
    <AbsoluteFill style={{ background: '#07060f' }}>
      <Audio src={staticFile('audio/music.wav')} volume={0.12} />
      {scenes.map((s, i) => {
        const el = <Sequence key={s.id} from={start} durationInFrames={s.frames}><SceneWrap s={s} i={i} /></Sequence>;
        start += s.frames;
        return el;
      })}
    </AbsoluteFill>
  );
};
