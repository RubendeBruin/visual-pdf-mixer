import * as pdfjs from 'pdfjs-dist';
import { PDFDocument, PDFPage } from 'pdf-lib';

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
 *
 * Pages from the same source document are copied in a single `copyPages` call
 * so that pdf-lib's internal deduplication cache (PDFObjectCopier) is shared
 * across all of those pages.  Without this batching, shared resources such as
 * embedded fonts and images are written into the output once per page that
 * references them, which can make the merged file substantially larger than
 * the sum of the source files.
 */
export async function buildMergedPdf(pages: PageEntry[]): Promise<Uint8Array> {
  const dest = await PDFDocument.create();

  // Cache parsed source documents keyed by the bytes reference.
  const cache = new Map<Uint8Array, PDFDocument>();
  for (const entry of pages) {
    if (!cache.has(entry.pdfBytes)) {
      cache.set(entry.pdfBytes, await PDFDocument.load(entry.pdfBytes));
    }
  }

  // Group the requested pages by source document while remembering the
  // position each page must occupy in the final output.
  // Using the pdfBytes reference as the map key guarantees that pages
  // loaded from the same file share the same PDFDocument instance.
  const batches = new Map<
    Uint8Array,
    Array<{ outputIndex: number; pageIndex: number }>
  >();
  for (let i = 0; i < pages.length; i++) {
    const { pdfBytes, pageIndex } = pages[i];
    let batch = batches.get(pdfBytes);
    if (!batch) {
      batch = [];
      batches.set(pdfBytes, batch);
    }
    batch.push({ outputIndex: i, pageIndex });
  }

  // Copy all pages from each source in one call so that resources shared
  // between pages (fonts, images, colour spaces, …) are only embedded once.
  const copiedPages: PDFPage[] = new Array(pages.length);
  for (const [sourceBytes, batch] of batches) {
    const src = cache.get(sourceBytes)!;
    const pageIndices = batch.map((b) => b.pageIndex);
    const copied = await dest.copyPages(src, pageIndices);
    for (let i = 0; i < batch.length; i++) {
      copiedPages[batch[i].outputIndex] = copied[i];
    }
  }

  // Add pages to the destination document in the order the user arranged them.
  for (const page of copiedPages) {
    dest.addPage(page);
  }

  return dest.save();
}
