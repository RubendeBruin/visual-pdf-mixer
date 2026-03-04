# PDF Mixer — Implementation Documentation

## Toolchain

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri v2](https://tauri.app) (Rust backend, system WebView2 on Windows) |
| Frontend framework | React 18 + TypeScript |
| Build tool | Vite 6 |
| PDF rendering (thumbnails) | [PDF.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`) |
| PDF manipulation (merge/save) | [pdf-lib](https://pdf-lib.js.org/) |

---

## Project Structure

```
pdfmixer/
├── index.html                      # HTML entry point (mounts React root)
├── package.json                    # npm dependencies and scripts
├── tsconfig.json                   # TypeScript config (ES2020, react-jsx)
├── vite.config.ts                  # Vite config with React plugin, pdfjs optimizeDeps
├── src/
│   ├── main.tsx                    # React entry point
│   ├── App.tsx                     # Root component — all UI and state logic
│   ├── pdfUtils.ts                 # PDF.js rendering + pdf-lib merge helpers
│   └── styles.css                  # Global dark-theme styles
└── src-tauri/
    ├── Cargo.toml                  # Rust package (name: pdfmixer)
    ├── tauri.conf.json             # App name, window size (1400×900), identifier
    ├── build.rs                    # Tauri build script
    ├── capabilities/
    │   └── default.json            # Tauri capability permissions (core:default)
    ├── icons/                      # App icons (all sizes)
    └── src/
        ├── lib.rs                  # Tauri builder — no custom commands needed
        └── main.rs                 # Binary entry point → calls pdfmixer_lib::run()
```

---

## Architecture

All PDF work runs entirely in the frontend (JS/WASM). The Rust/Tauri layer is kept minimal — it provides the native window and OS integration. No custom Tauri commands were needed.

### PDF loading and thumbnail rendering (`pdfUtils.ts`)

1. The user picks a file via a hidden `<input type="file">` element (browser file API — no Tauri filesystem plugin required).
2. The raw bytes are passed to `loadPdfPages(bytes: Uint8Array)`.
3. PDF.js opens the document, iterates each page, and renders it to an offscreen `<canvas>` at 35% scale.
4. Each canvas is serialised to a JPEG data URL (`thumbnailUrl`) and stored alongside the original bytes and page index in a `PageEntry` object.
5. `PageEntry` values are stored in React state arrays (`mainPages`, `srcPages`).

### Merging and saving (`pdfUtils.ts`)

`buildMergedPdf(pages: PageEntry[])` uses pdf-lib to:
1. Create a blank `PDFDocument`.
2. For each `PageEntry` in order, load (and cache) the originating PDF, copy the specific page, and append it to the destination document.
3. Return the merged document as `Uint8Array`, which is downloaded via a temporary object URL.

### State management (`App.tsx`)

All state lives in a single component with `useState` hooks:

| State | Type | Purpose |
|---|---|---|
| `mainPages` | `PageEntry[]` | Ordered pages of the document being built |
| `srcPages` | `PageEntry[]` | Pages of the currently loaded source PDF |
| `mainSelected` | `Set<string>` | Selected page IDs in the main panel |
| `srcSelected` | `Set<string>` | Selected page IDs in the source panel |
| `dropIdx` | `number \| null` | Insertion index highlighted during drag |
| `isDragging` | `boolean` | Whether a drag is in progress (shows drop zones) |

### Selection model

- **Click** — selects a single page, clears other selections.
- **Ctrl/Cmd + Click** — toggles a page in/out of the selection.
- **Shift + Click** — extends the selection from the last-clicked index to the current one.

Implemented via a shared `makeSelector` factory used for both panels, tracking the last-clicked index in a `useRef`.

### Drag and drop

- Only source panel pages are draggable (`draggable` prop set on `PageThumb`).
- On `dragStart`, the dragged page IDs (the current selection if the dragged page is selected, otherwise just that one page) are stored in a `dragStateRef`.
- Between every pair of adjacent main-panel thumbnails (and before the first / after the last) a `<DropZone>` component is rendered. While a drag is active, these zones are visible and respond to `dragOver`/`drop` events.
- On drop, the selected source pages are cloned with fresh UUIDs and spliced into `mainPages` at the target index.

### Keyboard shortcut

A `keydown` listener on `document` fires `Delete`/`Backspace` to remove all currently selected main-panel pages, unless focus is in a text input.

---

## Running the App

```bash
# Development (hot-reload, Rust debug build)
npm run tauri dev

# Production build
npm run tauri build
```

The first `tauri dev` or `tauri build` takes several minutes while Cargo compiles the Rust dependencies. Subsequent runs are fast due to incremental compilation.

---

## Key Dependencies

| Package | Version | Role |
|---|---|---|
| `@tauri-apps/api` | ^2 | Tauri JS API |
| `@tauri-apps/cli` | ^2 | `tauri dev` / `tauri build` CLI |
| `react` / `react-dom` | ^18.3.1 | UI framework |
| `pdfjs-dist` | ^4.9.155 | PDF rendering to canvas |
| `pdf-lib` | ^1.17.1 | PDF reading, page copying, document saving |
| `@vitejs/plugin-react` | ^4.3.4 | React JSX transform for Vite |
