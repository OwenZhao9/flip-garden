import { Img, OffthreadVideo, staticFile } from 'remotion';
import type { CSSProperties } from 'react';

// iPhone-style frame drawn in code. The Dynamic Island is part of the screenshot.
export const Phone = ({ src, scale = 0.6, scrollY = 0, style }: { src: string; scale?: number; scrollY?: number; style?: CSSProperties }) => {
  const w = 402 * 1.7, h = 874 * 1.7;
  return (
    <div style={{ width: w + 36, height: h + 36, transform: `scale(${scale})`, transformOrigin: 'top left', borderRadius: 120, background: '#0b0b12', padding: 18, boxShadow: '0 40px 120px rgba(0,0,0,.6), inset 0 0 0 3px #3a3a4a', ...style }}>
      <div style={{ width: w, height: h, borderRadius: 102, overflow: 'hidden', position: 'relative', background: '#14122a' }}>
        <Img src={staticFile(`shots/${src}`)} style={{ width: w, position: 'absolute', top: -scrollY }} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 150, background: '#14122a' }} />
      </div>
    </div>
  );
};
// Same frame, playing a slice of a real simulator recording. zoom > 1 crops in on (fx, fy) given as fractions of the screen.
export const PhoneVid = ({ rec, from, scale = 0.6, zoom = 1, fx = 0.5, fy = 0.5, rate = 1, style }: { rec: string; from: number; rate?: number; scale?: number; zoom?: number; fx?: number; fy?: number; style?: CSSProperties }) => {
  const w = 402 * 1.7, h = 874 * 1.7;
  return (
    <div style={{ width: w + 36, height: h + 36, transform: `scale(${scale})`, transformOrigin: 'top left', borderRadius: 120, background: '#0b0b12', padding: 18, boxShadow: '0 40px 120px rgba(0,0,0,.6), inset 0 0 0 3px #3a3a4a', ...style }}>
      <div style={{ width: w, height: h, borderRadius: 102, overflow: 'hidden', position: 'relative', background: '#14122a' }}>
        <div style={{ width: w, height: h, transform: `scale(${zoom})`, transformOrigin: `${fx * 100}% ${fy * 100}%` }}>
          <OffthreadVideo src={staticFile(`rec/${rec}`)} startFrom={Math.round(from * 30)} playbackRate={rate} muted style={{ width: w, height: h, objectFit: 'cover' }} />
        </div>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 150, background: '#14122a' }} />
      </div>
    </div>
  );
};
export const PHONE_W = (402 * 1.7 + 36);
export const PHONE_H = (874 * 1.7 + 36);
