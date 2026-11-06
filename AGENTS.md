# HanZiFun Agent Notes

## Project Context

HanZiFun is a static, offline-first Chinese handwriting practice workbook generator for children. The current implementation is an HTML/Tailwind CSS/custom CSS/JavaScript application with an npm-only build toolchain.

Use this directory as the project root for future work:

```text
/Users/rickytan/Code/HanZiFun
```

## Current Implementation

- Entry point: `index.html`
- Tailwind source: `src/tailwind.css`
- Generated Tailwind utilities: `tailwind.css`
- Domain and print styles: `style.css`
- App logic: `app.js`
- Core bundled stroke data: `data/strokes.js`
- On-demand stroke index: `data/stroke-index.js`
- Generated stroke chunks: `data/characters/`
- Production stroke archives: `data/strokes-pack-NNN.zip`
- Vendored ZIP extraction runtime: `vendor/fflate.min.js`
- Content presets: `data/content-templates.js`
- Data/build scripts: `scripts/`
- Production output: `dist/` (ignored by Git)
- Product requirements: `README.md`
- Design philosophy and visual rules: `DESIGN.md`
- Data attribution: `NOTICE.md`

The app preloads 28 core characters and supports all 9574 single-codepoint upstream characters through multiple ZIP packs. Each JSON chunk contains 50 characters; each ZIP pack contains up to 250 characters. The first 3500 come from the first-level common-character table; the remaining characters are upstream single-codepoint data sorted by Unicode code point. HTTP/PWA loads only the pack containing the needed chunk and selectively extracts entries with fflate; `file://` falls back to generated script chunks.

Templates currently implemented:

- Tracing practice
- Stroke-order breakdown
- Blank practice paper
- Article tracing with one visible input character per cell

Tianzi and Mizi are grid styles, not templates. The selected grid style applies to tracing, stroke-order breakdown, blank paper, and article tracing.

## Technical Direction

- Keep the app static and offline-capable.
- Avoid CDN/runtime network dependencies.
- Use Tailwind v4 utilities for application UI layout. Keep Preflight disabled and retain domain-specific paper, SVG, and print rules in `style.css`.
- Prefer SVG for character strokes, grids, arrows, and print-safe rendering.
- Keep print layout accurate in millimeters.
- Support paper sizes A5, A4, A3, and Letter.
- Support portrait and landscape orientation.
- All settings should update the preview immediately. The app should be WYSIWYG.
- Use one-tap segmented controls for short, stable option sets; reserve select menus for long or dynamic lists and number inputs for exact measurements.
- Use minus/input/plus steppers for discrete numeric settings, preserving direct entry, bounds, decimal steps, and mobile touch targets. Keep continuous visual adjustments as sliders.
- Persist settings and optionally input text in `localStorage` with a `settingsVersion`.
- Treat mobile as a first-class responsive target: scaled paper preview, no page-level horizontal scrolling, touch-friendly controls.
- Support PWA installation with a manifest, service worker, app icons, standalone display, and basic offline caching.
- Direct PDF export uses locally vendored jsPDF and native PDF path/line/text primitives. Never rasterize the whole page through Canvas or add a full-page image. Desktop printing may use `window.print()`. On mobile, detect the platform (iOS/iPadOS, including the iPadOS desktop user agent, or Android/HarmonyOS) and open the native share sheet with a generated PDF so the user can choose a printer; if file sharing is unavailable or rejected, fall back to the native print dialog and then a PDF download, because some mobile browsers ignore direct print calls.
- Built-in content templates include the 3500 common characters in 100-character groups, 100 Tang poems, selected Song Ci poems, the full San Zi Jing plus sections, and selected Shi Jing poems. Regenerate them with `npm run content:data` from a local `chinese-poetry` extract when needed.
- While an on-demand stroke ZIP is loading or decompressing, expose an explicit loading state and render pending grid glyphs with the browser's regular-script fallback stack at a size close to the final SVG strokes.
- After the initial page has been stable for 15 seconds, warm unused stroke ZIP packs in small batches through the Service Worker cache, falling back to low-priority HTML5 `prefetch` hints when no Service Worker is available. Exclude packs involved in the current page, defer while active stroke loads are running, and skip on save-data, 2G, offline, or `file://` contexts.
- Stroke data comes from `hanzi-writer-data`, derived from Make Me A Hanzi. Preserve attribution and license notes when expanding data.

## Product Decisions

- Target users: both parents and teachers.
- Target character coverage: all single-codepoint characters available in `hanzi-writer-data@2.0.1`.
- Do not bundle the full upstream character data into the main payload. A rough `hanzi-writer-data@2.0.1` estimate showed a 3500-character gzip sample around 3.95MB, above the 200KB direct-bundle threshold.
- Preferred data strategy: keep a tiny built-in set, split the full upstream data into ZIP packs of up to 250 characters, selectively fetch the pack containing the needed chunk, extract JSON entries with fflate, keep a 16-chunk LRU in memory, and let the Service Worker cache fetched ZIP packs. Preserve script chunks for direct `file://` use, but exclude them from `dist/`.
- Required formal templates: tracing practice, stroke-order breakdown, blank practice paper, and article tracing. Tianzi/Mizi is an independent grid-style setting shared by all templates.
- Blank practice paper does not require input text or stroke data. It should generate printable Tianzi or Mizi grid pages directly from layout settings.
- Stroke order is for print, not animation-first. Prioritize static clarity: numbers, start dots, direction arrows, and step breakdowns.
- Header information should be template-driven and optional: blank, simple title, homework, class, and teacher-style variants.
- Footer style is independent from the header and supports no footer, bottom-right page numbers, or centered page numbers.
- Standard tracing supports 1-6 rows per character, independently adjustable horizontal cell gaps and row gaps, and an optional guide character outside the grid strip.
- Horizontal cell gaps must support a true `0mm`; SVG grid frames extend to the cell boundary and joined cells omit their left frame so shared edges render exactly once.
- Standard tracing rows always fill the available width with whole cells. Do not restore a separate practice-cell-count setting.
- Standard tracing supports both full-character-then-blank practice and cumulative stroke tracing. In cumulative mode, cell N contains strokes 1 through N, and cells after the final stroke repeat the full character.
- Article tracing preserves repeated characters and punctuation, assigns one visible input character to each cell, and uses local-font fallback for punctuation or unsupported characters.
- Preview zoom ranges from 35% to 150%. Command+wheel adjusts zoom on macOS, with Ctrl+wheel as the cross-platform equivalent.
- Grid frame, center-cross, and Mizi-diagonal colors are independently configurable for every template.
- Homework, class, and teacher headers need handwriting-sized field lines. Expanded header height must be included in pagination calculations.
- Content should come from both manual input and built-in templates. Template categories include Tang poems, Song Ci, San Zi Jing, Shi Jing selections, elementary common character groups, basic character structures, and common words.
- Built-in content template insertion should support replacing current input by default and appending as an option.

## Local Run And Build

Install dependencies once:

```bash
npm install
```

The app can be opened directly:

```text
open index.html
```

For local HTTP and PWA testing:

```bash
npm run dev
```

Then visit:

```text
http://localhost:8765/
```

## Deployment

GitHub repository:

```text
https://github.com/rickytan/HanZiFun
```

GitHub Pages URL:

```text
https://rickytan.cn/HanZiFun/
```

GitHub Actions runs `npm ci` and `npm run build`, uploads `dist/`, and deploys it to Pages. The repository must use GitHub Actions as its Pages build source.

## Validation Checklist

Before committing meaningful changes:

```bash
npm run check
npm run build
```

For static serving checks:

```bash
npm run dev
curl -I http://localhost:8765/
curl -I http://localhost:8765/data/stroke-index.js
```

For render sanity, verify all five templates, on-demand loading, local persistence, A5/A4/A3/Letter portrait and landscape, and mobile settings drawer behavior. The default baseline remains:

```text
10 characters, 2 pages, 70 SVG cells
```

## Git Notes

- Default branch: `main`
- Current remote: `git@github.com:rickytan/HanZiFun.git`
- Last known requirements commit: `8b5c599 Add content templates and mobile PWA requirements`

Keep changes scoped and commit intentionally. Do not remove bundled data attribution.
Read `DESIGN.md` before making substantial UI changes.
