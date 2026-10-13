// Copies the static shell into dist/ and stamps the service worker with a version taken from the bundle's hash.
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

mkdirSync('dist', { recursive: true });
for (const f of ['index.html', 'demo.html', 'style.css', 'manifest.webmanifest']) copyFileSync(f, `dist/${f}`);
cpSync('icons', 'dist/icons', { recursive: true });
const hash = createHash('sha256');
for (const f of ['dist/app.js', 'dist/garden3d.js', 'dist/index.html', 'dist/style.css', 'dist/manifest.webmanifest']) hash.update(readFileSync(f));
const version = hash.digest('hex').slice(0, 12);
writeFileSync('dist/sw.js', readFileSync('sw.js', 'utf8').replace('__VERSION__', version));
console.log(`service worker version ${version}`);
