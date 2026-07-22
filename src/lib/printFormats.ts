// ── Print-format registry ────────────────────────────────────────────────────
// One place that knows how to turn a stored upload (PDF or image) into every
// wire format a printer might accept. The document route just looks a format up
// here and streams whatever `produce()` returns — adding a new format is a
// single entry in PRINT_FORMATS, nothing else changes.
//
// Why so many formats? No single encoding prints on every machine:
//   • image/pwg-raster / image/urf — IPP Everywhere & Mopria REQUIRE these; the
//     widest-working option on cheap lasers with no PDF interpreter.
//   • application/pdf              — office multifunction printers.
//   • image/jpeg                   — almost every photo-capable printer.
//   • application/postscript       — HP/Brother/Xerox office lasers.
//   • PCL (application/vnd.hp-PCL) — HP + the many clones that speak PCL5.
//   • text/plain                   — receipt/thermal and line printers.
// The mobile print engine tries them best-first until one actually prints, so
// the more we can produce, the more printers "just work".
import Jimp from "jimp";
import { PDFDocument } from "pdf-lib";
import { pdfToImages } from "./pdfRender";
import { imageToPwgRaster, pdfToPwgRaster } from "./pwgRaster";
import { imageToUrf, pdfToUrf } from "./urf";

export type PrintFormatKey = "pdf" | "pwg" | "urf" | "jpeg" | "postscript" | "pcl" | "text";

/** What the caller hands each generator: the raw stored bytes plus its type. */
export interface FormatInput {
  body: Buffer;
  /** "pdf" | "image" | "docx" | "pptx" | "other" — from the upload's detectType. */
  fileType: string;
  mimeType: string;
  /**
   * Target resolution for raster formats (PWG/URF), read off the printer by the
   * app. Matching the printer's own resolution is what stops it accepting a job
   * and then aborting it. Ignored by non-raster formats.
   */
  dpi?: number;
}

export interface PrintFormatSpec {
  key: PrintFormatKey;
  /** Content-Type header AND the IPP document-format declared to the printer. */
  mime: string;
  /** Filename extension used in the Content-Disposition. */
  ext: string;
  /**
   * Produce the print-ready bytes, or throw if this document can't be turned
   * into this format (the engine then falls through to the next format). Throw —
   * never return the original bytes — so a printer is never sent something it
   * will silently abort.
   */
  produce(input: FormatInput): Promise<Buffer>;
}

// ── Shared rasterisation ──────────────────────────────────────────────────────
// PostScript / PCL / JPEG all start from the same place: the document rendered
// to A4-sized bitmaps. Rendering here (rather than in each generator) keeps the
// page geometry identical across every format.

const RASTER_DPI = 150;                     // enough for text, small enough to stream
const A4_W = Math.round(8.27 * RASTER_DPI); // 1240 px
const A4_H = Math.round(11.69 * RASTER_DPI);// 1754 px

/** Centre a source image on a white A4 canvas — the shape a printer expects. */
function fitOntoA4(img: Jimp): Jimp {
  const canvas = new Jimp(A4_W, A4_H, 0xffffffff);
  img.scaleToFit(A4_W, A4_H);
  canvas.composite(img, Math.floor((A4_W - img.bitmap.width) / 2), Math.floor((A4_H - img.bitmap.height) / 2));
  return canvas;
}

/** Every page of the document as an A4 Jimp bitmap (images = one page). */
async function a4Pages(input: FormatInput): Promise<Jimp[]> {
  if (input.fileType === "pdf") {
    const images = await pdfToImages(input.body);
    if (images.length === 0) throw new Error("PDF produced no pages to rasterise.");
    return images.map(fitOntoA4);
  }
  if (input.fileType === "image") {
    return [fitOntoA4(await Jimp.read(input.body))];
  }
  throw new Error(`Cannot rasterise a "${input.fileType}" document.`);
}

// ── PostScript (Level 2) ──────────────────────────────────────────────────────
// One grayscale `image` operator per page, DSC-commented so spoolers accept it.
// Data is hex so the whole file is 7-bit-clean and survives any transport.

function pageToPostScript(canvas: Jimp, index: number): string {
  canvas.grayscale();
  const { width: w, height: h, data } = canvas.bitmap; // RGBA, R=G=B after grayscale
  let hex = "";
  for (let p = 0; p < w * h; p++) hex += data[p * 4].toString(16).padStart(2, "0");
  // Map the unit square onto the full A4 page (595×842 pt) and flip Y so the
  // first raster row prints at the top.
  return (
    `%%Page: ${index + 1} ${index + 1}\n` +
    `gsave\n595 842 scale\n/DeviceGray setcolorspace\n` +
    `/pl ${w} string def\n` +
    `${w} ${h} 8 [${w} 0 0 -${h} 0 ${h}]\n` +
    `{ currentfile pl readhexstring pop }\nimage\n${hex}\n` +
    `grestore\nshowpage\n`
  );
}

async function toPostScript(input: FormatInput): Promise<Buffer> {
  const pages = await a4Pages(input);
  const body = pages.map(pageToPostScript).join("");
  const ps =
    `%!PS-Adobe-3.0\n%%Creator: Prinsta\n%%Pages: ${pages.length}\n` +
    `%%EndComments\n${body}%%EOF\n`;
  return Buffer.from(ps, "latin1");
}

// ── PCL 5 (monochrome raster) ─────────────────────────────────────────────────
// The lingua franca of HP lasers and their many clones. Each page is 1-bit
// raster (bit set = black dot) sent uncompressed row by row.

const ESC = "\x1b";

function pageToPcl(canvas: Jimp): Buffer {
  canvas.grayscale();
  const { width: w, height: h, data } = canvas.bitmap;
  const bytesPerRow = Math.ceil(w / 8);
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(bytesPerRow);
    for (let x = 0; x < w; x++) {
      // gray < 128 → black → dot on (bit 1). MSB is the leftmost pixel.
      if (data[(y * w + x) * 4] < 128) row[x >> 3] |= 0x80 >> (x & 7);
    }
    rows.push(Buffer.from(`${ESC}*b${bytesPerRow}W`, "latin1"), row);
  }
  return Buffer.concat([
    Buffer.from(`${ESC}*t${RASTER_DPI}R`, "latin1"), // raster resolution
    Buffer.from(`${ESC}*r${w}S`, "latin1"),          // source raster width
    Buffer.from(`${ESC}*r0F`, "latin1"),             // raster follows orientation
    Buffer.from(`${ESC}*b0M`, "latin1"),             // compression: none
    Buffer.from(`${ESC}*r0A`, "latin1"),             // start raster at left margin
    ...rows,
    Buffer.from(`${ESC}*rC`, "latin1"),              // end raster
    Buffer.from("\x0c", "latin1"),                   // form feed → eject page
  ]);
}

async function toPcl(input: FormatInput): Promise<Buffer> {
  const pages = await a4Pages(input);
  return Buffer.concat([
    Buffer.from(`${ESC}E`, "latin1"),      // reset
    Buffer.from(`${ESC}&l26A`, "latin1"),  // page size: A4
    Buffer.from(`${ESC}&l0O`, "latin1"),   // portrait
    ...pages.map(pageToPcl),
    Buffer.from(`${ESC}E`, "latin1"),      // reset (flush)
  ]);
}

// ── JPEG ──────────────────────────────────────────────────────────────────────
// A single frame, so only single-page sources qualify. Multi-page PDFs throw and
// the engine falls through to a paginated format.

async function toJpeg(input: FormatInput): Promise<Buffer> {
  if (input.fileType === "image") {
    const img = await Jimp.read(input.body);
    return img.quality(90).getBufferAsync(Jimp.MIME_JPEG);
  }
  if (input.fileType === "pdf") {
    const images = await pdfToImages(input.body);
    if (images.length !== 1) throw new Error("JPEG only supports single-page documents.");
    return images[0].quality(90).getBufferAsync(Jimp.MIME_JPEG);
  }
  throw new Error(`Cannot render a "${input.fileType}" document as JPEG.`);
}

// ── PDF ───────────────────────────────────────────────────────────────────────
// PDFs pass straight through; a raw image is wrapped in a single PDF page so an
// IPP printer that only speaks application/pdf still accepts it.

async function toPdf(input: FormatInput): Promise<Buffer> {
  if (input.fileType === "pdf") return input.body;
  if (input.fileType === "image") {
    const pdf = await PDFDocument.create();
    const isPng = input.mimeType.includes("png") || (input.body[0] === 0x89 && input.body[1] === 0x50);
    const img = isPng ? await pdf.embedPng(input.body) : await pdf.embedJpg(input.body);
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    return Buffer.from(await pdf.save());
  }
  throw new Error(`Cannot wrap a "${input.fileType}" document as PDF.`);
}

// ── Plain text ────────────────────────────────────────────────────────────────
// For line/receipt printers. Only meaningful when the source really is text —
// we never guess text out of a rasterised page.

async function toText(input: FormatInput): Promise<Buffer> {
  if (input.mimeType.startsWith("text/") || input.fileType === "other") {
    const text = input.body.toString("utf8");
    if (!/[^\x00-\x08\x0e-\x1f]/.test(text.slice(0, 512))) {
      throw new Error("Document is not plain text.");
    }
    return Buffer.from(text, "utf8");
  }
  throw new Error(`Cannot render a "${input.fileType}" document as plain text.`);
}

// ── The registry ──────────────────────────────────────────────────────────────

export const PRINT_FORMATS: Record<PrintFormatKey, PrintFormatSpec> = {
  pwg: {
    key: "pwg",
    mime: "image/pwg-raster",
    ext: "pwg",
    produce: (i) => (i.fileType === "pdf" ? pdfToPwgRaster(i.body, i.dpi) : imageToPwgRaster(i.body, i.dpi)),
  },
  urf: {
    key: "urf",
    mime: "image/urf",
    ext: "urf",
    produce: (i) => (i.fileType === "pdf" ? pdfToUrf(i.body, i.dpi) : imageToUrf(i.body, i.dpi)),
  },
  pdf: { key: "pdf", mime: "application/pdf", ext: "pdf", produce: toPdf },
  jpeg: { key: "jpeg", mime: "image/jpeg", ext: "jpg", produce: toJpeg },
  postscript: { key: "postscript", mime: "application/postscript", ext: "ps", produce: toPostScript },
  pcl: { key: "pcl", mime: "application/vnd.hp-PCL", ext: "pcl", produce: toPcl },
  text: { key: "text", mime: "text/plain", ext: "txt", produce: toText },
};

/** Resolve a `?format=` query value to a spec, or undefined for an unknown one. */
export function printFormat(key: unknown): PrintFormatSpec | undefined {
  return typeof key === "string" && key in PRINT_FORMATS
    ? PRINT_FORMATS[key as PrintFormatKey]
    : undefined;
}
