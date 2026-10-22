import { db } from '@/server/db';
import { json, requirePrincipal, route } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { reconcileWallets } from '@/server/modules/wallet/wallet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/wallets/reconcile — 錢包快取 vs 帳本加總對帳（只回傳不一致者） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'wallet.reconcile');
  const all = await reconcileWallets(db());
  const mismatches = all.filter((r) => !r.ok);
  return json({ wallets: all.length, ok: mismatches.length === 0, mismatches });
});
