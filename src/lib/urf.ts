// Convert an uploaded image into Apple Raster (URF), the bitmap format cheap
// laser printers (Pantum, etc.) accept over IPP. This lets the app print
// directly — no OS print dialog — because the printer receives exactly the
// raster it understands instead of a PDF it can't interpret.
//
// URF layout: "UNIRAST\0" + page-count, then per page a 32-byte header and the
// raster rows. Each row is a 1-byte line-repeat (0 = once) followed by PackBits
// runs; we only emit repeat-runs (count 0–127 → pixel repeated count+1 times),
// which is always valid and compresses the large white margins well.
import Jimp from "jimp";
import { pdfToImages } from "./pdfRender";

/**
 * A4 pixel size at a resolution. URF is stricter than PWG here: the DPI in the
 * page header MUST be one the printer lists in `urf-supported` (e.g. "RS600"),
 * or the machine accepts the job and then aborts it mid-print. The app reads
 * that list off the printer and asks us to rasterise at the matching number —
 * so a 600-dpi-only laser gets a 600-dpi raster, exactly like the phone's own
 * print service sends.
 */
function a4Dims(dpi: number) {
  return { w: Math.round(8.27 * dpi), h: Math.round(11.69 * dpi) };
}

function normaliseDpi(dpi?: number): number {
  if (!dpi || !Number.isFinite(dpi)) return 300;
  if (dpi >= 600) return 600;
  if (dpi >= 300) return 300;
  return 150;
}

function fileHeader(pageCount: number): Buffer {
  const h = Buffer.alloc(12);
  h.write("UNIRAST\0", 0, "binary");
  h.writeUInt32BE(pageCount, 8);
  return h;
}

/** Encode one image as a URF page (32-byte header + PackBits rows). */
function encodeUrfPage(img: Jimp, w: number, h: number, dpi: number): Buffer {
  const canvas = new Jimp(w, h, 0xffffffff);
  img.scaleToFit(w, h);
  canvas.composite(img, Math.floor((w - img.bitmap.width) / 2), Math.floor((h - img.bitmap.height) / 2));
  const px = canvas.bitmap.data; // RGBA

  const pageHeader = Buffer.alloc(32);
  pageHeader.writeUInt8(24, 0); // bits per pixel (RGB)
  pageHeader.writeUInt8(1, 1);  // colorspace: sRGB
  pageHeader.writeUInt8(1, 2);  // duplex: none
  pageHeader.writeUInt8(4, 3);  // quality: normal
  pageHeader.writeUInt32BE(w, 12);
  pageHeader.writeUInt32BE(h, 16);
  pageHeader.writeUInt32BE(dpi, 20);

  const chunks: Buffer[] = [pageHeader];
  const rowStride = w * 4;
  for (let y = 0; y < h; y++) {
    const base = y * rowStride;
    const out: number[] = [0]; // line-repeat = 0 (row appears once)
    let x = 0;
    while (x < w) {
      const i = base + x * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      let run = 1;
      while (x + run < w && run < 128) {
        const j = base + (x + run) * 4;
        if (px[j] === r && px[j + 1] === g && px[j + 2] === b) run++;
        else break;
      }
      out.push(run - 1, r, g, b);
      x += run;
    }
    chunks.push(Buffer.from(out));
  }
  return Buffer.concat(chunks);
}

/** One image → single-page URF at the requested (printer-matched) DPI. */
export async function imageToUrf(buf: Buffer, dpi?: number): Promise<Buffer> {
  const d = normaliseDpi(dpi);
  const { w, h } = a4Dims(d);
  return Buffer.concat([fileHeader(1), encodeUrfPage(await Jimp.read(buf), w, h, d)]);
}

/** A PDF → multi-page URF, one raster page per PDF page. */
export async function pdfToUrf(pdf: Buffer, dpi?: number): Promise<Buffer> {
  const d = normaliseDpi(dpi);
  const { w, h } = a4Dims(d);
  const images = await pdfToImages(pdf);
  if (images.length === 0) throw new Error("PDF produced no pages to rasterise.");
  const chunks: Buffer[] = [fileHeader(images.length)];
  for (const img of images) chunks.push(encodeUrfPage(img, w, h, d));
  return Buffer.concat(chunks);
}
