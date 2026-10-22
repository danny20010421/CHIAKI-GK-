import { AppError } from '../../errors';
import { config } from '../../config';

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

class NotConfiguredOtpProvider implements OtpProvider {
  async send(): Promise<void> {
    throw new AppError('NOT_IMPLEMENTED', 'SMS OTP provider not configured');
  }
  async verify(): Promise<boolean> {
    throw new AppError('NOT_IMPLEMENTED', 'SMS OTP provider not configured');
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
  return c.AUTH_DEV_STUB && c.NODE_ENV !== 'production' ? new DevOtpProvider() : new NotConfiguredOtpProvider();
}
