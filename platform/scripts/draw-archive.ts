/** 排程：封存 90 天以前的抽賞紀錄（只標記、不刪除；冪等）。建議每日執行一次。 */
import { closeDb } from '../src/server/db';
import { runDrawArchive } from '../src/server/modules/draw/history';

let total = 0;
for (;;) {
  const r = await runDrawArchive();
  total += r.archived;
  if (r.archived === 0) break;
}
console.log(JSON.stringify({ archived: total }));
await closeDb();
