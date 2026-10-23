import { AppError } from '../../errors';
import type { ImageFormat } from './image-header';

/**
 * 會員上傳圖片的「重新封裝」（不依賴任何影像套件）：逐段解析容器，只保留解碼所需的資料段，
 * 移除所有中繼資料（EXIF／GPS 位置、XMP、ICC、文字註解、時間戳記…），並重建檔案。
 * 像素資料原樣保留（伺服器沒有影像解碼器，無法縮放；尺寸由驗證器強制，例如頭像必須 400×400，前端先裁切縮放）。
 * 結構不完整或無法解析 → 拒絕（ASSET_REJECTED），因此也順帶擋掉尾端夾帶的資料。
 */
export function stripMetadata(bytes: Uint8Array, format: ImageFormat): Buffer {
  const b = Buffer.from(bytes);
  try {
    if (format === 'png') return stripPng(b);
    if (format === 'jpeg') return stripJpeg(b);
    return stripWebp(b);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw bad();
  }
}

const bad = () => new AppError('ASSET_REJECTED', '圖片檔案結構不完整，無法處理，請重新匯出後再上傳');

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
function stripPng(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 8)];
  let o = 8;
  let ended = false;
  while (o + 12 <= b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString('latin1', o + 4, o + 8);
    const end = o + 12 + len;
    if (end > b.length) throw bad();
    if (PNG_KEEP.has(type)) out.push(b.subarray(o, end));
    o = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended) throw bad();
  return Buffer.concat(out);
}

function stripJpeg(b: Buffer): Buffer {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw bad();
  const out: Buffer[] = [b.subarray(0, 2)];
  let o = 2;
  for (;;) {
    if (o + 4 > b.length || b[o] !== 0xff) throw bad();
    const marker = b[o + 1]!;
    if (marker === 0xd9) throw bad(); // EOI 出現在影像資料之前
    const len = b.readUInt16BE(o + 2);
    const end = o + 2 + len;
    if (len < 2 || end > b.length) throw bad();
    // 保留 APP0（JFIF）、APP14（Adobe 色彩轉換）與所有非 APP/COM 段；丟棄 APP1–APP13、APP15（EXIF/XMP/ICC…）與 COM
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep = !(marker === 0xfe || (isApp && marker !== 0xe0 && marker !== 0xee));
    if (marker === 0xda) {
      // SOS 之後是壓縮資料直到 EOI：原樣保留，丟棄 EOI 之後夾帶的任何資料
      const eoi = b.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (eoi < end) throw bad();
      out.push(b.subarray(o, eoi + 2));
      return Buffer.concat(out);
    }
    if (keep) out.push(b.subarray(o, end));
    o = end;
  }
}

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);
function stripWebp(b: Buffer): Buffer {
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') throw bad();
  const riffEnd = Math.min(b.length, 8 + b.readUInt32LE(4));
  const chunks: Buffer[] = [];
  let o = 12;
  while (o + 8 <= riffEnd) {
    const type = b.toString('latin1', o, o + 4);
    const len = b.readUInt32LE(o + 4);
    const end = o + 8 + len + (len % 2);
    if (o + 8 + len > riffEnd) throw bad();
    if (WEBP_KEEP.has(type)) {
      const c = Buffer.from(b.subarray(o, Math.min(end, riffEnd)));
      if (type === 'VP8X') c[8] = c[8]! & ~(0x20 | 0x08 | 0x04); // 清除 ICC / EXIF / XMP 旗標
      chunks.push(c);
    }
    o = end;
  }
  if (!chunks.length) throw bad();
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}
