/** 排程：派送通知外送佇列（簡訊 / LINE / Web Push / Email）。建議每分鐘執行一次；可多實例並行。 */
import { closeDb } from '../src/server/db';
import { dispatchOutbox } from '../src/server/modules/notifications/outbox';

console.log(JSON.stringify(await dispatchOutbox({ limit: 500 })));
await closeDb();
