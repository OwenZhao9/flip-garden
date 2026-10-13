import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from 'remotion';
import raw from './agora.json';
import { PhoneVid, PHONE_H, PHONE_W } from './Phone';
import { Bg, Eyebrow, Subtitle, useSpring } from './Pitch';

// A scene lasts as long as its narration, but never so short that the footage would have to run faster than 2x.
const scenes = raw.map((s) => ({ ...s, frames: Math.max(s.frames, Math.ceil(((s.to - s.from) / 2) * 30)) }));
export const agoraFrames = scenes.reduce((a, s) => a + s.frames, 0);
const GREEN = '#9be564';

const SceneWrap = ({ s, i }: { s: (typeof scenes)[number]; i: number }) => {
  const f = useCurrentFrame();
  const fade = Math.min(interpolate(f, [0, 10], [0, 1], { extrapolateRight: 'clamp' }), interpolate(f, [s.frames - 10, s.frames], [1, 0], { extrapolateLeft: 'clamp' }));
  const p = useSpring(2, 14);
  const scale = 0.7;
  const rate = Math.max(0.5, (s.to - s.from) / (s.frames / 30));
  const left = i % 2 === 0;
  return (
    <AbsoluteFill style={{ opacity: fade, fontFamily: 'Helvetica Neue, Arial, sans-serif' }}>
      <Bg />
      <Audio src={staticFile(s.audio)} />
      <div style={{ position: 'absolute', left: left ? 150 : 1920 - 150 - PHONE_W * scale, top: 16 + (1 - p) * 500, width: PHONE_W * scale, height: PHONE_H * scale, transform: `rotateY(${left ? 8 : -8}deg)` }}>
        <PhoneVid rec={s.rec} from={s.from} rate={rate} scale={scale} />
      </div>
      <div style={{ position: 'absolute', [left ? 'left' : 'right']: 160 + PHONE_W * scale + 60, top: 330, width: 700, transform: `translateY(${(1 - p) * 40}px)`, opacity: p }}>
        <Eyebrow>{(s as { tag?: string }).tag ?? (s.rec === 'tour_s.mp4' ? 'Live data' : 'Simulated data')}</Eyebrow>
        <div style={{ color: 'white', fontSize: 78, fontWeight: 800, lineHeight: 1.05, marginTop: 24 }}>{s.title}</div>
        <div style={{ marginTop: 40, display: 'flex', gap: 12 }}>{scenes.map((_, k) => <div key={k} style={{ width: 34, height: 8, borderRadius: 4, background: k === i ? GREEN : 'rgba(255,255,255,.2)' }} />)}</div>
      </div>
      <Subtitle s={s} />
    </AbsoluteFill>
  );
};

export const Agora = () => {
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
