# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

HanZiFun 是一个静态、离线优先的中文写字练习本生成器（PWA）。纯 HTML + Tailwind CSS v4 + 原生 JavaScript，无运行时框架、无 CDN、无后端。所有计算与渲染在浏览器本地完成，用户输入不上传任何服务器。

权威需求与设计文档：`README.md`（产品需求稿）、`DESIGN.md`（设计哲学与视觉规则）、`AGENTS.md`（实现现状与技术方向）、`NOTICE.md`（数据来源与许可）。做实质性 UI 变更前先读 `DESIGN.md`。

## 常用命令

需 Node 22。依赖安装：`npm install`。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 先构建 Tailwind，再用 `scripts/serve.mjs` 起静态服务器（http://localhost:8765，`--dist` 可改为服务 `dist/`） |
| `npm run styles` | 由 `src/tailwind.css` 生成按需 `tailwind.css`（扫描 `index.html`） |
| `npm run assets` | 生成 192/512 PWA 图标 |
| `npm run vendor` | 从 node_modules 拷贝 fflate、jsPDF 及 LICENSE 到 `vendor/` |
| `npm run data` | 从 `hanzi-writer-data@2.0.1` 重建全量笔顺数据（核心字 + ZIP 包 + 索引 + 拼音） |
| `npm run data:core` | 仅重建 28 个核心预载字（快速调试） |
| `npm run content:data` | 从本地 `chinese-poetry` 提取重建内置内容模板（需本地数据集） |
| `npm run build` | 完整生产构建：styles + assets + vendor + data + `scripts/build.mjs` 输出 `dist/` |
| `npm run build:quick` | 用 `data:core` 替代 `data` 的快速构建 |
| `npm run check` | 语法/一致性检查（见下），是本仓库唯一的「lint」 |

`npm run check` 对 `app.js`、`service-worker.js` 和各构建脚本做 `node --check`，并运行 `scripts/check-service-worker.mjs`（用 vm 沙箱验证 SW 的 fetch 响应克隆与缓存写入）。提交前应同时跑 `npm run check` 和 `npm run build`。

### 测试

没有正式测试框架。仓库根的 `test_*.mjs` 是针对 PDF 导出/笔顺数据等模块的临时调试脚本，不在 `check` 或 `build` 中运行。运行单个脚本：

```bash
node test_form_xobj.mjs
```

这些脚本依赖 `dist/` 产物或 `data/` 数据，通常在 PDF 相关改动时临时创建，用完即弃。

## 架构

### 单文件应用核心

所有运行时逻辑集中在 `app.js`（单文件、顶层 IIFE 风格，无模块化）。`index.html` 是入口，左侧设置面板 + 右侧纸张预览。`style.css` 负责领域样式（纸张、格子、SVG、打印），Tailwind 仅用于 UI 布局工具类。

`app.js` 的逻辑分区（按文件顺序）：

1. **常量与默认设置**：`SETTINGS_VERSION`、`CSS_PX_PER_MM = 96/25.4`、`VIEWBOX_SIZE = 1024`、`DEFAULT_SETTINGS`、`PAPER_SIZES`。`USE_ZIP_PACK` 由 `location.protocol !== "file:"` 决定，控制笔顺数据走 ZIP 还是脚本回退。
2. **设置持久化**（`loadSettings`/`saveSettings`）：`localStorage`，带 `settingsVersion` 做版本迁移。
3. **SVG 渲染原语**（`makeGrid`/`renderStrokePaths`/`renderAnnotations`/`makeCharacterSvg`）：生成格子、笔画、编号、起笔点、箭头的 SVG。
4. **页面渲染器**（`renderStandardPages`/`renderStrokePages`/`renderBlankPages`/`renderCopyPages`）：四种模板各自分页排版，返回 `{ markup, pageCount, ... }`。
5. **笔顺数据加载**（`loadScript`/`packForChunk`/`openZipArchive`/`loadChunkFromZip`/`loadChunkScript`/`ensureCharacterData`）：见下方「数据策略」。
6. **主渲染循环**（`render`/`scheduleRender`）：`scheduleRender` 用 `requestAnimationFrame` 去抖，写 `localStorage` 后重渲。
7. **PDF 导出**（`preparePdfPages` → `buildPdfDocument` → `exportPdf`/`printWorksheet`）：见下方「PDF 导出」。
8. **控件绑定**（`init`）：通过 `[data-setting]` 选择器把所有控件统一接到 `syncSettingFromControl` → `scheduleRender`。

### WYSIWYG 渲染循环

这是理解一切改动的关键：**所有设置变更都立即更新预览，没有「生成」按钮**。控件 `input`/`change` → `syncSettingFromControl` 改 `settings` → `scheduleRender()` → rAF 内 `render()` 重排页面、更新摘要/状态/标题、写 `@page` 尺寸、调整预览缩放。任何新增设置都必须接入这条链路并实时生效。

`render()` 根据 `dataState`（ready/loading/error）决定渲染正常页还是错误页，并同步更新 `document.title`（加载中/失败时追加状态）和 `els.dataStatus`。

### 笔顺数据策略（核心架构）

上游 `hanzi-writer-data@2.0.1` 全量 9574 字约 22MB JSON，不进首屏。分层加载：

- **核心 28 字**：内联在 `data/strokes.js`，首屏直载，挂到 `window.HANZI_STROKES`。
- **按需 ZIP 包**：每 50 字一个 JSON chunk，每 2 个 chunk（100 字）打包成一个 `data/strokes-pack-NNN.zip`。`data/stroke-index.js` 提供 `HANZI_CHUNK_INDEX`（字→chunkId）和 `HANZI_PACK_INFO`（pack 列表）。
- **HTTP/PWA 路径**：`ensureCharacterData` 找到 chunk 所在 pack → `openZipArchive` 用 `fetch` 拉 ZIP → `loadChunkFromZip` 用 fflate 只解压命中的 JSON 条目 → `registerChunk` 注入 `HANZI_STROKES`。内存用 LRU 保留最近 16 个 chunk（`MAX_CACHED_CHUNKS`），当前页面所需 chunk 不被淘汰。
- **`file://` 回退**：双击 `index.html` 时 `USE_ZIP_PACK=false`，改用 `data/characters/chunk-NNN.js` 脚本（`loadChunkScript`）。这些脚本分片不进 `dist/`（`build.mjs` 显式删除）。
- **预取**：首屏稳定 15s 后，`prefetchUnusedStrokePacks` 分批低优先级 `prefetch` 未使用的 pack；省流量/2G/离线/`file://` 下跳过。Service Worker 缓存已下载的 pack 供离线复用。
- **无数据字**：`unsupportedCharacters` 列出无笔顺数据的字，在设置面板明示，不静默丢弃；文章临摹模板用本地字体回退渲染标点和缺数据字。

核心 28 字集合定义在 `scripts/build-stroke-data.mjs` 顶部的 `coreCharacters`，改预载字需同步此处并重跑 `npm run data:core`。

### PDF 导出

PDF 导出是纯客户端矢量生成，是本仓库最复杂的子系统。关键约束与机制：

- **纯矢量**：用本地 `vendor/jspdf.umd.min.js` 的原生路径/直线/文本原语生成 PDF。**禁止**整页 Canvas/JPEG/PNG 栅格化，禁止 html2canvas，禁止上传内容。导出的 PDF 不应包含整页 `/Image` 对象。
- **SVG→PDF 转换**：`parseSvgPath` 支持 `M/L/H/V/Q/C/Z`，二次贝塞尔（`Q`）转三次（`C`）并缓存。`drawSvgElement` 递归处理 SVG 子元素，用 `elementMatrix`/`mapSvgPoint` 做 CTM 变换。
- **Form XObject 复用**：`ensureGridForm` 把格子框线建成一个 Form 对象，每个单元格 `doFormObject("grid", m)` 引用；`ensureProgressiveForm` 把「字@步」的累加笔画也建成 Form 缓存（`progressiveFormCache`），`ensureGlyphForm` 缓存完整字形轮廓。这是控制多页 PDF 体积的关键——改动 PDF 导出时务必保持 Form 复用，避免回退为每格重画路径。
- **内嵌楷体子集字体**：页眉/页脚/拼音等排版文本用内嵌 AR PL UKai CN（文鼎楷体）正楷真文本渲染，不再走笔顺轮廓或 helvetica（无中文会乱码）。构建时 `scripts/build-font.mjs` 从 Debian `fonts-arphic-ukai` 解包 `ukai.ttc`，用 hb-subset 把 face 0（UKai CN）预子集为 `vendor/fonts/kai.ttf`（约 6.4MB，全部 ~9600 笔顺字+标点+数字+拉丁+拼音）；导出时 `prepareKaiFont` 用 `vendor/hb-subset.wasm`（HarfBuzz）按页面实际用字二次裁剪到几十 KB，经 `addFileToVFS`/`addFont` 嵌入 jsPDF，`drawHtmlText`/`drawPdfText`/`drawSvgElement` 的文本统一用 `KaiTi`。字体未覆盖的极生僻字（约 74 字）回退到笔顺轮廓 `drawHanziForm`；`vendor/fonts/kai-chars.json` 是字符集清单，供运行时 fallback 判断。
- **双入口**：`exportPdf`（右上角「导出 PDF」，直接下载本地 PDF）与 `printWorksheet`（浏览器打印对话框）是两个独立操作。移动端 `printWorksheet` 先用 `detectPrintPlatform` 判断 iOS/iPadOS/Android（含 iPadOS 桌面 UA），再用 jsPDF 生成 PDF 并通过 Web Share API 调起原生分享面板；分享不可用或被拒绝时回退到 `window.print()`，最后才下载 PDF。
- **排版一致性**：PDF 每页物理尺寸、方向、分页必须与实时预览一致。`preparePdfPages` 会先确保预览 DOM 就绪并等待笔顺数据与字体加载完成。

### 构建管线

`scripts/build.mjs` 把源文件指纹化（sha256 前 10 位 + package version）生成 SW 缓存版本号 `__BUILD_VERSION__`，然后用 esbuild 压缩 JS、html-minifier-terser 压缩 HTML、esbuild 压缩 CSS，拷贝 `data/`（删除 `characters/` 脚本分片）、`icons/`、`vendor/`、manifest 等到 `dist/`。`dist/` 被 git 忽略。

GitHub Actions（`.github/workflows/deploy-pages.yml`）在 push 到 `main` 时跑 `npm ci` + `npm run build`，上传 `dist/` 部署到 GitHub Pages。仓库 Pages 构建源必须设为 GitHub Actions。

### Service Worker

`service-worker.js` 预缓存 app shell（HTML/CSS/JS/manifest/icons/fflate/jsPDF/核心数据），对其他同源 GET 请求走「缓存优先，未命中则网络并克隆写入缓存」。缓存名带 `__BUILD_VERSION__`，激活时清理旧版本。`scripts/check-service-worker.mjs` 验证其响应克隆逻辑正确（响应体被消费前克隆给缓存）。

## 关键约定

- **保持静态与离线**：不引入 CDN/远程 JS/远程字体/远程 API/远程图片，所有资源本地化。新增运行时依赖必须先 `npm run vendor` 本地化。
- **Tailwind v4，Preflight 关闭**：UI 布局用 Tailwind 工具类，但领域相关纸张/SVG/打印规则留在 `style.css`，不能让 Preflight 重置破坏毫米级布局与打印样式。
- **毫米级精度**：纸张与格子用 mm 单位，`CSS_PX_PER_MM` 做换算。`@page` 尺寸由设置动态写入。水平间距 `0mm` 时相邻格子共用边线，不能重复绘制导致加粗（SVG 与 PDF 路径都要遵守）。
- **SVG 优先**：笔画、格子、箭头、编号用 SVG 渲染，保证打印清晰与 PDF 矢量化。
- **控件选择规则**（见 `DESIGN.md`/README §5.2.1）：≤6 个稳定高频选项用分段按钮；长/动态列表用 select；离散数值用 Stepper（减号/可输入/加号）；连续视觉值（透明度、缩放）用滑杆。分段按钮需明确选中态、支持键盘、≥44px 触摸高度。
- **保留数据归属**：笔顺数据源自 Make Me A Hanzi（经 hanzi-writer-data），内容模板源自 chinese-poetry。扩展数据时保留 `NOTICE.md` 与各 `*.LICENSE` 归属，不要删除。
- **提交前验证**：`npm run check` + `npm run build`。渲染 sanity 检查覆盖四种模板、按需加载、本地持久化、A5/A4/A3/Letter 横纵、移动端抽屉。默认基线：10 字、2 页、70 个 SVG 格。
