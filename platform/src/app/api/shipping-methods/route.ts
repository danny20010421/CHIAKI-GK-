import { db } from '@/server/db';
import { json, route } from '@/server/http';
import { listShippingMethods } from '@/server/modules/shipping/shipping';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/shipping-methods — 物流方式與運費（代幣） */
export const GET = route(async () => json({ methods: await listShippingMethods(db()) }));
