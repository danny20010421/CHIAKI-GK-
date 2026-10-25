// 把營運腳本（migration、worker、正式種子、建立管理員）打包成單一 .mjs（dist/），
// 讓正式映像不需要 tsx / TypeScript 即可執行：node dist/migrate.mjs、node dist/worker.mjs …
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const entries = {
  migrate: 'scripts/migrate.ts',
  worker: 'scripts/worker.ts',
  'seed-prod': 'scripts/seed-prod.ts',
  'create-admin': 'scripts/create-admin.ts',
  // 開發示範種子（測試站/預覽站用；正式站請用 seed-prod）
  seed: 'scripts/seed.ts',
};

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: entries,
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'linked',
  logLevel: 'info',
  // ESM 打包內若有 CommonJS 相依套件呼叫 require()，提供 require
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
