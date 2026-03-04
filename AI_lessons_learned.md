# AI Lessons Learned — PDF Mixer

This document captures everything that went wrong, why, and what to do differently
when building a similar Tauri + React + PDF.js + pdf-lib application.

---

## 1. Scaffolding into a non-empty directory fails

`npm create tauri-app@latest .` refuses to run when the directory already contains
files (even just markdown files). Scaffold into a temporary subdirectory and move
the files up afterwards:

```powershell
npm create tauri-app@latest _scaffold -- --template react-ts --manager npm --yes
# then copy _scaffold contents to the project root and delete _scaffold
```

---

## 2. The scaffold uses Vanilla TypeScript, not React — specify the template carefully

The interactive `create-tauri-app` prompt defaults to Vanilla TS even when you pass
`--template react-ts`. The scaffold that was created used a plain `main.ts` entry
point, not `main.tsx`, and had no JSX compiler option in `tsconfig.json`.

**Fixes required after scaffolding:**

- Add `"jsx": "react-jsx"` to `tsconfig.json` `compilerOptions`
- Add `@vitejs/plugin-react` to `vite.config.ts`
- Replace `src/main.ts` with `src/main.tsx` (React DOM entry)
- Replace `index.html` script tag to point at `main.tsx`
- Add `react`, `react-dom`, `@types/react`, `@types/react-dom` to `package.json`

---

## 3. The Rust crate name in `main.rs` must match `Cargo.toml`

The scaffold puts `_scaffold_lib::run()` in `src-tauri/src/main.rs`. When the
package is renamed in `Cargo.toml` (e.g. to `pdfmixer`), the lib name also changes
(to `pdfmixer_lib`). `main.rs` must be updated to match or the Rust build fails with:

```
error[E0433]: failed to resolve: use of unresolved module `_scaffold_lib`
```

Always update both `Cargo.toml` (`[package] name` and `[lib] name`) **and**
`src-tauri/src/main.rs` (`pdfmixer_lib::run()`) together.

---

## 4. The Rust toolchain version may be too old for Tauri's transitive dependencies

Tauri 2 pulls in crates (e.g. `time`) that require a recent `rustc`. If the system
has an old stable toolchain the build fails with:

```
error: package `time@0.3.47` cannot be built because it requires rustc >= 1.88.0
```

**Fix:** `rustup update stable` before the first build. Make this a documented
prerequisite.

---

## 5. HTML5 Drag and Drop does not work in Tauri WebView2 on Windows — use pointer events instead ✅ CONFIRMED WORKING

### What was tried (all failed)

Three successive HTML5 DnD approaches were attempted:

1. **React synthetic `dragover`/`drop` on a div** — `e.preventDefault()` was accidentally guarded behind an early return, blocking all drops.
2. **Native `addEventListener` on the panel div** — `dragover` and `drop` never fired reliably on the element.
3. **Native `addEventListener` on `document`** — events still did not fire; "no drop" cursor persisted throughout.

### Root cause

WebView2 (the Windows Chromium runtime embedded in Tauri) intercepts `dragover` and `drop` events for its own native OS drag-and-drop handling before they reach JavaScript. `e.preventDefault()` has no effect and drop events simply never arrive in JS for drags that originate inside the same WebView. This is a known, long-standing WebView2 limitation.

References:
- https://github.com/tauri-apps/tauri/issues/11151
- https://github.com/MicrosoftEdge/WebView2Feedback/issues/drag-drop

### ✅ Correct solution: implement drag with pointer events

Use `pointerdown`, `pointermove`, and `pointerup` on `document`. These events are **never intercepted by WebView2** and work reliably. This approach also works identically on all other platforms (WebKit, Chromium, Electron).

**Implementation pattern:**

```ts
// Module-level drag state — readable from any event handler without closures
interface PointerDrag {
  ids: string[];          // IDs of pages being dragged
  ghost: HTMLDivElement;  // floating label appended to <body>
}
let _drag: PointerDrag | null = null;

// On pointerdown of the draggable source thumbnail:
const handlePointerDown = (e: React.PointerEvent, id: string) => {
  if (e.button !== 0) return;
  // CRITICAL: release implicit capture so pointermove/pointerup go to document
  (e.target as HTMLElement).releasePointerCapture(e.pointerId);

  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";     // position:fixed; pointer-events:none
  ghost.textContent = "1 page";
  ghost.style.left = `${e.clientX + 14}px`;
  ghost.style.top  = `${e.clientY + 14}px`;
  document.body.appendChild(ghost);

  _drag = { ids: [id], ghost };
};

// In useEffect — document-level listeners:
document.addEventListener("pointermove", (e) => {
  if (!_drag) return;
  _drag.ghost.style.left = `${e.clientX + 14}px`;
  _drag.ghost.style.top  = `${e.clientY + 14}px`;
  if (isOverMainPanel(e.clientX, e.clientY)) {
    setDropIdx(computeInsertionIndex(e.clientY));
  } else {
    setDropIdx(null);
  }
});

document.addEventListener("pointerup", (e) => {
  const drag = _drag;
  if (!drag) return;
  drag.ghost.remove();
  _drag = null;
  if (isOverMainPanel(e.clientX, e.clientY)) {
    // insert pages at computeInsertionIndex(e.clientY)
  }
});

document.addEventListener("pointercancel", () => {
  if (_drag) { _drag.ghost.remove(); _drag = null; }
});
```

### Key implementation details

- **`releasePointerCapture`** is critical. Without it, the browser implicitly captures all pointer events to the source element on `pointerdown`, so `document` never sees `pointermove` or `pointerup`.
- The ghost element must have `pointer-events: none` and `position: fixed` so it follows the cursor without interfering with hit-testing.
- Hit-test the main panel on every `pointermove` using `getBoundingClientRect()` — no element-level routing needed.
- Also handle `pointercancel` (fired when the OS grabs the pointer, e.g. alt-tab) to clean up the ghost.
- Add `onDragStart={e => e.preventDefault()}` on source thumbnails to suppress any residual browser native drag behaviour while the pointer is held down.
- **Never use the HTML5 DnD API** (`draggable`, `ondragstart`, `ondragover`, `ondrop`) in any Tauri app on Windows.

---

## 6. ~~Never gate drop-target logic on React state that is set during the drag~~ (superseded by lesson 5)

> This lesson assumed HTML5 DnD would eventually work in WebView2. It does not. Use pointer events (see lesson 5). The observation below is still correct for environments where HTML5 DnD does work (e.g. Electron, plain Chromium).

`isDragging` was a React `useState` boolean set in `dragstart`. React state updates
are asynchronous — by the time the first `dragover` fires, `isDragging` may still be
`false`, causing the drop indicator to not appear and the drop to silently fail.

**Use a `useRef` for any data that must be readable synchronously in drag event
handlers.** React state (`useState`) is fine for things that only affect rendering
after the drop completes. Specifically:

- Store dragged page IDs in a `useRef<string[]>` (set synchronously in `dragstart`)
- Mirror fast-changing state into refs so handlers always see current values:

```ts
const srcPagesRef = useRef<PageEntry[]>([]);
srcPagesRef.current = srcPages;           // updated every render
```

---

## 7. ~~`dataTransfer.setData()` must be called during `dragstart`~~ (superseded by lesson 5)

> Irrelevant when using pointer events. Documented for completeness.

Some browsers (and WebView2) require at least one `setData` call in the `dragstart`
handler for DnD to be considered active. Omitting it can silently disable drops.

```ts
e.dataTransfer.setData("application/x-pdfmixer", ids.join(","));
```

The MIME type does not matter for an internal-only drag, but the call must be there.

---

## 8. Tiny hit targets between thumbnails are unusable — use the whole panel as the target

> This lesson applies equally to the pointer-event approach.

The first working approach placed 8 px `<DropZone>` divs between thumbnails. These
are nearly impossible to hit precisely with a drag cursor. The correct pattern:

- Make the **entire scrollable panel div** the drop target (`onDragOver`, `onDrop`
  on the container)
- Compute the insertion index by comparing `e.clientY` against thumbnail midpoints
  via `getBoundingClientRect()`:

```ts
const computeInsertionIndex = (clientY: number): number => {
  const thumbs = Array.from(ref.current.querySelectorAll(".thumb"));
  for (let i = 0; i < thumbs.length; i++) {
    const { top, height } = thumbs[i].getBoundingClientRect();
    if (clientY < top + height / 2) return i;
  }
  return thumbs.length;
};
```

---

## 9. ~~`onDragLeave` fires for every child element — guard with `relatedTarget`~~ (superseded by lesson 5)

> Irrelevant when using pointer events, which have no equivalent issue.

When the cursor moves from the panel container into a child element (a thumbnail),
`dragleave` fires on the container with `relatedTarget` pointing at the child. Without
a guard this clears the drop indicator on every thumbnail entry:

```ts
const handleMainDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
  const list = mainListRef.current;
  if (list && !list.contains(e.relatedTarget as Node)) {
    setDropIdx(null); // only clear when truly leaving the panel
  }
};
```

---

## 10. PDF.js worker path must be set before any document is loaded

PDF.js requires `GlobalWorkerOptions.workerSrc` to be set once at module load time.
With Vite, use `new URL(...)` so the worker asset is correctly hashed and included in
the bundle:

```ts
import * as pdfjs from "pdfjs-dist";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).href;
```

Also add `pdfjs-dist` to `optimizeDeps.include` in `vite.config.ts` to avoid
pre-bundling issues:

```ts
optimizeDeps: { include: ["pdfjs-dist"] }
```

---

## 11. PDF.js detaches the ArrayBuffer — always `.slice()` before passing

`pdfjs.getDocument({ data })` takes ownership of the buffer and detaches it.
If you pass the original `Uint8Array` directly you cannot re-use it afterwards
(e.g. pdf-lib also needs the same bytes). Always pass a copy:

```ts
const data = bytes.slice(0); // fresh copy for pdfjs
const doc = await pdfjs.getDocument({ data }).promise;
```

---

## 12. pdf-lib: cache source `PDFDocument` instances when building the merged output

`PDFDocument.load()` is expensive. When merging a large page list where many pages
come from the same source file, cache the parsed document keyed by the bytes reference:

```ts
const cache = new Map<Uint8Array, PDFDocument>();
for (const entry of pages) {
  let src = cache.get(entry.pdfBytes);
  if (!src) { src = await PDFDocument.load(entry.pdfBytes); cache.set(entry.pdfBytes, src); }
  const [page] = await dest.copyPages(src, [entry.pageIndex]);
  dest.addPage(page);
}
```

---

## 13. File I/O can be done entirely with browser APIs — no Tauri filesystem plugin needed

Opening a PDF: use a hidden `<input type="file">` element and `file.arrayBuffer()`.  
Saving: create a `Blob`, a temporary object URL, and trigger a download link.  
No `@tauri-apps/plugin-fs` or custom Rust commands are needed, which keeps the
permission footprint minimal and avoids plugin setup complexity.

---

## 14. First Tauri/Cargo build takes several minutes — set user expectations

The first `npm run tauri dev` or `npm run tauri build` compiles hundreds of Rust
crates from scratch. On a typical machine this takes 3–8 minutes. Subsequent runs
are fast due to incremental compilation. Document this so users do not think the
command has hung.

---

## 15. Drop indicator UX: make it impossible to miss

A 3 px line between thumbnails is not noticeable enough to confirm a valid drop
target, especially for first-time users. Use a clearly visible, labeled indicator:

- Minimum height ~32 px
- High-contrast colour (bright green `#00e676` works well on dark backgrounds)
- Include text: **"Insert N pages here"**
- Outline the entire panel with a dashed border while a drag is in progress

This also doubles as a functional confirmation that the drop will actually work.
---

## 16. `dataTransfer.files` is always empty for OS file drops in WebView2 — use `onDragDropEvent` instead ✅ CONFIRMED WORKING

### What was tried (failed)

Implementing OS-level file drop (dragging a PDF from File Explorer onto a panel)
using the standard HTML5/React pattern:

```tsx
const handleDrop = (e: React.DragEvent) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0]; // always undefined in WebView2
  if (!file) return;
  // ...
};
<div onDrop={handleDrop} onDragOver={e => e.preventDefault()} />
```

The `dragover`/`dragenter` prevention worked (the copy cursor appeared), but
`dataTransfer.files` was **always empty** by the time the `drop` event fired.
No file data was ever available to the JavaScript handler.

### Root cause

WebView2 purposely clears `dataTransfer.files` for OS-originated drag operations
before the JavaScript `drop` event fires. This is the same class of interception
that blocks HTML5 `dragover`/`drop` for internal drags (see Lesson 5). External
(OS → WebView2) file drops hit a different interception point but the outcome is
identical: the Web API delivers no file data.

### ✅ Correct solution: `getCurrentWindow().onDragDropEvent()`

Tauri intercepts the native OS drag-drop event _before_ WebView2 sees it and
re-emits it as a typed event with real file paths on disk.

```ts
import { getCurrentWindow } from "@tauri-apps/api/window";

useEffect(() => {
  const unlisten = getCurrentWindow().onDragDropEvent(async (event) => {
    if (event.payload.type !== "drop") return;
    const { paths, position } = event.payload;
    const pdfPaths = paths.filter(p => p.toLowerCase().endsWith(".pdf"));
    if (!pdfPaths.length) return;
    // Use drop X coordinate to route to the correct panel
    const panel = position.x < window.innerWidth / 2 ? "main" : "src";
    await loadFromPath(pdfPaths[0], panel);
  });
  return () => { unlisten.then(fn => fn()); };
}, []);
```

### Key points

- `onDragDropEvent` fires for `"enter"`, `"over"`, and `"drop"` sub-types.
  Only `"drop"` carries `paths`.
- `paths` are absolute filesystem paths as strings — pass them to
  `readFile(path)` from `@tauri-apps/plugin-fs` to get the bytes.
- The React `onDragOver`/`onDragEnter` handlers (calling `e.preventDefault()`)
  are still needed to make the browser show the copy cursor on hover — they just
  cannot be used to receive the drop.
- Panel routing by X coordinate is simpler than trying to hit-test React refs
  from outside the component, and accurate enough for a side-by-side layout.
- **Never rely on `dataTransfer.files` in any Tauri app on Windows** for
  OS-originated file drops. Use `onDragDropEvent` instead.