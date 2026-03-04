import * as pdfjs from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';

// Set up the PDF.js worker using Vite's asset URL handling
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href;

export interface PageEntry {
  /** Unique identifier for React keys and selection tracking */
  id: string;
  /** Data URL of the thumbnail image */
  thumbnailUrl: string;
  /** Raw bytes of the PDF file this page originates from */
  pdfBytes: Uint8Array;
  /** 0-based page index within the originating PDF */
  pageIndex: number;
}

const THUMBNAIL_SCALE = 0.35;

/**
 * Loads all pages of a PDF and renders them as thumbnails.
 * Returns a PageEntry array ready to be placed in app state.
 */
export async function loadPdfPages(bytes: Uint8Array): Promise<PageEntry[]> {
  // pdfjs needs its own copy of the buffer (it will detach it during loading)
  const data = bytes.slice(0);
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: PageEntry[] = [];

  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1); // pdfjs uses 1-based page numbers
    const viewport = page.getViewport({ scale: THUMBNAIL_SCALE });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d')!;

    await page.render({ canvasContext: ctx, viewport }).promise;

    pages.push({
      id: crypto.randomUUID(),
      thumbnailUrl: canvas.toDataURL('image/jpeg', 0.75),
      pdfBytes: bytes, // shared reference — do NOT mutate
      pageIndex: i,
    });
  }

  doc.destroy();
  return pages;
}

/**
 * Merges an ordered array of PageEntry values into a single PDF.
 * Caches PDFDocument instances so each source file is only parsed once.
 */
export async function buildMergedPdf(pages: PageEntry[]): Promise<Uint8Array> {
  const dest = await PDFDocument.create();

  // Cache parsed source documents keyed by the bytes reference
  const cache = new Map<Uint8Array, PDFDocument>();

  for (const entry of pages) {
    let src = cache.get(entry.pdfBytes);
    if (!src) {
      src = await PDFDocument.load(entry.pdfBytes);
      cache.set(entry.pdfBytes, src);
    }
    const [copied] = await dest.copyPages(src, [entry.pageIndex]);
    dest.addPage(copied);
  }

  return dest.save();
}
