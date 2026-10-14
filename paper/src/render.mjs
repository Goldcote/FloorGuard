// Headless Chrome helpers: HTML snippet -> PNG, HTML file -> PDF.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = process.env.PAPER_CHROME_PROFILE || join(tmpdir(), 'floorguard-paper-chrome');
const ROOT = resolve(new URL('..', import.meta.url).pathname);
export const FONT_URL = `file://${ROOT}/src/space-grotesk-latin-wght-normal.woff2`;

export const fontFace = `@font-face{font-family:'Space Grotesk';src:url('${FONT_URL}') format('woff2');font-weight:300 700;}`;

function chrome(args) {
  mkdirSync(PROFILE, { recursive: true });
  execFileSync(CHROME, ['--headless=new', `--user-data-dir=${PROFILE}`, '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--allow-file-access-from-files', ...args], { stdio: 'pipe' });
}

// Render an HTML body of a known CSS size to a PNG at `scale`.
export function snap(html, w, h, out, { scale = 2, bg = 'transparent' } = {}) {
  const dir = join(ROOT, 'build', 'snap');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, out.split('/').pop().replace(/\.png$/, '.html'));
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>${fontFace}html,body{margin:0;padding:0;background:${bg};width:${w}px;height:${h}px;overflow:hidden}svg{display:block}</style>${html}`);
  chrome([`--window-size=${w},${h}`, `--force-device-scale-factor=${scale}`, '--virtual-time-budget=3000', `--screenshot=${out}`, `file://${file}`]);
}

export function printPdf(htmlFile, out) {
  chrome(['--no-pdf-header-footer', '--virtual-time-budget=10000', `--print-to-pdf=${out}`, `file://${htmlFile}`]);
}
