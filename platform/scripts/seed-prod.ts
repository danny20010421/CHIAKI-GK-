/**
 * 正式環境種子（冪等）：只寫入參考資料（物流方式、任務獎勵、VIP 等級）與首頁橫幅；不建立示範會員/員工/UC幣。
 *   npm run db:seed:prod
 *   npm run db:seed:prod -- --pool-drafts   另外把內建賞池（含「世界之王」與其三支抽卡影片）建立為「草稿」，
 *                                          由後台走正常的雙人覆核發布（需先以 admin:create 建立超級管理員）。
 */
import { closeDb, db } from '../src/server/db';
import { seedHomeBanners, seedReferenceData, SEED_POOLS } from '../src/server/seed/reference';
import { createPoolDraft } from '../src/server/modules/pool/admin';

const sql = db();
await seedReferenceData(sql);
for (const line of await seedHomeBanners(sql)) console.log(`banner ${line}`);

if (process.argv.includes('--pool-drafts')) {
  const [admin] = await sql<{ userId: string }[]>`
    SELECT r.user_id FROM user_roles r JOIN admin_credentials c ON c.user_id = r.user_id WHERE r.role = 'SUPER_ADMIN' ORDER BY c.created_at NULLS LAST LIMIT 1`;
  if (!admin) {
    console.error('找不到超級管理員；請先執行 npm run admin:create');
    process.exitCode = 1;
  } else {
    for (const draft of SEED_POOLS) {
      const [existing] = await sql<{ status: string }[]>`SELECT status FROM pools WHERE slug = ${draft.slug}`;
      if (existing) {
        console.log(`${draft.slug}: already ${existing.status}`);
        continue;
      }
      const { poolId } = await createPoolDraft({ userId: admin.userId, roles: ['SUPER_ADMIN'], ageVerified: true }, draft);
      console.log(`${draft.slug}: draft created (${poolId}) — 請到後台送審並由第二人核准發布`);
    }
  }
}
console.log('正式環境參考資料已寫入。');
await closeDb();
