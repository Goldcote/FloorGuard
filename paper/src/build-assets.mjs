// Renders the raster assets the Word file needs: figures, framed screenshots
// and the full-bleed pages, all from the same sources as the PDF.
import { mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { BLOCKS } from './content.mjs';
import { FIGURES } from './figures.mjs';
import { coverHtml, partHtml, backHtml, shotFrame, A4 } from './pages.mjs';
import { snap } from './render.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const A = join(ROOT, 'build', 'assets');
mkdirSync(A, { recursive: true });

export const SHOT = { w: 1000, h: 659 };

const toJpg = (png, q = 86) => {
  const jpg = png.replace(/\.png$/, '.jpg');
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(q), png, '--out', jpg], { stdio: 'pipe' });
  return jpg;
};

export function buildAssets() {
  for (const [k, f] of Object.entries(FIGURES)) {
    const svg = f();
    const [, w, h] = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    snap(svg, +w, +h, join(A, `fig-${k}.png`), { scale: 2, bg: '#ffffff' });
  }
  for (const b of BLOCKS.filter((x) => x.t === 'shot')) {
    const src = join(ROOT, 'src/img', `${b.img}.png`);
    const png = join(A, `shot-${b.img}.png`);
    snap(`<style>.shotframe{box-shadow:none!important;border-radius:14px!important}</style>${shotFrame('file://' + src, b.route)}`, SHOT.w, SHOT.h, png, { scale: 2, bg: '#ffffff' });
    toJpg(png);
  }
  const full = { cover: coverHtml(), back: backHtml(), part0: partHtml(0), part1: partHtml(1), part2: partHtml(2), part3: partHtml(3) };
  for (const [k, html] of Object.entries(full)) {
    const png = join(A, `page-${k}.png`);
    snap(html, A4.w, A4.h, png, { scale: 2.5, bg: '#0A1014' });
    toJpg(png, 90);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildAssets();
  console.log('assets in', A, existsSync(join(A, 'page-cover.jpg')));
}
