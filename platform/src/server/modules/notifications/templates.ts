import type { NotificationType } from './notifications';

/**
 * 通知模板。每個事件產生：title / body（站內、推播、LINE、Email）與 sms（簡訊，盡量 ≤ 70 字）。
 * 文案為暫定，可由營運調整；所有變數由呼叫端提供（不在模板內查資料庫）。
 */
export interface Rendered {
  title: string;
  body: string;
  sms: string;
  /** 前台深連結（相對路徑） */
  url: string;
}

type Data = Record<string, unknown>;
const s = (v: unknown, d = ''): string => (v === undefined || v === null ? d : String(v));
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

const T: Record<NotificationType, (d: Data) => Rendered> = {
  DRAW_RESULT: (d) => ({
    title: '抽賞結果',
    body: `${s(d.poolTitle, '賞池')} 第 ${s(d.setNo)} 套 ${n(d.count)} 抽：${s(d.summary)}`,
    sms: `【CHIAKI】${s(d.poolTitle, '賞池')} ${n(d.count)} 抽結果：${s(d.summary)}`,
    url: `/me/draws/${s(d.drawId)}`,
  }),
  STORAGE_EXPIRY_7D: (d) => ({
    title: `獎品寄存將於 ${n(d.warnDays)} 天內到期`,
    body: `${n(d.count)} 件獎品寄存將於 ${s(d.day)} 起陸續到期，請於期限前申請出貨或回收；到期未處理的可回收獎品將依回收值自動轉為CC幣。`,
    sms: `【CHIAKI】您有 ${n(d.count)} 件獎品寄存將於 ${s(d.day)} 起到期，請儘速申請出貨。`,
    url: '/me/warehouse',
  }),
  STORAGE_EXPIRY_TODAY: (d) => ({
    title: '獎品寄存今日到期',
    body: `${n(d.count)} 件獎品寄存今日（${s(d.day)}）到期，到期未出貨的可回收獎品將依回收值自動轉為CC幣。`,
    sms: `【CHIAKI】您有 ${n(d.count)} 件獎品寄存今日到期，請儘速申請出貨。`,
    url: '/me/warehouse',
  }),
  STORAGE_AUTO_CONVERTED: (d) => ({
    title: '寄存到期，獎品已自動轉為CC幣',
    body: `${n(d.count)} 件獎品寄存已到期，已依各獎項回收值轉為 ${n(d.totalCoins)} CC幣（此CC幣不可退款・無法轉換，如有疑問請聯絡官方小編）。`,
    sms: `【CHIAKI】${n(d.count)} 件到期獎品已轉為 ${n(d.totalCoins)} CC幣（不可退款）。`,
    url: '/me/wallet',
  }),
  STORAGE_EXPIRED_HOLD: (d) => ({
    title: '寄存已到期（不可回收獎品）',
    body: `${n(d.count)} 件獎品寄存已到期且不可回收，請儘速申請出貨，客服將與您聯繫。`,
    sms: `【CHIAKI】您有 ${n(d.count)} 件不可回收獎品寄存已到期，請儘速申請出貨。`,
    url: '/me/warehouse',
  }),
  SHIPMENT_SHIPPED: (d) => ({
    title: '您的包裹已出貨',
    body: `包裹已由 ${s(d.carrierLabel)} 寄出，追蹤編號 ${s(d.trackingNo)}。${d.trackingUrl ? `查詢：${s(d.trackingUrl)}` : ''}`,
    sms: `【CHIAKI】包裹已由${s(d.carrierLabel)}寄出，單號 ${s(d.trackingNo)}`,
    url: `/me/shipments/${s(d.shipmentId)}`,
  }),
  SHIPMENT_UPDATED: (d) => ({
    title: '出貨單狀態更新',
    body: `您的出貨單狀態：${s(d.statusLabel)}。${d.reason ? `說明：${s(d.reason)}` : ''}${d.trackingNo ? `追蹤編號 ${s(d.trackingNo)}${d.carrierLabel ? `（${s(d.carrierLabel)}）` : ''}` : ''}`,
    sms: `【CHIAKI】出貨單狀態：${s(d.statusLabel)}`,
    url: `/me/shipments/${s(d.shipmentId)}`,
  }),
  FORUM_MODERATED: (d) => ({
    title: '討論區審核結果',
    body: `您的${s(d.targetLabel, '貼文')}「${s(d.title)}」${s(d.resultLabel)}。${d.reason ? `原因：${s(d.reason)}` : ''}`,
    sms: `【CHIAKI】討論區審核結果：${s(d.resultLabel)}`,
    url: `/forum/${s(d.postId)}`,
  }),
  REFUND_STATUS: (d) => ({
    title: '退款申請狀態更新',
    body: `您的${s(d.kindLabel, '退款')}申請（${s(d.amountLabel)}）狀態：${s(d.statusLabel)}。${d.note ? `備註：${s(d.note)}` : ''}`,
    sms: `【CHIAKI】您的${s(d.kindLabel, '退款')}申請狀態：${s(d.statusLabel)}`,
    url: '/me/refunds',
  }),
  TICKET_REPLY: (d) => ({
    title: '客服已回覆您的問題',
    body: `工單 #${s(d.ticketNo)}「${s(d.subject)}」有新的客服回覆。`,
    sms: `【CHIAKI】客服已回覆您的工單 #${s(d.ticketNo)}`,
    url: `/me/support/${s(d.ticketId)}`,
  }),
  REFERRAL_REWARD: (d) => ({
    title: '邀請獎勵已入帳',
    body: `恭喜！您邀請的 ${n(d.count)} 位好友皆已完成註冊與手機驗證，${n(d.coins)} CC幣已入帳（不可退款・無法轉換，如有疑問請聯絡官方小編）。`,
    sms: `【CHIAKI】邀請獎勵 ${n(d.coins)} CC幣已入帳。`,
    url: '/me/referral',
  }),
};

export function renderTemplate(type: NotificationType, data: Data): Rendered {
  return T[type](data);
}
