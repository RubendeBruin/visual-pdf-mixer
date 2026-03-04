import React, { useCallback, useEffect, useRef, useState } from "react";
import { PageEntry, buildMergedPdf, loadPdfPages } from "./pdfUtils";

type Panel = "main" | "src";

// ---------------------------------------------------------------------------
// Pointer-event drag state (module-level — always readable from DOM handlers)
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

  // Mirrors of state readable from async/event handlers without stale closures
  const srcPagesRef = useRef<PageEntry[]>([]);
  srcPagesRef.current = srcPages;
  const srcSelectedRef = useRef<Set<string>>(new Set());
  srcSelectedRef.current = srcSelected;
  const mainPagesRef = useRef<PageEntry[]>([]);
  mainPagesRef.current = mainPages;

  const mainListRef = useRef<HTMLDivElement>(null);
  const lastMainIdx = useRef<number>(-1);
  const lastSrcIdx = useRef<number>(-1);

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
  // Pointer-event drag — document-level listeners wired once on mount
  // -------------------------------------------------------------------------
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!_drag) return;

      // Move the ghost near the cursor
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

      // Remove ghost
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

    // pointercancel fires when OS grabs the pointer (e.g. alt-tab)
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
  // File pickers
  // -------------------------------------------------------------------------
  const pickFile = (onBytes: (b: Uint8Array) => void) => {
    const el = document.createElement("input");
    el.type = "file";
    el.accept = ".pdf,application/pdf";
    el.onchange = async () => {
      const file = el.files?.[0];
      if (!file) return;
      onBytes(new Uint8Array(await file.arrayBuffer()));
    };
    el.click();
  };

  const handleOpenMain = () =>
    pickFile(async bytes => {
      setLoading("main");
      try {
        setMainPages(await loadPdfPages(bytes));
        setMainSelected(new Set());
        lastMainIdx.current = -1;
      } finally { setLoading(null); }
    });

  const handleOpenSrc = () =>
    pickFile(async bytes => {
      setLoading("src");
      try {
        setSrcPages(await loadPdfPages(bytes));
        setSrcSelected(new Set());
        lastSrcIdx.current = -1;
      } finally { setLoading(null); }
    });

  // -------------------------------------------------------------------------
  // Save — reads ref to avoid stale closure over mainPages
  // -------------------------------------------------------------------------
  const handleSave = async () => {
    const pages = mainPagesRef.current;
    if (!pages.length || saving) return;
    setSaving(true);
    try {
      const bytes = await buildMergedPdf(pages);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "merged.pdf";
      a.click();
      URL.revokeObjectURL(url);
    } finally { setSaving(false); }
  };

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
  // Pointer-down on a source thumbnail — starts the drag
  // -------------------------------------------------------------------------
  const handleSrcPointerDown = (e: React.PointerEvent, id: string) => {
    // Only react to left-button (button 0)
    if (e.button !== 0) return;

    // Prevent implicit pointer capture on the source element so that
    // pointermove/pointerup bubble to document instead
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);

    const sel = srcSelectedRef.current;
    const ids = sel.has(id)
      ? srcPagesRef.current.filter(p => sel.has(p.id)).map(p => p.id)
      : [id];
    if (!sel.has(id)) setSrcSelected(new Set([id]));

    // Build the ghost element
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
  // Delete button
  // -------------------------------------------------------------------------
  const handleDeleteSelected = () => {
    setMainPages(prev => prev.filter(p => !mainSelected.has(p.id)));
    setMainSelected(new Set());
  };

  const dragCount = _drag?.ids.length ?? srcSelected.size ?? 1;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="app">
      <header className="toolbar">
        <span className="app-title">PDF Mixer</span>
        <button onClick={handleOpenMain} disabled={loading !== null}>
          {loading === "main" ? "Loading…" : "Open Main PDF"}
        </button>
        <button onClick={handleOpenSrc} disabled={loading !== null}>
          {loading === "src" ? "Loading…" : "Open Source PDF"}
        </button>
        {mainSelected.size > 0 && (
          <button className="delete-btn" onClick={handleDeleteSelected}>
            Delete {mainSelected.size} page{mainSelected.size > 1 ? "s" : ""}
          </button>
        )}
        <button
          className="save-btn"
          onClick={handleSave}
          disabled={!mainPages.length || saving}
        >
          {saving ? "Saving…" : "Save PDF"}
        </button>
      </header>

      <div className="panels">
        {/* LEFT — main document */}
        <div className="panel">
          <div className="panel-header">
            <span>Main Document</span>
            <span className="page-count">
              {mainPages.length} page{mainPages.length !== 1 ? "s" : ""}
            </span>
          </div>

          <div
            ref={mainListRef}
            className={`page-list${isDragging ? " panel-drop-active" : ""}`}
            data-panel="main"
          >
            {mainPages.length === 0 ? (
              <>
                {dropIdx !== null && <InsertIndicator count={dragCount} />}
                <p className={`empty-hint${isDragging ? " empty-hint--drag" : ""}`}>
                  {isDragging ? "Drop pages here" : "Open a PDF to edit"}
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

        {/* RIGHT — source document */}
        <div className="panel source-panel">
          <div className="panel-header">
            <span>Source Document</span>
            <span className="page-count">
              {srcPages.length} page{srcPages.length !== 1 ? "s" : ""}
            </span>
          </div>

          <div className="page-list" data-panel="src">
            {srcPages.length === 0 ? (
              <p className="empty-hint">Open a source PDF to insert pages</p>
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
              — drag into the main document
            </div>
          )}
        </div>
      </div>
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
      // Prevent browser text/image selection during pointer drag
      onDragStart={draggable ? e => e.preventDefault() : undefined}
    >
      <img src={page.thumbnailUrl} alt={`Page ${number}`} draggable={false} />
      <span className="page-num">{number}</span>
      {dragHint && <span className="drag-hint">{dragHint}</span>}
    </div>
  );
}
