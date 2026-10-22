/**
 * 以「實際檔頭位元組」判斷圖片格式與尺寸（手寫解析，不依賴任何套件；不信任副檔名與 MIME）。
 * 支援：PNG（IHDR）、JPEG（SOFn 標記）、WebP（VP8 / VP8L / VP8X）。無法解析 → null。
 */
export type ImageFormat = 'png' | 'jpeg' | 'webp';
export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(b: Uint8Array, off: number, len: number): string {
  if (off + len > b.length) return '';
  return String.fromCharCode(...b.subarray(off, off + len));
}
const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;

function parsePng(b: Uint8Array): ImageInfo | null {
  // 簽章(8) + IHDR 長度(4)=13 + 'IHDR'(4) + 寬(4) + 高(4)
  if (b.length < 24 || !PNG_SIG.every((v, i) => b[i] === v)) return null;
  if (u32be(b, 8) !== 13 || ascii(b, 12, 4) !== 'IHDR') return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  return width > 0 && height > 0 ? { format: 'png', width, height } : null;
}

function parseJpeg(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o < b.length) {
    if (b[o] !== 0xff) return null; // 標記必須以 0xFF 開頭
    while (o < b.length && b[o] === 0xff) o++; // 填充位元組
    if (o >= b.length) return null;
    const marker = b[o]!;
    o++;
    // 無長度欄位的標記
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS 出現在 SOF 之前 → 無法取得尺寸
    if (o + 2 > b.length) return null;
    const len = u16be(b, o);
    if (len < 2 || o + len > b.length) return null;
    // SOF0–SOF15（排除 DHT C4、JPG C8、DAC CC）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (len < 7) return null;
      const height = u16be(b, o + 3);
      const width = u16be(b, o + 5);
      return width > 0 && height > 0 ? { format: 'jpeg', width, height } : null;
    }
    o += len;
  }
  return null;
}

function parseWebp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 4);
  let width = 0;
  let height = 0;
  if (chunk === 'VP8 ') {
    // 有損：frame tag(3) + 起始碼 9D 01 2A + 寬/高（14 bits，高 2 bits 為縮放）
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    width = u16le(b, 26) & 0x3fff;
    height = u16le(b, 28) & 0x3fff;
  } else if (chunk === 'VP8L') {
    // 無損：簽章 0x2F + 14 bits (寬−1) + 14 bits (高−1)
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (chunk === 'VP8X') {
    // 延伸格式：flags(1) + reserved(3) + 畫布寬−1（24 bits）+ 畫布高−1（24 bits）
    width = u24le(b, 24) + 1;
    height = u24le(b, 27) + 1;
  } else {
    return null;
  }
  return width > 0 && height > 0 ? { format: 'webp', width, height } : null;
}

export function readImageHeader(bytes: Uint8Array): ImageInfo | null {
  return parsePng(bytes) ?? parseJpeg(bytes) ?? parseWebp(bytes);
}
