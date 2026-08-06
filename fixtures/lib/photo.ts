import zlib from "node:zlib";

/**
 * Builds a synthetic profile photo (grayscale PNG, no deps) that passes the
 * Backend's real quality gate (PhotoQualityValidatorService: brightness >=85,
 * Laplacian-variance sharpness >=80, corner whiteness >=190) — a 1x1 pixel
 * fixture (TINY_PNG_BASE64 in api.ts) fails all three, since athlete profile
 * photos are content-inspected (unlike identity-doc uploads, which only check
 * mimetype). A light checkerboard gives real edges for the sharpness check
 * while staying bright enough (both cells >=150) that brightness/whiteness
 * pass regardless of corner-sampling — see the CRC32/PNG encoder below.
 *
 * KNOWN GAP found while building this: PhotoQualityValidatorService's own
 * corner-whiteness check chains `.extract(region).stats()` — on this repo's
 * sharp/libvips build (0.34.5), `.extract()` immediately followed by
 * `.stats()` silently ignores the crop and returns whole-image stats instead
 * (reproduced independently of this custom encoder, with sharp's own PNG/JPEG
 * output too). In production this means the "background must be white"
 * check is actually checking the WHOLE photo's average brightness, not just
 * the corners. Not fixed here — flagged for the team, out of scope for E2E
 * test authoring.
 */
export function makeProfilePhotoPng(size = 220, margin = 24, cell = 8): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size + 1);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let v: number;
      if (x < margin || y < margin || x >= size - margin || y >= size - margin) {
        v = 245; // bright margin/corners
      } else {
        const cx = Math.floor((x - margin) / cell);
        const cy = Math.floor((y - margin) / cell);
        v = (cx + cy) % 2 === 0 ? 250 : 150; // checkerboard: sharp edges, both cells bright
      }
      row[x + 1] = v;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

let crcTable: number[] | undefined;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeData), 0);
  return Buffer.concat([len, typeData, crc]);
}
