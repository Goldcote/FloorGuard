// Full-bleed pages (cover, part openers, back cover) and the screenshot frame.
// Each is self-contained HTML at A4 size in CSS px (794 x 1123), used inline in
// the PDF and rendered to PNG for the Word file.
import { C, pixelTile, shield } from './figures.mjs';
import { META, PARTS, BLOCKS } from './content.mjs';

export const A4 = { w: 794, h: 1123 };

function stars(w, h, n, seed, maxY) {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = r() * w, y = r() * maxY, rr = r() < 0.08 ? 1.6 : 0.8 + r() * 0.5;
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rr.toFixed(2)}" fill="#CFFFF0" opacity="${(0.15 + r() * 0.55).toFixed(2)}"/>`;
  }
  return out;
}

function floorGrid(w, h, y0, vpY) {
  const vx = w / 2;
  let g = '';
  for (let i = -24; i <= 24; i++) {
    const xb = vx + i * 70;
    g += `<line x1="${vx + (xb - vx) * 0.02}" y1="${y0}" x2="${xb}" y2="${h}" />`;
  }
  for (let i = 1; i <= 14; i++) {
    const f = Math.pow(i / 14, 2.2);
    const y = y0 + (h - y0) * f;
    g += `<line x1="0" y1="${y.toFixed(1)}" x2="${w}" y2="${y.toFixed(1)}" />`;
  }
  return `<g stroke="${C.mint}" stroke-width="1" opacity=".22">${g}</g>`;
}

function coverArt(w, h) {
  const y0 = 760;
  // a rising, stepping bid line that climbs to the horizon
  const pts = [[-10, 1010], [190, 905], [190, 945], [380, 840], [380, 872], [560, 790], [560, 812], [700, 764]];
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="position:absolute;inset:0">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05090C"/><stop offset=".62" stop-color="#08151A"/><stop offset=".68" stop-color="#0B2A26"/><stop offset="1" stop-color="#061412"/></linearGradient>
    <radialGradient id="halo" cx="50%" cy="${(y0 / h) * 100}%" r="60%"><stop offset="0" stop-color="${C.mint}" stop-opacity=".30"/><stop offset=".5" stop-color="${C.mint}" stop-opacity=".06"/><stop offset="1" stop-color="${C.mint}" stop-opacity="0"/></radialGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#061412" stop-opacity="0"/><stop offset="1" stop-color="#03090A" stop-opacity=".9"/></linearGradient>
    <filter id="blur8"><feGaussianBlur stdDeviation="8"/></filter>
    <filter id="blur3"><feGaussianBlur stdDeviation="3"/></filter>
    <clipPath id="below"><rect x="0" y="${y0}" width="${w}" height="${h - y0}"/></clipPath>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#sky)"/>
  ${stars(w, h, 170, 7, y0 - 20)}
  <rect width="${w}" height="${h}" fill="url(#halo)"/>
  <g clip-path="url(#below)">${floorGrid(w, h, y0, y0 - 40)}<rect x="0" y="${y0}" width="${w}" height="${h - y0}" fill="url(#fade)"/></g>
  <line x1="0" y1="${y0}" x2="${w}" y2="${y0}" stroke="${C.mint}" stroke-width="2" opacity=".9"/>
  <line x1="0" y1="${y0}" x2="${w}" y2="${y0}" stroke="${C.mint}" stroke-width="12" opacity=".08"/><line x1="0" y1="${y0}" x2="${w}" y2="${y0}" stroke="${C.mint}" stroke-width="5" opacity=".18"/>
  <path d="${d}" fill="none" stroke="${C.mint}" stroke-width="16" opacity=".07" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${C.mint}" stroke-width="8" opacity=".14" stroke-linejoin="round"/>
  <path d="${d}" fill="none" stroke="${C.mint}" stroke-width="3.2" stroke-linejoin="round"/>
  <path d="M700 764 L 790 726" fill="none" stroke="${C.mint}" stroke-width="2" stroke-dasharray="3 7" opacity=".8"/>
  <circle cx="700" cy="764" r="14" fill="${C.mint}" opacity=".2"/>
  <circle cx="700" cy="764" r="6" fill="${C.bg}" stroke="${C.mint}" stroke-width="3"/>
  <g>${pixelTile(11, 600, 676, 70, { color: C.mint, bg: '#0C1F1C', stroke: C.mint, r: 10 })}</g>
  <g opacity=".22" transform="translate(0 ${2 * y0}) scale(1 -1)">${pixelTile(11, 600, 676, 70, { color: C.mint, bg: '#0C1F1C', stroke: C.mint, r: 10 })}</g>
  <g>${pixelTile(4, 690, 690, 56, { color: C.violet, bg: '#14122A', stroke: C.violet, r: 9 })}</g>
  <g opacity=".2" transform="translate(0 ${2 * y0}) scale(1 -1)">${pixelTile(4, 690, 690, 56, { color: C.violet, bg: '#14122A', stroke: C.violet, r: 9 })}</g>
  </svg>`;
}

const logo = (size = 26, color = C.mint) =>
  `<svg width="${size}" height="${size * 1.1}" viewBox="0 0 100 110">${shield(50, 55, 100, { stroke: color, sw: 7 }).replace(/<g transform="translate\([^)]*\) scale\([^)]*\)">/, '<g>')}</svg>`;

const fullBase = `position:relative;width:794px;height:1123px;overflow:hidden;background:${C.bg};color:${C.text};font-family:'Space Grotesk',sans-serif;`;

export function coverHtml() {
  return `<div class="full" style="${fullBase}">
  ${coverArt(A4.w, A4.h)}
  <div style="position:absolute;left:64px;top:56px;right:64px;display:flex;align-items:center;justify-content:space-between">
    <div style="display:flex;align-items:center;gap:12px;font-size:22px;font-weight:700;letter-spacing:-.2px">${logo(28)}<span>Floor<span style="color:${C.mint}">Guard</span></span></div>
    <div style="font-size:11px;letter-spacing:3px;color:${C.muted};font-weight:600">DESIGN PAPER · V1</div>
  </div>
  <div style="position:absolute;left:64px;top:210px;right:64px">
    <div style="font-size:12px;letter-spacing:4px;color:${C.mint};font-weight:600">OCTOBER 2026</div>
    <div style="font-size:96px;line-height:.98;font-weight:700;letter-spacing:-3.5px;margin-top:22px;color:#F4F8F7">Fees that<br><span style="color:${C.mint}">buy the floor.</span></div>
    <div style="font-size:22px;line-height:1.35;color:#C4D3D6;margin-top:34px;max-width:560px;font-weight:400">${META.subtitle.replace(', and ', ',<br>and ')}</div>
  </div>
  <div style="position:absolute;left:64px;right:64px;bottom:58px;display:flex;justify-content:space-between;align-items:flex-end">
    <div style="display:flex;gap:8px;flex-wrap:wrap;max-width:430px">
      ${['Unaudited prototype', 'No token today', 'Not deployed', 'MIT licensed'].map((s) => `<span style="font-size:11px;font-weight:600;letter-spacing:1px;padding:7px 12px;border-radius:999px;border:1px solid rgba(61,232,180,.45);color:#D9F7EE;background:rgba(10,16,20,.55)">${s}</span>`).join('')}
    </div>
    <div style="text-align:right;font-size:12px;color:${C.muted};line-height:1.6">github.com/Goldcote/FloorGuard<br><span style="color:${C.dim}">FloorGuard v1</span></div>
  </div>
</div>`;
}

export function partHtml(i) {
  const p = PARTS[i];
  const secs = [];
  let cur = -1;
  for (const b of BLOCKS) {
    if (b.t === 'part') cur = b.part;
    else if (b.t === 'h1' && cur === i) secs.push(b);
  }
  return `<div class="full" style="${fullBase}">
  <svg width="794" height="1123" style="position:absolute;inset:0" xmlns="http://www.w3.org/2000/svg">
    <defs><pattern id="pg${i}" width="44" height="44" patternUnits="userSpaceOnUse"><path d="M44 0H0V44" fill="none" stroke="${C.grid}" stroke-width="1"/></pattern>
    <radialGradient id="pr${i}" cx="85%" cy="8%" r="80%"><stop offset="0" stop-color="${C.mint}" stop-opacity=".16"/><stop offset="1" stop-color="${C.mint}" stop-opacity="0"/></radialGradient></defs>
    <rect width="794" height="1123" fill="url(#pg${i})"/><rect width="794" height="1123" fill="url(#pr${i})"/>
  </svg>
  <div style="position:absolute;left:64px;top:56px;display:flex;align-items:center;gap:10px;font-size:13px;font-weight:700;color:${C.muted}">${logo(18, C.muted)} FloorGuard v1</div>
  <div style="position:absolute;left:52px;top:120px;font-size:360px;line-height:1;font-weight:700;letter-spacing:-14px;background:linear-gradient(180deg,${C.mint} 0%,rgba(61,232,180,.55) 45%,rgba(61,232,180,0) 92%);-webkit-background-clip:text;background-clip:text;color:transparent">${p.n}</div>
  <div style="position:absolute;left:64px;right:64px;top:560px">
    <div style="font-size:12px;letter-spacing:4px;color:${C.mint};font-weight:600">PART ${p.n}</div>
    <div style="font-size:64px;font-weight:700;letter-spacing:-2px;margin-top:14px;line-height:1">${p.title}</div>
    <div style="font-size:21px;color:#B9C9CC;margin-top:22px;max-width:560px;line-height:1.4">${p.line}</div>
  </div>
  <div style="position:absolute;left:64px;right:64px;bottom:72px;border-top:1px solid ${C.line};padding-top:22px">
    ${secs.map((s) => `<div style="display:flex;gap:22px;align-items:baseline;padding:7px 0;font-size:17px"><span style="color:${C.mint};font-weight:600;width:28px">${String(s.n).padStart(2, '0')}</span><span style="color:#DDE7E8">${s.title}</span></div>`).join('')}
  </div>
</div>`;
}

export function backHtml() {
  return `<div class="full" style="${fullBase}">
  ${coverArt(A4.w, A4.h).replace('width="794"', 'width="794" opacity=".55"')}
  <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,16,20,.92) 0%,rgba(10,16,20,.75) 55%,rgba(10,16,20,.2) 100%)"></div>
  <div style="position:absolute;left:64px;right:64px;top:120px">
    ${logo(54)}
    <div style="font-size:60px;font-weight:700;letter-spacing:-2px;line-height:1.02;margin-top:36px">Build it<br><span style="color:${C.mint}">with us.</span></div>
    <div style="font-size:19px;color:#C4D3D6;line-height:1.5;margin-top:26px;max-width:540px">FloorGuard is MIT-licensed and built in the open. Security reviewers, mechanism designers, front-end and operations people, lawyers and NFT communities: start with the README, run the tests, and open an issue.</div>
    <div style="margin-top:34px;display:inline-block;padding:14px 22px;border-radius:12px;border:1px solid ${C.mint};font-size:20px;font-weight:600;color:${C.mint}">github.com/Goldcote/FloorGuard</div>
    <div style="margin-top:18px;font-size:14px;color:${C.muted}">Report vulnerabilities privately, as described in SECURITY.md.</div>
  </div>
  <div style="position:absolute;left:64px;right:64px;bottom:60px;font-size:11.5px;line-height:1.6;color:${C.muted};border-top:1px solid ${C.line};padding-top:18px">
    Unaudited experimental software. Nothing is deployed to a public network. There is no token today and nothing to buy; this paper is not an offer or a solicitation and presents no returns. Games, the lottery and paid raffles are regulated or prohibited in many places. Screenshots show the web app’s demo mode, with simulated data and play money.
  </div>
</div>`;
}

// Browser-window frame around an app screenshot.
export function shotFrame(src, route, { width = '100%' } = {}) {
  return `<div class="shotframe" style="width:${width};border-radius:12px;overflow:hidden;background:${C.bg};border:1px solid #1E2C33">
  <div style="height:30px;display:flex;align-items:center;gap:7px;padding:0 12px;background:#111B21;border-bottom:1px solid #1E2C33">
    <span style="width:10px;height:10px;border-radius:50%;background:#FF6B5F"></span><span style="width:10px;height:10px;border-radius:50%;background:#FFBD2E"></span><span style="width:10px;height:10px;border-radius:50%;background:#28C940"></span>
    <span style="margin-left:14px;flex:1;max-width:60%;height:18px;border-radius:9px;background:#0A1014;color:#8AA0A6;font:500 10px 'Space Grotesk',sans-serif;display:flex;align-items:center;padding:0 10px;gap:6px;white-space:nowrap;overflow:hidden"><span style="color:${C.mint}">●</span> FloorGuard demo&nbsp;·&nbsp;<span style="color:#C4D3D6">#${route}</span></span>
  </div>
  <img src="${src}" width="2880" height="1800" style="display:block;width:100%;height:auto;aspect-ratio:2880/1800">
</div>`;
}
