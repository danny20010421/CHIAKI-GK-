/**
 * 寄存到期掃描（排程用，建議每小時執行；冪等，可重複/並行執行）：
 *   到期前 7 天與到期當日通知、到期後依每套每獎項回收值自動轉為代幣（預設不可退款）。
 * 用法：npm run job:storage-sweep
 */
import { closeDb } from '../src/server/db';
import { runStorageSweep } from '../src/server/modules/warehouse/storage';

console.log(JSON.stringify(await runStorageSweep(), null, 2));
await closeDb();
