import { AppError } from '../../errors';
import { config, smsConfigured } from '../../config';

/**
 * 登入提供者介面。正式串接（簡訊 OTP 供應商、LINE Login）尚未實作；
 * 開發替身僅在 AUTH_DEV_STUB=1 且非 production 時可用。
 */
export interface OtpProvider {
  send(phone: string): Promise<void>;
  verify(phone: string, code: string): Promise<boolean>;
}

export interface LineLoginProvider {
  authorizeUrl(state: string): string;
  exchange(code: string): Promise<{ lineUserId: string; displayName: string }>;
}

export const DEV_OTP_CODE = '000000';

class DevOtpProvider implements OtpProvider {
  async send(): Promise<void> {
    /* 開發模式不發簡訊；固定碼 000000 */
  }
  async verify(_phone: string, code: string): Promise<boolean> {
    return code === DEV_OTP_CODE;
  }
}

export const SMS_DISABLED_MESSAGE = '簡訊服務尚未啟用（測試模式：尚未設定簡訊供應商），暫時無法發送驗證碼';

/** 未設定簡訊供應商（MITAKE_USERNAME / MITAKE_PASSWORD）：503 SMS_DISABLED，訊息明確標示為測試模式 */
class SmsDisabledOtpProvider implements OtpProvider {
  async send(): Promise<void> {
    throw new AppError('SMS_DISABLED', SMS_DISABLED_MESSAGE);
  }
  async verify(): Promise<boolean> {
    throw new AppError('SMS_DISABLED', SMS_DISABLED_MESSAGE);
  }
}

/** 已設定三竹帳號，但 OTP 發送/驗證串接尚待以正式帳號實作與驗證 */
class NotIntegratedOtpProvider implements OtpProvider {
  async send(): Promise<void> {
    throw new AppError('NOT_IMPLEMENTED', 'SMS OTP 串接尚未完成（已設定簡訊帳號，待實作三竹 OTP 發送）');
  }
  async verify(): Promise<boolean> {
    throw new AppError('NOT_IMPLEMENTED', 'SMS OTP 串接尚未完成（已設定簡訊帳號，待實作三竹 OTP 發送）');
  }
}

export class LineLoginStub implements LineLoginProvider {
  authorizeUrl(): string {
    throw new AppError('NOT_IMPLEMENTED', 'LINE Login not configured');
  }
  async exchange(): Promise<{ lineUserId: string; displayName: string }> {
    throw new AppError('NOT_IMPLEMENTED', 'LINE Login not configured');
  }
}

export function otpProvider(): OtpProvider {
  const c = config();
  if (c.AUTH_DEV_STUB && c.NODE_ENV !== 'production') return new DevOtpProvider();
  return smsConfigured(c) ? new NotIntegratedOtpProvider() : new SmsDisabledOtpProvider();
}
