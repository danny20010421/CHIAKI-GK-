import { z } from 'zod';
import { AppError } from '../../errors';
import { config } from '../../config';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { otpProvider } from '../auth/providers';
import { MemberImageSchema, storeMemberImage } from '../assets/assets';
import { rateLimitStore } from '../../security/rate-limit';
import { assertNotLocked, clearLoginFailures, recordLoginFailure } from '../../security/lockout';

/**
 * 會員資料（業主 2026-10 第六批）：
 *  - 暱稱 2–16 字（以字元計，emoji 算 1）、真實姓名、Email、頭像（素材驗證器：必須 400×400 正方形；重新封裝去除 EXIF/GPS 等中繼資料）。
 *  - 生日：完成年齡驗證後鎖定，不可再改。
 *  - 換手機：OTP 送到「新號碼」，確認後才更換（限流＋錯誤次數鎖定）。
 *  - 常用收件資訊：宅配 / 7-11 / 全家，一筆預設；申請出貨可直接引用。
 */
export const PhoneSchema = z.string().regex(/^09\d{8}$/, '請填寫台灣手機號碼 09xxxxxxxx');
const NicknameSchema = z
  .string()
  .trim()
  .refine((s) => Array.from(s).length >= 2 && Array.from(s).length <= 16, '暱稱須為 2–16 個字')
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), '暱稱含有不允許的字元');

export const ProfileSchema = z
  .object({
    nickname: NicknameSchema.optional(),
    realName: z.string().trim().min(1).max(50).nullable().optional(),
    email: z.string().trim().toLowerCase().email('Email 格式不正確').max(254).nullable().optional(),
    birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '生日格式為 YYYY-MM-DD').nullable().optional(),
    /** 頭像：base64 圖片（400×400）；null = 移除 */
    avatar: MemberImageSchema.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to update');

const mask = (p: string | null) => (p ? `${p.slice(0, 4)}***${p.slice(-3)}` : null);

export async function getProfile(d: Db, userId: string) {
  const [u] = await d<{ phone: string | null; nickname: string | null; realName: string | null; email: string | null; birthDate: string | null; ageVerifiedAt: Date | null; avatarAssetId: string | null; phoneVerifiedAt: Date | null }[]>`
    SELECT phone, nickname, real_name, email, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, age_verified_at, avatar_asset_id, phone_verified_at FROM users WHERE id = ${userId}`;
  if (!u) throw new AppError('NOT_FOUND', 'user not found');
  const [pending] = await d<{ newPhone: string; expiresAt: Date }[]>`SELECT new_phone, expires_at FROM phone_change_requests WHERE user_id = ${userId} AND expires_at > now()`;
  return {
    phone: u.phone,
    phoneVerified: u.phoneVerifiedAt !== null,
    nickname: u.nickname,
    realName: u.realName,
    email: u.email,
    birthDate: u.birthDate,
    /** 完成年齡驗證後生日不可修改 */
    birthDateLocked: u.ageVerifiedAt !== null,
    avatarUrl: u.avatarAssetId ? `/api/assets/${u.avatarAssetId}` : null,
    pendingPhoneChange: pending ? { phone: mask(pending.newPhone), expiresAt: pending.expiresAt } : null,
  };
}

export async function updateProfile(userId: string, input: z.input<typeof ProfileSchema>) {
  const v = ProfileSchema.parse(input);
  await transaction(async (tx) => {
    const [u] = await tx<{ birthDate: string | null; ageVerifiedAt: Date | null; nickname: string | null }[]>`
      SELECT to_char(birth_date, 'YYYY-MM-DD') AS birth_date, age_verified_at, nickname FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!u) throw new AppError('NOT_FOUND', 'user not found');
    if (v.birthDate !== undefined && v.birthDate !== u.birthDate && u.ageVerifiedAt) {
      throw new AppError('FORBIDDEN', '已完成年齡驗證，生日不可修改；如需更正請聯絡客服');
    }
    if (v.birthDate) {
      const d = new Date(`${v.birthDate}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v.birthDate || d.getTime() > Date.now()) throw new AppError('VALIDATION', '生日不正確');
    }
    let avatarId: string | null | undefined;
    if (v.avatar === null) avatarId = null;
    else if (v.avatar) {
      const img = await storeMemberImage(tx, userId, 'avatar', v.avatar, `${v.nickname ?? u.nickname ?? '會員'} 的頭像`, (info) =>
        info.width === 400 && info.height === 400 ? null : { check: 'ratio', ok: false, message: `頭像須為 400×400 px 正方形（目前 ${info.width}×${info.height} px），請裁切縮放後再上傳` },
      );
      avatarId = img.id;
    }
    await tx`
      UPDATE users SET
        nickname = ${v.nickname === undefined ? tx`nickname` : v.nickname},
        real_name = ${v.realName === undefined ? tx`real_name` : v.realName},
        email = ${v.email === undefined ? tx`email` : v.email},
        birth_date = ${v.birthDate === undefined ? tx`birth_date` : v.birthDate},
        avatar_asset_id = ${avatarId === undefined ? tx`avatar_asset_id` : avatarId},
        profile_updated_at = now()
      WHERE id = ${userId}`;
    // 稽核只記錄「改了哪些欄位」（個資本身不寫入稽核鏈）
    const fields = (['nickname', 'realName', 'email', 'birthDate', 'avatar'] as const).filter((k) => v[k] !== undefined);
    await appendAudit(tx, { actorType: 'USER', actorId: userId, action: 'PROFILE_UPDATED', entityType: 'user', entityId: userId, payload: { fields } });
  });
  return getProfile(db(), userId);
}

// ───────────── 換手機（OTP 送到新號碼） ─────────────

const PHONE_CHANGE_TTL_MIN = 10;

export async function requestPhoneChange(userId: string, input: { phone: string }) {
  const phone = PhoneSchema.parse(input.phone);
  const cap = config().PHONE_CHANGE_OTP_PER_HOUR;
  const t = await rateLimitStore().take(`phone-change:${userId}`, cap, cap / 3600);
  if (!t.allowed) throw new AppError('RATE_LIMITED', '驗證碼發送太頻繁，請稍後再試', { retryAfterSec: t.retryAfterSec });
  const t2 = await rateLimitStore().take(`phone-change-to:${phone}`, cap, cap / 3600);
  if (!t2.allowed) throw new AppError('RATE_LIMITED', '此號碼的驗證碼發送太頻繁，請稍後再試', { retryAfterSec: t2.retryAfterSec });
  const expiresAt = await transaction(async (tx) => {
    const [u] = await tx<{ phone: string | null }[]>`SELECT phone FROM users WHERE id = ${userId}`;
    if (u?.phone === phone) throw new AppError('VALIDATION', '新號碼與目前號碼相同');
    const [taken] = await tx`SELECT 1 FROM users WHERE phone = ${phone} AND id <> ${userId}`;
    if (taken) throw new AppError('CONFLICT', '此手機號碼已被其他帳號使用');
    const [r] = await tx<{ expiresAt: Date }[]>`
      INSERT INTO phone_change_requests (user_id, new_phone, expires_at) VALUES (${userId}, ${phone}, now() + make_interval(mins => ${PHONE_CHANGE_TTL_MIN}))
      ON CONFLICT (user_id) DO UPDATE SET new_phone = EXCLUDED.new_phone, requested_at = now(), expires_at = EXCLUDED.expires_at
      RETURNING expires_at`;
    return r!.expiresAt;
  });
  await otpProvider().send(phone);
  return { sentTo: mask(phone), expiresAt };
}

export async function confirmPhoneChange(userId: string, input: { phone: string; code: string }) {
  const phone = PhoneSchema.parse(input.phone);
  const code = z.string().regex(/^\d{4,8}$/, '驗證碼格式不正確').parse(input.code);
  const lockKey = `phone-change:${userId}`;
  await assertNotLocked(lockKey);
  const [pending] = await db()<{ newPhone: string; expiresAt: Date }[]>`SELECT new_phone, expires_at FROM phone_change_requests WHERE user_id = ${userId}`;
  if (!pending || pending.newPhone !== phone || pending.expiresAt.getTime() <= Date.now()) {
    throw new AppError('INVALID_STATE', '沒有待確認的換號申請，或已逾時，請重新發送驗證碼');
  }
  if (!(await otpProvider().verify(phone, code))) {
    await recordLoginFailure(lockKey, { userId });
    throw new AppError('UNAUTHENTICATED', '驗證碼錯誤');
  }
  await clearLoginFailures(lockKey);
  await transaction(async (tx) => {
    const [u] = await tx<{ phone: string | null }[]>`SELECT phone FROM users WHERE id = ${userId} FOR UPDATE`;
    const [taken] = await tx`SELECT 1 FROM users WHERE phone = ${phone} AND id <> ${userId}`;
    if (taken) throw new AppError('CONFLICT', '此手機號碼已被其他帳號使用');
    await tx`UPDATE users SET phone = ${phone}, phone_verified_at = now() WHERE id = ${userId}`;
    await tx`DELETE FROM phone_change_requests WHERE user_id = ${userId}`;
    await appendAudit(tx, { actorType: 'USER', actorId: userId, action: 'PHONE_CHANGED', entityType: 'user', entityId: userId, payload: { from: mask(u!.phone), to: mask(phone) } });
  });
  return { phone, changed: true };
}

// ───────────── 常用收件資訊 ─────────────

export const ADDRESS_METHODS = ['home', 'c711', 'fami'] as const;
export const ADDRESS_TO_SHIPPING: Record<(typeof ADDRESS_METHODS)[number], 'HOME_DELIVERY' | 'CVS_711_C2C' | 'CVS_FAMI_C2C'> = {
  home: 'HOME_DELIVERY',
  c711: 'CVS_711_C2C',
  fami: 'CVS_FAMI_C2C',
};
const MAX_ADDRESSES = 10;

const AddressFields = {
  method: z.enum(ADDRESS_METHODS),
  recipientName: z.string().trim().min(1).max(50),
  recipientPhone: PhoneSchema,
  address: z.string().trim().min(5).max(200).nullable().optional(),
  cvsStoreId: z.string().trim().min(3).max(20).nullable().optional(),
  cvsStoreName: z.string().trim().max(50).nullable().optional(),
  isDefault: z.boolean().optional(),
};
const checkAddress = (v: { method?: string; address?: string | null; cvsStoreId?: string | null }, ctx: z.RefinementCtx) => {
  if (v.method === 'home' && !v.address) ctx.addIssue({ code: 'custom', path: ['address'], message: '宅配需填寫地址' });
  if (v.method && v.method !== 'home' && !v.cvsStoreId) ctx.addIssue({ code: 'custom', path: ['cvsStoreId'], message: '超商取貨需填寫門市代號' });
};
export const AddressSchema = z.object(AddressFields).superRefine(checkAddress);
export const AddressUpdateSchema = z
  .object({ ...AddressFields, method: AddressFields.method.optional(), recipientName: AddressFields.recipientName.optional(), recipientPhone: PhoneSchema.optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to update');

export interface AddressRow {
  id: string;
  method: (typeof ADDRESS_METHODS)[number];
  recipientName: string;
  recipientPhone: string;
  address: string | null;
  cvsStoreId: string | null;
  cvsStoreName: string | null;
  isDefault: boolean;
  createdAt: Date;
}
const ADDR_COLS = (d: Db | Tx) => d`id, method, recipient_name, recipient_phone, address, cvs_store_id, cvs_store_name, is_default, created_at`;

export async function listAddresses(d: Db, userId: string): Promise<AddressRow[]> {
  return d<AddressRow[]>`SELECT ${ADDR_COLS(d)} FROM member_addresses WHERE user_id = ${userId} ORDER BY is_default DESC, created_at`;
}

export async function getOwnAddress(d: Db | Tx, userId: string, id: string): Promise<AddressRow> {
  const [a] = await d<AddressRow[]>`SELECT ${ADDR_COLS(d)} FROM member_addresses WHERE id = ${id} AND user_id = ${userId}`;
  if (!a) throw new AppError('NOT_FOUND', '找不到這筆收件資訊');
  return a;
}

const normalize = (m: string, v: { address?: string | null; cvsStoreId?: string | null; cvsStoreName?: string | null }) =>
  m === 'home' ? { address: v.address ?? null, cvsStoreId: null, cvsStoreName: null } : { address: null, cvsStoreId: v.cvsStoreId ?? null, cvsStoreName: v.cvsStoreName ?? null };

export async function createAddress(userId: string, input: z.input<typeof AddressSchema>): Promise<AddressRow> {
  const v = AddressSchema.parse(input);
  return transaction(async (tx) => {
    await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`; // 同一會員的收件資訊變更序列化（預設唯一）
    const [cnt] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM member_addresses WHERE user_id = ${userId}`;
    if (cnt!.n >= MAX_ADDRESSES) throw new AppError('VALIDATION', `最多 ${MAX_ADDRESSES} 筆收件資訊`);
    const isDefault = v.isDefault ?? cnt!.n === 0;
    if (isDefault) await tx`UPDATE member_addresses SET is_default = false WHERE user_id = ${userId} AND is_default`;
    const n = normalize(v.method, v);
    const [a] = await tx<AddressRow[]>`
      INSERT INTO member_addresses (user_id, method, recipient_name, recipient_phone, address, cvs_store_id, cvs_store_name, is_default)
      VALUES (${userId}, ${v.method}, ${v.recipientName}, ${v.recipientPhone}, ${n.address}, ${n.cvsStoreId}, ${n.cvsStoreName}, ${isDefault})
      RETURNING ${ADDR_COLS(tx)}`;
    return a!;
  });
}

export async function updateAddress(userId: string, id: string, input: z.input<typeof AddressUpdateSchema>): Promise<AddressRow> {
  const v = AddressUpdateSchema.parse(input);
  return transaction(async (tx) => {
    await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const cur = await getOwnAddress(tx, userId, id);
    const merged = {
      method: v.method ?? cur.method,
      recipientName: v.recipientName ?? cur.recipientName,
      recipientPhone: v.recipientPhone ?? cur.recipientPhone,
      address: v.address === undefined ? cur.address : v.address,
      cvsStoreId: v.cvsStoreId === undefined ? cur.cvsStoreId : v.cvsStoreId,
      cvsStoreName: v.cvsStoreName === undefined ? cur.cvsStoreName : v.cvsStoreName,
    };
    AddressSchema.parse(merged);
    if (v.isDefault === true) await tx`UPDATE member_addresses SET is_default = false WHERE user_id = ${userId} AND is_default AND id <> ${id}`;
    if (v.isDefault === false && cur.isDefault) throw new AppError('VALIDATION', '請改將其他收件資訊設為預設');
    const n = normalize(merged.method, merged);
    const [a] = await tx<AddressRow[]>`
      UPDATE member_addresses SET method = ${merged.method}, recipient_name = ${merged.recipientName}, recipient_phone = ${merged.recipientPhone},
             address = ${n.address}, cvs_store_id = ${n.cvsStoreId}, cvs_store_name = ${n.cvsStoreName},
             is_default = ${v.isDefault ?? cur.isDefault}, updated_at = now()
      WHERE id = ${id} RETURNING ${ADDR_COLS(tx)}`;
    return a!;
  });
}

export async function deleteAddress(userId: string, id: string): Promise<{ deleted: true; newDefaultId: string | null }> {
  return transaction(async (tx) => {
    await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const cur = await getOwnAddress(tx, userId, id);
    await tx`DELETE FROM member_addresses WHERE id = ${id}`;
    let newDefaultId: string | null = null;
    if (cur.isDefault) {
      const [next] = await tx<{ id: string }[]>`
        UPDATE member_addresses SET is_default = true, updated_at = now()
        WHERE id = (SELECT id FROM member_addresses WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1) RETURNING id`;
      newDefaultId = next?.id ?? null;
    }
    return { deleted: true as const, newDefaultId };
  });
}
