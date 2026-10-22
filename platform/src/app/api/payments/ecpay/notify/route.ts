import { handleEcpayNotify } from '@/server/modules/payment/payments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/payments/ecpay/notify — 綠界 ReturnURL（server-to-server）。
 * 回應純文字：成功/重複 '1|OK'；驗證失敗 '0|...'（綠界會重送）。
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.text();
    const r = await handleEcpayNotify(raw);
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  } catch (e) {
    console.error('[ecpay notify] error', e);
    return new Response('0|Server Error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}
