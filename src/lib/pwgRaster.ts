// Convert an uploaded image into PWG-Raster — the format IPP Everywhere /
// Mopria printers are required to accept, and the one Android's own print
// service produces. Cheap lasers (Pantum et al.) have no PDF interpreter but
// render this natively.
//
// Layout: "RaS2" sync word, then per page a 1796-byte header followed by the
// raster lines. Each line is <line-repeat><packbits runs>; we emit repeat-runs
// only (count 0–127 → pixel repeated count+1 times), which is always valid and
// compresses the large white margins well.
import Jimp from "jimp";
import { pdfToImages } from "./pdfRender";

const PAGE_W_PT = 595; // A4 in points
const PAGE_H_PT = 842;

/** sGray colour space — 0 is black, 255 is white. */
const COLORSPACE_SGRAY = 18;

/**
 * A4 pixel dimensions at a given resolution. This is the whole point of making
 * the DPI a parameter: a printer that advertises only 600 dpi ACCEPTS a 300-dpi
 * raster and then aborts it (job "Failed" mid-print), because the bitmap doesn't
 * match a resolution it can drive. The app reads the printer's own
 * urf-supported / printer-resolution and asks us to rasterise at that number, so
 * what we send is exactly what the machine can print — the same thing the phone's
 * own print service does.
 */
function a4Dims(dpi: number) {
  return { w: Math.round(8.27 * dpi), h: Math.round(11.69 * dpi) };
}

/** Clamp to the resolutions cheap lasers actually drive, so a bogus value can't blow up memory. */
function normaliseDpi(dpi?: number): number {
  if (!dpi || !Number.isFinite(dpi)) return 300;
  if (dpi >= 600) return 600;
  if (dpi >= 300) return 300;
  return 150;
}

function writeString(buf: Buffer, offset: number, value: string, length: number) {
  buf.write(value.slice(0, length - 1), offset, "ascii");
}

/** Fit a source image onto a white A4 canvas, centered — the shape the printer wants. */
function fitOntoA4(img: Jimp, w: number, h: number): Jimp {
  const canvas = new Jimp(w, h, 0xffffffff);
  img.scaleToFit(w, h);
  canvas.composite(img, Math.floor((w - img.bitmap.width) / 2), Math.floor((h - img.bitmap.height) / 2));
  return canvas;
}

/** Encode one already-A4-sized canvas as a PWG page (header + raster rows). */
function encodePwgPage(canvas: Jimp, totalPages: number, dpi: number): Buffer {
  const w = canvas.bitmap.width;
  const h = canvas.bitmap.height;
  canvas.grayscale();
  const px = canvas.bitmap.data; // RGBA
  const chunks: Buffer[] = [buildPageHeader(w, h, dpi, totalPages)];
  const rowStride = w * 4;
  for (let y = 0; y < h; y++) {
    const base = y * rowStride;
    const out: number[] = [0]; // line-repeat = 0 → this line appears once
    let x = 0;
    while (x < w) {
      const gray = px[base + x * 4]; // grayscale() makes R=G=B
      let run = 1;
      while (x + run < w && run < 128 && px[base + (x + run) * 4] === gray) run++;
      out.push(run - 1, gray);
      x += run;
    }
    chunks.push(Buffer.from(out));
  }
  return Buffer.concat(chunks);
}

function buildPageHeader(w: number, h: number, dpi: number, totalPages = 1): Buffer {
  const hd = Buffer.alloc(1796);
  writeString(hd, 0, "PwgRaster", 64);
  writeString(hd, 64, "", 64);            // MediaColor
  writeString(hd, 128, "", 64);           // MediaType
  writeString(hd, 192, "", 64);           // PrintContentOptimize

  hd.writeUInt32BE(0, 268);               // CutMedia
  hd.writeUInt32BE(0, 272);               // Duplex: off
  hd.writeUInt32BE(dpi, 276);             // HWResolution X
  hd.writeUInt32BE(dpi, 280);             // HWResolution Y
  hd.writeUInt32BE(0, 300);               // InsertSheet
  hd.writeUInt32BE(0, 304);               // Jog
  hd.writeUInt32BE(0, 308);               // LeadingEdge
  hd.writeUInt32BE(0, 324);               // MediaPosition
  hd.writeUInt32BE(0, 328);               // MediaWeight
  hd.writeUInt32BE(1, 340);               // NumCopies
  hd.writeUInt32BE(0, 344);               // Orientation
  hd.writeUInt32BE(PAGE_W_PT, 352);       // PageSize width (points)
  hd.writeUInt32BE(PAGE_H_PT, 356);       // PageSize height (points)
  hd.writeUInt32BE(0, 368);               // Tumble
  hd.writeUInt32BE(w, 372);               // Width (pixels)
  hd.writeUInt32BE(h, 376);               // Height (pixels)
  hd.writeUInt32BE(8, 384);               // BitsPerColor
  hd.writeUInt32BE(8, 388);               // BitsPerPixel
  hd.writeUInt32BE(w, 392);               // BytesPerLine (8bpp gray → 1 byte/px)
  hd.writeUInt32BE(0, 396);               // ColorOrder: chunky
  hd.writeUInt32BE(COLORSPACE_SGRAY, 400);
  hd.writeUInt32BE(1, 420);               // NumColors
  hd.writeUInt32BE(totalPages, 452);      // TotalPageCount
  hd.writeInt32BE(1, 456);                // CrossFeedTransform
  hd.writeInt32BE(1, 460);                // FeedTransform
  hd.writeUInt32BE(0, 464);               // ImageBoxLeft
  hd.writeUInt32BE(0, 468);               // ImageBoxTop
  hd.writeUInt32BE(w, 472);               // ImageBoxRight
  hd.writeUInt32BE(h, 476);               // ImageBoxBottom
  hd.writeUInt32BE(0, 480);               // AlternatePrimary
  hd.writeUInt32BE(4, 484);               // PrintQuality: normal
  hd.writeUInt32BE(0, 508);               // VendorIdentifier
  hd.writeUInt32BE(0, 512);               // VendorLength
  writeString(hd, 1668, "", 64);          // RenderingIntent
  writeString(hd, 1732, "A4", 64);        // PageSizeName
  return hd;
}

/** One image → single-page PWG-Raster at the requested (printer-matched) DPI. */
export async function imageToPwgRaster(buf: Buffer, dpi?: number): Promise<Buffer> {
  const d = normaliseDpi(dpi);
  const { w, h } = a4Dims(d);
  const canvas = fitOntoA4(await Jimp.read(buf), w, h);
  return Buffer.concat([Buffer.from("RaS2", "ascii"), encodePwgPage(canvas, 1, d)]);
}

/** A PDF → multi-page PWG-Raster, one raster page per PDF page. */
export async function pdfToPwgRaster(pdf: Buffer, dpi?: number): Promise<Buffer> {
  const d = normaliseDpi(dpi);
  const { w, h } = a4Dims(d);
  const images = await pdfToImages(pdf);
  if (images.length === 0) throw new Error("PDF produced no pages to rasterise.");
  const chunks: Buffer[] = [Buffer.from("RaS2", "ascii")];
  for (const img of images) chunks.push(encodePwgPage(fitOntoA4(img, w, h), images.length, d));
  return Buffer.concat(chunks);
}
