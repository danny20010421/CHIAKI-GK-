/**
 * 開發用種子資料（冪等）：參考資料、員工/示範會員、直購商品、範例賞池（經正式「雙人覆核」流程發布）。
 * 登入：開發替身 OTP（AUTH_DEV_STUB=1）固定碼 000000。
 */
import { db, closeDb } from '../src/server/db';
import { createUser } from '../src/server/modules/auth/users';
import type { Principal, Role } from '../src/server/modules/auth/rbac';
import { createPoolDraft } from '../src/server/modules/pool/admin';
import { approve, requestBalanceAdjust, requestPoolPublish } from '../src/server/modules/admin/approvals';
import { GK_FIRST_POOL, GUARANTEE_SAMPLE_POOL, seedReferenceData } from '../src/server/seed/reference';
import type { PoolDraftInput } from '../src/server/modules/pool/admin';

const sql = db();
await seedReferenceData(sql);

async function staff(phone: string, name: string, roles: Role[]): Promise<Principal> {
  const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE phone = ${phone}`;
  const id = u?.id ?? (await createUser(sql, { phone, displayName: name, roles })).id;
  return { userId: id, roles, ageVerified: true };
}

const admin = await staff('0900000001', '超級管理員', ['SUPER_ADMIN']);
const ops = await staff('0900000002', '營運', ['OPS']);
const fin1 = await staff('0900000003', '財務 A', ['FINANCE']);
const fin2 = await staff('0900000004', '財務 B', ['FINANCE']);
await staff('0900000005', '客服', ['CS']);
const member = await staff('0900000010', '示範會員', ['MEMBER']);
await sql`UPDATE users SET age_verified_at = COALESCE(age_verified_at, now()), birth_date = COALESCE(birth_date, '1995-01-01') WHERE id = ${member.userId}`;

const [{ coins }] = (await sql<{ coins: number }[]>`SELECT coins FROM wallets WHERE user_id = ${member.userId}`) as unknown as [{ coins: number }];
if (coins === 0) {
  const { approvalId } = await requestBalanceAdjust(fin1, { userId: member.userId, currency: 'COINS', amount: 5000, memo: '開發示範：初始代幣' });
  await approve(fin2, approvalId);
}

const products = [
  { sku: 'CHK-BOX-BLACKGOLD', name: 'CHIAKI 黑金 收藏展示盒', ip: 'CHIAKI ORIGINAL', price: 1280, stock: 12 },
  { sku: 'ACC-DUSTCASE-M', name: '模型專用 防塵壓克力盒 M', ip: '周邊配件', price: 390, stock: 60 },
  { sku: 'CHK-TOTE', name: 'CHIAKI 品牌 帆布托特包', ip: 'CHIAKI ORIGINAL', price: 880, stock: 15 },
];
for (const p of products) {
  await sql`INSERT INTO products (sku, name, ip, source, price_coins, stock) VALUES (${p.sku}, ${p.name}, ${p.ip}, 'CUSTOM', ${p.price}, ${p.stock})
            ON CONFLICT (sku) DO NOTHING`;
}

async function ensurePool(draft: PoolDraftInput) {
  const [existing] = await sql<{ id: string; status: string }[]>`SELECT id, status FROM pools WHERE slug = ${draft.slug}`;
  if (existing) return `${draft.slug}: already ${existing.status}`;
  const { poolId } = await createPoolDraft(ops, draft);
  const { approvalId } = await requestPoolPublish(ops, poolId);
  await approve(admin, approvalId); // 第二人核准 → 洗牌、承諾雜湊、規則版本
  return `${draft.slug}: published (${poolId})`;
}
console.log(await ensurePool(GK_FIRST_POOL));
console.log(await ensurePool(GUARANTEE_SAMPLE_POOL));

console.log(`
Seed complete. Dev login (AUTH_DEV_STUB=1): POST /api/auth/otp/verify {"phone": "<below>", "code": "000000"}
  0900000001 SUPER_ADMIN | 0900000002 OPS | 0900000003 FINANCE A | 0900000004 FINANCE B | 0900000005 CS
  0900000010 示範會員（已年齡驗證，5000 代幣）`);
await closeDb();
