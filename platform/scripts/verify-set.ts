/**
 * 公開驗證工具：npm run verify:set -- <reveal.json 路徑 或 https://…/api/pools/:id/sets/:no/reveal>
 * 重算 (1) 規則雜湊 sha256(canonicalJson(rules)) 與 (2) 承諾雜湊 sha256(canonical(layout) + "\n" + salt)。
 * 僅依賴 node:crypto，可獨立給第三方使用。
 */
import { readFileSync } from 'node:fs';
import { canonicalJson, sha256Hex } from '../src/server/lib/canonical';
import { COMMIT_SCHEME, computeCommitment, type LayoutEntry } from '../src/server/modules/pool/commitment';

const src = process.argv[2];
if (!src) {
  console.error('usage: npm run verify:set -- <reveal.json | reveal URL>');
  process.exit(2);
}
const data = (src.startsWith('http') ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, 'utf8'))) as {
  scheme: string; poolId: string; setNo: number; rulesHash: string; rules: unknown; commitment: string; salt: string; layout: LayoutEntry[];
};
if (data.scheme !== COMMIT_SCHEME) throw new Error(`unsupported scheme ${data.scheme}`);
const rulesOk = sha256Hex(canonicalJson(data.rules)) === data.rulesHash;
const recomputed = computeCommitment({ poolId: data.poolId, setNo: data.setNo, rulesHash: data.rulesHash, layout: data.layout }, data.salt);
const commitOk = recomputed === data.commitment;
console.log(`rules hash : ${rulesOk ? 'OK' : 'MISMATCH'} (${data.rulesHash})`);
console.log(`commitment : ${commitOk ? 'OK' : 'MISMATCH'}\n  published ${data.commitment}\n  recomputed ${recomputed}`);
console.log(`tickets    : ${data.layout.length}`);
process.exit(rulesOk && commitOk ? 0 : 1);
