import { AppError } from '../../errors';
import { config } from '../../config';
import { db } from '../../db';
import { createNotification, type NotificationType } from './notifications';

/**
 * 通知管道轉接器（adapter）。站內通知已實作；簡訊（三竹 Mitake）、LINE Messaging API、Web Push（VAPID）、Email 為替身：
 *  - 已建好「要送出的 HTTP 請求」（build*Request，純函式、有測試），正式串接只需補上 fetch 與回應解析並以實際帳號驗證。
 *  - NOTIFY_STUB_SEND=1（僅開發/測試）時假裝送出成功；否則丟出 NOT_IMPLEMENTED → 進入重試 → 最終 FAILED。
 */
export const CHANNELS = ['IN_APP', 'SMS', 'LINE', 'WEB_PUSH', 'EMAIL'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface OutboundMessage {
  id: string;
  userId: string;
  merchantId: string;
  eventType: NotificationType;
  channel: Channel;
  destination: string | null;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface ChannelAdapter {
  readonly channel: Channel;
  send(m: OutboundMessage): Promise<{ providerRef: string }>;
}

export interface HttpRequestSpec {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** 三竹簡訊 SmSend（HTTP POST, x-www-form-urlencoded）。clientid 作為供應商端冪等鍵。 */
export function buildMitakeRequest(m: OutboundMessage, c = config()): HttpRequestSpec {
  if (!m.destination) throw new AppError('VALIDATION', 'SMS destination missing');
  const params = new URLSearchParams({
    username: c.MITAKE_USERNAME,
    password: c.MITAKE_PASSWORD,
    dstaddr: m.destination,
    smbody: m.body,
    clientid: m.idempotencyKey.slice(-36),
    CharsetURL: 'UTF8',
  });
  return { url: `${c.MITAKE_API_URL}?CharsetURL=UTF8`, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString() };
}

/** LINE Messaging API push message。X-Line-Retry-Key 作為供應商端冪等鍵（需 UUID 格式）。 */
export function buildLinePushRequest(m: OutboundMessage, c = config()): HttpRequestSpec {
  if (!m.destination) throw new AppError('VALIDATION', 'LINE destination missing');
  return {
    url: 'https://api.line.me/v2/bot/message/push',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.LINE_CHANNEL_ACCESS_TOKEN}`, 'x-line-retry-key': m.id },
    body: JSON.stringify({ to: m.destination, messages: [{ type: 'text', text: `${m.title}\n${m.body}`.slice(0, 5000) }] }),
  };
}

/** Web Push 的通知內容（實際送出需 VAPID JWT 簽章與 aes128gcm 加密，尚未實作）。 */
export function buildWebPushPayload(m: OutboundMessage): string {
  return JSON.stringify({ title: m.title, body: m.body, url: (m.payload.url as string | undefined) ?? '/', tag: m.eventType });
}

function stubOr(channel: Channel, configured: boolean): Promise<{ providerRef: string }> {
  if (config().NOTIFY_STUB_SEND) return Promise.resolve({ providerRef: `stub-${channel.toLowerCase()}` });
  return Promise.reject(new AppError('NOT_IMPLEMENTED', configured ? `${channel} sender not yet integrated` : `${channel} provider not configured`));
}

class InAppAdapter implements ChannelAdapter {
  readonly channel = 'IN_APP' as const;
  async send(m: OutboundMessage) {
    await createNotification(db(), { userId: m.userId, merchantId: m.merchantId, type: m.eventType, title: m.title, body: m.body, payload: m.payload, dedupeKey: m.idempotencyKey.replace(/:IN_APP$/, '') });
    return { providerRef: 'in-app' };
  }
}

class MitakeSmsAdapter implements ChannelAdapter {
  readonly channel = 'SMS' as const;
  async send(m: OutboundMessage) {
    buildMitakeRequest(m); // 驗證可組出請求
    return stubOr('SMS', Boolean(config().MITAKE_USERNAME && config().MITAKE_PASSWORD));
  }
}

class LinePushAdapter implements ChannelAdapter {
  readonly channel = 'LINE' as const;
  async send(m: OutboundMessage) {
    buildLinePushRequest(m);
    return stubOr('LINE', Boolean(config().LINE_CHANNEL_ACCESS_TOKEN));
  }
}

class WebPushAdapter implements ChannelAdapter {
  readonly channel = 'WEB_PUSH' as const;
  async send(m: OutboundMessage) {
    buildWebPushPayload(m);
    return stubOr('WEB_PUSH', Boolean(config().VAPID_PUBLIC_KEY && config().VAPID_PRIVATE_KEY));
  }
}

class EmailAdapter implements ChannelAdapter {
  readonly channel = 'EMAIL' as const;
  async send() {
    return stubOr('EMAIL', false);
  }
}

const defaults: Record<Channel, ChannelAdapter> = {
  IN_APP: new InAppAdapter(),
  SMS: new MitakeSmsAdapter(),
  LINE: new LinePushAdapter(),
  WEB_PUSH: new WebPushAdapter(),
  EMAIL: new EmailAdapter(),
};
const overrides = new Map<Channel, ChannelAdapter>();

export function channelAdapter(c: Channel): ChannelAdapter {
  return overrides.get(c) ?? defaults[c];
}

/** 替換管道實作（正式串接或測試注入）；null 還原預設 */
export function setChannelAdapter(c: Channel, a: ChannelAdapter | null): void {
  if (a) overrides.set(c, a);
  else overrides.delete(c);
}
