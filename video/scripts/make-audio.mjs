// Usage: node scripts/make-audio.mjs <script.json> <out-data.json> [voice]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const [src, out, voice = 'Samantha'] = process.argv.slice(2);
const scenes = JSON.parse(readFileSync(src, 'utf8'));
mkdirSync('public/audio', { recursive: true });
const FPS = 30, PAD = 0.5;
const data = scenes.map((s) => {
  const aiff = `public/audio/${s.id}.aiff`, wav = `public/audio/${s.id}.wav`;
  execFileSync('say', ['-v', voice, '-r', '165', '-o', aiff, s.text]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ar', '44100', wav]);
  const d = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav]).toString());
  return { ...s, audio: `audio/${s.id}.wav`, seconds: d, frames: Math.ceil((d + PAD) * FPS) };
});
writeFileSync(out, JSON.stringify(data, null, 1));
console.log('total seconds', data.reduce((a, s) => a + s.frames / FPS, 0).toFixed(1));
