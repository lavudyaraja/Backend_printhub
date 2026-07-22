// Render a PDF's pages to raster bitmaps, so a PDF can be printed on a cheap
// laser (Pantum, etc.) that has no PDF interpreter and only accepts PWG-Raster /
// URF. Uses PDFium compiled to WebAssembly — no native binaries, no system
// packages — so it runs unchanged on the deploy host.
//
// Each page comes back as a Jimp image at ~300 dpi, ready to be laid onto the A4
// raster canvas the printer expects (see pwgRaster.ts / urf.ts).
import Jimp from "jimp";

/** 72 pt/inch → 300 dpi. Matches the raster canvas the encoders target. */
const RENDER_SCALE = 300 / 72;

// @hyzyla/pdfium ships as ESM only; this backend compiles to CommonJS, so it is
// pulled in with a dynamic import (the one interop path TypeScript won't rewrite
// into a broken `require`). Cached after the first load.
let pdfiumModule: Promise<any> | null = null;
function loadPdfium(): Promise<any> {
  if (!pdfiumModule) pdfiumModule = import("@hyzyla/pdfium");
  return pdfiumModule;
}

/**
 * Render every page of a PDF to a Jimp image. Best-effort per page: a page that
 * fails to render is skipped rather than sinking the whole job.
 */
export async function pdfToImages(pdf: Buffer): Promise<Jimp[]> {
  const { PDFiumLibrary } = await loadPdfium();
  const library = await PDFiumLibrary.init();
  try {
    const doc = await library.loadDocument(pdf);
    try {
      const images: Jimp[] = [];
      for (const page of doc.pages()) {
        try {
          const rendered = await page.render({ scale: RENDER_SCALE, render: "bitmap" });
          const data = Buffer.from(rendered.data);
          // PDFium hands back BGRA; Jimp reads RGBA — swap the red/blue channels
          // so colours (and the luminance the encoders derive) come out right.
          for (let i = 0; i + 2 < data.length; i += 4) {
            const b = data[i];
            data[i] = data[i + 2];
            data[i + 2] = b;
          }
          images.push(
            await new Promise<Jimp>((resolve, reject) =>
              new Jimp({ data, width: rendered.width, height: rendered.height }, (err: Error | null, img: Jimp) =>
                err ? reject(err) : resolve(img)
              )
            )
          );
        } catch (e) {
          console.error("[pdfRender] page render failed, skipping:", e);
        }
      }
      return images;
    } finally {
      doc.destroy();
    }
  } finally {
    library.destroy();
  }
}
