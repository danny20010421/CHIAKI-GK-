import { z } from 'zod';
import { body, json, route } from '@/server/http';
import { requestOtp } from '@/server/modules/auth/users';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({ phone: z.string().regex(/^09\d{8}$/) });

/** POST /api/auth/otp/request — 發送簡訊 OTP（目前僅開發替身） */
export const POST = route(async (req: Request) => {
  const b = await body(req, B);
  await requestOtp(b.phone);
  return json({ sent: true });
});
