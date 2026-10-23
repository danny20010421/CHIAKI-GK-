import { db } from '@/server/db';
import { json, route } from '@/server/http';
import { listShippingMethods } from '@/server/modules/shipping/shipping';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/shipping-methods — 物流方式（寄送方式由獎項預設；運費到付） */
export const GET = route(async () => json({ methods: await listShippingMethods(db()) }));
