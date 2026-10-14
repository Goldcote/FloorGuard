// Builds out/FloorGuard-v1-design-paper.docx from content.mjs: native Word
// text, headings, tables and lists, with the PDF's artwork as images.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink, ImageRun, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, AlignmentType, HeadingLevel, LevelFormat, Footer, PageNumber,
  TabStopType, VerticalAlign, HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType,
  PageBreak,
} from 'docx';
import { META, PARTS, BLOCKS, inline } from './content.mjs';
import { FIGURES } from './figures.mjs';
import { SHOT } from './build-assets.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const A = join(ROOT, 'build', 'assets');
const OUT = join(ROOT, 'out');
mkdirSync(OUT, { recursive: true });

// A4 in DXA, 2.2 cm side margins
const PAGE = { width: 11906, height: 16838 };
const MARGIN = { top: 1134, bottom: 1300, left: 1247, right: 1247, footer: 560 };
const W = PAGE.width - MARGIN.left - MARGIN.right; // 9412
const PX = Math.round(W / 15); // content width in px at 96 dpi

const COL = { ink: '18232A', head: '0B1216', muted: '5A6B72', accent: '0B8F6B', mint: '3DE8B4', dark: '0E171C', night: '0A1014', rule: 'E2E8E7', zebra: 'F6F9F8' };
const HF = 'Arial';
const BF = 'Georgia';
const MF = 'Consolas';

const pad = (n) => String(n).padStart(2, '0');
const img = (f) => readFileSync(join(A, f));

function runs(md, o = {}) {
  return inline(md).map((r) => {
    const tr = new TextRun({
      text: r.text,
      bold: r.b || o.bold,
      italics: r.i || o.italics,
      font: r.code ? MF : o.font,
      size: r.code ? (o.size ? o.size - 2 : 17) : o.size,
      color: r.link ? COL.accent : r.code ? '0A6E53' : o.color,
      underline: r.link ? { color: 'A7D8C8' } : undefined,
      shading: r.code && !o.noCodeShade ? { type: ShadingType.CLEAR, fill: 'EEF5F3', color: 'auto' } : undefined,
    });
    return r.link ? new ExternalHyperlink({ link: r.link, children: [tr] }) : tr;
  });
}

const P = (md, o = {}) =>
  new Paragraph({ children: runs(md, o), alignment: o.align ?? AlignmentType.LEFT, spacing: { after: o.after ?? 140, line: o.line ?? 300 }, ...(o.p || {}) });

const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const noBorders = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
const line = (c = COL.rule, s = 4) => ({ style: BorderStyle.SINGLE, size: s, color: c });

function cell(children, { w, fill, borders, margins, vAlign } = {}) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: fill ? { type: ShadingType.CLEAR, fill, color: 'auto' } : undefined,
    borders,
    margins: margins ?? { top: 100, bottom: 100, left: 140, right: 140 },
    verticalAlign: vAlign,
    children,
  });
}

function table(b) {
  const widths = b.widths.map((f) => Math.round(f * W));
  widths[widths.length - 1] += W - widths.reduce((a, c) => a + c, 0);
  const cb = { top: line(), bottom: line(), left: line(COL.rule), right: line(COL.rule) };
  const head = new TableRow({
    tableHeader: true,
    children: b.head.map((h, i) => cell([new Paragraph({ children: runs(h.toUpperCase(), { font: HF, size: 15, bold: true, color: 'E8F0F0', noCodeShade: true }) })], { w: widths[i], fill: COL.dark, borders: { ...cb, top: line(COL.dark), left: line(COL.dark), right: line(COL.dark) }, margins: { top: 110, bottom: 110, left: 140, right: 140 } })),
  });
  const pad_ = b.compact ? 60 : 90;
  const rows = b.rows.map((r, ri) =>
    new TableRow({
      cantSplit: true,
      children: r.map((x, i) => cell([new Paragraph({ children: runs(x, { font: HF, size: 17, color: i === 0 ? COL.head : '22323A', bold: i === 0 || undefined, noCodeShade: true }), spacing: { line: 260 } })], { w: widths[i], fill: ri % 2 ? COL.zebra : 'FFFFFF', borders: cb, margins: { top: pad_, bottom: pad_, left: 140, right: 140 } })),
    }),
  );
  return [new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: widths, rows: [head, ...rows], borders: { top: line(), bottom: line(), left: line(), right: line(), insideHorizontal: line(), insideVertical: line() } }), spacer(160)];
}

const spacer = (after = 120) => new Paragraph({ spacing: { after, before: 0 }, children: [] });

function boxed(children, { fill, left, border = COL.rule }) {
  return [
    new Table({
      width: { size: W, type: WidthType.DXA },
      columnWidths: [W],
      borders: noBorders,
      rows: [new TableRow({ cantSplit: true, children: [cell(children, { w: W, fill, borders: { top: line(border), bottom: line(border), right: line(border), left: { style: BorderStyle.SINGLE, size: 36, color: left } }, margins: { top: 180, bottom: 120, left: 260, right: 260 } })] })],
    }),
    spacer(200),
  ];
}

function figure(file, w, h, caption, label) {
  const width = PX, height = Math.round((PX * h) / w);
  return [
    new Paragraph({ keepNext: true, alignment: AlignmentType.CENTER, spacing: { before: 120, after: 80 }, children: [new ImageRun({ type: file.endsWith('.png') ? 'png' : 'jpg', data: img(file), transformation: { width, height }, altText: { title: label, description: caption.replace(/[*`]/g, ''), name: label } })] }),
    new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: label.toUpperCase() + '   ', font: HF, size: 14, bold: true, color: COL.accent }), ...runs(caption, { font: HF, size: 15, color: COL.muted })] }),
  ];
}

// Full-bleed page image, floating behind the text layer.
function fullPage(file, title) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 240 },
    children: [
      new ImageRun({
        type: 'jpg',
        data: img(file),
        transformation: { width: 794, height: 1123 },
        floating: { horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 }, verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 }, wrap: { type: TextWrappingType.NONE }, behindDocument: true, allowOverlap: true },
        altText: { title, description: title, name: title },
      }),
    ],
  });
}

const fullSection = (file, title) => ({
  properties: { page: { size: PAGE, margin: { top: 0, bottom: 0, left: 0, right: 0, header: 0, footer: 0 } } },
  children: [fullPage(file, title)],
});

const footer = new Footer({
  children: [
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: W }],
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: COL.rule, space: 6 } },
      children: [
        new TextRun({ text: 'FloorGuard v1  ·  Design paper', font: HF, size: 14, color: '8A9AA0', bold: true }),
        new TextRun({ children: ['\t', PageNumber.CURRENT], font: HF, size: 16, color: COL.accent, bold: true }),
      ],
    }),
  ],
});

const contentSection = (children) => ({
  properties: { page: { size: PAGE, margin: MARGIN } },
  footers: { default: footer },
  children,
});

function sectionHead(b, first) {
  const out = [];
  out.push(new Paragraph({ pageBreakBefore: !first && !!b.newPage, keepNext: true, spacing: { before: first ? 0 : 360, after: 40 }, border: { top: { style: BorderStyle.SINGLE, size: 12, color: COL.dark, space: 10 } }, children: [new TextRun({ text: `SECTION ${pad(b.n)}`, font: HF, size: 15, bold: true, color: COL.accent, characterSpacing: 60 })] }));
  out.push(new Paragraph({ heading: HeadingLevel.HEADING_1, keepNext: true, children: [new TextRun({ text: `${pad(b.n)}  `, color: COL.accent, bold: false }), new TextRun({ text: b.title })] }));
  if (b.sub) out.push(new Paragraph({ keepNext: true, spacing: { after: 200 }, children: [new TextRun({ text: b.sub, font: HF, size: 22, color: COL.muted })] }));
  return out;
}

function cards(b) {
  const cols = b.cols === 3 ? 3 : 2;
  const w = Math.floor(W / cols);
  const widths = Array(cols).fill(w);
  widths[cols - 1] += W - w * cols;
  const rows = [];
  for (let i = 0; i < b.items.length; i += cols) {
    const slice = b.items.slice(i, i + cols);
    rows.push(new TableRow({
      cantSplit: true,
      children: widths.map((cw, k) => {
        const it = slice[k];
        if (!it) return cell([new Paragraph({ children: [] })], { w: cw, borders: { top: none, bottom: none, left: none, right: none } });
        const [t, s] = it;
        const kids = [];
        if (b.numbered) kids.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: pad(i + k + 1), font: HF, size: 30, color: COL.accent })] }));
        kids.push(new Paragraph({ spacing: { after: 60 }, children: runs(t, { font: HF, size: 19, bold: true, color: COL.head }) }));
        kids.push(new Paragraph({ spacing: { after: 40, line: 264 }, children: runs(s, { size: 17, color: '33444B' }) }));
        return cell(kids, { w: cw, fill: 'FAFCFB', borders: { top: line('FFFFFF', 18), bottom: line('FFFFFF', 18), left: line('FFFFFF', 18), right: line('FFFFFF', 18) }, margins: { top: 160, bottom: 140, left: 180, right: 180 } });
      }),
    }));
  }
  return [new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: widths, borders: noBorders, rows }), spacer(200)];
}

function stats(b) {
  const w = Math.floor(W / b.items.length);
  const widths = b.items.map(() => w);
  widths[widths.length - 1] += W - w * b.items.length;
  return [
    new Table({
      width: { size: W, type: WidthType.DXA },
      columnWidths: widths,
      borders: noBorders,
      rows: [new TableRow({ cantSplit: true, children: b.items.map(([n, s], i) => cell([
        new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: n, font: HF, size: 40, bold: true, color: COL.mint })] }),
        new Paragraph({ spacing: { line: 240 }, children: [new TextRun({ text: s, font: HF, size: 15, color: 'AFC0C4' })] }),
      ], { w: widths[i], fill: COL.night, borders: { top: line(COL.night), bottom: line(COL.night), left: line(i ? '1E2C33' : COL.night), right: line(COL.night) }, margins: { top: 220, bottom: 220, left: 200, right: 160 } })) })],
    }),
    spacer(200),
  ];
}

function renderBlocks() {
  const sections = [];
  let cur = null, fig = 0, firstInSection = true;
  for (const b of BLOCKS) {
    switch (b.t) {
      case 'part':
        sections.push(fullSection(`page-part${b.part}.jpg`, `Part ${PARTS[b.part].n}: ${PARTS[b.part].title}`));
        cur = []; sections.push(contentSection(cur)); firstInSection = true;
        break;
      case 'h1':
        cur.push(...sectionHead(b, firstInSection)); firstInSection = false;
        break;
      case 'h2': cur.push(new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, children: [new TextRun(b.title)] })); break;
      case 'lead': cur.push(P(b.md, { font: HF, size: 23, color: '22323A', align: AlignmentType.LEFT, line: 320, after: 200 })); break;
      case 'p': cur.push(P(b.md)); break;
      case 'ul': b.items.forEach((i) => cur.push(new Paragraph({ numbering: { reference: 'dots', level: 0 }, alignment: AlignmentType.LEFT, spacing: { after: 100, line: 290 }, children: runs(i) }))); cur.push(spacer(80)); break;
      case 'ol': b.items.forEach((i) => cur.push(new Paragraph({ numbering: { reference: 'nums', level: 0 }, alignment: AlignmentType.LEFT, spacing: { after: 100, line: 290 }, children: runs(i) }))); cur.push(spacer(80)); break;
      case 'quote':
        cur.push(new Paragraph({ spacing: { before: 200, after: 280, line: 340 }, indent: { left: 200 }, shading: { type: ShadingType.CLEAR, fill: 'EAF8F3', color: 'auto' }, border: { left: { style: BorderStyle.SINGLE, size: 36, color: COL.mint, space: 14 } }, children: runs(b.md, { font: HF, size: 26, color: COL.head }) }));
        break;
      case 'stats': cur.push(...stats(b)); break;
      case 'formula':
        cur.push(...boxed(b.lines.map((l) => new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: l, font: MF, size: 17, color: COL.mint })] })), { fill: COL.night, left: COL.mint, border: COL.night }));
        break;
      case 'cards': cur.push(...cards(b)); break;
      case 'table': cur.push(...table(b)); break;
      case 'fig': {
        fig++;
        const svg = FIGURES[b.id]();
        const [, w, h] = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
        cur.push(...figure(`fig-${b.id}.png`, +w, +h, b.caption, `Figure ${fig}`));
        break;
      }
      case 'shot':
        cur.push(...figure(`shot-${b.img}.png`, SHOT.w, SHOT.h, b.caption + ' *Demo mode: simulated data, play money.*', 'In the app'));
        break;
      case 'callout': {
        const k = { note: ['EEF9F5', COL.mint, 'BFE9DA', '0A6E53'], warn: ['FFF2F0', 'FF7A6B', 'FBD1CA', 'B2382A'], status: ['FFF7E8', 'F5B94A', 'F3D9A4', '6B4A06'] }[b.kind];
        cur.push(...boxed([
          new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: b.title, font: HF, size: 21, bold: true, color: k[3] })] }),
          P(b.md, { size: 19, after: 60 }),
        ], { fill: k[0], left: k[1], border: k[2] }));
        break;
      }
      case 'sources':
        cur.push(new Paragraph({ spacing: { before: 120, after: 80 }, border: { top: { style: BorderStyle.SINGLE, size: 4, color: COL.rule, space: 8 } }, children: [new TextRun({ text: 'SOURCES', font: HF, size: 15, bold: true, color: COL.accent, characterSpacing: 40 })] }));
        b.items.forEach(([t, u], i) => cur.push(new Paragraph({ spacing: { after: 60, line: 240 }, children: [new TextRun({ text: `${i + 1}. ${t} `, font: HF, size: 15, color: '33444B' }), new ExternalHyperlink({ link: u, children: [new TextRun({ text: u.replace(/^https?:\/\//, ''), font: HF, size: 14, color: COL.accent })] })] })));
        cur.push(spacer(160));
        break;
      case 'glossary':
        b.items.forEach(([t, d]) => cur.push(new Paragraph({ spacing: { after: 90 }, indent: { left: 160 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: COL.mint, space: 10 } }, children: [new TextRun({ text: t + '  ', font: HF, bold: true, size: 19, color: COL.head }), ...runs(d, { size: 18, color: '33444B' })] })));
        cur.push(spacer(160));
        break;
      default:
        throw new Error('unknown block ' + b.t);
    }
  }
  return sections;
}

function frontMatter() {
  const c = [];
  c.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: 'FLOORGUARD V1 · DESIGN PAPER', font: HF, size: 15, bold: true, color: COL.accent, characterSpacing: 60 })] }));
  c.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(META.title)] }));
  c.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: META.subtitle, font: HF, size: 26, color: '33444B' })] }));
  c.push(P(META.intro, { size: 18, color: COL.muted, after: 240 }));
  c.push(...boxed([
    new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: '●  Status, stated first', font: HF, size: 21, bold: true, color: '6B4A06' })] }),
    ...META.status.map((s) => new Paragraph({ numbering: { reference: 'dots', level: 0 }, spacing: { after: 60, line: 270 }, children: runs(s, { size: 18 }) })),
  ], { fill: 'FFF7E8', left: 'F5B94A', border: 'F3D9A4' }));
  c.push(new Paragraph({ spacing: { before: 200, after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: COL.dark, space: 4 } }, children: [new TextRun({ text: 'CONTENTS', font: HF, size: 16, bold: true, color: COL.accent, characterSpacing: 60 })] }));
  for (const b of BLOCKS) {
    if (b.t === 'part') c.push(new Paragraph({ spacing: { before: 140, after: 50 }, children: [new TextRun({ text: `${PARTS[b.part].n}\t`, font: HF, size: 20, bold: true, color: COL.accent }), new TextRun({ text: PARTS[b.part].title, font: HF, size: 20, bold: true, color: COL.head })], tabStops: [{ type: TabStopType.LEFT, position: 560 }] }));
    if (b.t === 'h1') c.push(new Paragraph({ spacing: { after: 30 }, indent: { left: 560 }, tabStops: [{ type: TabStopType.LEFT, position: 1100 }], children: [new TextRun({ text: `${pad(b.n)}\t`, font: HF, size: 18, color: '8A9AA0', bold: true }), new TextRun({ text: b.title, font: HF, size: 18, color: '2A3A41' })] }));
  }
  return contentSection(c);
}

const doc = new Document({
  creator: 'FloorGuard contributors',
  title: 'FloorGuard v1: Design paper',
  description: META.subtitle,
  styles: {
    default: { document: { run: { font: BF, size: 20, color: COL.ink }, paragraph: { spacing: { line: 300 } } } },
    paragraphStyles: [
      { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { font: HF, size: 60, bold: true, color: COL.head }, paragraph: { spacing: { after: 100 } } },
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: HF, size: 44, bold: true, color: COL.head }, paragraph: { spacing: { before: 0, after: 200 }, outlineLevel: 0, keepNext: true } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: HF, size: 25, bold: true, color: COL.head }, paragraph: { spacing: { before: 300, after: 100 }, outlineLevel: 1, keepNext: true } },
    ],
  },
  numbering: {
    config: [
      { reference: 'dots', levels: [{ level: 0, format: LevelFormat.BULLET, text: '■', alignment: AlignmentType.LEFT, style: { run: { color: COL.mint, size: 14 }, paragraph: { indent: { left: 360, hanging: 260 } } } }] },
      { reference: 'nums', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1', alignment: AlignmentType.LEFT, style: { run: { font: HF, bold: true, color: COL.accent }, paragraph: { indent: { left: 400, hanging: 300 } } } }] },
    ],
  },
  sections: [fullSection('page-cover.jpg', 'FloorGuard v1 cover'), frontMatter(), ...renderBlocks(), fullSection('page-back.jpg', 'Build it with us')],
});

const out = join(OUT, 'FloorGuard-v1-design-paper.docx');
writeFileSync(out, await Packer.toBuffer(doc));
console.log(out);
