/**
 * 開發用種子資料（冪等）：參考資料、員工/示範會員、直購商品、範例賞池（經正式「雙人覆核」流程發布）。
 * 登入：開發替身 OTP（AUTH_DEV_STUB=1）固定碼 000000。
 */
import { db, closeDb } from '../src/server/db';
import { createUser } from '../src/server/modules/auth/users';
import { setAdminCredentials } from '../src/server/modules/auth/admin-auth';
import type { Principal, Role } from '../src/server/modules/auth/rbac';
import { createPoolDraft } from '../src/server/modules/pool/admin';
import { approve, requestBalanceAdjust, requestPoolPublish } from '../src/server/modules/admin/approvals';
import { RETIRED_SEED_POOL_SLUGS, SEED_POOLS, seedHomeBanners, seedReferenceData } from '../src/server/seed/reference';
import type { PoolDraftInput } from '../src/server/modules/pool/admin';
import { deletePool, setPoolOffline } from '../src/server/modules/pool/manage';

const sql = db();
await seedReferenceData(sql);

/**
 * 後台帳號密碼：只從環境變數 ADMIN_INITIAL_PASSWORD 讀取（絕不寫在程式碼或版控中），資料庫只存 scrypt 雜湊。
 * ADMIN_PASSWORD_HINT（選用）會顯示在後台登入頁 —— 提示會降低安全性，請斟酌使用。
 * 未設定 ADMIN_INITIAL_PASSWORD 時不建立/不變更任何後台密碼（後台 API 需要密碼登入的 session）。
 */
const initialPassword = process.env.ADMIN_INITIAL_PASSWORD ?? '';
const passwordHint = process.env.ADMIN_PASSWORD_HINT || null;
const credentialsSet: string[] = [];

async function staff(phone: string, name: string, roles: Role[], loginId?: string): Promise<Principal> {
  const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE phone = ${phone}`;
  const id = u?.id ?? (await createUser(sql, { phone, displayName: name, roles })).id;
  if (loginId && initialPassword) {
    const [has] = await sql`SELECT 1 FROM admin_credentials WHERE user_id = ${id}`;
    if (!has) {
      await setAdminCredentials(sql, { userId: id, loginId, password: initialPassword, hint: passwordHint });
      credentialsSet.push(loginId);
    }
  }
  return { userId: id, roles, ageVerified: true };
}

const admin = await staff('0900000001', '超級管理員', ['SUPER_ADMIN'], 'admin');
const ops = await staff('0900000002', '營運', ['OPS'], 'ops');
const fin1 = await staff('0900000003', '財務 A', ['FINANCE'], 'finance-a');
const fin2 = await staff('0900000004', '財務 B', ['FINANCE'], 'finance-b');
await staff('0900000005', '客服', ['CS'], 'support');
const member = await staff('0900000010', '示範會員', ['MEMBER']);
await sql`UPDATE users SET age_verified_at = COALESCE(age_verified_at, now()), birth_date = COALESCE(birth_date, '1995-01-01') WHERE id = ${member.userId}`;

const [{ coins }] = (await sql<{ coins: number }[]>`SELECT coins FROM wallets WHERE user_id = ${member.userId}`) as unknown as [{ coins: number }];
if (coins === 0) {
  const { approvalId } = await requestBalanceAdjust(fin1, { userId: member.userId, amount: 5000, memo: '開發示範：初始 UC幣' });
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
/** 舊的佔位/範例賞池：無銷售 → 軟刪除；已有銷售 → 下架（既有紀錄不受影響） */
async function retirePool(slug: string) {
  const [p] = await sql<{ id: string; offline: boolean; deletedAt: Date | null; sales: number }[]>`
    SELECT p.id, p.offline, p.deleted_at, (SELECT count(*)::int FROM draws d WHERE d.pool_id = p.id) AS sales FROM pools p WHERE p.slug = ${slug}`;
  if (!p || p.deletedAt) return `${slug}: absent`;
  const reason = '種子資料更新：移除舊的範例賞池';
  if (p.sales === 0) {
    await deletePool(admin, p.id, { reason });
    return `${slug}: deleted`;
  }
  if (!p.offline) await setPoolOffline(admin, p.id, { offline: true, reason });
  return `${slug}: offline (has sales)`;
}
for (const slug of RETIRED_SEED_POOL_SLUGS) console.log(await retirePool(slug));
for (const draft of SEED_POOLS) console.log(await ensurePool(draft));
for (const line of await seedHomeBanners(sql)) console.log(`banner ${line}`);

console.log(`
Seed complete.
  會員登入（AUTH_DEV_STUB=1）：POST /api/auth/otp/verify {"phone": "0900000010", "code": "000000"}（示範會員，已年齡驗證，5000 UC幣）
  後台登入：POST /api/auth/admin/login {"loginId": "admin|ops|finance-a|finance-b|support", "password": "<ADMIN_INITIAL_PASSWORD>"}
  ${initialPassword ? `已設定後台密碼（scrypt 雜湊）：${credentialsSet.join(', ') || '（皆已存在，未變更）'}` : '⚠ 未設定 ADMIN_INITIAL_PASSWORD：未建立後台密碼，後台 API 將無法登入'}`);
await closeDb();
