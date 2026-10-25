/**
 * 建立第一個（或另一個）超級管理員。正式環境用（不建立示範資料）。
 *   npm run admin:create -- --login <帳號> [--name 顯示名稱] [--phone 09xxxxxxxx]
 * 密碼：互動終端機會提示輸入（不顯示）；非互動（CI / 容器 exec 無 TTY）時讀 NEW_ADMIN_PASSWORD 環境變數。
 * 完成後：登入後台 → 綁定 TOTP 兩步驟驗證 → 設定 ADMIN_MFA_REQUIRED=true 並重新部署。
 */
import { createInterface } from 'node:readline';
import { closeDb } from '../src/server/db';
import { createSuperAdmin } from '../src/server/ops/bootstrap';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => {
    if (!muted) process.stdout.write(s);
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const loginId = arg('login');
if (!loginId) {
  console.error('用法：npm run admin:create -- --login <帳號> [--name 顯示名稱] [--phone 09xxxxxxxx]');
  process.exit(2);
}
let password = process.env.NEW_ADMIN_PASSWORD ?? '';
if (!password && process.stdin.isTTY) {
  password = await promptHidden('新密碼（至少 12 碼）：');
  const again = await promptHidden('再輸入一次：');
  if (again !== password) {
    console.error('兩次輸入的密碼不同');
    process.exit(2);
  }
}
if (!password) {
  console.error('請在互動終端機執行，或設定 NEW_ADMIN_PASSWORD 環境變數');
  process.exit(2);
}
try {
  const r = await createSuperAdmin({ loginId, password, displayName: arg('name'), phone: arg('phone') ?? null });
  console.log(`已建立超級管理員 ${r.loginId}（user ${r.userId}）。下一步：登入後台並綁定兩步驟驗證（TOTP）。`);
} catch (e) {
  console.error(`建立失敗：${(e as Error).message}`);
  process.exitCode = 1;
}
await closeDb();
