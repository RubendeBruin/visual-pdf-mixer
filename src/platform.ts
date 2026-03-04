/**
 * platform.ts – runtime Tauri / browser abstraction.
 *
 * Every function in this file provides a unified API that delegates to the
 * native Tauri plugin when the app runs inside a Tauri webview, or falls back
 * to standard browser APIs when the app is served from a regular web server.
 *
 * All Tauri-specific imports are done dynamically so they are never called in
 * a plain-browser context (avoiding IPC errors) while still being included in
 * the Vite bundle for Tauri builds.
 */

/**
 * Returns true when the app is running inside a Tauri webview.
 * Tauri always injects `window.__TAURI_INTERNALS__` before the page loads.
 */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenResult {
  /** Raw bytes of the selected PDF file. */
  bytes: Uint8Array;
  /** Display name (filename without path) used for the panel title. */
  name: string;
  /**
   * Full filesystem path — only available in Tauri; undefined in the browser.
   * Used by handleSave to overwrite the same file.
   */
  path?: string;
}

// ---------------------------------------------------------------------------
// Open a PDF file
// ---------------------------------------------------------------------------

/**
 * Shows a file-picker and returns the selected PDF's bytes and metadata.
 *
 * - Tauri: native OS dialog + `readFile` from the fs plugin.
 * - Browser: hidden `<input type="file">` element.
 *
 * Returns `null` when the user cancels.
 */
export async function openPdfFile(title: string): Promise<OpenResult | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');

    const selected = await open({
      title,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!selected || typeof selected !== 'string') return null;

    const bytes = await readFile(selected);
    const name = selected.split(/[/\\]/).pop() ?? selected;
    return { bytes, name, path: selected };
  }

  // Browser fallback — hidden <input type="file">
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,application/pdf';

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const buffer = await file.arrayBuffer();
      resolve({ bytes: new Uint8Array(buffer), name: file.name });
    });

    // Some browsers fire a 'cancel' event when the dialog is dismissed.
    input.addEventListener('cancel', () => resolve(null));

    input.click();
  });
}

// ---------------------------------------------------------------------------
// Save / download a PDF file
// ---------------------------------------------------------------------------

/**
 * Saves PDF bytes to a file chosen by the user.
 *
 * - Tauri: native save dialog + `writeFile` from the fs plugin.
 *          Returns the chosen filesystem path, or `null` if cancelled.
 * - Browser: triggers a download. Returns the filename used, never `null`.
 */
export async function savePdfFile(
  bytes: Uint8Array,
  defaultPath?: string,
): Promise<string | null> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');

    const chosen = await save({
      title: 'Save PDF As',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      defaultPath: defaultPath ?? 'merged.pdf',
    });
    if (!chosen) return null;

    await writeFile(chosen, bytes);
    return chosen;
  }

  // Browser fallback — create an object URL and trigger a download link.
  const fileName = defaultPath
    ? (defaultPath.split(/[/\\]/).pop() ?? defaultPath)
    : 'merged.pdf';

  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke the object URL after a short delay to free memory.
  setTimeout(() => URL.revokeObjectURL(url), 500);

  return fileName;
}

/**
 * Overwrites an existing file on disk (Tauri only).
 *
 * In the browser there is no way to overwrite a file on disk, so this
 * falls back to `savePdfFile` which triggers a download.
 */
export async function overwritePdfFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  if (isTauri()) {
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    await writeFile(path, bytes);
    return;
  }

  await savePdfFile(bytes, path);
}

// ---------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------

/**
 * Asks the user to confirm an action.
 *
 * - Tauri: native `ask` dialog (warning style).
 * - Browser: `window.confirm`.
 */
export async function confirmDialog(
  message: string,
  title: string,
): Promise<boolean> {
  if (isTauri()) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(message, { title, kind: 'warning' });
  }

  return window.confirm(`${title}\n\n${message}`);
}
