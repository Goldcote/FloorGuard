# The design paper as PDF and Word

`docs/FLOORGUARD-V1.md` is the text of record. This folder turns it into a
designed PDF and an editable Word file: the text lives in `src/content.mjs`
(keep it in step with the Markdown), the figures are drawn in `src/figures.mjs`,
and the screenshots in `src/img/` are the web app in demo mode.

You need Node 22 and Google Chrome (the scripts call it headless to draw the
figures and print the PDF; the path in `src/render.mjs` is the macOS one).
Poppler's `pdftotext` is used to put page numbers in the contents.

```bash
npm install
```

```bash
npm run build
```

The files are written to `out/`. Published copies are attached to the
[design paper release](https://github.com/Goldcote/FloorGuard/releases/tag/paper-v1).

The Space Grotesk font is under the SIL Open Font License 1.1.
