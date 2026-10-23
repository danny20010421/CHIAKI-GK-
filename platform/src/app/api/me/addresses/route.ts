import { db } from '@/server/db';
import { body, json, requirePrincipal, route } from '@/server/http';
import { AddressSchema, createAddress, listAddresses } from '@/server/modules/member/profile';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/addresses — 常用收件資訊（預設在最前） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json({ addresses: await listAddresses(db(), p.userId) });
});

/** POST /api/me/addresses — { method: home|c711|fami, recipientName, recipientPhone (09xxxxxxxx), address | cvsStoreId (+cvsStoreName), isDefault? } */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await createAddress(p.userId, await body(req, AddressSchema)), 201);
});
