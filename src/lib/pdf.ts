// PDF → PNG page rendering via MuPDF WebAssembly. Pure WASM — no python, no
// node-canvas, no system libraries — so it runs on any host (Render native
// runtime included) with a plain `npm install`. mupdf is ESM-only, hence the
// dynamic import from this CommonJS build.

let _mupdf: any;
async function getMupdf() {
  if (!_mupdf) _mupdf = await import("mupdf");
  return _mupdf;
}

// Render a single 1-indexed PDF page to a PNG buffer.
export async function renderPdfPageToPng(
  pdfBuffer: Buffer,
  pageNumber: number,
  scale = 2
): Promise<Buffer> {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(pdfBuffer, "application/pdf");
  const count = doc.countPages();
  if (pageNumber < 1 || pageNumber > count) {
    throw new Error(`page ${pageNumber} out of range (1-${count})`);
  }
  const page = doc.loadPage(pageNumber - 1); // MuPDF is 0-indexed
  const pixmap = page.toPixmap(
    mupdf.Matrix.scale(scale, scale),
    mupdf.ColorSpace.DeviceRGB,
    false, // no alpha — white background for print previews
    true
  );
  return Buffer.from(pixmap.asPNG());
}
