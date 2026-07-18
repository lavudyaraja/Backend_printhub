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

const DPI = 300;
const PAGE_W = 2480; // A4 @ 300dpi
const PAGE_H = 3508;
const PAGE_W_PT = 595; // A4 in points
const PAGE_H_PT = 842;

/** sGray colour space — 0 is black, 255 is white. */
const COLORSPACE_SGRAY = 18;

function writeString(buf: Buffer, offset: number, value: string, length: number) {
  buf.write(value.slice(0, length - 1), offset, "ascii");
}

function buildPageHeader(): Buffer {
  const h = Buffer.alloc(1796);
  writeString(h, 0, "PwgRaster", 64);
  writeString(h, 64, "", 64);            // MediaColor
  writeString(h, 128, "", 64);           // MediaType
  writeString(h, 192, "", 64);           // PrintContentOptimize

  h.writeUInt32BE(0, 268);               // CutMedia
  h.writeUInt32BE(0, 272);               // Duplex: off
  h.writeUInt32BE(DPI, 276);             // HWResolution X
  h.writeUInt32BE(DPI, 280);             // HWResolution Y
  h.writeUInt32BE(0, 300);               // InsertSheet
  h.writeUInt32BE(0, 304);               // Jog
  h.writeUInt32BE(0, 308);               // LeadingEdge
  h.writeUInt32BE(0, 324);               // MediaPosition
  h.writeUInt32BE(0, 328);               // MediaWeight
  h.writeUInt32BE(1, 340);               // NumCopies
  h.writeUInt32BE(0, 344);               // Orientation
  h.writeUInt32BE(PAGE_W_PT, 352);       // PageSize width (points)
  h.writeUInt32BE(PAGE_H_PT, 356);       // PageSize height (points)
  h.writeUInt32BE(0, 368);               // Tumble
  h.writeUInt32BE(PAGE_W, 372);          // Width (pixels)
  h.writeUInt32BE(PAGE_H, 376);          // Height (pixels)
  h.writeUInt32BE(8, 384);               // BitsPerColor
  h.writeUInt32BE(8, 388);               // BitsPerPixel
  h.writeUInt32BE(PAGE_W, 392);          // BytesPerLine (8bpp gray → 1 byte/px)
  h.writeUInt32BE(0, 396);               // ColorOrder: chunky
  h.writeUInt32BE(COLORSPACE_SGRAY, 400);
  h.writeUInt32BE(1, 420);               // NumColors
  h.writeUInt32BE(1, 452);               // TotalPageCount
  h.writeInt32BE(1, 456);                // CrossFeedTransform
  h.writeInt32BE(1, 460);                // FeedTransform
  h.writeUInt32BE(0, 464);               // ImageBoxLeft
  h.writeUInt32BE(0, 468);               // ImageBoxTop
  h.writeUInt32BE(PAGE_W, 472);          // ImageBoxRight
  h.writeUInt32BE(PAGE_H, 476);          // ImageBoxBottom
  h.writeUInt32BE(0, 480);               // AlternatePrimary
  h.writeUInt32BE(4, 484);               // PrintQuality: normal
  h.writeUInt32BE(0, 508);               // VendorIdentifier
  h.writeUInt32BE(0, 512);               // VendorLength
  writeString(h, 1668, "", 64);          // RenderingIntent
  writeString(h, 1732, "A4", 64);        // PageSizeName
  return h;
}

export async function imageToPwgRaster(buf: Buffer): Promise<Buffer> {
  const img = await Jimp.read(buf);
  // White A4 canvas, image fitted inside it and centred, then flattened to gray.
  const canvas = new Jimp(PAGE_W, PAGE_H, 0xffffffff);
  img.scaleToFit(PAGE_W, PAGE_H);
  canvas.composite(img, Math.floor((PAGE_W - img.bitmap.width) / 2), Math.floor((PAGE_H - img.bitmap.height) / 2));
  canvas.grayscale();
  const px = canvas.bitmap.data; // RGBA

  const chunks: Buffer[] = [Buffer.from("RaS2", "ascii"), buildPageHeader()];

  const rowStride = PAGE_W * 4;
  for (let y = 0; y < PAGE_H; y++) {
    const base = y * rowStride;
    const out: number[] = [0]; // line-repeat = 0 → this line appears once
    let x = 0;
    while (x < PAGE_W) {
      const gray = px[base + x * 4]; // grayscale() makes R=G=B
      let run = 1;
      while (x + run < PAGE_W && run < 128 && px[base + (x + run) * 4] === gray) run++;
      out.push(run - 1, gray);
      x += run;
    }
    chunks.push(Buffer.from(out));
  }

  return Buffer.concat(chunks);
}
