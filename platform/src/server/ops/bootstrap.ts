import { z } from 'zod';
import { AppError } from '../errors';
import { transaction } from '../db';
import { appendAudit } from '../modules/audit/audit';
import { createUser } from '../modules/auth/users';
import { setAdminCredentials } from '../modules/auth/admin-auth';

/**
 * 正式環境初始化：建立第一個超級管理員（scripts/create-admin.ts）。
 * 不建立任何示範會員、示範 UC幣或示範員工（那些只在開發種子 scripts/seed.ts）。
 * 建立後請立即登入後台並綁定 TOTP 兩步驟驗證（POST /api/admin/auth/mfa/enroll → verify），再設定 ADMIN_MFA_REQUIRED=true。
 */
export const SuperAdminSchema = z.object({
  loginId: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,64}$/, '登入帳號限 3–64 字：英數、點、底線、連字號'),
  password: z.string().min(12, '超級管理員密碼至少 12 碼').max(200),
  displayName: z.string().trim().min(1).max(50).default('超級管理員'),
  /** 選用：員工手機（之後可用於通知）；與會員手機不可重複 */
  phone: z.string().regex(/^09\d{8}$/, '手機格式 09xxxxxxxx').nullable().default(null),
});

export async function createSuperAdmin(input: z.input<typeof SuperAdminSchema>): Promise<{ userId: string; loginId: string }> {
  const v = SuperAdminSchema.parse(input);
  return transaction(async (tx) => {
    const [taken] = await tx`SELECT 1 FROM admin_credentials WHERE login_id = ${v.loginId}`;
    if (taken) throw new AppError('CONFLICT', `登入帳號 ${v.loginId} 已存在`);
    if (v.phone) {
      const [p] = await tx`SELECT 1 FROM users WHERE phone = ${v.phone}`;
      if (p) throw new AppError('CONFLICT', '此手機號碼已被使用');
    }
    const u = await createUser(tx, { phone: v.phone, displayName: v.displayName, roles: ['SUPER_ADMIN'] });
    await setAdminCredentials(tx, { userId: u.id, loginId: v.loginId, password: v.password });
    await appendAudit(tx, {
      actorType: 'SYSTEM',
      actorId: 'create-admin',
      action: 'ADMIN_ACCOUNT_CREATED',
      entityType: 'user',
      entityId: u.id,
      payload: { loginId: v.loginId, roles: ['SUPER_ADMIN'], via: 'scripts/create-admin.ts' },
    });
    return { userId: u.id, loginId: v.loginId };
  });
}
