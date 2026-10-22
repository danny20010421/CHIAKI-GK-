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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** 角色 → 權限。MERCHANT 為 P4 多商家預留，目前無任何權限。 */
const MATRIX: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  OPS: ['pool.draft.create', 'pool.publish.request', 'pool.publish.approve', 'shipment.manage', 'approval.list', 'member.read', 'risk.read'],
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
  ],
  CS: ['member.read', 'refund.decide', 'risk.read'],
  MERCHANT: [],
  MEMBER: [],
};

export interface Principal {
  userId: string;
  roles: Role[];
  ageVerified: boolean;
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
