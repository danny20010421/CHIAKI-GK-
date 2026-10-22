import type { ImageFormat, ImageInfo } from './image-header';

/**
 * 圖片素材規格（業主提供）。鍵：建議尺寸、最小尺寸、格式、檔案上限 KB、比例 ±2%（高度不限者不檢查比例）。
 * 前台檢查器與後台上傳皆以此表為準（GET /api/assets/specs）；伺服器端一律重新驗證，不信任前台。
 */
export const ASSET_TYPES = ['cover', 'prize', 'banner', 'bannerM', 'event', 'eventBody', 'ticket', 'ip', 'product', 'partner', 'og'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export interface AssetSpec {
  type: AssetType;
  label: string;
  suggested: { width: number; height: number | null };
  min: { width: number; height: number | null };
  /** 高度不限（eventBody）時的高度上限 */
  maxHeight: number | null;
  formats: ImageFormat[];
  maxKB: number;
  /** 比例容許誤差；null = 高度不限、不檢查比例 */
  ratioTolerance: number | null;
}

const s = (type: AssetType, label: string, w: number, h: number | null, minW: number, minH: number | null, formats: ImageFormat[], maxKB: number, maxHeight: number | null = null): AssetSpec => ({
  type,
  label,
  suggested: { width: w, height: h },
  min: { width: minW, height: minH },
  maxHeight,
  formats,
  maxKB,
  ratioTolerance: h === null ? null : 0.02,
});

export const ASSET_SPECS: Record<AssetType, AssetSpec> = {
  cover: s('cover', '賞池封面', 1600, 1600, 1080, 1080, ['jpeg', 'webp'], 600),
  prize: s('prize', '獎項圖', 1200, 1200, 800, 800, ['png', 'jpeg', 'webp'], 400),
  banner: s('banner', '首頁橫幅（桌機）', 2400, 900, 1800, 675, ['jpeg', 'webp'], 800),
  bannerM: s('bannerM', '首頁橫幅（手機）', 1200, 1500, 900, 1125, ['jpeg', 'webp'], 600),
  event: s('event', '活動頁主視覺', 1920, 640, 1440, 480, ['jpeg', 'webp'], 700),
  eventBody: s('eventBody', '活動頁內文長圖', 1080, null, 1080, null, ['jpeg', 'webp', 'png'], 1000, 3000),
  ticket: s('ticket', '籤紙圖', 3000, 2040, 1500, 1020, ['png'], 1500),
  ip: s('ip', 'IP 作品圖', 800, 800, 600, 600, ['jpeg', 'webp', 'png'], 300),
  product: s('product', '商城商品圖', 1200, 1200, 800, 800, ['jpeg', 'webp', 'png'], 400),
  partner: s('partner', '合作夥伴標誌', 400, 400, 200, 200, ['jpeg', 'webp', 'png'], 150),
  og: s('og', '社群分享縮圖（OG）', 1200, 630, 1200, 630, ['jpeg', 'png'], 300),
};

/** 安全上限：避免極大像素的「解壓縮炸彈」（規格只定最小值，此為額外防護） */
export const MAX_PIXEL_DIMENSION = 8000;
/** 最大檔案（所有類型中最大者），供上傳本文大小限制使用 */
export const MAX_ASSET_BYTES = Math.max(...Object.values(ASSET_SPECS).map((x) => x.maxKB)) * 1024;

export type CheckName = 'format' | 'size' | 'minDimensions' | 'ratio' | 'maxHeight' | 'pixelLimit';
export interface CheckResult {
  check: CheckName;
  ok: boolean;
  message: string;
}

const FMT: Record<ImageFormat, string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP' };
const fmtList = (f: ImageFormat[]) => f.map((x) => FMT[x]).join('、');
const kb = (bytes: number) => Math.round((bytes / 1024) * 10) / 10;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** 依規格逐項檢查（info 為 null = 無法辨識格式） */
export function checkAgainstSpec(spec: AssetSpec, info: ImageInfo | null, byteLength: number): CheckResult[] {
  const out: CheckResult[] = [];
  if (!info) {
    out.push({ check: 'format', ok: false, message: `無法辨識的圖片格式（只接受 PNG、JPEG、WebP；系統以檔案內容判斷，不看副檔名或 MIME）` });
  } else {
    const ok = spec.formats.includes(info.format);
    out.push({ check: 'format', ok, message: ok ? `格式 ${FMT[info.format]} 符合（允許：${fmtList(spec.formats)}）` : `格式 ${FMT[info.format]} 不符合，「${spec.label}」只接受 ${fmtList(spec.formats)}` });
  }
  const sizeOk = byteLength <= spec.maxKB * 1024;
  out.push({ check: 'size', ok: sizeOk, message: sizeOk ? `檔案大小 ${kb(byteLength)} KB，未超過上限 ${spec.maxKB} KB` : `檔案大小 ${kb(byteLength)} KB 超過上限 ${spec.maxKB} KB，請壓縮後再上傳` });
  if (!info) return out;

  const { width: w, height: h } = info;
  const minH = spec.min.height;
  const minOk = w >= spec.min.width && (minH === null || h >= minH);
  const minLabel = minH === null ? `寬至少 ${spec.min.width} px（高度不限）` : `至少 ${spec.min.width}×${minH} px`;
  const sugLabel = spec.suggested.height === null ? `寬 ${spec.suggested.width} px` : `${spec.suggested.width}×${spec.suggested.height} px`;
  out.push({ check: 'minDimensions', ok: minOk, message: minOk ? `尺寸 ${w}×${h} px 符合最小尺寸（${minLabel}；建議 ${sugLabel}）` : `尺寸 ${w}×${h} px 太小，需${minLabel}（建議 ${sugLabel}）` });

  if (spec.ratioTolerance === null) {
    out.push({ check: 'ratio', ok: true, message: '高度不限，不檢查比例' });
  } else {
    const target = spec.suggested.width / spec.suggested.height!;
    const actual = w / h;
    const diff = Math.abs(actual / target - 1);
    const ok = diff <= spec.ratioTolerance;
    const g = gcd(spec.suggested.width, spec.suggested.height!);
    const ratioLabel = `${spec.suggested.width / g}:${spec.suggested.height! / g}`;
    out.push({
      check: 'ratio',
      ok,
      message: ok
        ? `比例 ${actual.toFixed(3)} 符合 ${ratioLabel}（誤差 ${(diff * 100).toFixed(2)}%，容許 ±${spec.ratioTolerance * 100}%）`
        : `比例 ${actual.toFixed(3)} 不符合 ${ratioLabel}（${target.toFixed(3)}），誤差 ${(diff * 100).toFixed(2)}% 超過 ±${spec.ratioTolerance * 100}%，請裁切後再上傳`,
    });
  }
  if (spec.maxHeight !== null) {
    const ok = h <= spec.maxHeight;
    out.push({ check: 'maxHeight', ok, message: ok ? `高度 ${h} px，未超過上限 ${spec.maxHeight} px` : `高度 ${h} px 超過上限 ${spec.maxHeight} px，請分割成多張圖片` });
  }
  const pxOk = w <= MAX_PIXEL_DIMENSION && h <= MAX_PIXEL_DIMENSION;
  if (!pxOk) out.push({ check: 'pixelLimit', ok: false, message: `尺寸 ${w}×${h} px 超過系統上限（單邊 ${MAX_PIXEL_DIMENSION} px）` });
  return out;
}

/** 公開規格表（前台檢查器使用） */
export function publicSpecs() {
  return {
    note: '伺服器以檔案內容（檔頭）判斷格式與尺寸，不採信副檔名或 MIME；比例容許 ±2%（高度不限者除外）；1 KB = 1024 bytes。',
    specs: ASSET_TYPES.map((t) => {
      const x = ASSET_SPECS[t];
      return { ...x, formats: x.formats.map((f) => FMT[f]), ratioTolerancePercent: x.ratioTolerance === null ? null : x.ratioTolerance * 100, heightFree: x.ratioTolerance === null };
    }),
  };
}
