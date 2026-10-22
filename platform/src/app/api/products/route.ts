import { db } from '@/server/db';
import { json, route } from '@/server/http';
import { listProducts } from '@/server/modules/catalog/catalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/products — 直購商城商品（固定價格、無機率） */
export const GET = route(async () => json({ products: await listProducts(db()) }));
