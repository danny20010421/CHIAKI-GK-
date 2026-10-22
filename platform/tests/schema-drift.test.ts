import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { db } from '../src/server/db';
import { setupTestDb } from './helpers';

/** 比對 prisma/schema.prisma（鏡像）與實際 migrate 後的 PostgreSQL 結構，防止兩者漂移。 */
const PRISMA_TO_PG: Record<string, string[]> = {
  String: ['text', 'uuid'],
  BigInt: ['bigint'],
  Int: ['integer'],
  Boolean: ['boolean'],
  DateTime: ['timestamp with time zone', 'date'],
  Bytes: ['bytea'],
};

function parsePrisma(src: string) {
  const tables = new Map<string, Map<string, { type: string; nullable: boolean }>>();
  for (const m of src.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const body = m[2]!;
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? m[1]!;
    const cols = new Map<string, { type: string; nullable: boolean }>();
    for (const line of body.split('\n')) {
      const f = /^\s+(\w+)\s+(\w+)(\?)?(.*)$/.exec(line);
      if (!f || line.trim().startsWith('@@')) continue;
      const col = /@map\("([^"]+)"\)/.exec(f[4]!)?.[1] ?? f[1]!;
      cols.set(col, { type: f[2]!, nullable: f[3] === '?' });
    }
    tables.set(table, cols);
  }
  return tables;
}

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

describe('schema drift', () => {
  it('prisma/schema.prisma mirrors the migrated database (tables, columns, types, nullability)', async () => {
    const prisma = parsePrisma(readFileSync('prisma/schema.prisma', 'utf8'));
    const rows = await db()<{ tableName: string; columnName: string; dataType: string; isNullable: string }[]>`
      SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
      FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> '_chiaki_migrations'`;
    const dbTables = new Map<string, Map<string, { dataType: string; nullable: boolean }>>();
    for (const r of rows) {
      if (!dbTables.has(r.tableName)) dbTables.set(r.tableName, new Map());
      dbTables.get(r.tableName)!.set(r.columnName, { dataType: r.dataType, nullable: r.isNullable === 'YES' });
    }
    assert.deepEqual([...prisma.keys()].sort(), [...dbTables.keys()].sort(), 'table sets differ');
    for (const [t, cols] of dbTables) {
      const pc = prisma.get(t)!;
      assert.deepEqual([...pc.keys()].sort(), [...cols.keys()].sort(), `columns differ in ${t}`);
      for (const [c, d] of cols) {
        const p = pc.get(c)!;
        assert.ok(PRISMA_TO_PG[p.type]?.includes(d.dataType), `${t}.${c}: prisma ${p.type} vs pg ${d.dataType}`);
        assert.equal(p.nullable, d.nullable, `${t}.${c}: nullability`);
      }
    }
  });
});
