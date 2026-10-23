import { requestIp, route, text } from '@/server/http';
import { handleEcpayNotify } from '@/server/modules/payment/payments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/payments/ecpay/notify — 綠界 ReturnURL（server-to-server, x-www-form-urlencoded）。
 * 回應純文字：成功/重複 '1|OK'；驗證失敗 '0|...'（綠界會重送）。
 * 防火牆同其他路由（封鎖清單、限流、本文大小），另有來源 IP 允許清單、CheckMacValue、重放防護（見 payments.ts）。
 */
export const POST = route(
  async (req: Request) => {
    try {
      const raw = await req.text();
      const r = await handleEcpayNotify(raw, { ip: requestIp(req) });
      return text(r.body, r.status);
    } catch (e) {
      // 測試網站（SITE_TEST_MODE）：拒絕任何付款通知
      if ((e as { code?: string }).code === 'TEST_SITE') return text(`0|${(e as Error).message}`, 403);
      console.error('[ecpay notify] error', e);
      return text('0|Server Error', 500);
    }
  },
  { allowForm: true },
);
