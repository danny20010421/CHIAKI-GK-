import { AppError } from '../../errors';
import { config } from '../../config';

/**
 * 綠界信用卡刷退（部分退款）介面。正式串接：綠界「信用卡請退款」API（CreditDetail/DoAction，Action=R，需 CheckMacValue、
 * MerchantTradeNo + TradeNo + TotalAmount），僅限信用卡交易、且須在綠界規定的期限內；超過期限需改銀行轉帳。
 * 目前為替身：ECPAY_REFUND_STUB=1（僅開發/測試）時回傳成功；否則 NOT_IMPLEMENTED（財務改用銀行轉帳撥款）。
 */
export interface CardRefundRequest {
  merchantTradeNo: string;
  providerTradeNo: string | null;
  amount: number;
  /** 冪等鍵：同一退款申請重試不得重複刷退 */
  idempotencyKey: string;
}

export interface EcpayRefundGateway {
  refundCard(r: CardRefundRequest): Promise<{ providerRef: string }>;
}

class StubGateway implements EcpayRefundGateway {
  private done = new Map<string, string>();
  async refundCard(r: CardRefundRequest) {
    const prev = this.done.get(r.idempotencyKey);
    if (prev) return { providerRef: prev };
    const ref = `STUB-R-${r.merchantTradeNo}-${r.amount}`;
    this.done.set(r.idempotencyKey, ref);
    return { providerRef: ref };
  }
}

class NotConfiguredGateway implements EcpayRefundGateway {
  async refundCard(): Promise<{ providerRef: string }> {
    throw new AppError('NOT_IMPLEMENTED', '綠界刷退 API 尚未串接，請改以銀行轉帳撥款');
  }
}

let override: EcpayRefundGateway | null = null;
const stub = new StubGateway();

export function ecpayRefundGateway(): EcpayRefundGateway {
  if (override) return override;
  return config().ECPAY_REFUND_STUB && config().NODE_ENV !== 'production' ? stub : new NotConfiguredGateway();
}

export function setEcpayRefundGateway(g: EcpayRefundGateway | null): void {
  override = g;
}
