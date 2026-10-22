import { AppError } from '../../errors';

export const ROLES = ['SUPER_ADMIN', 'OPS', 'FINANCE', 'CS', 'MERCHANT', 'MEMBER'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'pool.draft.create',
  'pool.publish.request',
  'pool.publish.approve',
  'refund.decide',
  'refund.approve',
  'wallet.adjust.request',
  'wallet.adjust.approve',
  'payment.bank.confirm.request',
  'payment.bank.confirm.approve',
  'approval.list',
  'shipment.manage',
  'audit.read',
  'wallet.reconcile',
  'risk.read',
  'member.read',
  'pool.config.manage', // 發布後營運設定：每套運費、每套獎項回收值、出貨時程說明
  'jobs.run', // 手動觸發排程工作（寄存到期掃描、抽賞紀錄封存、通知派送）
  'shipping_refund.decide', // 運費新台幣退款：核准/駁回
  'shipping_refund.payout', // 運費新台幣退款：撥款（須與核准者不同人）
  'cs.ticket.manage', // 客服工單：檢視、回覆、指派、狀態
  'cs.compensation.grant', // 客服補償點數（超過門檻需第二人核准）
  'cs.compensation.approve',
  'storage.extend', // 延長寄存期限
  'shipment.resend', // 退件/異常重新出貨
  'security.manage', // 封鎖清單（IP/裝置）
  'catalog.ip.manage', // IP（作品）與分類管理
  'asset.manage', // 圖片素材上傳與連結
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** 角色 → 權限。MERCHANT 為 P4 多商家預留，目前無任何權限。 */
const MATRIX: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  OPS: [
    'pool.draft.create',
    'pool.publish.request',
    'pool.publish.approve',
    'shipment.manage',
    'shipment.resend',
    'approval.list',
    'member.read',
    'risk.read',
    'pool.config.manage',
    'jobs.run',
    'cs.ticket.manage',
    'storage.extend',
    'security.manage',
    'catalog.ip.manage',
    'asset.manage',
  ],
  FINANCE: [
    'refund.decide',
    'refund.approve',
    'wallet.adjust.request',
    'wallet.adjust.approve',
    'payment.bank.confirm.request',
    'payment.bank.confirm.approve',
    'approval.list',
    'audit.read',
    'wallet.reconcile',
    'shipping_refund.decide',
    'shipping_refund.payout',
    'cs.compensation.approve',
  ],
  CS: ['member.read', 'refund.decide', 'risk.read', 'cs.ticket.manage', 'cs.compensation.grant', 'storage.extend', 'shipment.resend', 'approval.list'],
  MERCHANT: [],
  MEMBER: [],
};

export type AuthMethod = 'OTP' | 'PASSWORD' | 'LINE';

/** 目前請求所使用的 session（由 http 層的 authenticate 填入；直接呼叫 domain 函式時可省略） */
export interface SessionInfo {
  tokenHash: string;
  authMethod: AuthMethod;
  reauthAt: Date | null;
  mfaVerifiedAt: Date | null;
  /** 憑證來源：Authorization Bearer 或 HttpOnly cookie（cookie 需 CSRF 檢查） */
  via: 'BEARER' | 'COOKIE';
}

export interface Principal {
  userId: string;
  roles: Role[];
  ageVerified: boolean;
  session?: SessionInfo;
}

export function hasPermission(roles: readonly Role[], perm: Permission): boolean {
  return roles.some((r) => MATRIX[r]?.includes(perm));
}

export function requirePermission(p: Principal, perm: Permission): void {
  if (!hasPermission(p.roles, perm)) throw new AppError('FORBIDDEN', `missing permission ${perm}`);
}

export function isStaff(p: Principal): boolean {
  return p.roles.some((r) => r !== 'MEMBER');
}
