// Builds out/FloorGuard-v1-design-paper.pdf from content.mjs.
// Two passes: the first finds the page each section lands on, the second writes
// those numbers into the contents.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { META, PARTS, BLOCKS, inline } from './content.mjs';
import { FIGURES, C } from './figures.mjs';
import { coverHtml, partHtml, backHtml, shotFrame } from './pages.mjs';
import { fontFace, printPdf } from './render.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BUILD = join(ROOT, 'build');
const OUT = join(ROOT, 'out');
mkdirSync(BUILD, { recursive: true });
mkdirSync(OUT, { recursive: true });

// Screenshots: JPEG copies keep the files small.
export function shotJpg(name) {
  const src = join(ROOT, 'src/img', `${name}.png`);
  const dst = join(BUILD, 'img', `${name}.jpg`);
  mkdirSync(join(BUILD, 'img'), { recursive: true });
  if (!existsSync(dst)) execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '84', '-Z', '2200', src, '--out', dst], { stdio: 'pipe' });
  return dst;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const md = (s) =>
  inline(s)
    .map((r) => {
      let h = esc(r.text);
      if (r.code) h = `<code>${h}</code>`;
      if (r.i) h = `<em>${h}</em>`;
      if (r.b) h = `<strong>${h}</strong>`;
      if (r.link) h = `<a href="${r.link}">${h}</a>`;
      return h;
    })
    .join('');

const pad = (n) => String(n).padStart(2, '0');

function contents(pages) {
  const rows = [];
  let part = -1;
  for (const b of BLOCKS) {
    if (b.t === 'part') {
      part = b.part;
      const p = PARTS[part];
      rows.push(`<div class="toc-part"><span class="toc-roman">${p.n}</span><span class="toc-ptitle">${p.title}</span><span class="toc-dots"></span><span class="toc-pg">${pages[`P${part}`] ?? '00'}</span></div>`);
    } else if (b.t === 'h1') {
      rows.push(`<div class="toc-row"><span class="toc-n">${pad(b.n)}</span><span class="toc-title">${b.title}</span><span class="toc-dots"></span><span class="toc-pg">${pages[`S${b.n}`] ?? '00'}</span></div>`);
    }
  }
  return rows.join('');
}

function frontMatter(pages) {
  return `<section class="front">
  <div class="kicker">FLOORGUARD V1 · DESIGN PAPER</div>
  <h1 class="front-title">${META.title}</h1>
  <p class="front-sub">${META.subtitle}</p>
  <p class="front-intro">${md(META.intro)}</p>
  <div class="status">
    <div class="status-h"><span class="status-dot"></span>Status, stated first</div>
    <ul>${META.status.map((s) => `<li>${md(s)}</li>`).join('')}</ul>
  </div>
  <div class="toc"><div class="toc-h">Contents</div>${contents(pages)}</div>
</section>`;
}

function renderBlocks() {
  let fig = 0, shot = 0, h = '', open = false;
  const close = () => (open ? '</section>' : '');
  for (const b of BLOCKS) {
    switch (b.t) {
      case 'part':
        h += close(); open = false;
        h += `<div class="fullpage">${partHtml(b.part)}</div>`;
        break;
      case 'h1':
        h += close(); open = true;
        h += `<section class="sec${b.newPage ? ' newpage' : ''}"><header class="sec-head"><div class="sec-num">${pad(b.n)}</div><div class="sec-titles"><div class="kicker">SECTION ${pad(b.n)}</div><h1>${b.title}</h1>${b.sub ? `<div class="sec-sub">${b.sub}</div>` : ''}</div></header>`;
        break;
      case 'h2': h += `<h2>${b.title}</h2>`; break;
      case 'lead': h += `<p class="lead">${md(b.md)}</p>`; break;
      case 'p': h += `<p>${md(b.md)}</p>`; break;
      case 'ul': h += `<ul class="list">${b.items.map((i) => `<li>${md(i)}</li>`).join('')}</ul>`; break;
      case 'ol': h += `<ol class="olist">${b.items.map((i, k) => `<li><span class="oln">${k + 1}</span><div>${md(i)}</div></li>`).join('')}</ol>`; break;
      case 'quote': h += `<blockquote>${md(b.md)}</blockquote>`; break;
      case 'stats': h += `<div class="stats">${b.items.map(([n, s]) => `<div class="stat"><div class="stat-n">${n}</div><div class="stat-s">${s}</div></div>`).join('')}</div>`; break;
      case 'formula': h += `<pre class="formula">${b.lines.map(esc).join('\n')}</pre>`; break;
      case 'cards':
        h += `<div class="cards c${b.cols}">${b.items.map(([t, s], k) => `<div class="card">${b.numbered ? `<div class="card-n">${k + 1}</div>` : ''}<div class="card-t">${md(t)}</div><div class="card-s">${md(s)}</div></div>`).join('')}</div>`;
        break;
      case 'table': {
        const cols = b.widths.map((w) => `<col style="width:${(w * 100).toFixed(1)}%">`).join('');
        h += `<table class="${b.compact ? 'compact' : ''}"><colgroup>${cols}</colgroup><thead><tr>${b.head.map((x) => `<th>${md(x)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((x) => `<td>${md(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        break;
      }
      case 'fig':
        fig++;
        h += `<figure class="fig"><div class="figart">${FIGURES[b.id]()}</div><figcaption><span>Figure ${fig}</span>${md(b.caption)}</figcaption></figure>`;
        break;
      case 'shot':
        shot++;
        h += `<figure class="shot${b.side ? ' side' : ''}"${b.width ? ` style="width:${b.width * 100}%"` : ''}>${shotFrame('file://' + shotJpg(b.img), b.route)}<figcaption><span>In the app</span>${md(b.caption)} <em class="demo">Demo mode: simulated data, play money.</em></figcaption></figure>`;
        break;
      case 'callout':
        h += `<aside class="callout ${b.kind}"><div class="callout-t">${b.title}</div><p>${md(b.md)}</p></aside>`;
        break;
      case 'sources':
        h += `<div class="sources"><div class="sources-h">Sources</div><ol>${b.items.map(([t, u]) => `<li><span>${esc(t)}</span><a href="${u}">${esc(u.replace(/^https?:\/\//, ''))}</a></li>`).join('')}</ol></div>`;
        break;
      case 'glossary':
        h += `<dl class="glossary">${b.items.map(([t, d]) => `<div><dt>${t}</dt><dd>${md(d)}</dd></div>`).join('')}</dl>`;
        break;
      default:
        throw new Error('unknown block ' + b.t);
    }
  }
  return h + close();
}

const CSS = `
${fontFace}
@page { size: A4; margin: 20mm 19mm 22mm 19mm;
  @bottom-left { content: "FloorGuard v1  ·  Design paper"; font: 600 7.5pt 'Space Grotesk', sans-serif; color: #8A9AA0; letter-spacing: .6pt; }
  @bottom-right { content: counter(page); font: 700 8pt 'Space Grotesk', sans-serif; color: #0B8F6B; }
}
@page full { margin: 0; @bottom-left { content: none } @bottom-right { content: none } }
:root { --ink:#18232A; --muted:#5A6B72; --accent:#0B8F6B; --mint:${C.mint}; --gold:#B7790C; --rule:#E2E8E7; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; background: #fff; }
body { font-family: Charter, 'Iowan Old Style', Georgia, serif; font-size: 10.2pt; line-height: 1.58; color: var(--ink); hyphens: manual; overflow-wrap: break-word; }
a { color: var(--accent); text-decoration: none; border-bottom: .6pt solid rgba(11,143,107,.35); }
strong { font-weight: 700; color: #0E171C; }
code { font-family: 'SF Mono', Menlo, monospace; font-size: .84em; background: #EEF5F3; color: #0A6E53; padding: .5pt 3pt; border-radius: 3pt; }
.fullpage { page: full; break-before: page; break-after: page; }
.full { break-inside: avoid; }
.kicker { font: 600 7.6pt 'Space Grotesk', sans-serif; letter-spacing: 2.4pt; color: var(--accent); }
h1, h2, .lead, blockquote, .card-t, th, figcaption, .stat, .toc, .status-h, .callout-t, .sources-h, dt { font-family: 'Space Grotesk', sans-serif; }

/* front matter */
.front { break-before: page; }
.front-title { font: 700 30pt/1 'Space Grotesk', sans-serif; letter-spacing: -1pt; margin: 6pt 0 6pt; }
.front-sub { font: 500 12.5pt/1.4 'Space Grotesk', sans-serif; color: #33444B; margin: 0 0 10pt; max-width: 135mm; }
.front-intro { font-size: 9pt; color: var(--muted); margin: 0 0 12pt; max-width: 150mm; }
.status { background: #FFF7E8; border: 1px solid #F3D9A4; border-left: 4pt solid #F5B94A; border-radius: 8pt; padding: 10pt 14pt 8pt; margin-bottom: 16pt; }
.status-h { font-weight: 700; font-size: 10.5pt; display: flex; align-items: center; gap: 7pt; color: #6B4A06; }
.status-dot { width: 7pt; height: 7pt; border-radius: 50%; background: #F5B94A; outline: 3pt solid rgba(245,185,74,.25); }
.status ul { margin: 5pt 0 0; padding-left: 14pt; font-size: 9pt; line-height: 1.5; }
.status li { margin: 2pt 0; }
.toc-h { font-weight: 700; font-size: 9pt; letter-spacing: 2.4pt; text-transform: uppercase; color: var(--accent); border-bottom: 1.2pt solid #0E171C; padding-bottom: 4pt; margin-bottom: 4pt; }
.toc-part { display: flex; align-items: baseline; gap: 8pt; margin-top: 6pt; padding: 3pt 0 1pt; font-weight: 700; font-size: 10pt; }
.toc-roman { color: var(--accent); width: 22pt; }
.toc-row { display: flex; align-items: baseline; gap: 8pt; font-size: 9.2pt; padding: 1.3pt 0 1.3pt 30pt; color: #2A3A41; }
.toc-n { color: #8A9AA0; width: 16pt; font-weight: 600; }
.toc-dots { flex: 1; border-bottom: .8pt dotted #B9C5C4; transform: translateY(-3pt); }
.toc-pg { font-weight: 700; color: #0E171C; min-width: 14pt; text-align: right; }

/* sections */
.sec { break-before: auto; padding-top: 6pt; }
.sec.newpage { break-before: page; }
.sec:not(.newpage) { margin-top: 16pt; }
.sec-head { display: flex; gap: 14pt; align-items: flex-start; border-top: 1.4pt solid #0E171C; padding-top: 10pt; margin-bottom: 12pt; break-after: avoid; }
.sec-num { font: 300 40pt/0.9 'Space Grotesk', sans-serif; color: var(--accent); letter-spacing: -1.5pt; min-width: 54pt; }
.sec-titles h1 { font-size: 22pt; line-height: 1.08; letter-spacing: -.6pt; margin: 3pt 0 0; font-weight: 700; color: #0B1216; }
.sec-sub { font: 500 11pt 'Space Grotesk', sans-serif; color: var(--muted); margin-top: 3pt; }
h2 { font-size: 12.5pt; letter-spacing: -.2pt; margin: 16pt 0 5pt; color: #0B1216; break-after: avoid; }
p { margin: 0 0 7.5pt; text-align: left; }
.lead { hyphens: manual; font-size: 12pt; line-height: 1.5; color: #22323A; text-align: left; margin-bottom: 10pt; font-weight: 400; }
.lead strong { font-weight: 700; }
.list { margin: 4pt 0 10pt; padding: 0; list-style: none; }
.list li { position: relative; padding-left: 15pt; margin: 0 0 5pt; text-align: left; }
.list li::before { content: ''; position: absolute; left: 2pt; top: 6pt; width: 6pt; height: 6pt; border-radius: 1.5pt; background: var(--mint); }
.olist { list-style: none; margin: 4pt 0 10pt; padding: 0; }
.olist li { display: flex; gap: 10pt; margin-bottom: 6pt; break-inside: avoid; }
.oln { font: 700 9pt 'Space Grotesk', sans-serif; flex: 0 0 18pt; height: 18pt; border-radius: 50%; background: #0E171C; color: var(--mint); display: flex; align-items: center; justify-content: center; margin-top: 1pt; }
blockquote { margin: 12pt 0 14pt; padding: 12pt 16pt 12pt 18pt; font-size: 13.5pt; line-height: 1.38; font-weight: 500; color: #0B1216; background: linear-gradient(90deg,#EAF8F3,#fff 85%); border-left: 4pt solid var(--mint); border-radius: 0 10pt 10pt 0; break-inside: avoid; letter-spacing: -.15pt; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; background: #0A1014; border-radius: 12pt; margin: 12pt 0 14pt; overflow: hidden; break-inside: avoid; }
.stat { padding: 13pt 12pt 12pt; border-right: 1px solid #1E2C33; background: radial-gradient(circle at 100% 0, rgba(61,232,180,.12), transparent 70%); }
.stat:last-child { border-right: 0; }
.stat-n { font-size: 21pt; font-weight: 700; color: var(--mint); letter-spacing: -.6pt; line-height: 1.05; }
.stat-s { font-size: 7.6pt; color: #AFC0C4; line-height: 1.35; margin-top: 5pt; }
.formula { font: 500 9pt/1.7 'SF Mono', Menlo, monospace; background: #0A1014; color: var(--mint); border-radius: 10pt; padding: 12pt 16pt; margin: 6pt 0 10pt; white-space: pre; break-inside: avoid; }
.cards { display: flex; flex-wrap: wrap; gap: 8pt; margin: 8pt 0 12pt; }
.cards.c2 .card { width: calc((100% - 8pt) / 2); }
.cards.c3 .card { width: calc((100% - 16pt) / 3); }
.card { border: 1px solid var(--rule); border-radius: 9pt; padding: 8pt 10pt 7pt; background: linear-gradient(180deg,#FAFCFB,#fff); break-inside: avoid; position: relative; }
.card-n { font: 700 8pt 'Space Grotesk', sans-serif; width: 16pt; height: 16pt; border-radius: 50%; background: #0E171C; color: var(--mint); display: flex; align-items: center; justify-content: center; margin-bottom: 4pt; }
.card-t { font-weight: 700; font-size: 10pt; line-height: 1.25; color: #0B1216; margin-bottom: 4pt; }
.card-s { font-size: 8.4pt; line-height: 1.4; color: #33444B; }
table { width: 100%; border-collapse: separate; border-spacing: 0; margin: 8pt 0 12pt; font: 400 8.5pt/1.4 'Space Grotesk', sans-serif; color: #22323A; break-inside: auto; border-radius: 9pt; overflow: hidden; border: 1px solid var(--rule); }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th { background: #0E171C; color: #E8F0F0; text-align: left; font-weight: 600; font-size: 7.2pt; letter-spacing: 1.2pt; text-transform: uppercase; padding: 7pt 9pt; }
td { padding: 6.5pt 9pt; border-top: 1px solid var(--rule); vertical-align: top; }
tbody tr:nth-child(even) td { background: #F6F9F8; }
td:first-child { font-weight: 600; color: #0E171C; }
td code { background: transparent; padding: 0; color: #0A6E53; font-size: 7.9pt; }
table.compact td { padding: 4.5pt 9pt; }
.fig, .shot { margin: 12pt 0 14pt; break-inside: avoid; }
.shot { width: 90%; margin-left: auto; margin-right: auto; }
.shot.side { width: 100%; display: flex; gap: 14pt; align-items: center; }
.shot.side .shotframe { flex: 0 0 60%; }
.shot.side figcaption { margin: 0; font-size: 8.4pt; }
.figart svg { width: 94%; margin: 0 auto; height: auto; display: block; border-radius: 12pt; }
figcaption { font-size: 7.9pt; line-height: 1.45; color: var(--muted); margin-top: 6pt; padding-left: 2pt; }
figcaption > span { font-weight: 700; color: var(--accent); letter-spacing: 1pt; text-transform: uppercase; font-size: 7pt; margin-right: 6pt; }
figcaption .demo { color: #8A9AA0; }
.callout { border-radius: 10pt; padding: 11pt 15pt 5pt; margin: 10pt 0 14pt; break-inside: avoid; border: 1px solid; }
.callout-t { font-weight: 700; font-size: 10.5pt; margin-bottom: 4pt; }
.callout p { font-size: 9.4pt; }
.callout.note { background: #EEF9F5; border-color: #BFE9DA; border-left: 4pt solid var(--mint); }
.callout.note .callout-t { color: #0A6E53; }
.callout.warn { background: #FFF2F0; border-color: #FBD1CA; border-left: 4pt solid #FF7A6B; }
.callout.warn .callout-t { color: #B2382A; }
.callout.status { background: #FFF7E8; border-color: #F3D9A4; border-left: 4pt solid #F5B94A; }
.callout.status .callout-t { color: #6B4A06; }
.sources { margin: 10pt 0; padding: 9pt 12pt; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); break-inside: avoid; }
.sources-h { font-weight: 700; font-size: 7.4pt; letter-spacing: 2pt; text-transform: uppercase; color: var(--accent); margin-bottom: 4pt; }
.sources ol { margin: 0; padding-left: 13pt; font-size: 7.6pt; line-height: 1.45; color: var(--muted); }
.sources li span { color: #33444B; display: block; }
.sources a { border: 0; word-break: break-all; }
.glossary { display: grid; grid-template-columns: 1fr 1fr; gap: 6pt 14pt; margin: 6pt 0 10pt; }
.glossary div { border-left: 2pt solid var(--mint); padding: 2pt 0 2pt 9pt; break-inside: avoid; }
.glossary dt { font-weight: 700; font-size: 9.5pt; }
.glossary dd { margin: 1pt 0 0; font-size: 8.7pt; color: #33444B; line-height: 1.4; }
`;

function html(pages) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FloorGuard v1: Design paper</title>
<meta name="author" content="FloorGuard contributors"><meta name="description" content="${META.subtitle}">
<style>${CSS}</style></head><body>
<div class="fullpage" style="break-before:auto">${coverHtml()}</div>
${frontMatter(pages)}
${renderBlocks()}
<div class="fullpage">${backHtml()}</div>
</body></html>`;
}

function findPages(pdf) {
  const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const pages = text.split('\f');
  const found = {};
  pages.forEach((raw, i) => {
    const pg = raw.replace(/\s+/g, '');
    for (const m1 of pg.matchAll(/SECTION(\d\d)/g)) if (!found[`S${+m1[1]}`]) found[`S${+m1[1]}`] = i + 1;
    const m2 = raw.match(/PART\s+(IV|III|II|I)\b/);
    if (m2) {
      const idx = PARTS.findIndex((p) => p.n === m2[1]);
      if (idx >= 0 && !found[`P${idx}`]) found[`P${idx}`] = i + 1;
    }
  });
  return { found, count: pages.filter((p) => p.trim()).length };
}

const file = join(BUILD, 'paper.html');
const pdf = join(OUT, 'FloorGuard-v1-design-paper.pdf');
writeFileSync(file, html({}));
printPdf(file, pdf);
const { found } = findPages(pdf);
writeFileSync(file, html(found));
printPdf(file, pdf);
const check = findPages(pdf);
const same = Object.keys(found).every((k) => found[k] === check.found[k]);
console.log(JSON.stringify({ pages: check.count, toc: check.found, stable: same }));
