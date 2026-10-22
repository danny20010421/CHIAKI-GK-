import { z } from 'zod';
import { body, json, route } from '@/server/http';
import { loginWithOtp } from '@/server/modules/auth/users';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({
  phone: z.string().regex(/^09\d{8}$/),
  code: z.string().regex(/^\d{6}$/),
  deviceFingerprint: z.string().min(8).max(128).optional(),
});

/** POST /api/auth/otp/verify — 驗證 OTP 並取得 Bearer token */
export const POST = route(async (req: Request) => {
  const b = await body(req, B);
  const fp = b.deviceFingerprint ?? req.headers.get('x-device-fingerprint') ?? undefined;
  return json(await loginWithOtp(b.phone, b.code, fp));
});
