"use strict";
(function () {
const SETTINGS_KEY = "hanzifun.settings";
const SETTINGS_VERSION = 8;
const APP_TITLE = "汉字 Fun";
const CSS_PX_PER_MM = 96 / 25.4;
const VIEWBOX_SIZE = 1024;
const BASELINE = 900;
const STROKE_ACTIVE_COLOR = "#202b33";
const STROKE_DONE_COLOR = "#b7c0c7";
const MAX_CACHED_CHUNKS = 16;
const USE_ZIP_PACK = location.protocol !== "file:";
const BUILD_VERSION = "__BUILD_VERSION__";
const CDN_BASE = "__CDN_BASE__".startsWith("https://") ? "__CDN_BASE__" : "";
const STEP_CELL_MM = 16;
const STEP_COLUMN_GAP_MM = 2.5;
const STEP_ITEM_HEIGHT_MM = 20;
const STROKE_CARD_MIN_HEIGHT_MM = 48;
const STROKE_CARD_FIXED_WIDTH_MM = 38;
const STROKE_CARD_PADDING_MM = 4;
const KAI_FONT_FACE = "KaiTi";

const PAPER_SIZES = {
  A5: [148, 210],
  A4: [210, 297],
  A3: [297, 420],
  Letter: [216, 279],
};

const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  inputText: "人 口 日 月 水 火 山 田 木 永",
  template: "trace",
  gridStyle: "tian",
  paperSize: "A4",
  orientation: "portrait",
  headerPreset: "homework",
  footerPreset: "right",
  title: "中文写字练习",
  studentName: "",
  className: "",
  date: new Date().toISOString().slice(0, 10),
  cellSizeMm: 16,
  marginMm: 10,
  rowsPerPage: 0,
  cellsPerRow: 0,
  rowsPerCharacter: 1,
  cellGapMm: 1,
  rowGapMm: 3,
  blankPageCount: 1,
  dedupe: true,
  showPinyin: true,
  showRowGuide: true,
  showStrokeNumbers: true,
  showStartDots: true,
  showArrows: true,
  showGuides: true,
  traceMode: "full",
  traceColor: "#d8dde1",
  traceOpacity: 1,
  traceScale: 1,
  strokeActiveColor: "#202b33",
  guideColor: "#202b33",
  gridFrameColor: "#aebac2",
  gridCrossColor: "#c9d2d8",
  gridDiagonalColor: "#d8c6c6",
  zoom: 70,
};

const NUMBER_FIELDS = new Set([
  "cellSizeMm", "marginMm", "rowsPerPage", "cellsPerRow",
  "rowsPerCharacter", "cellGapMm", "rowGapMm", "blankPageCount",
  "traceOpacity", "traceScale", "zoom",
]);

const TEMPLATE_LABELS = {
  trace: "描红练习",
  stroke: "笔顺分解",
  blank: "空白格纸",
  copy: "文章临摹",
};

const GRID_STYLE_LABELS = {
  tian: "田字格",
  mi: "米字格",
};

const PROGRESSIVE_TRACE_MODES = new Set(["progressive", "progressive-blank"]);

const els = {
  controls: document.querySelector("#controls"),
  pages: document.querySelector("#pages"),
  summary: document.querySelector("#summary"),
  dataStatus: document.querySelector("#dataStatus"),
  contentStatus: document.querySelector("#contentStatus"),
  compactStatus: document.querySelector("#compactStatus"),
  saveStatus: document.querySelector("#saveStatus"),
  contentCategory: document.querySelector("#contentCategory"),
  contentTemplate: document.querySelector("#contentTemplate"),
  replaceContentBtn: document.querySelector("#replaceContentBtn"),
  appendContentBtn: document.querySelector("#appendContentBtn"),
  exportPdfBtn: document.querySelector("#exportPdfBtn"),
  exportStatus: document.querySelector("#exportStatus"),
  printBtn: document.querySelector("#printBtn"),
  printNote: document.querySelector("#printNote"),
  installBtn: document.querySelector("#installBtn"),
  settingsBtn: document.querySelector("#settingsBtn"),
  closeSettingsBtn: document.querySelector("#closeSettingsBtn"),
  drawerBackdrop: document.querySelector("#drawerBackdrop"),
  resetBtn: document.querySelector("#resetBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  printPageStyle: document.querySelector("#printPageStyle"),
  previewWrap: document.querySelector(".preview-wrap"),
};

let settings = loadSettings();
let renderFrame = 0;
let markerSequence = 0;
let installPrompt = null;
const pendingChunks = new Map();
const scriptLoadPromises = new Map();
const failedChunks = new Set();
const loadedChunks = new Map();
const chunkCharacters = new Map();
const coreCharacters = new Set(Object.keys(window.HANZI_STROKES || {}));
let activeChunkIds = new Set();
const zipArchivePromises = new Map();
const zipArchiveStates = new Map();
let exportStatusTimer = 0;
let printNoteTimer = 0;
let strokePrefetchScheduled = false;
let strokePrefetchCursor = 0;
let pdfOperationActive = false;
const svgPngCache = new WeakMap();
const PACK_FETCH_TIMEOUT_MS = 30000;
const MAX_PACK_RETRIES = 2;
const MAX_CHUNK_RETRIES = 3;
const MAX_CONCURRENT_PACK_DOWNLOADS = 2;
let activePackDownloads = 0;
const packDownloadQueue = [];
const prefetchedPackIds = new Set();
const advertisedPrefetchUrls = new Set();

function fetchWithTimeout(url, options = {}, timeout = PACK_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function connectionAllowsBackgroundWork() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return navigator.onLine && !connection?.saveData && !/(^|-)2g$/.test(connection?.effectiveType || "");
}

function pdfRuntimeUrls() {
  return [
    "vendor/jspdf.umd.min.js",
    CDN_BASE ? `${CDN_BASE}/vendor/hb-subset.wasm` : "vendor/hb-subset.wasm",
    CDN_BASE ? `${CDN_BASE}/vendor/fonts/kai.ttf` : "vendor/fonts/kai.ttf",
    CDN_BASE ? `${CDN_BASE}/vendor/fonts/kai-chars.json` : "vendor/fonts/kai-chars.json",
  ];
}

function cacheUrlsInServiceWorker(urls) {
  if (!("serviceWorker" in navigator) || !location.protocol.startsWith("http")) return false;
  const send = (target) => {
    if (!target) return false;
    target.postMessage({ type: "CACHE_URLS", urls });
    return true;
  };
  if (send(navigator.serviceWorker.controller)) return true;
  navigator.serviceWorker.ready.then((registration) => send(registration.active)).catch(() => undefined);
  return true;
}

function advertiseFetchPrefetch(url) {
  if (!url || advertisedPrefetchUrls.has(url)) return;
  advertisedPrefetchUrls.add(url);
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.as = "fetch";
  link.crossOrigin = "anonymous";
  link.href = url;
  document.head.append(link);
}

function cacheOrPrefetchUrls(urls) {
  const validUrls = urls.filter(Boolean);
  if (!validUrls.length) return;
  if (cacheUrlsInServiceWorker(validUrls)) return;
  for (const url of validUrls) advertiseFetchPrefetch(url);
}
let activePdfProgress = null;
let pdfProtectedCharacters = [];

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (stored && typeof stored === "object" && Number(stored.settingsVersion) <= SETTINGS_VERSION) {
      const migrated = { ...stored };
      delete migrated.practiceCount;
      delete migrated.stepCount;
      if (["tian", "mizi"].includes(migrated.template)) {
        migrated.gridStyle = migrated.template === "mizi" ? "mi" : "tian";
        migrated.template = "trace";
      }
      if (/^#[0-9a-f]{6}$/i.test(migrated.gridColor || "")) {
        migrated.gridFrameColor ??= migrated.gridColor;
        migrated.gridCrossColor ??= migrated.gridColor;
        migrated.gridDiagonalColor ??= migrated.gridColor;
      }
      delete migrated.gridColor;
      if (Number(stored.settingsVersion) < 8 && !migrated.traceColor) {
        migrated.traceColor = DEFAULT_SETTINGS.traceColor;
        migrated.traceOpacity = DEFAULT_SETTINGS.traceOpacity;
      }
      return { ...DEFAULT_SETTINGS, ...migrated, settingsVersion: SETTINGS_VERSION };
    }
  } catch {
    // Private browsing and file URLs can deny storage access.
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings() {
  settings.settingsVersion = SETTINGS_VERSION;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    els.saveStatus.textContent = "已自动保存";
  } catch {
    els.saveStatus.textContent = "本机未允许保存";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function extractCharacters(text, dedupe) {
  const chars = Array.from(text.matchAll(/[\u3400-\u9fff]/gu), (match) => match[0]);
  return dedupe ? [...new Set(chars)] : chars;
}

function extractPageCharacters() {
  const svgChars = [...els.pages.querySelectorAll("svg.hanzi-cell[data-ch]")]
    .map((svg) => svg.dataset.ch)
    .filter(Boolean);
  const textChars = extractCharacters(els.pages.textContent || "", true);
  const fallbackChars = kaiCharSet
    ? textChars.filter((ch) => !kaiCharSet.has(ch))
    : [];
  return [...new Set([...svgChars, ...fallbackChars])];
}

function extractCopyItems(text) {
  return Array.from(text).filter((character) => !/\s/u.test(character));
}

function layoutCopyItems(text, columns) {
  const slots = [];
  let cursor = 0;
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((line, lineIndex) => {
    const characters = Array.from(line).filter((character) => !/\s/u.test(character));
    for (const character of characters) slots[cursor++] = character;
    if (lineIndex === lines.length - 1) return;
    const remainder = cursor % columns;
    if (!characters.length && remainder === 0) cursor += columns;
    else if (remainder) cursor += columns - remainder;
  });
  return { slots, usedSlots: cursor };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function settingColor(key) {
  return /^#[0-9a-f]{6}$/i.test(settings[key]) ? settings[key] : DEFAULT_SETTINGS[key];
}

function headerReservedHeight() {
  if (settings.headerPreset === "blank") return 0;
  return settings.headerPreset === "simple" ? 18 : 28;
}

function paperDimensions() {
  const base = PAPER_SIZES[settings.paperSize] || PAPER_SIZES.A4;
  return settings.orientation === "landscape" ? { width: base[1], height: base[0] } : { width: base[0], height: base[1] };
}

function gridStyle() {
  return settings.gridStyle === "mi" ? "mi" : "tian";
}

function pointToSvg(point) {
  return { x: point[0], y: BASELINE - point[1] };
}

function makeGrid(type, options = {}) {
  // Keep the frame clear of the SVG clipping edge so print rasterization
  // cannot drop the left or bottom stroke at some scaling factors. When a
  // neighbour shares the edge (cell/row gap 0) the shared side is extended
  // to the viewBox boundary (joinRight/joinBottom) and the matching side on
  // the adjacent cell is omitted (joinLeft/joinTop), so the two cells meet
  // without a sub-pixel gap or a doubled stroke.
  const edge = 8;
  const farEdge = VIEWBOX_SIZE - edge;
  const left = options.joinLeft ? 0 : edge;
  const right = options.joinRight ? VIEWBOX_SIZE : farEdge;
  const top = options.joinTop ? 0 : edge;
  const bottom = options.joinBottom ? VIEWBOX_SIZE : farEdge;
  const frame = (options.joinLeft || options.joinTop)
    ? `<path class="grid-frame-line" d="${
        options.joinTop ? `M${right} ${top}` : `M${left} ${top}H${right}`
      }V${bottom}H${left}${
        options.joinLeft ? "" : `V${top}`
      }"></path>`
    : `<rect class="grid-frame-line" x="${left}" y="${top}" width="${right - left}" height="${bottom - top}"></rect>`;
  if (!settings.showGuides) return frame;
  const diagonals = type === "mi"
    ? `<line class="grid-diagonal-line" x1="${edge}" y1="${edge}" x2="${farEdge}" y2="${farEdge}"></line><line class="grid-diagonal-line" x1="${farEdge}" y1="${edge}" x2="${edge}" y2="${farEdge}"></line>`
    : "";
  return `${frame}<line class="grid-cross-line" x1="512" y1="${edge}" x2="512" y2="${farEdge}"></line><line class="grid-cross-line" x1="${edge}" y1="512" x2="${farEdge}" y2="512"></line>${diagonals}`;
}

function renderStrokePaths(data, options) {
  if (options.blank) return "";
  const mode = options.mode || "full";
  const step = options.step ?? data.strokes.length - 1;
  return data.strokes.map((path, index) => {
    if (mode === "step" && index > step) return "";
    let className = "stroke";
    if (mode === "step" && index < step) className = "done";
    if (options.trace) className = "trace";
    if (options.guide) className = "guide";
    const opacity = options.trace ? settings.traceOpacity : 1;
    const colorStyle = options.trace ? ` style="--trace-color:${settingColor("traceColor")}"` : "";
    return `<path class="${className}" d="${path}" opacity="${opacity}"${colorStyle}></path>`;
  }).join("");
}

function renderAnnotations(data, annotateStep) {
  return data.medians.map((median, index) => {
    if (annotateStep !== undefined && index !== annotateStep) return "";
    const start = pointToSvg(median[0]);
    const directionPoint = pointToSvg(median[Math.min(Math.max(1, Math.floor(median.length * 0.18)), median.length - 1)]);
    const markerId = `arrow-${markerSequence += 1}`;
    const marker = settings.showArrows
      ? `<defs><marker id="${markerId}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z"></path></marker></defs>`
      : "";
    const arrow = settings.showArrows
      ? `<line class="median-arrow" x1="${start.x}" y1="${start.y}" x2="${directionPoint.x}" y2="${directionPoint.y}" marker-end="url(#${markerId})"></line>`
      : "";
    const dot = settings.showStartDots ? `<circle class="start-dot" cx="${start.x}" cy="${start.y}" r="22"></circle>` : "";
    const number = settings.showStrokeNumbers
      ? `<text class="order-label" x="${start.x + 34}" y="${start.y - 28}">${index + 1}</text>`
      : "";
    return `${marker}${arrow}${dot}${number}`;
  }).join("");
}

function makeCharacterSvg(character, options = {}) {
  const data = window.HANZI_STROKES?.[character];
  const grid = makeGrid(options.gridStyle || gridStyle(), options);
  if (options.blank) {
    return `<svg class="hanzi-cell" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}" role="img" aria-label="空白练习格">${grid}</svg>`;
  }
  if (!data) {
    const opacity = options.trace ? settings.traceOpacity : 1;
    const colorStyle = options.trace ? ` style="--trace-color:${settingColor("traceColor")}"` : "";
    const glyphClass = options.trace ? "fallback-glyph trace-glyph" : "fallback-glyph";
    const traceScale = (options.trace || options.applyTraceScale) && settings.template !== "stroke" ? (settings.traceScale ?? 1) : 1;
    const textTransform = traceScale !== 1 ? ` transform="translate(512 512) scale(${traceScale}) translate(-512 -512)"` : "";
    return `<svg class="hanzi-cell pending-cell" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}" role="img" aria-label="${escapeHtml(character)} 正在载入">${grid}<text class="${glyphClass}" x="512" y="512" opacity="${opacity}"${colorStyle}${textTransform}>${escapeHtml(character)}</text></svg>`;
  }
  const paths = renderStrokePaths(data, options);
  const annotations = options.annotate ? renderAnnotations(data, options.annotateStep) : "";
  const dataAttrs = [`data-ch="${escapeHtml(character)}"`];
  if (options.trace) dataAttrs.push('data-trace="1"');
  if (options.mode === "step") dataAttrs.push(`data-step="${options.step ?? data.strokes.length - 1}"`);
  if (options.applyTraceScale) dataAttrs.push('data-trace-scale="1"');
  if (options.guide) dataAttrs.push('data-guide="1"');
  const traceScale = (options.trace || options.applyTraceScale) && settings.template !== "stroke" ? (settings.traceScale ?? 1) : 1;
  const scaleWrap = traceScale !== 1 ? `<g transform="translate(512 512) scale(${traceScale}) translate(-512 -512)">` : "";
  const scaleClose = traceScale !== 1 ? "</g>" : "";
  return `<svg class="hanzi-cell" ${dataAttrs.join(" ")} viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}" role="img" aria-label="${escapeHtml(character)} 字练习格">${grid}${scaleWrap}<g transform="translate(0 ${BASELINE}) scale(1 -1)">${paths}</g>${annotations}${scaleClose}</svg>`;
}

function makeCopyCell(character, options = {}) {
  if (window.HANZI_STROKES?.[character]) {
    return makeCharacterSvg(character, { ...options, trace: true, gridStyle: gridStyle() });
  }
  const grid = makeGrid(gridStyle(), options);
  const traceScale = settings.traceScale ?? 1;
  const textTransform = traceScale !== 1 ? ` transform="translate(512 512) scale(${traceScale}) translate(-512 -512)"` : "";
  return `<svg class="hanzi-cell copy-cell" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}" role="img" aria-label="${escapeHtml(character)} 临摹格">${grid}<text class="copy-glyph trace-glyph" x="512" y="512" opacity="${settings.traceOpacity}" style="--trace-color:${settingColor("traceColor")}"${textTransform}>${escapeHtml(character)}</text></svg>`;
}

function pinyinFor(character) {
  return settings.showPinyin ? (window.HANZI_PINYIN?.[character] || "") : "";
}

function makePracticeCells(character, cellCount, joinTop = false, joinBottom = false) {
  const joinLeft = settings.cellGapMm === 0;
  const joinRight = joinLeft;
  return Array.from({ length: cellCount }, (_, index) =>
    makeCharacterSvg(character, index === 0
      ? { trace: true, annotate: true, joinLeft, joinRight: joinRight && index < cellCount - 1, joinTop, joinBottom }
      : { blank: true, joinLeft, joinRight: joinRight && index < cellCount - 1, joinTop, joinBottom })
  ).join("");
}

function progressiveRowsNeeded(character, maximumCells) {
  const strokeCount = window.HANZI_STROKES?.[character]?.strokes.length || 1;
  const firstRowCapacity = maximumCells - 1;
  return strokeCount <= firstRowCapacity
    ? 1
    : 1 + Math.ceil((strokeCount - firstRowCapacity) / maximumCells);
}

function makeProgressiveCells(character, cellCount, startStep, hasLeadingCell, joinTop = false, joinBottom = false) {
  const strokeCount = window.HANZI_STROKES?.[character]?.strokes.length || 1;
  const cellGap0 = settings.cellGapMm === 0;
  return Array.from({ length: cellCount }, (_, index) => {
    const step = startStep + index;
    const joinLeft = cellGap0 && (hasLeadingCell || index > 0);
    const joinRight = cellGap0 && index < cellCount - 1;
    if (settings.traceMode === "progressive-blank" && step >= strokeCount) {
      return makeCharacterSvg("", { blank: true, joinLeft, joinRight, joinTop, joinBottom });
    }
    const clampedStep = Math.min(step, strokeCount - 1);
    return makeCharacterSvg(character, {
      trace: true,
      mode: "step",
      step: clampedStep,
      annotate: step < strokeCount,
      annotateStep: clampedStep,
      joinLeft,
      joinRight,
      joinTop,
      joinBottom,
    });
  }).join("");
}

function makeStandardRow(row, maximumCells, options = {}) {
  const { character, rowIndex } = row;
  const rowClass = settings.showRowGuide ? "char-row" : "char-row no-row-guide";
  const guideCharPx = clamp(settings.cellSizeMm * CSS_PX_PER_MM * 0.58, 10, 20);
  const guidePinyinPx = clamp(settings.cellSizeMm * CSS_PX_PER_MM * 0.25, 7, 10);
  const rowStyle = `style="--cell-mm:${settings.cellSizeMm}mm;--cell-gap-mm:${settings.cellGapMm}mm;--guide-char-px:${guideCharPx.toFixed(2)}px;--guide-pinyin-px:${guidePinyinPx.toFixed(2)}px"`;
  const guide = settings.showRowGuide
    ? `<div class="char-info"><span class="pinyin">${escapeHtml(pinyinFor(character))}</span><strong>${escapeHtml(character)}</strong></div>`
    : "";
  const cellGap0 = settings.cellGapMm === 0;
  const { joinTop = false, joinBottom = false } = options;
  let cells;
  if (PROGRESSIVE_TRACE_MODES.has(settings.traceMode)) {
    const isFirstRow = rowIndex === 0;
    const startStep = isFirstRow ? 0 : maximumCells - 1 + (rowIndex - 1) * maximumCells;
    const leadingCell = isFirstRow ? makeCharacterSvg(character, { applyTraceScale: true, guide: true, joinRight: cellGap0, joinTop, joinBottom }) : "";
    cells = `${leadingCell}${makeProgressiveCells(character, maximumCells - (isFirstRow ? 1 : 0), startStep, isFirstRow, joinTop, joinBottom)}`;
  } else {
    cells = `${makeCharacterSvg(character, { applyTraceScale: true, guide: true, joinRight: cellGap0, joinTop, joinBottom })}${makePracticeCells(character, maximumCells - 1, joinTop, joinBottom)}`;
  }
  return `<article class="${rowClass}" ${rowStyle}>
    ${guide}<div class="exercise-strip">${cells}</div>
  </article>`;
}

function makeStrokeCard(layout) {
  const { character, stepColumns, height } = layout;
  const data = window.HANZI_STROKES?.[character];
  const cardStyle = `style="--step-columns:${stepColumns};min-height:${height}mm"`;
  if (!data) return `<article class="stroke-card loading-card" ${cardStyle}><strong>${escapeHtml(character)}</strong><span>正在载入笔顺数据</span></article>`;
  const steps = Array.from({ length: data.strokes.length }, (_, step) =>
    `<div class="step-item">${makeCharacterSvg(character, { mode: "step", step })}<span>${step + 1} 画</span></div>`
  ).join("");
  return `<article class="stroke-card" ${cardStyle}>
    <div class="stroke-main"><span class="pinyin">${escapeHtml(pinyinFor(character))}</span>${makeCharacterSvg(character, { trace: true, annotate: true })}<strong>${escapeHtml(character)} · ${data.strokes.length} 画</strong></div>
    <div class="step-grid">${steps}</div>
  </article>`;
}

function strokeCardLayout(character, usableWidth) {
  const strokeCount = window.HANZI_STROKES?.[character]?.strokes.length || 1;
  const stepAreaWidth = Math.max(STEP_CELL_MM, usableWidth - STROKE_CARD_FIXED_WIDTH_MM);
  const stepColumns = Math.max(1, Math.floor((stepAreaWidth + STEP_COLUMN_GAP_MM) / (STEP_CELL_MM + STEP_COLUMN_GAP_MM)));
  const stepRows = Math.ceil(strokeCount / stepColumns);
  const stepHeight = stepRows * STEP_ITEM_HEIGHT_MM + Math.max(0, stepRows - 1) * STEP_COLUMN_GAP_MM;
  return {
    character,
    stepColumns,
    height: Math.max(STROKE_CARD_MIN_HEIGHT_MM, stepHeight + STROKE_CARD_PADDING_MM),
  };
}

function headerFields() {
  const preset = settings.headerPreset;
  if (preset === "blank") return "";
  const title = `<h2>${escapeHtml(settings.title || TEMPLATE_LABELS[settings.template])}</h2>`;
  const fields = [];
  const writableField = (label, value) => `<span class="meta-field"><span>${label}</span><span class="meta-write">${escapeHtml(value)}</span></span>`;
  if (["class", "teacher"].includes(preset)) fields.push(writableField("班级", settings.className));
  if (["homework", "class", "teacher"].includes(preset)) fields.push(writableField("姓名", settings.studentName));
  if (["homework", "class"].includes(preset)) fields.push(writableField("日期", settings.date));
  const expandedClass = preset === "simple" ? "" : " expanded-header";
  return `<header class="page-header${expandedClass}">${title}${fields.length ? `<div class="page-meta">${fields.join("")}</div>` : ""}</header>`;
}

function footerFields(pageIndex, pageCount) {
  if (settings.footerPreset === "none") return "";
  const alignment = settings.footerPreset === "center" ? "center" : "right";
  return `<footer class="page-footer footer-${alignment}">${pageIndex + 1} / ${pageCount}</footer>`;
}

function makePage(body, pageIndex, pageCount, dimensions, extraClass = "") {
  return `<div class="page-shell" style="--paper-width:${dimensions.width}mm;--paper-height:${dimensions.height}mm">
    <section class="page ${extraClass}" style="--paper-width:${dimensions.width}mm;--paper-height:${dimensions.height}mm;--page-margin:${settings.marginMm}mm;--grid-frame-color:${settingColor("gridFrameColor")};--grid-cross-color:${settingColor("gridCrossColor")};--grid-diagonal-color:${settingColor("gridDiagonalColor")};--trace-color:${settingColor("traceColor")};--stroke-active:${settingColor("strokeActiveColor")};--guide-color:${settingColor("guideColor")}">
      ${headerFields()}${body}${footerFields(pageIndex, pageCount)}
    </section>
  </div>`;
}

function renderStandardPages(characters, dimensions) {
  const usableWidth = dimensions.width - settings.marginMm * 2;
  const usableHeight = dimensions.height - settings.marginMm * 2 - headerReservedHeight();
  const guideWidth = settings.showRowGuide ? 17.5 : 0;
  const exerciseWidth = Math.max(settings.cellSizeMm * 2, usableWidth - guideWidth);
  const maximumCells = Math.max(2, Math.floor((exerciseWidth + settings.cellGapMm) / (settings.cellSizeMm + settings.cellGapMm)));
  const automaticRows = Math.max(1, Math.floor((usableHeight + settings.rowGapMm) / (settings.cellSizeMm + settings.rowGapMm)));
  const rows = settings.rowsPerPage > 0 ? Math.min(settings.rowsPerPage, automaticRows) : automaticRows;
  const configuredRowsPerCharacter = clamp(Math.round(settings.rowsPerCharacter), 1, 6);
  let rowsPerCharacter = configuredRowsPerCharacter;
  let autoExpandedRows = false;
  const pages = [];
  let currentPage = [];
  for (const character of characters) {
    const requiredRows = PROGRESSIVE_TRACE_MODES.has(settings.traceMode) ? progressiveRowsNeeded(character, maximumCells) : 1;
    const characterRowCount = Math.max(configuredRowsPerCharacter, requiredRows);
    rowsPerCharacter = Math.max(rowsPerCharacter, characterRowCount);
    if (requiredRows > configuredRowsPerCharacter) autoExpandedRows = true;
    const characterRows = Array.from({ length: characterRowCount }, (_, rowIndex) => ({ character, rowIndex }));
    if (currentPage.length && characterRows.length <= rows && currentPage.length + characterRows.length > rows) {
      pages.push(currentPage);
      currentPage = [];
    }
    while (characterRows.length) {
      const available = rows - currentPage.length;
      currentPage.push(...characterRows.splice(0, available));
      if (currentPage.length === rows) {
        pages.push(currentPage);
        currentPage = [];
      }
    }
  }
  if (currentPage.length) pages.push(currentPage);
  if (!pages.length) pages.push([]);
  const rowGap0 = settings.rowGapMm === 0;
  const markup = pages.map((pageRows, pageIndex) => {
    const body = pageRows.length
      ? `<div class="practice-list" style="--row-gap-mm:${settings.rowGapMm}mm">${pageRows.map((row, rowIdx) => makeStandardRow(row, maximumCells, {
          joinTop: rowGap0 && rowIdx > 0,
          joinBottom: rowGap0 && rowIdx < pageRows.length - 1,
        })).join("")}</div>`
      : '<div class="empty-page-message">请在左侧输入要练习的汉字</div>';
    return makePage(body, pageIndex, pages.length, dimensions);
  }).join("");
  return { markup, pageCount: pages.length, rowsPerCharacter, autoExpandedRows };
}

function renderStrokePages(characters, dimensions) {
  const usableWidth = dimensions.width - settings.marginMm * 2;
  const usableHeight = dimensions.height - settings.marginMm * 2 - headerReservedHeight();
  const maximumCardsPerPage = settings.rowsPerPage > 0 ? settings.rowsPerPage : Infinity;
  const pages = [];
  let currentPage = [];
  let currentHeight = 0;
  for (const layout of characters.map((character) => strokeCardLayout(character, usableWidth))) {
    const gap = currentPage.length ? settings.rowGapMm : 0;
    if (currentPage.length && (currentPage.length >= maximumCardsPerPage || currentHeight + gap + layout.height > usableHeight)) {
      pages.push(currentPage);
      currentPage = [];
      currentHeight = 0;
    }
    currentHeight += (currentPage.length ? settings.rowGapMm : 0) + layout.height;
    currentPage.push(layout);
  }
  if (currentPage.length) pages.push(currentPage);
  if (!pages.length) pages.push([]);
  const markup = pages.map((pageLayouts, pageIndex) => {
    const body = pageLayouts.length
      ? `<div class="stroke-list" style="--row-gap-mm:${settings.rowGapMm}mm">${pageLayouts.map(makeStrokeCard).join("")}</div>`
      : '<div class="empty-page-message">请在左侧输入要学习笔顺的汉字</div>';
    return makePage(body, pageIndex, pages.length, dimensions, "stroke-page");
  }).join("");
  return { markup, pageCount: pages.length };
}

function renderBlankPages(dimensions) {
  const usableWidth = dimensions.width - settings.marginMm * 2;
  const usableHeight = dimensions.height - settings.marginMm * 2 - headerReservedHeight();
  const automaticColumns = Math.max(1, Math.floor((usableWidth + settings.cellGapMm) / (settings.cellSizeMm + settings.cellGapMm)));
  const automaticRows = Math.max(1, Math.floor((usableHeight + settings.rowGapMm) / (settings.cellSizeMm + settings.rowGapMm)));
  const columns = settings.cellsPerRow > 0 ? Math.min(settings.cellsPerRow, automaticColumns) : automaticColumns;
  const rows = settings.rowsPerPage > 0 ? Math.min(settings.rowsPerPage, automaticRows) : automaticRows;
  const cells = Array.from({ length: columns * rows }, (_, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    return makeCharacterSvg("", {
      blank: true,
      gridStyle: gridStyle(),
      joinLeft: settings.cellGapMm === 0 && col > 0,
      joinRight: settings.cellGapMm === 0 && col < columns - 1,
      joinTop: settings.rowGapMm === 0 && row > 0,
      joinBottom: settings.rowGapMm === 0 && row < rows - 1,
    });
  }).join("");
  const body = `<div class="blank-grid" style="--blank-columns:${columns};--cell-mm:${settings.cellSizeMm}mm;--cell-gap-mm:${settings.cellGapMm}mm;--row-gap-mm:${settings.rowGapMm}mm">${cells}</div>`;
  const pages = Array.from({ length: settings.blankPageCount }, (_, index) => makePage(body, index, settings.blankPageCount, dimensions, "blank-page"));
  return { markup: pages.join(""), pageCount: pages.length, columns, rows };
}

function renderCopyPages(text, dimensions) {
  const usableWidth = dimensions.width - settings.marginMm * 2;
  const usableHeight = dimensions.height - settings.marginMm * 2 - headerReservedHeight();
  const automaticColumns = Math.max(1, Math.floor((usableWidth + settings.cellGapMm) / (settings.cellSizeMm + settings.cellGapMm)));
  const automaticRows = Math.max(1, Math.floor((usableHeight + settings.rowGapMm) / (settings.cellSizeMm + settings.rowGapMm)));
  const columns = settings.cellsPerRow > 0 ? Math.min(settings.cellsPerRow, automaticColumns) : automaticColumns;
  const rows = settings.rowsPerPage > 0 ? Math.min(settings.rowsPerPage, automaticRows) : automaticRows;
  const pageCapacity = columns * rows;
  const { slots, usedSlots } = layoutCopyItems(text, columns);
  const pageCount = Math.max(1, Math.ceil(Math.max(1, usedSlots) / pageCapacity));
  const markup = Array.from({ length: pageCount }, (_, pageIndex) => {
    const cells = Array.from({ length: pageCapacity }, (_, index) => {
      const character = slots[pageIndex * pageCapacity + index];
      const col = index % columns;
      const row = Math.floor(index / columns);
      const options = {
        joinLeft: settings.cellGapMm === 0 && col > 0,
        joinRight: settings.cellGapMm === 0 && col < columns - 1,
        joinTop: settings.rowGapMm === 0 && row > 0,
        joinBottom: settings.rowGapMm === 0 && row < rows - 1,
      };
      return character !== undefined
        ? makeCopyCell(character, options)
        : makeCharacterSvg("", { ...options, blank: true, gridStyle: gridStyle() });
    }).join("");
    const body = `<div class="blank-grid copy-grid" style="--blank-columns:${columns};--cell-mm:${settings.cellSizeMm}mm;--cell-gap-mm:${settings.cellGapMm}mm;--row-gap-mm:${settings.rowGapMm}mm">${cells}</div>`;
    return makePage(body, pageIndex, pageCount, dimensions, "copy-page");
  }).join("");
  return { markup, pageCount, columns, rows };
}

function renderDataErrorPage(dimensions) {
  const body = `<div class="preview-data-state error" role="status" aria-live="polite">
    <span class="preview-error-mark" aria-hidden="true">!</span>
    <strong>笔顺数据加载失败</strong><span>请检查网络连接后刷新页面重试</span>
  </div>`;
  return { markup: makePage(body, 0, 1, dimensions, "data-state-page"), pageCount: 1 };
}

function unsupportedCharacters(characters) {
  return [...new Set(characters.filter((character) => !window.HANZI_STROKES?.[character] && !window.HANZI_CHUNK_INDEX?.[character]))];
}

function loadScript(source) {
  if (scriptLoadPromises.has(source)) return scriptLoadPromises.get(source);
  const promise = new Promise((resolve, reject) => {
    if (source.includes("jspdf") && window.jspdf?.jsPDF) {
      resolve();
      return;
    }
    if (source.includes("fflate") && window.fflate) {
      resolve();
      return;
    }
    const existing = document.querySelector(`script[src="${source}"]`);
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }
    const script = existing || document.createElement("script");
    script.src = source;
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = reject;
    if (!existing) document.head.append(script);
  });
  scriptLoadPromises.set(source, promise);
  promise.catch(() => scriptLoadPromises.delete(source));
  return promise;
}

// --- 内嵌楷体字体运行时：hb-subset 按需裁剪 + jsPDF 嵌入 ---
// 解决页眉等排版文本用 helvetica 无中文导致的乱码。
const kaiRuntime = { wasm: null, font: null, chars: null };
let kaiCharSet = null;

async function loadHbSubsetWasm() {
  if (kaiRuntime.wasm) return kaiRuntime.wasm;
  const url = CDN_BASE ? `${CDN_BASE}/vendor/hb-subset.wasm` : "vendor/hb-subset.wasm";
  const res = await fetch(url);
  if (!res.ok) throw new Error("hb-subset.wasm 载入失败");
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer());
  kaiRuntime.wasm = instance.exports;
  return kaiRuntime.wasm;
}

async function loadKaiFontBuffer() {
  if (kaiRuntime.font) return kaiRuntime.font;
  const url = CDN_BASE ? `${CDN_BASE}/vendor/fonts/kai.ttf` : "vendor/fonts/kai.ttf";
  const res = await fetch(url);
  if (!res.ok) throw new Error("kai.ttf 载入失败");
  kaiRuntime.font = new Uint8Array(await res.arrayBuffer());
  return kaiRuntime.font;
}

async function loadKaiCharSet() {
  if (kaiRuntime.chars) return kaiRuntime.chars;
  const url = CDN_BASE ? `${CDN_BASE}/vendor/fonts/kai-chars.json` : "vendor/fonts/kai-chars.json";
  const res = await fetch(url);
  if (!res.ok) throw new Error("kai-chars.json 载入失败");
  kaiRuntime.chars = new Set(JSON.parse(await res.text()));
  return kaiRuntime.chars;
}

// 用 hb-subset.wasm 把字体裁剪到 text 实际用字，返回子集字体 Uint8Array。
// 移植自 subset-font（去掉 Node fs/Buffer/fontverter），纯浏览器 WebAssembly。
function subsetFontKai(H, fontU8, text) {
  const heapu8 = new Uint8Array(H.memory.buffer);
  const input = H.hb_subset_input_create_or_fail();
  if (!input) throw new Error("hb_subset_input_create_or_fail");
  const fontBuffer = H.malloc(fontU8.byteLength);
  heapu8.set(fontU8, fontBuffer);
  const blob = H.hb_blob_create(fontBuffer, fontU8.byteLength, 2, 0, 0);
  const face = H.hb_face_create(blob, 0);
  H.hb_blob_destroy(blob);
  const layoutFeatures = H.hb_subset_input_set(input, 6);
  H.hb_set_clear(layoutFeatures);
  H.hb_set_invert(layoutFeatures);
  const inputUnicodes = H.hb_subset_input_unicode_set(input);
  for (const ch of text) H.hb_set_add(inputUnicodes, ch.codePointAt(0));
  const subset = H.hb_subset_or_fail(face, input);
  H.hb_subset_input_destroy(input);
  if (!subset) {
    H.hb_face_destroy(face);
    H.free(fontBuffer);
    throw new Error("hb_subset_or_fail");
  }
  const result = H.hb_face_reference_blob(subset);
  const offset = H.hb_blob_get_data(result, 0);
  const len = H.hb_blob_get_length(result);
  const copy = new Uint8Array(heapu8.subarray(offset, offset + len));
  H.hb_blob_destroy(result);
  H.hb_face_destroy(subset);
  H.hb_face_destroy(face);
  H.free(fontBuffer);
  return copy;
}

function uint8ToBase64(u8) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// 收集页面所有文本字符（含 SVG 笔画编号），用于子集化。
function collectPdfTextChars(pages) {
  const chars = new Set();
  for (const page of pages) {
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent) continue;
      const computed = getComputedStyle(parent);
      if (computed.display === "none" || computed.visibility === "hidden" || Number(computed.opacity) === 0) continue;
      for (const ch of node.data) {
        if (!/\s/u.test(ch)) chars.add(ch);
      }
    }
  }
  return chars;
}

// 载入楷体运行时，按页面实际用字子集化后嵌入 pdf；字符集存入 kaiCharSet 供渲染期 fallback。
async function prepareKaiFont(pdf, pages) {
  const [H, fontU8, charSet] = await Promise.all([loadHbSubsetWasm(), loadKaiFontBuffer(), loadKaiCharSet()]);
  const chars = collectPdfTextChars(pages);
  const subset = subsetFontKai(H, fontU8, [...chars].join(""));
  pdf.addFileToVFS("kai.ttf", uint8ToBase64(subset));
  pdf.addFont("kai.ttf", KAI_FONT_FACE, "normal");
  kaiCharSet = charSet;
}

function packForChunk(chunkId) {
  const packInfo = window.HANZI_PACK_INFO || {};
  if (!Array.isArray(packInfo.packs)) {
    return { id: "legacy", file: packInfo.file || "data/strokes-pack-000.zip", chunks: packInfo.chunks || 0 };
  }
  const numericChunkId = Number(chunkId);
  let firstChunk = 0;
  for (const pack of packInfo.packs) {
    const chunks = Number(pack.chunks) || 0;
    if (numericChunkId >= firstChunk && numericChunkId < firstChunk + chunks) return { ...pack, firstChunk };
    firstChunk += chunks;
  }
  return null;
}

function resolvePackUrl(pack, preferOrigin = false) {
  if (!pack?.file) return null;
  if (!CDN_BASE || !USE_ZIP_PACK || preferOrigin) return pack.file;
  return `${CDN_BASE}/${pack.file}`;
}

function charactersInChunk(chunkId) {
  if (!chunkCharacters.has(chunkId)) {
    chunkCharacters.set(
      chunkId,
      Object.entries(window.HANZI_CHUNK_INDEX || {})
        .filter(([, id]) => id === chunkId)
        .map(([character]) => character)
    );
  }
  return chunkCharacters.get(chunkId);
}

function touchLoadedChunk(chunkId) {
  if (!loadedChunks.has(chunkId)) return;
  const characters = loadedChunks.get(chunkId);
  loadedChunks.delete(chunkId);
  loadedChunks.set(chunkId, characters);
}

function evictUnusedChunks() {
  for (const [chunkId, characters] of loadedChunks) {
    if (loadedChunks.size <= MAX_CACHED_CHUNKS || activeChunkIds.has(chunkId)) continue;
    for (const character of characters) {
      if (!coreCharacters.has(character)) delete window.HANZI_STROKES[character];
    }
    loadedChunks.delete(chunkId);
    failedChunks.delete(chunkId);
  }
}

function registerChunk(chunkId, data) {
  Object.assign(window.HANZI_STROKES, data);
  loadedChunks.delete(chunkId);
  loadedChunks.set(chunkId, Object.keys(data));
  evictUnusedChunks();
}

async function openZipArchive(pack) {
  if (!pack) throw new Error("Stroke ZIP pack not found");
  if (zipArchivePromises.has(pack.id)) return zipArchivePromises.get(pack.id);
  const promise = (async () => {
    while (activePackDownloads >= MAX_CONCURRENT_PACK_DOWNLOADS) {
      await new Promise((resolve) => packDownloadQueue.push(resolve));
    }
    activePackDownloads += 1;
    try {
      reportPdfProgress("载入解压组件…");
      await loadScript("vendor/fflate.min.js");
      let lastError;
      for (let attempt = 0; attempt <= MAX_PACK_RETRIES; attempt += 1) {
        zipArchiveStates.set(pack.id, "loading");
        scheduleRender(false);
        try {
          reportPdfProgress("下载笔顺字库…");
          const preferOrigin = attempt > 0;
          const response = await fetchWithTimeout(resolvePackUrl(pack, preferOrigin), {}, PACK_FETCH_TIMEOUT_MS);
          if (!response.ok) throw new Error(`Stroke ZIP request failed: ${response.status}`);
          reportPdfProgress("解析笔顺字库…");
          const bytes = new Uint8Array(await response.arrayBuffer());
          reportPdfProgress("读取笔顺数据…");
          zipArchiveStates.set(pack.id, "ready");
          scheduleRender(false);
          return { bytes };
        } catch (error) {
          lastError = error;
          if (attempt < MAX_PACK_RETRIES) {
            reportPdfProgress(`重试下载笔顺字库 (${attempt + 1}/${MAX_PACK_RETRIES})…`);
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          }
        }
      }
      zipArchiveStates.set(pack.id, "error");
      scheduleRender(false);
      zipArchivePromises.delete(pack.id);
      throw lastError;
    } finally {
      activePackDownloads -= 1;
      if (packDownloadQueue.length > 0) packDownloadQueue.shift()();
    }
  })();
  zipArchivePromises.set(pack.id, promise);
  return promise;
}

async function loadChunkFromZip(chunkId) {
  const pack = packForChunk(chunkId);
  const archive = await openZipArchive(pack);
  const filename = `chunk-${chunkId}.json`;
  reportPdfProgress(`解压笔顺分片 ${chunkId}…`);
  const entries = window.fflate.unzipSync(archive.bytes, {
    filter: (entry) => entry.name === filename,
  });
  const bytes = entries[filename];
  if (!bytes) throw new Error(`Stroke ZIP entry not found: ${chunkId}`);
  registerChunk(chunkId, JSON.parse(new TextDecoder().decode(bytes)));
}

async function loadChunkScript(chunkId) {
  await loadScript(`data/characters/chunk-${chunkId}.js`);
  const data = {};
  for (const character of charactersInChunk(chunkId)) {
    if (window.HANZI_STROKES[character]) data[character] = window.HANZI_STROKES[character];
  }
  registerChunk(chunkId, data);
}

function ensureCharacterData(characters) {
  const chunkIds = [...new Set(characters.map((character) => window.HANZI_CHUNK_INDEX?.[character]).filter(Boolean))];
  activeChunkIds = new Set(chunkIds);
  for (const chunkId of chunkIds) touchLoadedChunk(chunkId);
  evictUnusedChunks();

  for (const chunkId of chunkIds) {
    const needsData = charactersInChunk(chunkId).some((character) => characters.includes(character) && !window.HANZI_STROKES?.[character]);
    if (!needsData || pendingChunks.has(chunkId)) continue;
    if (failedChunks.has(chunkId)) continue;
    const promise = (async () => {
      for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt += 1) {
        try {
          await (USE_ZIP_PACK ? loadChunkFromZip(chunkId) : loadChunkScript(chunkId));
          pendingChunks.delete(chunkId);
          scheduleRender(false);
          return;
        } catch (error) {
          console.error(`Stroke chunk ${chunkId} failed (attempt ${attempt + 1}/${MAX_CHUNK_RETRIES})`, error);
          if (attempt < MAX_CHUNK_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          }
        }
      }
      pendingChunks.delete(chunkId);
      failedChunks.add(chunkId);
      scheduleRender(false);
    })();
    pendingChunks.set(chunkId, promise);
  }
  return Promise.all(chunkIds.map((chunkId) => pendingChunks.get(chunkId)).filter(Boolean));
}

function activeZipPacks() {
  const packs = new Map();
  for (const chunkId of activeChunkIds) {
    const pack = packForChunk(chunkId);
    if (pack) packs.set(pack.id, pack);
  }
  return [...packs.values()];
}

function prefetchUnusedStrokePacks() {
  strokePrefetchScheduled = false;
  if (!USE_ZIP_PACK || !connectionAllowsBackgroundWork()) return;
  if (pendingChunks.size || [...zipArchiveStates.values()].includes("loading")) {
    scheduleStrokePackPrefetch(2000);
    return;
  }

  const activePackIds = new Set(activeZipPacks().map((pack) => pack.id));
  const packs = window.HANZI_PACK_INFO?.packs || [];
  const batchSize = 2;
  let advertised = 0;
  for (let count = 0; count < packs.length && advertised < batchSize; count += 1) {
    const pack = packs[(strokePrefetchCursor + count) % packs.length];
    if (!pack?.file) continue;
    if (activePackIds.has(pack.id)) continue;
    if (zipArchivePromises.has(pack.id)) continue;
    if (prefetchedPackIds.has(pack.id)) continue;
    prefetchedPackIds.add(pack.id);
    advertised += 1;
    cacheOrPrefetchUrls([resolvePackUrl(pack) ?? pack.file]);
  }
  strokePrefetchCursor = (strokePrefetchCursor + Math.max(batchSize, advertised)) % Math.max(1, packs.length);
  if (packs.some((pack) => !activePackIds.has(pack.id) && !zipArchivePromises.has(pack.id) && !prefetchedPackIds.has(pack.id))) {
    scheduleStrokePackPrefetch(4500);
  }
}

function scheduleStrokePackPrefetch(delay = 0) {
  if (strokePrefetchScheduled) return;
  strokePrefetchScheduled = true;
  const schedule = () => {
    if ("requestIdleCallback" in window) window.requestIdleCallback(prefetchUnusedStrokePacks, { timeout: 4000 });
    else setTimeout(prefetchUnusedStrokePacks, 1200);
  };
  if (delay) setTimeout(schedule, delay);
  else schedule();
}

function warmPdfRuntime() {
  if (!connectionAllowsBackgroundWork()) return;
  cacheOrPrefetchUrls(pdfRuntimeUrls());
  loadHbSubsetWasm().catch(() => {});
  loadKaiFontBuffer().catch(() => {});
  loadKaiCharSet().catch(() => {});
}

function updatePreviewScale(dimensions) {
  const availableWidth = Math.max(240, els.previewWrap.clientWidth - 40);
  const requestedScale = settings.zoom / 100;
  const fitScale = availableWidth / (dimensions.width * CSS_PX_PER_MM);
  const baseScale = Math.min(1, fitScale);
  const scale = settings.zoom > 100 ? baseScale * requestedScale : Math.min(requestedScale, fitScale);
  document.documentElement.style.setProperty("--preview-scale", scale.toFixed(4));
  for (const shell of els.pages.querySelectorAll(".page-shell")) {
    shell.style.width = `${dimensions.width * CSS_PX_PER_MM * scale}px`;
    shell.style.height = `${dimensions.height * CSS_PX_PER_MM * scale}px`;
  }
}

function render() {
  markerSequence = 0;
  const dimensions = paperDimensions();
  const copyItems = settings.template === "copy" ? extractCopyItems(settings.inputText) : [];
  const characters = extractCharacters(settings.inputText, settings.template === "copy" ? false : settings.dedupe);
  const unsupported = unsupportedCharacters(characters);
  const printable = characters.filter((character) => !unsupported.includes(character));
  const dataCharacters = [...new Set([...printable, ...pdfProtectedCharacters])];
  if (settings.template !== "blank" || pdfProtectedCharacters.length) ensureCharacterData(dataCharacters);

  const loaded = printable.filter((character) => window.HANZI_STROKES?.[character]).length;
  const loading = printable.length - loaded;
  const activeFailedChunks = [...activeChunkIds].filter((chunkId) => failedChunks.has(chunkId));
  const dataState = settings.template === "blank" || loading === 0
    ? "ready"
    : activeFailedChunks.length ? "error" : "loading";
  let result;

  if (dataState === "error") result = renderDataErrorPage(dimensions);
  else if (settings.template === "blank") result = renderBlankPages(dimensions);
  else if (settings.template === "copy") result = renderCopyPages(settings.inputText, dimensions);
  else if (settings.template === "stroke") result = renderStrokePages(printable, dimensions);
  else result = renderStandardPages(printable, dimensions);

  els.pages.innerHTML = result.markup;
  updatePreviewScale(dimensions);
  els.printPageStyle.textContent = `@page { size: ${dimensions.width}mm ${dimensions.height}mm; margin: 0; }`;

  const contentAmount = settings.template === "copy" ? `${copyItems.length} 个字符` : `${printable.length} 个字`;
  let summary = dataState === "loading"
    ? `${contentAmount} · 笔顺加载中…`
    : dataState === "error"
      ? `${contentAmount} · 笔顺加载失败`
      : settings.template === "blank"
    ? `${result.pageCount} 页 · ${result.columns} × ${result.rows} 格`
    : settings.template === "copy"
      ? `${copyItems.length} 个字符 · ${result.pageCount} 页`
      : `${printable.length} 个字 · ${result.pageCount} 页`;
  if (result.autoExpandedRows) summary += ` · 笔顺最多 ${result.rowsPerCharacter} 行`;
  else if (result.rowsPerCharacter > 1) summary += ` · 每字 ${result.rowsPerCharacter} 行`;
  els.summary.textContent = summary;
  els.contentStatus.textContent = settings.template === "copy"
    ? `${copyItems.length} 个字符${unsupported.length ? ` · ${unsupported.length} 字使用字体` : ""}`
    : unsupported.length ? `${unsupported.length} 个字暂无数据：${unsupported.join(" ")}` : `${characters.length} 个汉字`;
  const activePacks = activeZipPacks();
  const loadingPacks = activePacks.filter((pack) => zipArchiveStates.get(pack.id) === "loading");
  const readyPackCount = [...zipArchiveStates.values()].filter((state) => state === "ready").length;
  const loadingMegabytes = (loadingPacks.reduce((total, pack) => total + (pack.bytes || 0), 0) / 1024 / 1024).toFixed(1);
  els.dataStatus.textContent = activeFailedChunks.length
    ? `${activeFailedChunks.length} 个笔顺分片加载失败`
    : loadingPacks.length ? `正在加载 ${loadingMegabytes}MB 笔顺字库`
      : loading ? `正在解压 ${loading} 个字`
        : readyPackCount ? `ZIP 字库已就绪 · ${readyPackCount} 包 · 内存 ${loadedChunks.size} 分片`
          : navigator.onLine ? "笔顺数据已就绪" : "离线可用";
  els.dataStatus.dataset.state = dataState;
  els.dataStatus.setAttribute("aria-busy", dataState === "loading" ? "true" : "false");
  els.summary.dataset.state = dataState;
  els.pages.setAttribute("aria-busy", dataState === "loading" ? "true" : "false");
  els.printBtn.disabled = dataState !== "ready" || pdfOperationActive;
  const compactSuffix = dataState === "loading" ? " · 笔顺加载中…" : dataState === "error" ? " · 笔顺加载失败" : "";
  els.compactStatus.textContent = `${settings.paperSize} · ${settings.orientation === "portrait" ? "纵向" : "横向"} · ${GRID_STYLE_LABELS[gridStyle()]} · ${TEMPLATE_LABELS[settings.template]}${compactSuffix}`;
  document.title = dataState === "loading"
    ? `${APP_TITLE}（笔顺加载中…）`
    : dataState === "error" ? `${APP_TITLE}（笔顺加载失败）` : APP_TITLE;
  document.body.dataset.template = settings.template;
  updateHeaderFieldVisibility();
  updateOutputs();
  prerenderStrokePngs();
}

function buildStandaloneSvg(svg) {
  const character = svg.dataset.ch;
  const data = window.HANZI_STROKES?.[character];
  if (!data) return null;
  const step = svg.dataset.step;
  const mode = step !== undefined ? "step" : "full";
  const stepNum = step !== undefined ? Number(step) : data.strokes.length - 1;
  const paths = data.strokes.map((pathData, index) => {
    if (mode === "step" && index > stepNum) return "";
    const fill = mode === "step" && index < stepNum ? STROKE_DONE_COLOR : settingColor("strokeActiveColor");
    return `<path d="${pathData}" fill="${fill}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}"><g transform="translate(0 ${BASELINE}) scale(1 -1)">${paths}</g></svg>`;
}

function prerenderStrokePngs() {
  if (settings.template !== "stroke") return;
  for (const svg of els.pages.querySelectorAll("svg.hanzi-cell[data-ch]")) {
    if (svgPngCache.has(svg)) continue;
    const svgSource = buildStandaloneSvg(svg);
    if (!svgSource) continue;
    const img = new Image();
    const svgDataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgSource);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      canvas.getContext("2d").drawImage(img, 0, 0, 256, 256);
      svgPngCache.set(svg, canvas.toDataURL("image/png"));
    };
    img.src = svgDataUrl;
  }
}

function scheduleRender(shouldSave = true) {
  if (shouldSave) {
    saveSettings();
  }
  cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(render);
}

function readControl(control) {
  if (control.type === "checkbox") return control.checked;
  if (NUMBER_FIELDS.has(control.dataset.setting)) {
    const value = Number(control.value);
    if (!Number.isFinite(value)) return DEFAULT_SETTINGS[control.dataset.setting];
    const minimum = control.min === "" ? -Infinity : Number(control.min);
    const maximum = control.max === "" ? Infinity : Number(control.max);
    return clamp(value, minimum, maximum);
  }
  return control.value;
}

function syncSettingFromControl(control) {
  if (control.type === "radio" && !control.checked) return;
  settings[control.dataset.setting] = readControl(control);
  scheduleRender();
}

function applySettingsToControls() {
  for (const control of document.querySelectorAll("[data-setting]")) {
    const key = control.dataset.setting;
    if (!(key in settings)) continue;
    if (control.type === "checkbox" || control.type === "radio") control.checked = control.type === "checkbox" ? Boolean(settings[key]) : control.value === String(settings[key]);
    else control.value = settings[key];
  }
}

function updateOutputs() {
  document.querySelector("#traceOpacityOutput").value = `${Math.round(settings.traceOpacity * 100)}%`;
  document.querySelector("#traceScaleOutput").value = `${Math.round(settings.traceScale * 100)}%`;
  document.querySelector("#zoomOutput").value = `${settings.zoom}%`;
  updateSteppers();
}

function updateSteppers() {
  for (const stepper of document.querySelectorAll("[data-stepper]")) {
    const input = stepper.querySelector("input[type='number']");
    const value = Number(input.value);
    const minimum = input.min === "" ? -Infinity : Number(input.min);
    const maximum = input.max === "" ? Infinity : Number(input.max);
    stepper.querySelector("[data-stepper-action='decrement']").disabled = Number.isFinite(value) && value <= minimum;
    stepper.querySelector("[data-stepper-action='increment']").disabled = Number.isFinite(value) && value >= maximum;
  }
}

function adjustStepper(button) {
  const input = button.closest("[data-stepper]")?.querySelector("input[type='number']");
  if (!input) return;
  if (button.dataset.stepperAction === "increment") input.stepUp();
  else input.stepDown();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function showExportStatus(message, isError = false) {
  clearTimeout(exportStatusTimer);
  els.exportStatus.textContent = message;
  els.exportStatus.classList.toggle("error", isError);
  els.exportStatus.hidden = false;
  exportStatusTimer = setTimeout(() => { els.exportStatus.hidden = true; }, 5000);
}

function reportPdfProgress(message) {
  activePdfProgress?.(message);
}

function beginPdfOperation(button) {
  if (pdfOperationActive || button.disabled) return null;
  const originalLabel = button.textContent;
  pdfOperationActive = true;
  els.exportPdfBtn.disabled = true;
  els.printBtn.disabled = true;
  button.setAttribute("aria-busy", "true");
  activePdfProgress = (message) => { button.textContent = message; };
  reportPdfProgress("生成中…");
  return () => {
    pdfProtectedCharacters = [];
    activePdfProgress = null;
    pdfOperationActive = false;
    button.removeAttribute("aria-busy");
    button.textContent = originalLabel;
    els.exportPdfBtn.disabled = false;
    els.printBtn.disabled = els.dataStatus.dataset.state !== "ready";
  };
}

function exportFilename() {
  const fallback = TEMPLATE_LABELS[settings.template] || "汉字练习";
  const title = String(settings.title || fallback).trim().replace(/[\\/:*?"<>|]/g, "-").slice(0, 48) || fallback;
  return `${title}-${settings.paperSize}-${settings.orientation === "landscape" ? "横向" : "纵向"}.pdf`;
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function preparePdfPages() {
  const inputCharacters = settings.template === "blank"
    ? []
    : extractCharacters(settings.inputText, settings.template === "copy" ? false : settings.dedupe);
  const unsupported = unsupportedCharacters(inputCharacters);
  const printable = inputCharacters.filter((character) => !unsupported.includes(character));
  // 从现有 DOM 提取页面字符（页眉/标题字等），防止 LRU 逐出
  const existingPageChars = extractPageCharacters().filter((character) => !unsupportedCharacters([character]).length);
  pdfProtectedCharacters = existingPageChars;
  const allCharacters = [...new Set([...printable, ...existingPageChars])];
  reportPdfProgress("准备练习字…");
  await ensureCharacterData(allCharacters);
  if (document.fonts?.ready) await document.fonts.ready;
  render();
  await nextPaint();
  const pageCharacters = extractPageCharacters();
  const supportedPageCharacters = pageCharacters.filter((character) => !unsupportedCharacters([character]).length);
  pdfProtectedCharacters = supportedPageCharacters;
  const pdfCharacters = [...new Set([...printable, ...supportedPageCharacters])];
  if (pdfCharacters.some((character) => !window.HANZI_STROKES?.[character])) {
    reportPdfProgress("准备页眉文字…");
    await ensureCharacterData(pdfCharacters);
    render();
    await nextPaint();
  }
  reportPdfProgress("完成页面排版…");
  const missing = printable.filter((character) => !window.HANZI_STROKES?.[character]);
  if (missing.length && settings.template !== "copy") throw new Error(`笔顺数据载入失败：${missing.join(" ")}`);
  render();
  await nextPaint();
}

function pageMetrics(page, dimensions) {
  const rect = page.getBoundingClientRect();
  return {
    rect,
    xScale: dimensions.width / rect.width,
    yScale: dimensions.height / rect.height,
  };
}

function relativeRect(rect, metrics) {
  return {
    x: (rect.left - metrics.rect.left) * metrics.xScale,
    y: (rect.top - metrics.rect.top) * metrics.yScale,
    width: rect.width * metrics.xScale,
    height: rect.height * metrics.yScale,
  };
}

function cssColor(value, opacity = 1) {
  const str = String(value);
  const hex = str.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  const match = hex ? [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)] : str.match(/[\d.]+/g);
  if (!match || value === "none" || value === "transparent") return null;
  const channels = match.slice(0, 3).map(Number);
  const alpha = clamp(opacity * (match[3] === undefined ? 1 : Number(match[3])), 0, 1);
  return channels.map((channel) => Math.round(255 - (255 - channel) * alpha));
}

function setPdfColor(pdf, method, value, opacity = 1) {
  const color = cssColor(value, opacity);
  if (!color) return false;
  pdf[method](...color);
  return true;
}

function drawBorderLine(pdf, start, end, width, color, style) {
  setPdfColor(pdf, "setDrawColor", color);
  pdf.setLineWidth(width);
  pdf.setLineCap("butt");
  pdf.setLineDashPattern(style === "dashed" ? [width * 3, width * 2] : style === "dotted" ? [width, width * 1.8] : [], 0);
  pdf.line(start.x, start.y, end.x, end.y);
}

function drawHtmlBorders(pdf, page, metrics) {
  for (const element of page.querySelectorAll("*")) {
    if (element.closest("svg")) continue;
    const computed = getComputedStyle(element);
    if (computed.display === "none" || computed.visibility === "hidden") continue;
    const box = relativeRect(element.getBoundingClientRect(), metrics);
    if (!box.width || !box.height) continue;
    const sides = [
      ["Top", { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y }, metrics.yScale],
      ["Right", { x: box.x + box.width, y: box.y }, { x: box.x + box.width, y: box.y + box.height }, metrics.xScale],
      ["Bottom", { x: box.x, y: box.y + box.height }, { x: box.x + box.width, y: box.y + box.height }, metrics.yScale],
      ["Left", { x: box.x, y: box.y }, { x: box.x, y: box.y + box.height }, metrics.xScale],
    ];
    for (const [side, start, end, scale] of sides) {
      const style = computed[`border${side}Style`];
      const width = parseFloat(computed[`border${side}Width`]) * scale;
      if (!width || style === "none" || style === "hidden") continue;
      drawBorderLine(pdf, start, end, width, computed[`border${side}Color`], style);
    }
  }
}

const parsedPathCache = new Map();

function parseSvgPath(pathData) {
  if (parsedPathCache.has(pathData)) return parsedPathCache.get(pathData);
  const tokens = pathData.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const operations = [];
  let index = 0;
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  while (index < tokens.length) {
    const rawCommand = tokens[index++];
    const command = rawCommand === "z" ? "Z" : rawCommand;
    const number = () => {
      const token = tokens[index++];
      const value = Number(token);
      if (token === undefined || !Number.isFinite(value)) throw new Error(`SVG 路径命令 ${command} 缺少坐标`);
      return value;
    };
    if (command === "M") {
      current = { x: number(), y: number() };
      start = { ...current };
      operations.push({ op: "m", points: [current] });
    } else if (command === "L") {
      current = { x: number(), y: number() };
      operations.push({ op: "l", points: [current] });
    } else if (command === "H") {
      current = { x: number(), y: current.y };
      operations.push({ op: "l", points: [current] });
    } else if (command === "V") {
      current = { x: current.x, y: number() };
      operations.push({ op: "l", points: [current] });
    } else if (command === "Q") {
      const control = { x: number(), y: number() };
      const end = { x: number(), y: number() };
      const first = { x: current.x + (control.x - current.x) * 2 / 3, y: current.y + (control.y - current.y) * 2 / 3 };
      const second = { x: end.x + (control.x - end.x) * 2 / 3, y: end.y + (control.y - end.y) * 2 / 3 };
      operations.push({ op: "c", points: [first, second, end] });
      current = end;
    } else if (command === "C") {
      const first = { x: number(), y: number() };
      const second = { x: number(), y: number() };
      const end = { x: number(), y: number() };
      operations.push({ op: "c", points: [first, second, end] });
      current = end;
    } else if (command === "Z") {
      operations.push({ op: "h", points: [] });
      current = { ...start };
    } else {
      throw new Error(`不支持的 SVG 路径命令：${rawCommand}`);
    }
  }
  parsedPathCache.set(pathData, operations);
  return operations;
}

function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyMatrix(left, right) {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

function elementMatrix(element) {
  const matrix = element.transform?.baseVal?.consolidate()?.matrix;
  return matrix ? { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f } : identityMatrix();
}

function mapSvgPoint(point, matrix, box) {
  const x = matrix.a * point.x + matrix.c * point.y + matrix.e;
  const y = matrix.b * point.x + matrix.d * point.y + matrix.f;
  return { x: box.x + x * box.width / VIEWBOX_SIZE, y: box.y + y * box.height / VIEWBOX_SIZE };
}

function pdfPath(pathData, matrix, box) {
  return parseSvgPath(pathData).map((operation) => ({
    op: operation.op,
    c: operation.points.flatMap((point) => {
      const mapped = mapSvgPoint(point, matrix, box);
      return [mapped.x, mapped.y];
    }),
  }));
}

function drawPdfPath(pdf, path, style) {
  pdf.path(path);
  if (style === "FD") pdf.fillStroke();
  else if (style === "F") pdf.fill();
  else if (style === "S") pdf.stroke();
}

function paintSvgShape(pdf, element, matrix, box, path) {
  const computed = getComputedStyle(element);
  const opacity = Number(computed.opacity) || 1;
  const hasFill = setPdfColor(pdf, "setFillColor", computed.fill, opacity * (Number(computed.fillOpacity) || 1));
  const hasStroke = setPdfColor(pdf, "setDrawColor", computed.stroke, opacity * (Number(computed.strokeOpacity) || 1));
  const unitScale = (box.width + box.height) / (VIEWBOX_SIZE * 2);
  pdf.setLineWidth(Math.max(0.01, parseFloat(computed.strokeWidth || "1") * unitScale));
  pdf.setLineCap(computed.strokeLinecap || "butt");
  pdf.setLineJoin(computed.strokeLinejoin || "miter");
  const dash = computed.strokeDasharray === "none" ? [] : (computed.strokeDasharray.match(/[\d.]+/g) || []).map(Number).map((value) => value * unitScale);
  pdf.setLineDashPattern(dash, 0);
  const style = hasFill && hasStroke ? "FD" : hasFill ? "F" : hasStroke ? "S" : null;
  if (style) drawPdfPath(pdf, path, style);
}

function drawSvgElement(pdf, element, parentMatrix, box) {
  const tag = element.tagName.toLowerCase();
  if (["defs", "marker"].includes(tag)) return;
  const matrix = multiplyMatrix(parentMatrix, elementMatrix(element));
  if (["g", "svg"].includes(tag)) {
    for (const child of element.children) drawSvgElement(pdf, child, matrix, box);
    return;
  }
  if (tag === "path" && element.hasAttribute("d")) {
    paintSvgShape(pdf, element, matrix, box, pdfPath(element.getAttribute("d"), matrix, box));
    return;
  }
  const point = (x, y) => mapSvgPoint({ x: Number(x), y: Number(y) }, matrix, box);
  if (tag === "line") {
    const start = point(element.getAttribute("x1"), element.getAttribute("y1"));
    const end = point(element.getAttribute("x2"), element.getAttribute("y2"));
    paintSvgShape(pdf, element, matrix, box, [{ op: "m", c: [start.x, start.y] }, { op: "l", c: [end.x, end.y] }]);
    if (element.hasAttribute("marker-end")) {
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const length = Math.min(box.width, box.height) * 0.035;
      const spread = length * 0.55;
      const back = { x: end.x - Math.cos(angle) * length, y: end.y - Math.sin(angle) * length };
      setPdfColor(pdf, "setFillColor", getComputedStyle(element).stroke);
      drawPdfPath(pdf, [
        { op: "m", c: [end.x, end.y] },
        { op: "l", c: [back.x + Math.sin(angle) * spread, back.y - Math.cos(angle) * spread] },
        { op: "l", c: [back.x - Math.sin(angle) * spread, back.y + Math.cos(angle) * spread] },
        { op: "h", c: [] },
      ], "F");
    }
    return;
  }
  if (tag === "rect") {
    const x = Number(element.getAttribute("x"));
    const y = Number(element.getAttribute("y"));
    const width = Number(element.getAttribute("width"));
    const height = Number(element.getAttribute("height"));
    const corners = [point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height)];
    paintSvgShape(pdf, element, matrix, box, [
      { op: "m", c: [corners[0].x, corners[0].y] },
      ...corners.slice(1).map((corner) => ({ op: "l", c: [corner.x, corner.y] })),
      { op: "h", c: [] },
    ]);
    return;
  }
  if (tag === "circle") {
    const center = point(element.getAttribute("cx"), element.getAttribute("cy"));
    const radius = Number(element.getAttribute("r")) * (box.width + box.height) / (VIEWBOX_SIZE * 2);
    const computed = getComputedStyle(element);
    const hasFill = setPdfColor(pdf, "setFillColor", computed.fill, Number(computed.opacity) || 1);
    const hasStroke = setPdfColor(pdf, "setDrawColor", computed.stroke, Number(computed.opacity) || 1);
    pdf.circle(center.x, center.y, radius, hasFill && hasStroke ? "FD" : hasFill ? "F" : "S");
    return;
  }
  if (tag === "text") {
    const computed = getComputedStyle(element);
    const anchor = point(element.getAttribute("x"), element.getAttribute("y"));
    setPdfColor(pdf, "setTextColor", computed.stroke === "none" ? computed.fill : computed.stroke, Number(computed.opacity) || 1);
    pdf.setFont(KAI_FONT_FACE, "normal");
    pdf.setFontSize(parseFloat(computed.fontSize) * box.width / VIEWBOX_SIZE * 72 / 25.4);
    pdf.text(element.textContent, anchor.x, anchor.y, { align: computed.textAnchor === "middle" ? "center" : "left", baseline: "middle" });
  }
}

// Form XObject caches: each unique grid / glyph / progressive step is defined
// once in unit viewBox space (0..VIEWBOX_SIZE) and reused per cell via Do,
// so repeated characters and grids no longer duplicate path data per cell.
const gridFormCache = new Map();
const glyphFormCache = new Map();
const stepFormCache = new Map();
const UNIT_BOX = { x: 0, y: 0, width: VIEWBOX_SIZE, height: VIEWBOX_SIZE };
const FLIP_MATRIX = { a: 1, b: 0, c: 0, d: -1, e: 0, f: BASELINE };

function gridFormKey(source) {
  const frame = source.querySelector(".grid-frame-line");
  const joinLeft = frame && frame.tagName.toLowerCase() === "path";
  return `${gridStyle()}@${joinLeft ? 1 : 0}@${settings.showGuides ? 1 : 0}`;
}

function ensureGridForm(pdf, source) {
  const key = gridFormKey(source);
  if (gridFormCache.has(key)) return key;
  const edge = 8;
  const far = VIEWBOX_SIZE - edge;
  const mid = VIEWBOX_SIZE / 2;
  const closed = !(source.querySelector(".grid-frame-line")?.tagName.toLowerCase() === "path");
  pdf.beginFormObject(0, 0, VIEWBOX_SIZE, VIEWBOX_SIZE, pdf.Matrix(1, 0, 0, 1, 0, 0));
  pdf.setLineCap("square");
  pdf.setLineJoin("miter");
  setPdfColor(pdf, "setDrawColor", settingColor("gridFrameColor"));
  pdf.setLineWidth(9);
  pdf.setLineDashPattern([], 0);
  const frameOps = [{ op: "m", c: [edge, edge] }, { op: "l", c: [far, edge] }, { op: "l", c: [far, far] }, { op: "l", c: [edge, far] }];
  if (closed) frameOps.push({ op: "h", c: [] });
  drawPdfPath(pdf, frameOps, "S");
  if (settings.showGuides) {
    pdf.setLineWidth(6);
    pdf.setLineDashPattern([25, 22], 0);
    setPdfColor(pdf, "setDrawColor", settingColor("gridCrossColor"));
    drawPdfPath(pdf, [{ op: "m", c: [mid, edge] }, { op: "l", c: [mid, far] }], "S");
    drawPdfPath(pdf, [{ op: "m", c: [edge, mid] }, { op: "l", c: [far, mid] }], "S");
    if (gridStyle() === "mi") {
      setPdfColor(pdf, "setDrawColor", settingColor("gridDiagonalColor"));
      drawPdfPath(pdf, [{ op: "m", c: [edge, edge] }, { op: "l", c: [far, far] }], "S");
      drawPdfPath(pdf, [{ op: "m", c: [far, edge] }, { op: "l", c: [edge, far] }], "S");
    }
  }
  pdf.endFormObject(key);
  gridFormCache.set(key, true);
  return key;
}

function ensureGlyphForm(pdf, character) {
  if (glyphFormCache.has(character)) return true;
  const data = window.HANZI_STROKES?.[character];
  if (!data) return false;
  pdf.beginFormObject(0, 0, VIEWBOX_SIZE, VIEWBOX_SIZE, pdf.Matrix(1, 0, 0, 1, 0, 0));
  for (const pathData of data.strokes) drawPdfPath(pdf, pdfPath(pathData, FLIP_MATRIX, UNIT_BOX), "F");
  pdf.endFormObject(character);
  glyphFormCache.set(character, true);
  return true;
}

// Progressive step form: strokes 0..step. In trace mode the form is
// color-agnostic (caller sets the trace color). In step mode the done/current
// distinction is baked in so the current stroke stays highlighted.
// 单笔 Form：每笔一个 color-agnostic Form，渲染时叠加 doFormObject。
// 相比每步建含累加笔画的 Form（路径 O(N²) 重复），路径数据降到 O(N)，大幅减小 PDF 体积。
function ensureStrokeForm(pdf, character, index) {
  const key = `${character}#s${index}`;
  if (stepFormCache.has(key)) return true;
  const data = window.HANZI_STROKES?.[character];
  if (!data || index >= data.strokes.length) return false;
  pdf.beginFormObject(0, 0, VIEWBOX_SIZE, VIEWBOX_SIZE, pdf.Matrix(1, 0, 0, 1, 0, 0));
  drawPdfPath(pdf, pdfPath(data.strokes[index], FLIP_MATRIX, UNIT_BOX), "F");
  pdf.endFormObject(key);
  stepFormCache.set(key, true);
  return true;
}

function drawCellGlyph(pdf, source, square) {
  const character = source.dataset.ch;
  const trace = source.dataset.trace === "1";
  const guide = source.dataset.guide === "1";
  const step = source.dataset.step;
  const applyScale = trace || source.dataset.traceScale === "1";
  const traceScale = applyScale ? (settings.traceScale ?? 1) : 1;
  // 缩小 trace glyph 的渲染区域，保持居中
  const scaledSize = square.width * traceScale;
  const scaledSquare = {
    x: square.x + (square.width - scaledSize) / 2,
    y: square.y + (square.height - scaledSize) / 2,
    width: scaledSize,
    height: scaledSize
  };
  const scale = scaledSize / VIEWBOX_SIZE;
  const matrix = pdf.Matrix(scale, 0, 0, scale, scaledSquare.x, scaledSquare.y);
  if (step !== undefined) {
    const data = window.HANZI_STROKES?.[character];
    if (!data) return;
    const n = Number(step);
    const doneEnd = Math.min(n, data.strokes.length);
    setPdfColor(pdf, "setFillColor", trace ? settingColor("traceColor") : STROKE_DONE_COLOR, trace ? settings.traceOpacity : 1);
    for (let i = 0; i < doneEnd; i++) {
      if (!ensureStrokeForm(pdf, character, i)) return;
      pdf.doFormObject(`${character}#s${i}`, matrix);
    }
    if (n < data.strokes.length) {
      if (!trace) setPdfColor(pdf, "setFillColor", settingColor("strokeActiveColor"));
      if (!ensureStrokeForm(pdf, character, n)) return;
      pdf.doFormObject(`${character}#s${n}`, matrix);
    }
  } else {
    setPdfColor(pdf, "setFillColor", trace ? settingColor("traceColor") : (guide ? settingColor("guideColor") : settingColor("strokeActiveColor")), trace ? settings.traceOpacity : 1);
    if (!ensureGlyphForm(pdf, character)) return;
    pdf.doFormObject(character, matrix);
  }
}

function drawHanziForm(pdf, character, box, color, opacity = 1) {
  const data = window.HANZI_STROKES?.[character];
  if (!data) return false;
  const size = Math.min(box.width, box.height);
  const square = { x: box.x + (box.width - size) / 2, y: box.y + (box.height - size) / 2, width: size, height: size };
  setPdfColor(pdf, "setFillColor", color, opacity);
  if (!ensureGlyphForm(pdf, character)) return false;
  pdf.doFormObject(character, pdf.Matrix(size / VIEWBOX_SIZE, 0, 0, size / VIEWBOX_SIZE, square.x, square.y));
  return true;
}

function drawPageSvgs(pdf, page, metrics) {
  for (const source of page.querySelectorAll("svg.hanzi-cell")) {
    const box = relativeRect(source.getBoundingClientRect(), metrics);
    if (!box.width || !box.height) continue;
    const size = Math.min(box.width, box.height);
    const square = { x: box.x + (box.width - size) / 2, y: box.y + (box.height - size) / 2, width: size, height: size };
    const matrix = pdf.Matrix(size / VIEWBOX_SIZE, 0, 0, size / VIEWBOX_SIZE, square.x, square.y);
    pdf.doFormObject(ensureGridForm(pdf, source), matrix);
    if (source.dataset.ch) drawCellGlyph(pdf, source, square);
    // Annotations (start dots, arrows, stroke numbers) stay inline: they only
    // appear on model/step cells, so their duplication is bounded.
    for (const child of source.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === "g" || child.classList.contains("grid-frame-line") || child.classList.contains("grid-cross-line") || child.classList.contains("grid-diagonal-line")) continue;
      drawSvgElement(pdf, child, identityMatrix(), box);
    }
  }
}

function drawToneMark(pdf, mark, box, color, width) {
  setPdfColor(pdf, "setDrawColor", color);
  setPdfColor(pdf, "setFillColor", color);
  pdf.setLineWidth(width);
  pdf.setLineCap("round");
  if (mark === "\u0304") pdf.line(box.x + box.width * 0.2, box.y + box.height * 0.08, box.x + box.width * 0.8, box.y + box.height * 0.08);
  if (mark === "\u0301") pdf.line(box.x + box.width * 0.43, box.y + box.height * 0.17, box.x + box.width * 0.72, box.y + box.height * 0.02);
  if (mark === "\u0300") pdf.line(box.x + box.width * 0.28, box.y + box.height * 0.02, box.x + box.width * 0.57, box.y + box.height * 0.17);
  if (mark === "\u030c") pdf.lines([[box.width * 0.25, box.height * 0.14], [box.width * 0.25, -box.height * 0.14]], box.x + box.width * 0.25, box.y + box.height * 0.03, [1, 1], "S");
  if (mark === "\u0308") {
    const radius = width * 0.75;
    pdf.circle(box.x + box.width * 0.35, box.y + box.height * 0.08, radius, "F");
    pdf.circle(box.x + box.width * 0.65, box.y + box.height * 0.08, radius, "F");
  }
}

function drawPdfText(pdf, character, box, computed) {
  const fontSize = parseFloat(computed.fontSize) / CSS_PX_PER_MM;
  const decomposed = character.normalize("NFD");
  const base = Array.from(decomposed).find((part) => !/\p{Mark}/u.test(part)) || character;
  const marks = Array.from(decomposed).filter((part) => /\p{Mark}/u.test(part));
  const baseline = box.y + (box.height - fontSize) / 2 + fontSize * 0.8;
  setPdfColor(pdf, "setTextColor", computed.color, computed.opacity);
  pdf.setFont(KAI_FONT_FACE, "normal");
  pdf.setFontSize(parseFloat(computed.fontSize) * 0.75);
  pdf.text(base, box.x, baseline);
  for (const mark of marks) drawToneMark(pdf, mark, box, computed.color, Math.max(0.12, fontSize * 0.07));
}

function drawHtmlText(pdf, page, metrics) {
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || parent.closest("svg")) continue;
    const computed = getComputedStyle(parent);
    if (computed.display === "none" || computed.visibility === "hidden" || Number(computed.opacity) === 0) continue;
    let offset = 0;
    for (const character of Array.from(node.data)) {
      const end = offset + character.length;
      if (!/\s/u.test(character)) {
        range.setStart(node, offset);
        range.setEnd(node, end);
        const rect = range.getBoundingClientRect();
        if (rect.width && rect.height) {
          const box = relativeRect(rect, metrics);
          const fontSize = parseFloat(computed.fontSize) / CSS_PX_PER_MM;
          const glyphBox = { x: box.x, y: box.y + (box.height - fontSize) / 2, width: box.width, height: fontSize };
          if (/[\u3400-\u9fff]/u.test(character) && kaiCharSet && !kaiCharSet.has(character) && drawHanziForm(pdf, character, glyphBox, computed.color, computed.opacity)) {
            // \u751f\u50fb\u5b57\uff08\u8d85\u51fa\u5185\u5d4c\u6977\u4f53\u8986\u76d6\uff09\u4e14\u6709\u7b14\u987a\u6570\u636e\uff1a\u7528\u7b14\u987a\u8f6e\u5ed3 fallback\uff0c\u907f\u514d\u7f3a\u5b57\u7a7a\u767d
          } else {
            drawPdfText(pdf, character, box, computed);
          }
        }
      }
      offset = end;
    }
  }
  range.detach();
}

async function buildPdfDocument() {
  await loadKaiCharSet();
  await preparePdfPages();
  reportPdfProgress("载入 PDF 组件…");
  await nextPaint();
  await loadScript("vendor/jspdf.umd.min.js");
  if (!window.jspdf?.jsPDF) throw new Error("PDF 组件载入失败");

  const dimensions = paperDimensions();
  const orientation = dimensions.width > dimensions.height ? "landscape" : "portrait";
  const pdf = new window.jspdf.jsPDF({
    orientation,
    unit: "mm",
    format: [dimensions.width, dimensions.height],
    compress: true,
  });
  const pages = [...els.pages.querySelectorAll(".page")];
  await prepareKaiFont(pdf, pages);

  gridFormCache.clear();
  glyphFormCache.clear();
  stepFormCache.clear();
  const sf = pdf.internal.scaleFactor;
  const pageMatrix = pdf.Matrix(sf, 0, 0, -sf, 0, dimensions.height * sf);
  pdf.advancedAPI(() => {
    // advancedAPI emits the mm->pt CTM (q + scale matrix) once, on page 1.
    // addPage() inside advanced mode does NOT re-emit it, so every page from
    // page 2 on would render in raw PDF points (~2.8x smaller, flipped Y).
    // Re-establish the CTM per page and balance q/Q: pages 1..N-1 close their
    // own q with restoreGraphicsState; the final page's q is closed by the
    // restoreGraphicsState that advancedAPI emits when exiting.
    for (const [index, page] of pages.entries()) {
      reportPdfProgress(`生成第 ${index + 1} / ${pages.length} 页…`);
      if (index > 0) {
        pdf.addPage([dimensions.width, dimensions.height], orientation);
        pdf.saveGraphicsState();
        pdf.internal.write(pageMatrix.toString() + " cm");
      }
      pdf.setFillColor(255, 255, 255);
      pdf.rect(0, 0, dimensions.width, dimensions.height, "F");
      const metrics = pageMetrics(page, dimensions);
      drawHtmlBorders(pdf, page, metrics);
      drawPageSvgs(pdf, page, metrics);
      drawHtmlText(pdf, page, metrics);
      if (index < pages.length - 1) pdf.restoreGraphicsState();
    }
    return undefined;
  });

  return { pdf, pageCount: pages.length };
}

async function exportPdf() {
  const finish = beginPdfOperation(els.exportPdfBtn);
  if (!finish) return;
  try {
    const { pdf, pageCount } = await buildPdfDocument();
    reportPdfProgress("保存 PDF…");
    await nextPaint();
    pdf.save(exportFilename());
    showExportStatus(`已生成 ${pageCount} 页 PDF`);
  } catch (error) {
    console.error(error);
    showExportStatus(error?.message || "PDF 导出失败，请重试", true);
  } finally {
    finish();
  }
}

function detectPrintPlatform() {
  const ua = navigator.userAgent || "";
  const uaData = navigator.userAgentData;
  const platformName = uaData?.platform || navigator.platform || "";
  const touchPoints = navigator.maxTouchPoints || 0;

  if (/iPhone|iPad|iPod/i.test(ua) || /iPhone|iPad|iPod/i.test(platformName)) return { os: "ios", mobile: true };
  // iPadOS 13+ reports a desktop Macintosh user agent. Without the touch-point
  // check an iPad would take the desktop window.print() path instead of the
  // system share sheet where AirPrint is available.
  if (/Mac/i.test(platformName) && touchPoints > 1) return { os: "ipados", mobile: true };
  if (/HarmonyOS|OpenHarmony/i.test(ua)) return { os: "harmony", mobile: true };
  if (/Android/i.test(ua) || /Android/i.test(platformName)) return { os: "android", mobile: true };
  if (uaData?.mobile === true || /Mobi|Mobile|Tablet/i.test(ua)) return { os: "mobile", mobile: true };
  if (matchMedia("(pointer: coarse)").matches && matchMedia("(max-width: 900px)").matches) {
    return { os: "mobile", mobile: true };
  }
  return { os: "desktop", mobile: false };
}

function showPrintNote(message, timeout = 7000) {
  clearTimeout(printNoteTimer);
  printNoteTimer = 0;
  els.printNote.textContent = message;
  els.printNote.hidden = false;
  if (timeout > 0) {
    printNoteTimer = setTimeout(() => {
      els.printNote.hidden = true;
      printNoteTimer = 0;
    }, timeout);
  }
}

function hidePrintNote() {
  clearTimeout(printNoteTimer);
  printNoteTimer = 0;
  els.printNote.hidden = true;
}

function mobilePrintHint(platform) {
  if (platform.os === "ios" || platform.os === "ipados") {
    return "正在生成 PDF，完成后将尝试打开系统分享面板，请选择「打印」并选择打印机。";
  }
  if (platform.os === "android" || platform.os === "harmony") {
    return "正在生成 PDF，完成后将尝试打开系统分享面板，请选择「打印」服务并选择打印机。";
  }
  return "正在生成 PDF，完成后将尝试打开系统分享面板，请在其中选择打印机。";
}

function savedPdfHint(platform, pageCount) {
  if (platform.os === "ios" || platform.os === "ipados") {
    return `已生成 ${pageCount} 页 PDF，请在下载文件中打开并选择「打印」`;
  }
  if (platform.os === "android" || platform.os === "harmony") {
    return `已生成 ${pageCount} 页 PDF，请在下载内容中打开并选择「打印」`;
  }
  return `已生成 ${pageCount} 页 PDF，请打开文件后选择打印`;
}

function canSharePdfFile(file) {
  if (typeof File === "undefined" || typeof navigator.share !== "function") return false;
  if (typeof navigator.canShare !== "function") return true;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

async function sharePdfForPrint(pdf, filename) {
  // navigator.share is the native system share sheet on iOS/iPadOS and Android.
  // Both expose a Print target for PDF files (AirPrint on iOS; Android 11+
  // Share-to-Print), so sharing the generated PDF lets the user pick a printer.
  if (typeof File === "undefined" || typeof navigator.share !== "function") return "unsupported";
  let file;
  try {
    const blob = pdf.output("blob");
    file = new File([blob], filename, { type: "application/pdf" });
  } catch (error) {
    console.warn("生成分享文件失败", error);
    return "unsupported";
  }
  if (!canSharePdfFile(file)) return "unsupported";
  try {
    await navigator.share({ files: [file], title: APP_TITLE });
    return "shared";
  } catch (error) {
    if (error?.name === "AbortError") return "cancelled";
    // Includes NotAllowedError when a slow PDF build outlives transient user
    // activation. The caller falls back to the system print dialog.
    console.warn("系统分享不可用", error);
    return "failed";
  }
}

function tryDirectPrint() {
  return new Promise((resolve) => {
    let settled = false;
    let opened = false;
    let timer = 0;
    const onBeforePrint = () => {
      opened = true;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("beforeprint", onBeforePrint);
      resolve(result);
    };
    window.addEventListener("beforeprint", onBeforePrint, { once: true });
    timer = setTimeout(() => finish(opened), 800);
    try {
      window.print();
    } catch (error) {
      console.warn("浏览器不支持直接打印", error);
      finish(false);
      return;
    }
    // Desktop browsers fire beforeprint synchronously; mobile ones may report
    // it asynchronously, so the timer above is still needed there.
    if (opened) finish(true);
  });
}

async function shareOrSavePdfForPrint(pdf, filename) {
  const result = await sharePdfForPrint(pdf, filename);
  if (result === "shared" || result === "cancelled") return result;
  pdf.save(filename);
  return "saved";
}

async function printMobileWorksheet(platform) {
  const finish = beginPdfOperation(els.printBtn);
  if (!finish) {
    hidePrintNote();
    return;
  }
  try {
    const canAttemptFileShare = typeof File !== "undefined" && typeof navigator.share === "function";
    let printUnavailable = false;
    if (!canAttemptFileShare) {
      // In-app browsers such as WeChat do not expose the Web Share API. Try the
      // native print dialog first instead of generating an unused PDF.
      reportPdfProgress("正在打开系统打印…");
      hidePrintNote();
      if (await tryDirectPrint()) {
        showExportStatus("已打开系统打印，请选择打印机");
        return;
      }
      printUnavailable = true;
    }

    reportPdfProgress("正在生成 PDF…");
    const { pdf, pageCount } = await buildPdfDocument();
    const filename = exportFilename();
    if (canAttemptFileShare) {
      const shareResult = await sharePdfForPrint(pdf, filename);
      if (shareResult === "shared") {
        hidePrintNote();
        showExportStatus(`已生成 ${pageCount} 页 PDF，可在系统分享面板中选择「打印」`);
        return;
      }
      if (shareResult === "cancelled") {
        hidePrintNote();
        showExportStatus("已取消系统分享");
        return;
      }
    }

    // Sharing is unavailable or rejected. window.print() needs no user
    // activation and opens the native print dialog in most mobile browsers.
    hidePrintNote();
    if (!printUnavailable && (await tryDirectPrint())) {
      showExportStatus(`已打开系统打印，请选择打印机（共 ${pageCount} 页）`);
      return;
    }
    pdf.save(filename);
    showExportStatus(savedPdfHint(platform, pageCount));
  } catch (error) {
    console.error(error);
    hidePrintNote();
    showExportStatus(error?.message || "打印失败，请尝试使用导出 PDF 功能", true);
  } finally {
    finish();
  }
}

async function printWorksheet() {
  const platform = detectPrintPlatform();
  if (platform.mobile) {
    showPrintNote(mobilePrintHint(platform), 0);
    await printMobileWorksheet(platform);
    return;
  }

  // Desktop prints the live document. Some browsers (including a few mobile
  // ones) silently ignore window.print(), so detect beforeprint and fall back.
  showPrintNote("打印时请选择与预览一致的纸张，并使用“实际大小 / 100%”，关闭浏览器页眉页脚。", 5000);
  if (await tryDirectPrint()) return;

  hidePrintNote();
  const finish = beginPdfOperation(els.printBtn);
  if (!finish) return;
  try {
    reportPdfProgress("正在生成 PDF…");
    const { pdf, pageCount } = await buildPdfDocument();
    await shareOrSavePdfForPrint(pdf, exportFilename());
    showExportStatus(`浏览器不支持直接打印，${pageCount} 页 PDF 已生成，请打开后选择打印`);
  } catch (error) {
    console.error(error);
    showExportStatus(error?.message || "打印失败，请尝试使用导出 PDF 功能", true);
  } finally {
    finish();
  }
}

function updateHeaderFieldVisibility() {
  const visible = {
    title: settings.headerPreset !== "blank",
    className: ["class", "teacher"].includes(settings.headerPreset),
    studentName: ["homework", "class", "teacher"].includes(settings.headerPreset),
    date: ["homework", "class"].includes(settings.headerPreset),
  };
  for (const field of document.querySelectorAll("[data-header-field]")) field.hidden = !visible[field.dataset.headerField];
}

function populateContentTemplates() {
  const templates = window.HANZI_CONTENT_TEMPLATES || [];
  const categories = [...new Set(templates.map((item) => item.category))];
  els.contentCategory.innerHTML = categories.map((category) => `<option>${escapeHtml(category)}</option>`).join("");

  const updateItems = () => {
    const items = templates.filter((item) => item.category === els.contentCategory.value);
    els.contentTemplate.innerHTML = items.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("");
  };
  els.contentCategory.addEventListener("change", updateItems);
  updateItems();
}

function selectedContentTemplate() {
  return (window.HANZI_CONTENT_TEMPLATES || []).find((item) => item.id === els.contentTemplate.value);
}

function insertContent(append) {
  const template = selectedContentTemplate();
  if (!template) return;
  settings.inputText = append && settings.inputText.trim() ? `${settings.inputText.trim()}\n${template.text}` : template.text;
  if (!append) settings.title = template.title;
  applySettingsToControls();
  scheduleRender();
}

function setDrawer(open) {
  document.body.classList.toggle("settings-open", open);
  els.settingsBtn.setAttribute("aria-expanded", String(open));
}

function registerPwa() {
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      els.dataStatus.textContent = "离线缓存暂不可用";
    });
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    els.installBtn.hidden = false;
  });
  els.installBtn.addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    els.installBtn.hidden = true;
  });
}

function init() {
  if (BUILD_VERSION !== "__BUILD_VERSION__") {
    const stored = localStorage.getItem("hanzifun.version");
    if (stored && stored !== BUILD_VERSION) {
      const finishUpgrade = () => {
        localStorage.setItem("hanzifun.version", BUILD_VERSION);
        window.location.reload();
      };
      if ("caches" in window) {
        caches.keys()
          .then((keys) => Promise.all(keys.filter((k) => k.startsWith("hanzifun-")).map((k) => caches.delete(k))))
          .then(finishUpgrade)
          .catch(finishUpgrade);
      } else {
        finishUpgrade();
      }
      return;
    }
    localStorage.setItem("hanzifun.version", BUILD_VERSION);
  }
  if (CDN_BASE) {
    const firstPackFile = window.HANZI_PACK_INFO?.packs?.[0]?.file || "data/strokes-pack-000.zip";
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "fetch";
    link.crossOrigin = "anonymous";
    link.href = `${CDN_BASE}/${firstPackFile}`;
    document.head.append(link);
  }
  applySettingsToControls();
  populateContentTemplates();
  for (const control of document.querySelectorAll("[data-setting]")) {
    const liveInputTypes = ["text", "textarea", "range", "number", "color"];
    control.addEventListener(liveInputTypes.includes(control.type) ? "input" : "change", () => syncSettingFromControl(control));
  }
  els.controls.addEventListener("click", (event) => {
    const button = event.target.closest("[data-stepper-action]");
    if (button) adjustStepper(button);
  });
  els.replaceContentBtn.addEventListener("click", () => insertContent(false));
  els.appendContentBtn.addEventListener("click", () => insertContent(true));
  els.settingsBtn.addEventListener("click", () => setDrawer(true));
  els.closeSettingsBtn.addEventListener("click", () => setDrawer(false));
  els.drawerBackdrop.addEventListener("click", () => setDrawer(false));
  els.resetBtn.addEventListener("click", () => {
    settings = { ...DEFAULT_SETTINGS, date: new Date().toISOString().slice(0, 10) };
    applySettingsToControls();
    scheduleRender();
  });
  els.clearBtn.addEventListener("click", () => {
    settings.inputText = "";
    settings.title = "";
    applySettingsToControls();
    scheduleRender();
  });
  els.exportPdfBtn.addEventListener("click", exportPdf);
  els.printBtn.addEventListener("click", () => {
    printWorksheet().catch((error) => {
      console.error(error);
      hidePrintNote();
      showExportStatus(error?.message || "打印失败，请尝试使用导出 PDF 功能", true);
    });
  });
  els.pages.addEventListener("click", (event) => {
    if (settings.template !== "stroke") return;
    const svg = event.target.closest("svg.hanzi-cell");
    if (!svg) return;
    const character = svg.dataset.ch;
    if (!character) return;
    const data = window.HANZI_STROKES?.[character];
    if (!data) return;
    const svgSource = buildStandaloneSvg(svg);
    if (!svgSource) return;
    if (!navigator.clipboard?.write) {
      showExportStatus("当前环境不支持复制，请通过 HTTPS 或本地服务器打开", true);
      return;
    }
    const textBlob = new Blob([svgSource], { type: "text/plain" });
    const htmlBlob = new Blob([svgSource], { type: "text/html" });
    // 优先使用预渲染的 PNG（Safari 不支持 image/svg+xml，且异步 canvas 会丢失用户手势）
    const cachedPng = svgPngCache.get(svg);
    const items = { "text/html": htmlBlob, "text/plain": textBlob };
    if (cachedPng) {
      const bytes = atob(cachedPng.split(",")[1]);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      items["image/png"] = new Blob([arr], { type: "image/png" });
    }
    navigator.clipboard.write([new ClipboardItem(items)]).then(() => {
      showExportStatus(cachedPng ? "已复制到剪贴板（PNG 图片 + SVG 源码）" : "已复制 SVG 到剪贴板");
    }).catch(() => {
      showExportStatus("复制失败，请重试", true);
    });
  });
  els.previewWrap.addEventListener("wheel", (event) => {
    if ((!event.metaKey && !event.ctrlKey) || event.deltaY === 0) return;
    event.preventDefault();
    const nextZoom = clamp(settings.zoom + (event.deltaY < 0 ? 5 : -5), 35, 200);
    if (nextZoom === settings.zoom) return;
    settings.zoom = nextZoom;
    document.querySelector("#zoom").value = nextZoom;
    scheduleRender();
  }, { passive: false });
  document.querySelector("#zoomReset")?.addEventListener("click", () => {
    settings.zoom = 100;
    document.querySelector("#zoom").value = 100;
    document.querySelector("#zoomOutput").value = "100%";
    scheduleRender();
  });
  window.addEventListener("resize", () => updatePreviewScale(paperDimensions()));
  window.addEventListener("online", () => {
    failedChunks.clear();
    scheduleRender(false);
    scheduleStrokePackPrefetch();
  });
  window.addEventListener("offline", () => scheduleRender(false));
  window.addEventListener("load", () => scheduleStrokePackPrefetch(15000));
  window.addEventListener("load", () => {
    const schedule = () => warmPdfRuntime();
    if ("requestIdleCallback" in window) window.requestIdleCallback(schedule, { timeout: 8000 });
    else setTimeout(schedule, 2500);
  });
  registerPwa();
  render();
}

init();
})();
