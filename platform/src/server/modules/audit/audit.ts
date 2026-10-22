import { canonicalJson, sha256Hex } from '../../lib/canonical';
import type { Db, Tx } from '../../db';

/**
 * 稽核紀錄（append-only + hash chain）。
 * hash = SHA-256(canonicalJson({seq, prevHash, merchantId, actorType, actorId, action, entityType, entityId, payloadJson, createdAt}))
 * 資料表層級另以 trigger 禁止 UPDATE/DELETE/TRUNCATE；verifyAuditChain 可偵測繞過 trigger 的竄改或刪除。
 */
export type ActorType = 'USER' | 'ADMIN' | 'SYSTEM' | 'PROVIDER';

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  payload?: Record<string, unknown>;
  merchantId?: string;
}

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditRowForHash {
  seq: number;
  prevHash: string;
  merchantId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  payloadJson: string;
  createdAt: string;
}

export function computeAuditHash(r: AuditRowForHash): string {
  return sha256Hex(
    canonicalJson({
      seq: r.seq,
      prevHash: r.prevHash,
      merchantId: r.merchantId,
      actorType: r.actorType,
      actorId: r.actorId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      payloadJson: r.payloadJson,
      createdAt: r.createdAt,
    }),
  );
}

/**
 * 在呼叫端的交易內追加一筆稽核紀錄。會鎖定 audit_head（全域序列化點），
 * 因此應在交易的「最後」呼叫，以縮短持鎖時間並維持一致的鎖順序。
 */
export async function appendAudit(tx: Tx, e: AuditEntry): Promise<{ seq: number; hash: string }> {
  const [head] = await tx<{ lastSeq: number; lastHash: string }[]>`
    SELECT last_seq, last_hash FROM audit_head WHERE id = 1 FOR UPDATE`;
  if (!head) throw new Error('audit_head missing');
  const row: AuditRowForHash = {
    seq: head.lastSeq + 1,
    prevHash: head.lastHash,
    merchantId: e.merchantId ?? 'chiaki',
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    payloadJson: canonicalJson(e.payload ?? {}),
    createdAt: new Date().toISOString(),
  };
  const hash = computeAuditHash(row);
  await tx`
    INSERT INTO audit_log (seq, merchant_id, actor_type, actor_id, action, entity_type, entity_id, payload_json, created_at, prev_hash, hash)
    VALUES (${row.seq}, ${row.merchantId}, ${row.actorType}, ${row.actorId}, ${row.action}, ${row.entityType}, ${row.entityId},
            ${row.payloadJson}, ${row.createdAt}, ${row.prevHash}, ${hash})`;
  await tx`UPDATE audit_head SET last_seq = ${row.seq}, last_hash = ${hash} WHERE id = 1`;
  return { seq: row.seq, hash };
}

export type ChainVerification =
  | { ok: true; count: number; headHash: string }
  | { ok: false; count: number; brokenAtSeq: number; reason: string };

/** 逐筆重算雜湊並檢查鏈結、序號連續性與 head 指標（可偵測竄改、插入、刪除與截尾）。 */
export async function verifyAuditChain(db: Db, batchSize = 1000): Promise<ChainVerification> {
  let expectedSeq = 1;
  let prevHash = GENESIS_HASH;
  let count = 0;
  for (;;) {
    const rows = await db<(AuditRowForHash & { hash: string })[]>`
      SELECT seq, prev_hash, merchant_id, actor_type, actor_id, action, entity_type, entity_id, payload_json, created_at, hash
      FROM audit_log WHERE seq >= ${expectedSeq} ORDER BY seq LIMIT ${batchSize}`;
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.seq !== expectedSeq) return { ok: false, count, brokenAtSeq: expectedSeq, reason: 'missing or reordered row' };
      if (r.prevHash !== prevHash) return { ok: false, count, brokenAtSeq: r.seq, reason: 'prev_hash mismatch' };
      if (computeAuditHash(r) !== r.hash) return { ok: false, count, brokenAtSeq: r.seq, reason: 'hash mismatch (row content altered)' };
      prevHash = r.hash;
      expectedSeq++;
      count++;
    }
  }
  const [head] = await db<{ lastSeq: number; lastHash: string }[]>`SELECT last_seq, last_hash FROM audit_head WHERE id = 1`;
  if (!head || head.lastSeq !== count || head.lastHash !== prevHash) {
    return { ok: false, count, brokenAtSeq: count + 1, reason: 'audit head does not match chain tail (rows removed?)' };
  }
  return { ok: true, count, headHash: prevHash };
}
