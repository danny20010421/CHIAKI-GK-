import { config } from '../config';

/**
 * 媒體網址（圖片、影片）：
 *  - https:// 開頭的完整網址 → 原樣回傳。
 *  - /api/... （資料庫內的上傳素材，例如 /api/assets/:id）→ 一律由本站 API 提供，不加前綴。
 *  - 其他站內路徑（例如 /media/video/gacha1.mp4、/media/banners/x.jpg）→ 設定 MEDIA_BASE_URL（CDN／物件儲存）時加上前綴，
 *    否則維持站內路徑（由同一網站提供）。
 * 資料庫只存「路徑」，換 CDN 時改環境變數即可，不需改資料。
 */
export function mediaUrl(path: string | null | undefined, base: string = config().MEDIA_BASE_URL): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (!path.startsWith('/') || path.startsWith('/api/') || !base) return path;
  return `${base.replace(/\/+$/, '')}${path}`;
}
