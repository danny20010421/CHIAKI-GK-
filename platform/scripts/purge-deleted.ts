/**
 * 硬刪除超過 30 天還原期限的軟刪除賞池/套（排程用，建議每日執行；冪等）。只會刪除 0 銷售的資料。
 * 用法：npm run job:purge-deleted
 */
import { closeDb } from '../src/server/db';
import { purgeDeleted } from '../src/server/modules/pool/manage';

console.log(JSON.stringify(await purgeDeleted(), null, 2));
await closeDb();
