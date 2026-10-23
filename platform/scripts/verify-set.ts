/**
 * 公開驗證工具：npm run verify:set -- <reveal.json 路徑 或 https://…/api/pools/:id/sets/:no/reveal>
 * 重算 (1) 規則雜湊 sha256(canonicalJson(rules)) 與 (2) 承諾雜湊 sha256(canonical(layout) + "\n" + salt)。
 * 機率賞另外重算 chiaki-prob-v1 種子流（見 src/server/modules/pool/prob.ts）。
 * 支援 chiaki-commit-v2（[籤號, 等級, 獎項 id]）與舊套的 chiaki-commit-v1（[籤號, 賞級, 獎項 id]）。
 * 僅依賴 node:crypto，可獨立給第三方使用。
 */
import { readFileSync } from 'node:fs';
import { canonicalJson, sha256Hex } from '../src/server/lib/canonical';
import { COMMIT_SCHEMES, computeCommitment, type CommitScheme, type LayoutEntry } from '../src/server/modules/pool/commitment';
import { replayProbSet, type ProbReplayInput } from '../src/server/modules/pool/prob';

const src = process.argv[2];
if (!src) {
  console.error('usage: npm run verify:set -- <reveal.json | reveal URL>');
  process.exit(2);
}
const data = (src.startsWith('http') ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, 'utf8'))) as {
  scheme: string; poolId: string; setNo: number; rulesHash: string; rules: unknown; commitment: string; salt: string; layout: LayoutEntry[];
  prob?: ProbReplayInput;
};
if (!(COMMIT_SCHEMES as readonly string[]).includes(data.scheme)) throw new Error(`unsupported scheme ${data.scheme}`);
const rulesOk = sha256Hex(canonicalJson(data.rules)) === data.rulesHash;
const recomputed = computeCommitment({ scheme: data.scheme as CommitScheme, poolId: data.poolId, setNo: data.setNo, rulesHash: data.rulesHash, layout: data.layout }, data.salt);
const commitOk = recomputed === data.commitment;
console.log(`rules hash : ${rulesOk ? 'OK' : 'MISMATCH'} (${data.rulesHash})`);
console.log(`commitment : ${commitOk ? 'OK' : 'MISMATCH'} [${data.scheme}]\n  published ${data.commitment}\n  recomputed ${recomputed}`);
console.log(`tickets    : ${data.layout.length}`);
// 機率賞（chiaki-prob-v1）：核對 seed 雜湊並依 nonce 順序重算每一筆抽賞
const probOk = data.prob ? replayProbSet(data.prob) : null;
if (probOk) console.log(`prob seed  : ${probOk.seedOk ? 'OK' : 'MISMATCH'}\nprob draws : ${probOk.mismatches.length ? `MISMATCH at nonce ${probOk.mismatches.join(',')}` : `OK (${data.prob!.draws.length})`}`);
process.exit(rulesOk && commitOk && (probOk?.ok ?? true) ? 0 : 1);
