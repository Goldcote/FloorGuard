// Vector figures for the FloorGuard v1 design paper.
// Every figure is an SVG string drawn on the dark "vault" panel, so the same
// artwork serves the PDF (inline) and the Word file (rendered to PNG).

export const C = {
  bg: '#0A1014',
  panel: '#0F1A1F',
  panel2: '#13222A',
  line: '#203039',
  grid: '#15232B',
  text: '#E8F0F0',
  muted: '#8AA0A6',
  dim: '#5C7178',
  mint: '#3DE8B4',
  mintDim: '#1F7F66',
  gold: '#F5B94A',
  coral: '#FF7A6B',
  violet: '#8B7BFF',
};

const F = `font-family="Space Grotesk, sans-serif"`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function frame(w, h, body, { grid = true } = {}) {
  const g = grid
    ? `<defs><pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="${C.grid}" stroke-width="1"/></pattern>
       <radialGradient id="glow" cx="80%" cy="0%" r="90%"><stop offset="0" stop-color="${C.mint}" stop-opacity=".10"/><stop offset="1" stop-color="${C.mint}" stop-opacity="0"/></radialGradient></defs>
       <rect width="${w}" height="${h}" fill="url(#g)"/><rect width="${w}" height="${h}" fill="url(#glow)"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ${F}>
  <rect width="${w}" height="${h}" rx="22" fill="${C.bg}"/>
  <g clip-path="url(#clip)"><clipPath id="clip"><rect width="${w}" height="${h}" rx="22"/></clipPath>${g}</g>
  <defs>
    <marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.mint}"/></marker>
    <marker id="ahm" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.muted}"/></marker>
    <marker id="ahg" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.gold}"/></marker>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>
  ${body}
</svg>`;
}

const t = (x, y, s, { size = 16, fill = C.text, weight = 500, anchor = 'start', ls = 0, op = 1 } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}" letter-spacing="${ls}" opacity="${op}">${esc(s)}</text>`;
const label = (x, y, s, o = {}) => t(x, y, s.toUpperCase(), { size: 12, fill: C.muted, weight: 600, ls: 2, ...o });
const box = (x, y, w, h, { fill = C.panel, stroke = C.line, r = 14, sw = 1.5, dash = '' } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;

// Deterministic 5x5 mirrored pixel avatar, like the app's demo tokens.
export function pixelTile(seed, x, y, size, { color = C.mint, bg = C.panel2, stroke = C.line, r = 8 } = {}) {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const cell = size / 7;
  let out = `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="${bg}" stroke="${stroke}" stroke-width="1.5"/>`;
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 3; col++)
      if (rnd() > 0.45) {
        for (const c of col === 2 ? [2] : [col, 4 - col])
          out += `<rect x="${(x + cell * (c + 1)).toFixed(1)}" y="${(y + cell * (row + 1)).toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" fill="${color}"/>`;
      }
  return out;
}

export function shield(cx, cy, s, { fill = 'none', stroke = C.mint, sw = 3 } = {}) {
  const k = s / 100;
  return `<g transform="translate(${cx - 50 * k} ${cy - 55 * k}) scale(${k})"><path d="M50 4 L92 20 V52 C92 80 72 98 50 106 C28 98 8 80 8 52 V20 Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw / k}" stroke-linejoin="round"/>
  <path d="M30 70 L50 34 L70 70 Z" fill="none" stroke="${stroke}" stroke-width="${sw / k}" stroke-linejoin="round"/><path d="M22 70 H78" stroke="${stroke}" stroke-width="${sw / k}" stroke-linecap="round"/></g>`;
}

/* ---------- Figure: why now ---------- */
export function figContext() {
  const W = 1200, H = 600;
  let b = '';
  b += label(48, 58, 'Blur · monthly trading volume');
  // bars
  const base = 470, top = 130, hBig = base - top;
  b += `<line x1="60" y1="${base}" x2="440" y2="${base}" stroke="${C.line}" stroke-width="2"/>`;
  b += `<rect x="90" y="${top}" width="120" height="${hBig}" rx="6" fill="url(#bar1)"/>`;
  b += `<defs><linearGradient id="bar1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.violet}"/><stop offset="1" stop-color="${C.violet}" stop-opacity=".25"/></linearGradient></defs>`;
  b += t(150, top - 16, '$1.43B', { size: 28, weight: 700, anchor: 'middle' });
  const hSmall = Math.max(2, (hBig * 7) / 1430);
  b += `<rect x="290" y="${base - hSmall}" width="120" height="${hSmall}" fill="${C.coral}"/>`;
  b += t(350, base - 22, '<$7M', { size: 28, weight: 700, anchor: 'middle', fill: C.coral });
  b += t(150, base + 30, 'March 2023', { size: 15, fill: C.muted, anchor: 'middle' });
  b += t(350, base + 30, 'March 2026', { size: 15, fill: C.muted, anchor: 'middle' });
  b += t(350, 250, '−99.5%', { size: 54, weight: 700, anchor: 'middle', fill: C.text });
  b += t(350, 280, 'in three years', { size: 15, fill: C.muted, anchor: 'middle' });
  b += t(48, 560, 'Source: The Block, 12 Oct 2026', { size: 13, fill: C.dim });

  // timeline
  const X = 540, x0 = 600;
  b += label(X, 58, 'The venues of the last cycle');
  const ev = [
    ['2023', 'OpenSea Pro launches: zero fees, rewards for trading', C.muted],
    ['Mar 2026', 'OpenSea delays its SEA token; no new date', C.muted],
    ['6 Oct 2026', 'Abstract announces it will shut down on 15 Dec', C.muted],
    ['12 Oct 2026', 'Blur announces its website will close', C.gold],
    ['Oct 2026', 'This paper: a venue whose fees buy the floor', C.mint],
    ['12 Nov 2026', 'Blur website closes; Blend stops new loans', C.coral],
    ['15 Dec 2026', 'Abstract shuts down', C.coral],
  ];
  const y0 = 110, dy = 64;
  b += `<line x1="${x0}" y1="${y0 - 10}" x2="${x0}" y2="${y0 + dy * (ev.length - 1) + 10}" stroke="${C.line}" stroke-width="2"/>`;
  ev.forEach(([d, s, col], i) => {
    const y = y0 + i * dy;
    const me = col === C.mint;
    if (me) b += `<circle cx="${x0}" cy="${y}" r="14" fill="${C.mint}" opacity=".15"/>`;
    b += `<circle cx="${x0}" cy="${y}" r="${me ? 8 : 6}" fill="${me ? C.mint : C.bg}" stroke="${col}" stroke-width="3"/>`;
    b += t(x0 + 28, y - 4, d, { size: 13, fill: col === C.muted ? C.dim : col, weight: 700, ls: 1 });
    b += t(x0 + 28, y + 18, s, { size: 17, fill: me ? C.mint : C.text, weight: me ? 700 : 500 });
  });
  b += t(X, 560, 'Sources: Decrypt; The Block; CryptoTicker. Details in section 2.', { size: 13, fill: C.dim });
  return frame(W, H, b);
}

/* ---------- Figure: the system ---------- */
export function figSystem() {
  const W = 1200, H = 720;
  let b = '';
  const fees = [
    ['Marketplace', '2% of every sale'],
    ['Prediction markets', '3% of winnings'],
    ['Dice · coinflip · slots', 'half of the 2% edge'],
    ['Lottery · ticket raffles', '5% of pots'],
    ['IP licences', 'licences on vault art'],
  ];
  b += label(40, 50, 'Fees in');
  const fx = 40, fw = 250, fh = 78;
  fees.forEach(([a, s], i) => {
    const y = 70 + i * 100;
    b += box(fx, y, fw, fh, { fill: C.panel });
    b += t(fx + 20, y + 33, a, { size: 18, weight: 600 });
    b += t(fx + 20, y + 58, s, { size: 14, fill: C.muted });
    // curve into treasury
    const sy = y + fh / 2, ty = 300 + i * 18;
    b += `<path d="M${fx + fw} ${sy} C ${fx + fw + 50} ${sy}, ${370 - 50} ${ty}, 372 ${ty}" fill="none" stroke="${C.mint}" stroke-width="2" stroke-dasharray="2 7" stroke-linecap="round" opacity=".9" marker-end="url(#ah)"/>`;
  });
  // treasury
  const tx = 380, ty = 250, tw = 240, th = 200;
  b += box(tx, ty, tw, th, { fill: C.panel2, stroke: C.mintDim, sw: 2 });
  b += label(tx + 22, ty + 36, 'Treasury');
  b += t(tx + 22, ty + 70, 'One budget', { size: 22, weight: 700 });
  b += t(tx + 22, ty + 96, 'per collection', { size: 22, weight: 700 });
  b += `<rect x="${tx + 22}" y="${ty + 118}" width="${tw - 44}" height="16" rx="8" fill="${C.bg}" stroke="${C.line}"/>`;
  b += `<rect x="${tx + 22}" y="${ty + 118}" width="${(tw - 44) * 0.62}" height="16" rx="8" fill="${C.mint}"/>`;
  b += t(tx + 22, ty + 162, 'optional project share ≤ 50%', { size: 14, fill: C.muted });
  b += t(tx + 22, ty + 182, 'budgets never mix', { size: 13, fill: C.dim });

  // engine
  const ex = 700, ey = 250, ew = 240, eh = 200;
  b += `<path d="M${tx + tw} ${ty + th / 2} H ${ex - 6}" stroke="${C.mint}" stroke-width="2.5" marker-end="url(#ah)"/>`;
  b += t((tx + tw + ex) / 2, ty + th / 2 - 12, 'funds', { size: 13, fill: C.muted, anchor: 'middle' });
  b += box(ex, ey, ew, eh, { fill: C.panel2, stroke: C.mint, sw: 2 });
  b += label(ex + 22, ey + 36, 'BuybackEngine', { fill: C.mint });
  b += t(ex + 22, ey + 70, 'The rising bid', { size: 22, weight: 700 });
  // mini sawtooth
  const sx = ex + 22, sw = ew - 44, sy = ey + 160;
  let p = `M${sx} ${sy}`;
  const seg = [[0, 0], [0.3, -50], [0.3, -28], [0.62, -62], [0.62, -40], [1, -70]];
  seg.forEach(([fx2, fy]) => (p += ` L${sx + fx2 * sw} ${sy + fy}`));
  b += `<path d="${p}" fill="none" stroke="${C.mint}" stroke-width="3" stroke-linejoin="round"/>`;
  b += `<line x1="${sx}" y1="${sy - 48}" x2="${sx + sw}" y2="${sy - 48}" stroke="${C.gold}" stroke-dasharray="4 5" stroke-width="1.5"/>`;
  b += t(ex + 22, ey + 186, 'never above the budget', { size: 14, fill: C.muted });

  // holder
  const hx = 700, hy = 70, hw = 240, hh = 92;
  b += box(hx, hy, hw, hh, { fill: C.panel, r: 46 });
  b += t(hx + hw / 2, hy + 40, 'Any holder', { size: 19, weight: 700, anchor: 'middle' });
  b += t(hx + hw / 2, hy + 64, 'sells any token, any time', { size: 14, fill: C.muted, anchor: 'middle' });
  b += `<path d="M${hx + hw / 2} ${hy + hh} V ${ey - 6}" stroke="${C.gold}" stroke-width="2.5" marker-end="url(#ahg)"/>`;
  b += t(hx + hw / 2 + 12, (hy + hh + ey) / 2 + 5, 'NFT', { size: 13, fill: C.gold, weight: 600 });
  b += `<path d="M${hx + hw / 2 - 40} ${ey - 6} V ${hy + hh + 6}" stroke="${C.mint}" stroke-width="2" stroke-dasharray="3 5" marker-end="url(#ah)"/>`;
  b += t(hx + hw / 2 - 52, (hy + hh + ey) / 2 + 5, 'ETH', { size: 13, fill: C.mint, weight: 600, anchor: 'end' });

  // vault
  const vx = 1000, vy = 220, vw = 165, vh = 260;
  b += `<path d="M${ex + ew} ${ey + eh / 2} H ${vx - 6}" stroke="${C.gold}" stroke-width="2.5" marker-end="url(#ahg)"/>`;
  b += t((ex + ew + vx) / 2, ey + eh / 2 - 12, 'NFT', { size: 13, fill: C.gold, anchor: 'middle', weight: 600 });
  b += box(vx, vy, vw, vh, { fill: C.panel2, stroke: C.gold, sw: 2 });
  b += label(vx + 20, vy + 36, 'Vault', { fill: C.gold });
  b += shield(vx + vw / 2, vy + 110, 70, { stroke: C.gold, sw: 3 });
  b += t(vx + vw / 2, vy + 190, 'moving lock', { size: 17, weight: 700, anchor: 'middle' });
  b += t(vx + vw / 2, vy + 212, 'daily draw from 90 d', { size: 15, fill: C.muted, anchor: 'middle' });
  b += t(vx + vw / 2, vy + 240, 'art licensable meanwhile', { size: 12, fill: C.dim, anchor: 'middle' });

  // auction
  const ax = 700, ay = 560, aw = 240, ah = 110;
  b += box(ax, ay, aw, ah, { fill: C.panel });
  b += label(ax + 20, ay + 32, 'Dutch auction');
  let ac = '';
  for (let i = 0; i <= 40; i++) {
    const xx = ax + 20 + (i / 40) * (aw - 40);
    const yy = ay + 52 + 38 * (1 - Math.pow(0.5, i / 8));
    ac += (i ? ' L' : 'M') + xx.toFixed(1) + ' ' + yy.toFixed(1);
  }
  b += `<path d="${ac}" fill="none" stroke="${C.text}" stroke-width="2"/>`;
  b += t(ax + 20, ay + ah - 10, 'opens 16× reserve, halves daily', { size: 13, fill: C.muted });
  b += `<path d="M${vx + 40} ${vy + vh} C ${vx + 40} ${ay + 40}, ${ax + aw + 60} ${ay + ah / 2}, ${ax + aw + 6} ${ay + ah / 2}" fill="none" stroke="${C.gold}" stroke-width="2" stroke-dasharray="6 6" marker-end="url(#ahg)"/>`;
  b += `<path d="M${ax - 6} ${ay + ah / 2} C ${tx + tw / 2 + 60} ${ay + ah / 2}, ${tx + tw / 2} ${ay}, ${tx + tw / 2} ${ty + th + 8}" fill="none" stroke="${C.mint}" stroke-width="2.5" marker-end="url(#ah)"/>`;
  b += t(560, 640, 'proceeds return to the budget', { size: 14, fill: C.mint, anchor: 'middle', weight: 600 });

  // raffle
  const rx = 1000, ry = 560, rw = 165, rh = 110;
  b += box(rx, ry, rw, rh, { fill: C.panel });
  b += label(rx + 20, ry + 32, 'Vault raffle');
  b += t(rx + 20, ry + 60, 'to fee payers, by', { size: 15, weight: 600 });
  b += t(rx + 20, ry + 80, 'points; 1 in 5 buys', { size: 15, weight: 600 });
  b += t(rx + 20, ry + 98, 'go here after 30 d', { size: 13, fill: C.muted });
  b += `<path d="M${vx + vw - 40} ${vy + vh} V ${ry - 6}" stroke="${C.gold}" stroke-width="2" stroke-dasharray="6 6" marker-end="url(#ahg)"/>`;

  // points
  b += box(40, 600, 250, 70, { fill: C.bg, stroke: C.line, dash: '5 5' });
  b += t(60, 632, 'Points', { size: 17, weight: 700 });
  b += t(60, 655, 'earned for fees paid', { size: 14, fill: C.muted });
  b += `<path d="M${165} 578 V 594" stroke="${C.muted}" stroke-width="1.5" marker-end="url(#ahm)"/>`;
  b += `<path d="M290 652 C 380 700, 900 708, ${rx - 6} 650" fill="none" stroke="${C.muted}" stroke-width="1.5" stroke-dasharray="3 6" marker-end="url(#ahm)"/>`;
  b += t(640, 704, 'weights', { size: 12, fill: C.dim, anchor: 'middle' });
  return frame(W, H, b);
}

/* ---------- Figure: rising bid simulation ---------- */
export function simulateBid() {
  const dt = 1 / 24, days = 60;
  let budget = 2.2, base = 0.9, curve = 0.9;
  const growth = 0.10, step = 0.15, cap = 1.5, inflow = 0.062;
  const floor = (d) => 1 + 0.07 * Math.sin(d / 8.5) - 0.0015 * d;
  const pts = [], sales = [];
  for (let i = 0; i <= days / dt; i++) {
    const d = i * dt;
    const before = budget;
    budget += inflow * dt;
    if (before < curve) curve = Math.max(base, before);
    curve = Math.min(cap, curve + growth * base * dt);
    const bid = Math.min(curve, budget);
    const fl = floor(d);
    pts.push({ d, bid, curve, fl, budget, minBid: 0.1 * base });
    if (bid >= fl && bid >= 0.1 * base) {
      sales.push({ d, price: bid, limited: budget <= curve });
      budget -= bid;
      base = bid * (1 - step);
      curve = base;
    }
  }
  return { pts, sales, cap, days };
}

export function figBid() {
  const W = 1200, H = 600;
  const { pts, sales, cap, days } = simulateBid();
  const L = 90, R = 1150, T = 104, B = 500;
  const X = (d) => L + (d / days) * (R - L);
  const Y = (v) => B - (v / 1.65) * (B - T);
  let b = '';
  b += label(48, 48, 'The rising bid · illustrative run of the rules');
  for (const v of [0, 0.5, 1, 1.5]) {
    b += `<line x1="${L}" y1="${Y(v)}" x2="${R}" y2="${Y(v)}" stroke="${C.line}" stroke-width="1"/>`;
    b += t(L - 14, Y(v) + 5, v.toFixed(1), { size: 13, fill: C.dim, anchor: 'end' });
  }
  for (let d = 0; d <= days; d += 10) b += t(X(d), B + 26, d === 0 ? 'day 0' : `${d}`, { size: 13, fill: C.dim, anchor: 'middle' });
  b += t(L - 14, T - 22, 'ETH', { size: 12, fill: C.dim, anchor: 'end' });
  // cap
  b += `<line x1="${L}" y1="${Y(cap)}" x2="${R}" y2="${Y(cap)}" stroke="${C.coral}" stroke-dasharray="6 6" stroke-width="1.5" opacity=".8"/>`;
  b += t(R, Y(cap) - 10, 'owner’s cap 1.5', { size: 13, fill: C.coral, anchor: 'end' });
  const path = (key) => pts.map((p, i) => (i ? 'L' : 'M') + X(p.d).toFixed(1) + ' ' + Y(Math.min(1.65, p[key])).toFixed(1)).join(' ');
  // the bid only exists at or above the minimum bid (10% of the base)
  let bidPath = '', on = false;
  pts.forEach((p) => {
    const ok = p.bid >= p.minBid;
    if (ok) { bidPath += (on ? 'L' : 'M') + X(p.d).toFixed(1) + ' ' + Y(p.bid).toFixed(1) + ' '; }
    on = ok;
  });
  b += `<clipPath id="plot"><rect x="${L}" y="${T - 30}" width="${R - L}" height="${B - T + 30}"/></clipPath><g clip-path="url(#plot)">`;
  b += `<rect x="${L}" y="${Y(0.09)}" width="${R - L}" height="${B - Y(0.09)}" fill="${C.coral}" opacity=".07"/>`;
  b += `<path d="${path('budget')} L ${X(days)} ${B} L ${L} ${B} Z" fill="${C.violet}" opacity=".10"/>`;
  b += `<path d="${path('budget')}" fill="none" stroke="${C.violet}" stroke-width="1.5" opacity=".7"/>`;
  b += `<path d="${path('fl')}" fill="none" stroke="${C.gold}" stroke-width="2.5"/>`;
  b += `<path d="${path('curve')}" fill="none" stroke="${C.text}" stroke-width="1.5" stroke-dasharray="4 5" opacity=".55"/>`;
  b += `<path d="${bidPath}" fill="none" stroke="${C.mint}" stroke-width="9" opacity=".12"/>`;
  b += `<path d="${bidPath}" fill="none" stroke="${C.mint}" stroke-width="3.5" stroke-linejoin="round"/>`;
  b += `</g>`;
  b += t(R - 6, Y(0.09) + 22, 'no bid below the minimum (10% of base)', { size: 12, fill: C.coral, anchor: 'end', op: 0.9 });
  sales.forEach((s, i) => {
    b += `<circle cx="${X(s.d)}" cy="${Y(s.price)}" r="9" fill="${C.bg}" stroke="${C.gold}" stroke-width="3"/>`;
    b += `<circle cx="${X(s.d)}" cy="${Y(s.price)}" r="3.5" fill="${C.gold}"/>`;
    if (i > 0) b += t(X(s.d), Y(s.price) - 18, `sale ${s.price.toFixed(2)}`, { size: 12, fill: C.gold, anchor: 'middle', weight: 600 });
  });
  // annotations, in the empty band above the floor
  const note = (x, y, tx, ty, lines, col) => {
    b += `<path d="M${tx} ${ty} L ${x} ${y + 8}" stroke="${col}" stroke-width="1.2" opacity=".8"/><circle cx="${tx}" cy="${ty}" r="3" fill="${col}"/>`;
    lines.forEach((l, k) => (b += t(x + 6, y - 22 + k * 18, l, { size: 13.5, fill: col, weight: 600 })));
  };
  if (sales.length > 3) {
    const s2 = sales[2], s3 = sales[3];
    const dm = s2.d + (s3.d - s2.d) * 0.55, pm = pts.find((q) => q.d >= dm);
    note(X(dm) + 10, Y(1.30), X(dm), Y(pm.bid), ['budget-limited: the bid is the budget,', 'rising only as fees arrive'], C.mint);
    const s0 = sales[0];
    note(X(s0.d) + 26, Y(1.30), X(s0.d) + 4, Y(s0.price * 0.85) , ['two quick sales while the budget is full;', 'after each, the curve restarts 15% lower'], C.muted);
  }
  // legend
  const lg = [[C.mint, 'bid', ''], [C.text, 'curve', '4 5'], [C.gold, 'floor (cheapest seller)', ''], [C.violet, 'collection budget', '']];
  let lx = L;
  lg.forEach(([c, s, d]) => {
    b += `<line x1="${lx}" y1="${H - 40}" x2="${lx + 28}" y2="${H - 40}" stroke="${c}" stroke-width="3" ${d ? `stroke-dasharray="${d}"` : ''}/>`;
    b += t(lx + 38, H - 35, s, { size: 14, fill: C.muted });
    lx += 70 + s.length * 8;
  });
  b += t(R, H - 35, 'Model: fees 0.06 ETH a day, sellers accept at the floor', { size: 12, fill: C.dim, anchor: 'end' });
  return frame(W, H, b);
}

/* ---------- Figure: simulation results ---------- */
export function figResults() {
  const W = 1200, H = 600;
  const rows = [
    ['Steady fee inflow', '0.02–0.5 floors a day', 0.2, 0.2, '+0.2%', true],
    ['Market falling 70% a year', '', 0.1, 0.2, '+0.1–0.2%', true],
    ['Market rising 3× a year', 'cap set high enough', 0.1, 0.2, '+0.1–0.2%', true],
    ['60 days unfunded, then a lump', '30 floors at once', 0.2, 0.2, '+0.2%', true],
    ['Floor −60% overnight, guardian acts', 'worst purchase +0.3%', 0.2, 0.3, '+0.2%', true],
    ['One holder owns the supply', 'patient seller, cap 1.5', 17, 34, '+17–34%', false],
    ['Floor −60% overnight, nobody acts', 'first purchase only', 144, 144, '+144%', false],
  ];
  const L = 430, R = 1060, T = 110, rh = 62;
  const X = (v) => L + (v / 150) * (R - L);
  let b = '';
  b += label(48, 50, 'Average price paid above the floor · year of hourly trading, real contracts');
  for (const v of [0, 50, 100, 150]) {
    b += `<line x1="${X(v)}" y1="${T - 18}" x2="${X(v)}" y2="${T + rows.length * rh - 10}" stroke="${C.line}"/>`;
    b += t(X(v), T + rows.length * rh + 14, `+${v}%`, { size: 13, fill: C.dim, anchor: 'middle' });
  }
  rows.forEach(([a, s, lo, hi, txt, good], i) => {
    const y = T + i * rh;
    const col = good ? C.mint : C.coral;
    b += t(48, y + 20, a, { size: 17, weight: 600 });
    if (s) b += t(48, y + 42, s, { size: 13, fill: C.muted });
    const w = Math.max(9, X(hi) - L);
    if (lo !== hi) b += `<rect x="${L}" y="${y + 6}" width="${Math.max(5, X(lo) - L)}" height="26" rx="4" fill="${col}"/><rect x="${X(lo)}" y="${y + 6}" width="${Math.max(4, X(hi) - X(lo))}" height="26" rx="4" fill="${col}" opacity=".45"/>`;
    else b += `<rect x="${L}" y="${y + 6}" width="${w}" height="26" rx="4" fill="${col}"/>`;
    b += t(L + w + 14, y + 26, txt, { size: 18, weight: 700, fill: col });
  });
  b += `<line x1="40" y1="${T + 5 * rh - 16}" x2="${W - 40}" y2="${T + 5 * rh - 16}" stroke="${C.line}" stroke-dasharray="4 6"/>`;
  b += t(W - 48, T + 5 * rh - 26, 'the honest limits', { size: 13, fill: C.coral, anchor: 'end', weight: 600 });
  b += t(48, H - 26, 'Economics review simulation; 1.002 average paid/floor = +0.2%. Sellers accept at the floor.', { size: 13, fill: C.dim });
  return frame(W, H, b);
}

/* ---------- Figure: vault lifecycle ---------- */
export function figVault() {
  const W = 1200, H = 640;
  let b = '';
  b += label(48, 50, 'Life of a holding · the moving lock');
  // A: bought
  const y = 80, h = 250;
  b += box(48, y, 230, h, { fill: C.panel2 });
  b += pixelTile(7, 70, y + 22, 64, { color: C.gold });
  b += t(150, y + 50, 'Bought', { size: 22, weight: 700 });
  b += t(150, y + 76, 'at price P', { size: 15, fill: C.muted });
  b += `<rect x="70" y="${y + 112}" width="186" height="52" rx="10" fill="${C.bg}" stroke="${C.mint}"/>`;
  b += t(86, y + 135, '4 in 5', { size: 17, weight: 700, fill: C.mint });
  b += t(86, y + 154, 'moving lock', { size: 13, fill: C.muted });
  b += `<rect x="70" y="${y + 176}" width="186" height="52" rx="10" fill="${C.bg}" stroke="${C.violet}"/>`;
  b += t(86, y + 199, '1 in 5', { size: 17, weight: 700, fill: C.violet });
  b += t(86, y + 218, 'to players after 30 days', { size: 13, fill: C.muted });

  // B: the ramps
  const bx = 298, bw = 560;
  b += `<path d="M284 ${y + h / 2} H 290" stroke="${C.mint}" stroke-width="2.5" marker-end="url(#ah)"/>`;
  b += box(bx, y, bw, h, { fill: C.panel2, stroke: C.gold, sw: 2 });
  b += t(bx + 22, y + 34, 'From 90 days: a daily draw nobody can predict', { size: 18, weight: 700 });
  const px = bx + 40, pw = bw - 80, py = y + 56, ph = 132;
  const X = (d) => px + (Math.min(d, 400) / 400) * pw;
  b += `<rect x="${X(0)}" y="${py}" width="${X(90) - X(0)}" height="${ph}" fill="${C.bg}" opacity=".85"/>`;
  b += t((X(0) + X(90)) / 2, py + ph / 2 + 5, 'locked', { size: 12, fill: C.dim, anchor: 'middle', weight: 600, op: 0.8 });
  b += `<line x1="${px}" y1="${py + ph}" x2="${px + pw}" y2="${py + ph}" stroke="${C.line}"/>`;
  for (const [d, l] of [[0, '0'], [90, '90 d'], [182, '6 mo'], [365, '1 yr']]) b += t(X(d), py + ph + 18, l, { size: 12, fill: C.dim, anchor: 'middle' });
  // required floor (gold), left scale 100%..130%
  const Yf = (v) => py + 10 + (1.3 - v) / 0.3 * (ph - 30);
  const Yc = (v) => py + ph - 6 - (v / 5) * (ph - 40);
  const ramp = (d, a, z) => (d <= 90 ? a : d >= 365 ? z : a + (z - a) * (d - 90) / 275);
  let pf = '', pc = '';
  for (let d = 90; d <= 400; d += 5) {
    pf += (pf ? 'L' : 'M') + X(d).toFixed(1) + ' ' + Yf(ramp(d, 1.3, 1.0)).toFixed(1) + ' ';
    pc += (pc ? 'L' : 'M') + X(d).toFixed(1) + ' ' + Yc(ramp(d, 0.5, 5)).toFixed(1) + ' ';
  }
  b += `<path d="${pf}" fill="none" stroke="${C.gold}" stroke-width="3"/>`;
  b += `<path d="${pc}" fill="none" stroke="${C.mint}" stroke-width="3"/>`;
  b += t(X(86), Yf(1.3) + 5, '130% of P', { size: 13, fill: C.gold, weight: 600, anchor: 'end' });
  b += t(X(400), Yf(1.0) - 10, '100% of P', { size: 13, fill: C.gold, weight: 600, anchor: 'end' });
  b += t(X(86), Yc(0.5) + 5, '0.5% a day', { size: 13, fill: C.mint, weight: 600, anchor: 'end' });
  b += t(X(400), Yc(5) + 22, '5% a day', { size: 13, fill: C.mint, weight: 600, anchor: 'end' });
  b += `<line x1="${bx + 22}" y1="${y + h - 18}" x2="${bx + 44}" y2="${y + h - 18}" stroke="${C.gold}" stroke-width="3"/>`;
  b += t(bx + 52, y + h - 13, 'median floor needed', { size: 13, fill: C.muted });
  b += `<line x1="${bx + 220}" y1="${y + h - 18}" x2="${bx + 242}" y2="${y + h - 18}" stroke="${C.mint}" stroke-width="3"/>`;
  b += t(bx + 250, y + h - 13, 'chance of being drawn each day', { size: 13, fill: C.muted });

  // C: exit
  const cx = 878, cw = 274;
  b += `<path d="M${bx + bw + 4} ${y + h / 2} H ${cx - 6}" stroke="${C.mint}" stroke-width="2.5" marker-end="url(#ah)"/>`;
  b += box(cx, y, cw, h, { fill: C.panel2, stroke: C.mint, sw: 2 });
  b += label(cx + 20, y + 34, 'Then a Dutch auction', { fill: C.mint });
  const ax = cx + 20, aw = cw - 40, ay = y + 56, ah2 = 100;
  let pth = '';
  for (let i = 0; i <= 60; i++) {
    const d = (i / 60) * 4.5;
    const price = Math.max(1, 16 * Math.pow(0.5, d));
    const yy = ay + ah2 - (Math.log2(price) / 4) * ah2;
    pth += (i ? ' L' : 'M') + (ax + (i / 60) * aw).toFixed(1) + ' ' + yy.toFixed(1);
  }
  b += `<path d="${pth}" fill="none" stroke="${C.text}" stroke-width="2.5"/>`;
  b += `<line x1="${ax}" y1="${ay + ah2}" x2="${ax + aw}" y2="${ay + ah2}" stroke="${C.mint}" stroke-width="2"/>`;
  b += t(ax + aw, ay + 16, 'opens 16× the reserve', { size: 13, weight: 600, anchor: 'end' });
  b += t(ax + aw, ay + ah2 + 18, 'halves daily to the reserve', { size: 13, fill: C.mint, weight: 600, anchor: 'end' });
  b += t(cx + 20, y + 206, 'never below the floor:', { size: 15, weight: 700 });
  b += t(cx + 20, y + 228, 'an unlock is never a dump', { size: 15, weight: 700 });

  // rules strip
  const ry = 352;
  const chips = [
    ['Daily random draw', 'no date known in advance', C.mint],
    ['30-day median floor', 'a moment cannot move it', C.gold],
    ['Weekly cap', '5% of holdings at most', C.text],
    ['Prizes vest 30 days', 'no same-day dumping', C.violet],
  ];
  chips.forEach(([a, z, c], i) => {
    const x = 48 + i * 278;
    b += box(x, ry, 262, 82, { fill: C.panel });
    b += `<circle cx="${x + 22}" cy="${ry + 30}" r="6" fill="${c}"/>`;
    b += t(x + 38, ry + 36, a, { size: 17, weight: 700 });
    b += t(x + 38, ry + 60, z, { size: 14, fill: C.muted });
  });

  // facts
  const fy = 468;
  b += t(48, fy + 46, '2–5', { size: 56, weight: 700, fill: C.mint });
  b += t(190, fy + 22, 'tokens at most returned in one week,', { size: 16 });
  b += t(190, fy + 46, 'against 5–20 under the fixed lock.', { size: 15, fill: C.muted });
  b += t(640, fy + 46, '1 in 62', { size: 56, weight: 700, fill: C.gold });
  b += t(860, fy + 22, 'stays off the market:', { size: 16 });
  b += t(860, fy + 46, '1 in 50 bought, 1 in 5 to players.', { size: 15, fill: C.muted });
  b += t(48, H - 22, 'Model: test/econ/sim_moving_lock.py, 10,000 sales a year, 25% on FloorGuard, three years.', { size: 13, fill: C.dim });
  return frame(W, H, b);
}

/* ---------- Figure: one in fifty ---------- */
export function figFifty() {
  const W = 1200, H = 470;
  let b = '';
  b += label(48, 50, 'Tokens traded on FloorGuard');
  const s = 52, g = 12, x0 = 48, y0 = 80;
  for (let i = 0; i < 50; i++) {
    const r = Math.floor(i / 10), c = i % 10;
    const x = x0 + c * (s + g), y = y0 + r * (s + g);
    if (i === 37) {
      b += `<rect x="${x - 6}" y="${y - 6}" width="${s + 12}" height="${s + 12}" rx="12" fill="${C.mint}" opacity=".18"/>`;
      b += pixelTile(i + 3, x, y, s, { color: C.bg, bg: C.mint, stroke: C.mint });
    } else b += pixelTile(i + 3, x, y, s, { color: '#2A3D45', bg: C.panel, stroke: C.line });
  }
  const rx = 740;
  b += t(rx, 150, '1 in 50', { size: 92, weight: 700, fill: C.mint });
  b += t(rx, 196, 'tokens bought by the floor bid', { size: 22, weight: 600 });
  b += t(rx, 224, 'on any price path: the price cancels out', { size: 18, fill: C.muted });
  b += `<rect x="${rx}" y="262" width="410" height="100" rx="14" fill="${C.panel2}" stroke="${C.line}"/>`;
  b += t(rx + 22, 296, 'TOKENS BOUGHT =', { size: 12, fill: C.muted, weight: 600, ls: 2 });
  b += t(rx + 22, 334, '2% × (1 − project share) × traded', { size: 20, weight: 600, fill: C.text });
  b += t(rx, 396, 'With one purchase in five raffled to players,', { size: 15, fill: C.muted });
  b += t(rx, 418, 'about 1 in 62 stays off the market.', { size: 15, fill: C.gold, weight: 600 });
  return frame(W, H, b);
}

/* ---------- Figure: materiality ---------- */
export function figMateriality() {
  const W = 1200, H = 500;
  const rows = [
    ['2,500 sales a year', '5% on FloorGuard', '6 ETH', 0.07, 0.05],
    ['10,000 sales a year', '25% on FloorGuard', '122 ETH', 1.48, 1.11],
    ['30,000 sales a year', '25% on FloorGuard', '367 ETH', 4.45, 3.32],
    ['10,000 sales a year', '100% on FloorGuard', '489 ETH', 5.93, 4.42],
  ];
  const L = 420, R = 1000, T = 100, rh = 84;
  const X = (v) => L + (v / 6.5) * (R - L);
  let b = '';
  b += label(48, 50, 'Share of supply held in the Vault after three years · 10,000 tokens, 1 ETH floor');
  for (const v of [0, 2, 4, 6]) {
    b += `<line x1="${X(v)}" y1="${T - 16}" x2="${X(v)}" y2="${T + rows.length * rh - 14}" stroke="${C.line}"/>`;
    b += t(X(v), T + rows.length * rh + 10, `${v}%`, { size: 13, fill: C.dim, anchor: 'middle' });
  }
  rows.forEach(([a, s2, fee, old, now], i) => {
    const y = T + i * rh;
    b += t(48, y + 24, a, { size: 18, weight: 600 });
    b += t(48, y + 48, `${s2} · fees ${fee}`, { size: 14, fill: C.muted });
    b += `<rect x="${L}" y="${y + 4}" width="${Math.max(4, X(old) - L)}" height="20" rx="5" fill="none" stroke="${C.dim}" stroke-dasharray="4 4"/>`;
    b += t(Math.max(L + 4, X(old)) + 10, y + 19, `${old.toFixed(2)}%`, { size: 14, fill: C.dim, weight: 600 });
    b += `<defs><linearGradient id="mg${i}" x1="0" x2="1"><stop offset="0" stop-color="${C.mintDim}"/><stop offset="1" stop-color="${C.mint}"/></linearGradient></defs>`;
    b += `<rect x="${L}" y="${y + 30}" width="${Math.max(5, X(now) - L)}" height="30" rx="6" fill="url(#mg${i})"/>`;
    b += t(Math.max(L + 5, X(now)) + 12, y + 53, `${now.toFixed(2)}%`, { size: 21, weight: 700, fill: C.text });
  });
  b += `<rect x="${W - 330}" y="34" width="22" height="12" rx="3" fill="none" stroke="${C.dim}" stroke-dasharray="4 4"/>` + t(W - 300, 45, 'fixed lock', { size: 13, fill: C.dim });
  b += `<rect x="${W - 200}" y="34" width="22" height="12" rx="3" fill="${C.mint}"/>` + t(W - 170, 45, 'moving lock', { size: 13, fill: C.muted });
  b += t(48, H - 24, 'Economics review model, rerun with both rules (test/econ/sim_moving_lock.py). The players’ share returns a fifth of purchases.', { size: 13, fill: C.dim });
  return frame(W, H, b);
}

/* ---------- Figure: control ---------- */
export function figControl() {
  const W = 1200, H = 560;
  let b = '';
  b += label(48, 50, 'Who controls what');
  // owner
  b += box(48, 80, 520, 200, { fill: C.panel2, stroke: C.line });
  b += t(72, 122, 'Owner', { size: 26, weight: 700 });
  b += t(72, 148, 'configures every contract; chooses who may spend', { size: 15, fill: C.muted });
  const steps = [['Single key', C.coral], ['Multisig', C.gold], ['Multisig + timelock', C.mint]];
  steps.forEach(([s, c], i) => {
    const x = 72 + i * 145, pw = i === 2 ? 172 : 128;
    b += `<rect x="${x}" y="182" width="${pw}" height="46" rx="23" fill="${C.bg}" stroke="${c}" stroke-width="2"/>`;
    b += t(x + pw / 2, 211, s, { size: 15, weight: 600, anchor: 'middle', fill: c });
    if (i < 2) b += `<path d="M${x + 130} 205 H ${x + 143}" stroke="${C.muted}" stroke-width="1.5"/>`;
  });
  b += t(72, 258, 'recommended: a multisig behind the timelock the deploy script creates', { size: 13, fill: C.dim });

  b += box(48, 300, 520, 150, { fill: C.panel2, stroke: C.line });
  b += t(72, 342, 'Guardian', { size: 26, weight: 700 });
  b += t(72, 368, 'a fast key for a crash, while the owner is slow', { size: 15, fill: C.muted });
  b += `<rect x="72" y="388" width="180" height="42" rx="21" fill="${C.bg}" stroke="${C.mint}"/>` + t(162, 415, '↓ lower the bid', { size: 15, anchor: 'middle', fill: C.mint, weight: 600 });
  b += `<rect x="268" y="388" width="200" height="42" rx="21" fill="${C.bg}" stroke="${C.mint}"/>` + t(368, 415, '❚❚ pause a collection', { size: 15, anchor: 'middle', fill: C.mint, weight: 600 });

  // cannot reach
  b += box(610, 80, 542, 370, { fill: C.bg, stroke: C.gold, sw: 2, dash: '' });
  b += shield(660, 130, 54, { stroke: C.gold, sw: 3 });
  b += t(700, 122, 'Beyond the owner’s reach', { size: 24, weight: 700, fill: C.gold });
  b += t(700, 148, 'enforced in the contracts', { size: 14, fill: C.muted });
  const items = ['Escrowed offers', 'Accrued project shares', 'Prizes that already have a winner', 'Stakes in a void market', 'Funds reserved for open bets', 'The games bankroll (its share holders’)'];
  items.forEach((s, i) => {
    const y = 196 + i * 40;
    b += `<circle cx="650" cy="${y - 6}" r="11" fill="none" stroke="${C.gold}" stroke-width="2"/><path d="M644 ${y - 6} l4 4 l8 -8" fill="none" stroke="${C.gold}" stroke-width="2"/>`;
    b += t(674, y, s, { size: 17, weight: 500 });
  });
  b += t(48, H - 70, 'The owner cannot withdraw from the Treasury directly, but chooses who may spend, so it must be trusted.', { size: 15, fill: C.muted });
  b += t(48, H - 42, 'Next step (open problem 6): each collection’s settings held by its own community multisig, with or without a token.', { size: 15, fill: C.muted });
  return frame(W, H, b);
}

/* ---------- Figure: roadmap ---------- */
export function figRoadmap() {
  const W = 1200, H = 520;
  const ph = [
    ['0', 'Open', 'Contributors engaged'],
    ['1', 'Testnet', 'Two weeks without an unexplained incident'],
    ['2', 'Audit the core', 'Findings fixed and re-reviewed'],
    ['3', 'First community', 'Real trades, real buybacks, published figures'],
    ['4', 'Engagement', 'Per module, audited, legally sound'],
    ['5', 'Community control', 'Owner powers reduced to the minimum'],
  ];
  let b = '';
  b += label(48, 50, 'Roadmap · no dates, only exit criteria');
  const w = 182, gap = 8, base = 450;
  ph.forEach(([n, a, c], i) => {
    const x = 48 + i * (w + gap);
    const h = 150 + i * 46;
    const y = base - h;
    const now = i === 0;
    b += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${now ? C.panel2 : C.panel}" stroke="${now ? C.mint : C.line}" stroke-width="${now ? 2 : 1.5}"/>`;
    b += t(x + 18, y + 52, n, { size: 44, weight: 700, fill: now ? C.mint : C.dim });
    const tl = a.length > 13 ? [a.slice(0, a.lastIndexOf(' ')), a.slice(a.lastIndexOf(' ') + 1)] : [a];
    tl.forEach((s2, k) => (b += t(x + 18, y + 84 + k * 22, s2, { size: 18, weight: 700 })));
    // wrap criterion
    const words = c.split(' ');
    let line = '', ly = y + 112 + (tl.length - 1) * 22;
    words.forEach((wd) => {
      if ((line + ' ' + wd).trim().length > 19) { b += t(x + 18, ly, line.trim(), { size: 13.5, fill: C.muted }); line = wd; ly += 19; }
      else line += ' ' + wd;
    });
    b += t(x + 18, ly, line.trim(), { size: 13.5, fill: C.muted });
    if (now) b += `<rect x="${x + w - 90}" y="${y + 22}" width="72" height="24" rx="12" fill="${C.mint}"/>` + t(x + w - 54, y + 39, 'NOW', { size: 12, weight: 700, fill: C.bg, anchor: 'middle', ls: 2 });
  });
  b += t(48, H - 30, 'Each phase starts when the one before has met its criterion.', { size: 14, fill: C.muted });
  return frame(W, H, b);
}

export const FIGURES = {
  context: figContext,
  system: figSystem,
  bid: figBid,
  results: figResults,
  vault: figVault,
  fifty: figFifty,
  materiality: figMateriality,
  control: figControl,
  roadmap: figRoadmap,
};
