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

const DPI = 300;
const PAGE_W = 2480; // A4 width  @ 300 dpi
const PAGE_H = 3508; // A4 height @ 300 dpi

function fileHeader(pageCount: number): Buffer {
  const h = Buffer.alloc(12);
  h.write("UNIRAST\0", 0, "binary");
  h.writeUInt32BE(pageCount, 8);
  return h;
}

/** Encode one image as a URF page (32-byte header + PackBits rows). */
function encodeUrfPage(img: Jimp): Buffer {
  const canvas = new Jimp(PAGE_W, PAGE_H, 0xffffffff);
  img.scaleToFit(PAGE_W, PAGE_H);
  canvas.composite(img, Math.floor((PAGE_W - img.bitmap.width) / 2), Math.floor((PAGE_H - img.bitmap.height) / 2));
  const px = canvas.bitmap.data; // RGBA

  const pageHeader = Buffer.alloc(32);
  pageHeader.writeUInt8(24, 0); // bits per pixel (RGB)
  pageHeader.writeUInt8(1, 1);  // colorspace: sRGB
  pageHeader.writeUInt8(1, 2);  // duplex: none
  pageHeader.writeUInt8(4, 3);  // quality: normal
  pageHeader.writeUInt32BE(PAGE_W, 12);
  pageHeader.writeUInt32BE(PAGE_H, 16);
  pageHeader.writeUInt32BE(DPI, 20);

  const chunks: Buffer[] = [pageHeader];
  const rowStride = PAGE_W * 4;
  for (let y = 0; y < PAGE_H; y++) {
    const base = y * rowStride;
    const out: number[] = [0]; // line-repeat = 0 (row appears once)
    let x = 0;
    while (x < PAGE_W) {
      const i = base + x * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      let run = 1;
      while (x + run < PAGE_W && run < 128) {
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

/** One image → single-page URF. */
export async function imageToUrf(buf: Buffer): Promise<Buffer> {
  return Buffer.concat([fileHeader(1), encodeUrfPage(await Jimp.read(buf))]);
}

/** A PDF → multi-page URF, one raster page per PDF page. */
export async function pdfToUrf(pdf: Buffer): Promise<Buffer> {
  const images = await pdfToImages(pdf);
  if (images.length === 0) throw new Error("PDF produced no pages to rasterise.");
  const chunks: Buffer[] = [fileHeader(images.length)];
  for (const img of images) chunks.push(encodeUrfPage(img));
  return Buffer.concat(chunks);
}
