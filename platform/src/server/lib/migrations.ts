import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from './canonical';
import type { Sql } from '../db';

/**
 * 極簡 migration runner：依序套用 prisma/migrations/<name>/migration.sql（Prisma 目錄格式），
 * 並以 checksum 防止已套用的檔案被修改。
 */
export async function runMigrations(sql: Sql, dir = join(process.cwd(), 'prisma', 'migrations')): Promise<string[]> {
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS _chiaki_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'migration.sql')))
    .map((d) => d.name)
    .sort();
  const applied = new Map(
    (await sql<{ name: string; checksum: string }[]>`SELECT name, checksum FROM _chiaki_migrations`).map((r) => [r.name, r.checksum]),
  );
  const done: string[] = [];
  for (const name of names) {
    const body = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
    const checksum = sha256Hex(body);
    const prev = applied.get(name);
    if (prev) {
      if (prev !== checksum) throw new Error(`migration ${name} was modified after being applied`);
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO _chiaki_migrations (name, checksum) VALUES (${name}, ${checksum})`;
    });
    done.push(name);
  }
  return done;
}
