import { db, closeDb } from '../src/server/db';
import { runMigrations } from '../src/server/lib/migrations';

const applied = await runMigrations(db());
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
await closeDb();
