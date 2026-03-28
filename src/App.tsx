import React, { useCallback, useEffect, useRef, useState } from "react";
import { PageEntry, buildMergedPdf, loadPdfPages } from "./pdfUtils";
import {
  isTauri,
  openPdfFile,
  savePdfFile,
  overwritePdfFile,
  confirmDialog,
} from "./platform";

type Panel = "main" | "src";
type LayoutMode = "column" | "wrap";

const BASE_PX   = 210;   // thumbnail base width in pixels at 100 %
const ZOOM_STEP = 25;
const ZOOM_MIN  = 25;
const ZOOM_MAX  = 400;

// ---------------------------------------------------------------------------
// Pointer-event drag state (module-level - always readable from DOM handlers)
// ---------------------------------------------------------------------------
interface PointerDrag {
  ids: string[];          // page IDs being dragged
  ghost: HTMLDivElement;  // floating ghost element appended to <body>
}
let _drag: PointerDrag | null = null;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const [mainPages, setMainPages] = useState<PageEntry[]>([]);
  const [srcPages, setSrcPages] = useState<PageEntry[]>([]);
  const [mainSelected, setMainSelected] = useState<Set<string>>(new Set());
  const [srcSelected, setSrcSelected] = useState<Set<string>>(new Set());

  const [isDragging, setIsDragging] = useState(false);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState<Panel | null>(null);
  const [mainFilePath, setMainFilePath] = useState<string | null>(null);

  // Per-panel view options
  const [mainZoom, setMainZoom] = useState(100);
  const [srcZoom,  setSrcZoom]  = useState(100);
  const [mainFit,  setMainFit]  = useState(false);
  const [srcFit,   setSrcFit]   = useState(false);
  const [mainLayout, setMainLayout] = useState<LayoutMode>("column");
  const [srcLayout,  setSrcLayout]  = useState<LayoutMode>("column");

  // Mirrors of state readable from async/event handlers without stale closures
  const srcPagesRef = useRef<PageEntry[]>([]);
  srcPagesRef.current = srcPages;
  const srcSelectedRef = useRef<Set<string>>(new Set());
  srcSelectedRef.current = srcSelected;
  const mainPagesRef = useRef<PageEntry[]>([]);
  mainPagesRef.current = mainPages;
  const mainFilePathRef = useRef<string | null>(null);
  mainFilePathRef.current = mainFilePath;

  const mainListRef = useRef<HTMLDivElement>(null);
  const lastMainIdx = useRef<number>(-1);
  const lastSrcIdx  = useRef<number>(-1);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  const isOverMainPanel = (clientX: number, clientY: number): boolean => {
    const el = mainListRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  };

  const computeInsertionIndex = (clientY: number): number => {
    const el = mainListRef.current;
    if (!el) return 0;
    const thumbs = Array.from(el.querySelectorAll<HTMLElement>(".thumb"));
    for (let i = 0; i < thumbs.length; i++) {
      const { top, height } = thumbs[i].getBoundingClientRect();
      if (clientY < top + height / 2) return i;
    }
    return thumbs.length;
  };

  // -------------------------------------------------------------------------
  // Pointer-event drag - document-level listeners wired once on mount
  // -------------------------------------------------------------------------
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!_drag) return;
      _drag.ghost.style.left = `${e.clientX + 14}px`;
      _drag.ghost.style.top  = `${e.clientY + 14}px`;
      if (isOverMainPanel(e.clientX, e.clientY)) {
        setIsDragging(true);
        setDropIdx(computeInsertionIndex(e.clientY));
      } else {
        setIsDragging(false);
        setDropIdx(null);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const drag = _drag;
      if (!drag) return;
      drag.ghost.remove();
      _drag = null;
      setIsDragging(false);
      if (!isOverMainPanel(e.clientX, e.clientY)) {
        setDropIdx(null);
        return;
      }
      const insertAt = computeInsertionIndex(e.clientY);
      const idSet = new Set(drag.ids);
      const toInsert = srcPagesRef.current
        .filter(p => idSet.has(p.id))
        .map(p => ({ ...p, id: crypto.randomUUID() }));
      if (toInsert.length) {
        setMainPages(prev => {
          const next = [...prev];
          next.splice(insertAt, 0, ...toInsert);
          return next;
        });
      }
      setDropIdx(null);
    };

    const onPointerCancel = () => {
      if (_drag) { _drag.ghost.remove(); _drag = null; }
      setIsDragging(false);
      setDropIdx(null);
    };

    document.addEventListener("pointermove",   onPointerMove);
    document.addEventListener("pointerup",     onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
    return () => {
      document.removeEventListener("pointermove",   onPointerMove);
      document.removeEventListener("pointerup",     onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Delete key
  // -------------------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      setMainPages(prev => prev.filter(p => !mainSelected.has(p.id)));
      setMainSelected(new Set());
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mainSelected]);

  // -------------------------------------------------------------------------
  // Open files - platform-agnostic (Tauri dialog or browser <input>)
  // -------------------------------------------------------------------------

  /**
   * Core loader: renders pages from raw bytes and stores them in the
   * appropriate panel.  `fileIdentifier` may be a full OS path (Tauri) or
   * just a display name / filename (browser), or null if unknown.
   */
  const loadFromBytes = async (bytes: Uint8Array, fileIdentifier: string | null, panel: Panel) => {
    if (loading !== null) return;
    setLoading(panel);
    try {
      const pages = await loadPdfPages(bytes);
      if (panel === "main") {
        setMainPages(pages);
        setMainSelected(new Set());
        setMainFilePath(fileIdentifier);
        lastMainIdx.current = -1;
      } else {
        setSrcPages(pages);
        setSrcSelected(new Set());
        lastSrcIdx.current = -1;
      }
    } catch (err) {
      console.error("Failed to open PDF:", err);
    } finally {
      setLoading(null);
    }
  };

  const handleOpenMain = async () => {
    const result = await openPdfFile("Open Main PDF");
    if (!result) return;
    // In Tauri the path is the full OS path; in the browser it is just the
    // filename, but both serve as the label and (in Tauri) as the save target.
    await loadFromBytes(result.bytes, result.path ?? result.name, "main");
  };

  const handleOpenSrc = async () => {
    const result = await openPdfFile("Open Source PDF");
    if (!result) return;
    await loadFromBytes(result.bytes, result.path ?? result.name, "src");
  };

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  /**
   * Builds the merged PDF bytes from the current main-panel pages.
   * Returns `null` (and logs an error) if something goes wrong.
   */
  const buildBytes = async (): Promise<Uint8Array | null> => {
    const pages = mainPagesRef.current;
    if (!pages.length) return null;
    try {
      return await buildMergedPdf(pages);
    } catch (err) {
      console.error("Failed to build PDF:", err);
      return null;
    }
  };

  /**
   * Save — behaviour differs by platform:
   * - Tauri with a known path: ask for overwrite confirmation, then write.
   * - Tauri without a path / any browser context: falls through to Save As.
   */
  const handleSave = async () => {
    const path = mainFilePathRef.current;

    // In the browser there is no "overwrite" concept — always use Save As.
    if (!path || !isTauri()) {
      await handleSaveAs();
      return;
    }

    const fileName = path.split(/[/\\]/).pop() ?? path;
    const confirmed = await confirmDialog(`Overwrite "${fileName}"?`, "Save");
    if (!confirmed) return;

    if (saving) return;
    setSaving(true);
    try {
      const bytes = await buildBytes();
      if (bytes) await overwritePdfFile(path, bytes);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Save As — opens a save dialog (Tauri) or triggers a download (browser).
   * Updates `mainFilePath` with the chosen name so subsequent saves use it.
   */
  const handleSaveAs = async () => {
    if (!mainPagesRef.current.length || saving) return;
    setSaving(true);
    try {
      const bytes = await buildBytes();
      if (!bytes) return;
      const saved = await savePdfFile(bytes, mainFilePathRef.current ?? undefined);
      if (saved) setMainFilePath(saved);
    } finally {
      setSaving(false);
    }
  };

  // -------------------------------------------------------------------------
  // OS file-drop
  //
  // Tauri: listen to the native window drag-drop event which provides file
  //        paths; determine target panel by cursor position.
  // Browser: handled by onDrop on each panel element (see JSX below).
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | null = null;

    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      unlisten = await getCurrentWindow().onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const { paths, position } = event.payload;
        const pdfPaths = paths.filter(p => p.toLowerCase().endsWith(".pdf"));
        if (!pdfPaths.length) return;
        const panel: Panel = position.x < window.innerWidth / 2 ? "main" : "src";
        const bytes = await readFile(pdfPaths[0]);
        await loadFromBytes(bytes, pdfPaths[0], panel);
      });
    })();

    return () => { unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Drag-over handler (cursor feedback only)
  // -------------------------------------------------------------------------
  const handlePanelFileDrag = (e: React.DragEvent) => {
    if (_drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  // -------------------------------------------------------------------------
  // Browser file-drop handlers (used only in non-Tauri context)
  //
  // Tauri intercepts OS drag-drop at the window level (see useEffect above)
  // so these onDrop handlers are effectively a no-op in that environment.
  // In a plain browser they are the primary way to open files by dropping.
  // -------------------------------------------------------------------------
  const makePanelDropHandler = (panel: Panel) => async (e: React.DragEvent) => {
    e.preventDefault(); // always prevent browser default (navigating to dropped file)
    if (_drag) return; // internal thumbnail drag — already handled elsewhere
    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.name.toLowerCase().endsWith(".pdf"),
    );
    if (!files.length) return;
    const buffer = await files[0].arrayBuffer();
    await loadFromBytes(new Uint8Array(buffer), files[0].name, panel);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleMainDrop = useCallback(makePanelDropHandler("main"), [loading]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleSrcDrop  = useCallback(makePanelDropHandler("src"),  [loading]);

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------
  const makeSelector = (
    list: PageEntry[],
    selected: Set<string>,
    setSelected: React.Dispatch<React.SetStateAction<Set<string>>>,
    lastIdx: React.MutableRefObject<number>,
  ) => (id: string, idx: number, e: React.MouseEvent) => {
    if (e.shiftKey && lastIdx.current >= 0) {
      const lo = Math.min(lastIdx.current, idx);
      const hi = Math.max(lastIdx.current, idx);
      const next = new Set(selected);
      for (let i = lo; i <= hi; i++) next.add(list[i].id);
      setSelected(next);
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      next.has(id) ? next.delete(id) : next.add(id);
      setSelected(next);
      lastIdx.current = idx;
    } else {
      setSelected(new Set([id]));
      lastIdx.current = idx;
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleMainClick = useCallback(
    makeSelector(mainPages, mainSelected, setMainSelected, lastMainIdx),
    [mainPages, mainSelected],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleSrcClick = useCallback(
    makeSelector(srcPages, srcSelected, setSrcSelected, lastSrcIdx),
    [srcPages, srcSelected],
  );

  // -------------------------------------------------------------------------
  // Pointer-down on a source thumbnail - starts the drag
  // -------------------------------------------------------------------------
  const handleSrcPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    const sel = srcSelectedRef.current;
    const ids = sel.has(id)
      ? srcPagesRef.current.filter(p => sel.has(p.id)).map(p => p.id)
      : [id];
    if (!sel.has(id)) setSrcSelected(new Set([id]));
    const count = ids.length;
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = count === 1 ? "1 page" : `${count} pages`;
    ghost.style.left = `${e.clientX + 14}px`;
    ghost.style.top  = `${e.clientY + 14}px`;
    document.body.appendChild(ghost);
    _drag = { ids, ghost };
  };

  // -------------------------------------------------------------------------
  // Delete selected
  // -------------------------------------------------------------------------
  const handleDeleteSelected = () => {
    setMainPages(prev => prev.filter(p => !mainSelected.has(p.id)));
    setMainSelected(new Set());
  };

  // -------------------------------------------------------------------------
  // Zoom helpers
  // -------------------------------------------------------------------------
  const zoomIn  = (setZoom: React.Dispatch<React.SetStateAction<number>>, setFit: (v: boolean) => void) =>
    () => { setZoom(z => Math.min(ZOOM_MAX, z + ZOOM_STEP)); setFit(false); };
  const zoomOut = (setZoom: React.Dispatch<React.SetStateAction<number>>, setFit: (v: boolean) => void) =>
    () => { setZoom(z => Math.max(ZOOM_MIN, z - ZOOM_STEP)); setFit(false); };
  const toggleFit = (setFit: React.Dispatch<React.SetStateAction<boolean>>) =>
    () => setFit(f => !f);
  const toggleLayout = (setLayout: React.Dispatch<React.SetStateAction<LayoutMode>>) =>
    () => setLayout(l => l === "column" ? "wrap" : "column");

  const thumbStyle = (zoom: number, fit: boolean): React.CSSProperties =>
    ({ "--thumb-w": fit ? "calc(100% - 16px)" : `${BASE_PX * zoom / 100}px` } as React.CSSProperties);

  const dragCount = _drag?.ids.length ?? srcSelected.size ?? 1;
  const busy = loading !== null || saving;
  const mainLabel = mainFilePath ? mainFilePath.split(/[/\\]/).pop() : "Main Document";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="app">
      <div className="panels">

        {/* LEFT - main document */}
        <div className="panel" onDragOver={handlePanelFileDrag} onDragEnter={handlePanelFileDrag} onDrop={handleMainDrop}>
          <div className="panel-header">
            <span className="panel-title">{mainLabel}</span>
            <div className="panel-header-actions">
              <span className="page-count">
                {mainPages.length} page{mainPages.length !== 1 ? "s" : ""}
              </span>
              <ZoomControls
                zoom={mainZoom} fit={mainFit} layout={mainLayout}
                onZoomIn={zoomIn(setMainZoom, setMainFit)}
                onZoomOut={zoomOut(setMainZoom, setMainFit)}
                onToggleFit={toggleFit(setMainFit)}
                onToggleLayout={toggleLayout(setMainLayout)}
              />
              <div className="header-separator" />
              <button className="panel-btn" onClick={handleOpenMain} disabled={busy}>
                {loading === "main" ? "Opening..." : "Open"}
              </button>
              <button
                className="panel-btn"
                onClick={handleSave}
                disabled={!mainPages.length || busy}
                title={isTauri() && mainFilePath ? `Overwrite ${mainLabel}` : "Download as PDF"}
              >
                {saving ? "Saving..." : "Save"}
              </button>
              <button className="panel-btn" onClick={handleSaveAs} disabled={!mainPages.length || busy}>
                Save As...
              </button>
              {mainSelected.size > 0 && (
                <button className="panel-btn delete-btn" onClick={handleDeleteSelected} disabled={busy}>
                  Delete {mainSelected.size} page{mainSelected.size > 1 ? "s" : ""}
                </button>
              )}
            </div>
          </div>

          <div
            ref={mainListRef}
            className={[
              "page-list",
              isDragging ? "panel-drop-active" : "",
              mainLayout === "wrap" ? "page-list--wrap" : "",
            ].filter(Boolean).join(" ")}
            style={thumbStyle(mainZoom, mainFit)}
            data-panel="main"
          >
            {mainPages.length === 0 ? (
              <>
                {dropIdx !== null && <InsertIndicator count={dragCount} />}
                <p className={`empty-hint${isDragging ? " empty-hint--drag" : ""}`}>
                  {isDragging ? "Drop pages here" : "Open a PDF or drag a file here"}
                </p>
              </>
            ) : (
              mainPages.map((page, i) => (
                <React.Fragment key={page.id}>
                  {dropIdx === i && <InsertIndicator count={dragCount} />}
                  <PageThumb
                    page={page}
                    number={i + 1}
                    selected={mainSelected.has(page.id)}
                    onClick={e => handleMainClick(page.id, i, e)}
                  />
                  {dropIdx === mainPages.length && i === mainPages.length - 1 && (
                    <InsertIndicator count={dragCount} />
                  )}
                </React.Fragment>
              ))
            )}
          </div>
        </div>

        {/* RIGHT - source document */}
        <div className="panel source-panel" onDragOver={handlePanelFileDrag} onDragEnter={handlePanelFileDrag} onDrop={handleSrcDrop}>
          <div className="panel-header">
            <span className="panel-title">Source Document</span>
            <div className="panel-header-actions">
              <span className="page-count">
                {srcPages.length} page{srcPages.length !== 1 ? "s" : ""}
              </span>
              <ZoomControls
                zoom={srcZoom} fit={srcFit} layout={srcLayout}
                onZoomIn={zoomIn(setSrcZoom, setSrcFit)}
                onZoomOut={zoomOut(setSrcZoom, setSrcFit)}
                onToggleFit={toggleFit(setSrcFit)}
                onToggleLayout={toggleLayout(setSrcLayout)}
              />
              <div className="header-separator" />
              <button className="panel-btn" onClick={handleOpenSrc} disabled={busy}>
                {loading === "src" ? "Opening..." : "Open"}
              </button>
            </div>
          </div>

          <div
            className={[
              "page-list",
              srcLayout === "wrap" ? "page-list--wrap" : "",
            ].filter(Boolean).join(" ")}
            style={thumbStyle(srcZoom, srcFit)}
            data-panel="src"
          >
            {srcPages.length === 0 ? (
              <p className="empty-hint">Open a PDF or drag a file here</p>
            ) : (
              srcPages.map((page, i) => (
                <PageThumb
                  key={page.id}
                  page={page}
                  number={i + 1}
                  selected={srcSelected.has(page.id)}
                  draggable
                  dragHint={
                    srcSelected.size > 1 && srcSelected.has(page.id)
                      ? `${srcSelected.size} pages`
                      : undefined
                  }
                  onClick={e => handleSrcClick(page.id, i, e)}
                  onPointerDown={e => handleSrcPointerDown(e, page.id)}
                />
              ))
            )}
          </div>

          {srcSelected.size > 0 && (
            <div className="src-hint">
              {srcSelected.size} page{srcSelected.size > 1 ? "s" : ""} selected
              &mdash; drag into the main document
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ZoomControls
// ---------------------------------------------------------------------------
interface ZoomControlsProps {
  zoom: number;
  fit: boolean;
  layout: LayoutMode;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleFit: () => void;
  onToggleLayout: () => void;
}

function ZoomControls({ zoom, fit, layout, onZoomIn, onZoomOut, onToggleFit, onToggleLayout }: ZoomControlsProps) {
  return (
    <div className="zoom-controls">
      <button className="panel-btn zoom-btn" onClick={onZoomOut} title="Zoom out" disabled={!fit && zoom <= ZOOM_MIN}>−</button>
      <span className="zoom-label">{fit ? "fit" : `${zoom}%`}</span>
      <button className="panel-btn zoom-btn" onClick={onZoomIn} title="Zoom in" disabled={!fit && zoom >= ZOOM_MAX}>+</button>
      <button
        className={`panel-btn zoom-btn${fit ? " zoom-btn--active" : ""}`}
        onClick={onToggleFit}
        title="Fit to pane width"
      >↔</button>
      <button
        className="panel-btn zoom-btn"
        onClick={onToggleLayout}
        title={layout === "column" ? "Switch to grid layout" : "Switch to list layout"}
      >{layout === "column" ? "⊞" : "☰"}</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InsertIndicator
// ---------------------------------------------------------------------------
function InsertIndicator({ count }: { count: number }) {
  return (
    <div className="insert-indicator">
      <span className="insert-indicator__label">
        Insert {count} page{count !== 1 ? "s" : ""} here
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PageThumb
// ---------------------------------------------------------------------------
interface PageThumbProps {
  page: PageEntry;
  number: number;
  selected: boolean;
  draggable?: boolean;
  dragHint?: string;
  onClick: (e: React.MouseEvent) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
}

function PageThumb({ page, number, selected, draggable, dragHint, onClick, onPointerDown }: PageThumbProps) {
  return (
    <div
      className={`thumb${selected ? " selected" : ""}${draggable ? " draggable" : ""}`}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onDragStart={draggable ? e => e.preventDefault() : undefined}
    >
      <img src={page.thumbnailUrl} alt={`Page ${number}`} draggable={false} />
      <span className="page-num">{number}</span>
      {dragHint && <span className="drag-hint">{dragHint}</span>}
    </div>
  );
}