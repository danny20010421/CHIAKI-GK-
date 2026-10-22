export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'TICKET_TAKEN'
  | 'TICKET_HELD'
  | 'TICKET_NOT_FOUND'
  | 'SET_NOT_ON_SALE'
  | 'NOT_ENOUGH_TICKETS'
  | 'INSUFFICIENT_FUNDS'
  | 'AGE_VERIFICATION_REQUIRED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'NOT_SOLD_OUT'
  | 'NOT_RECYCLABLE'
  | 'RATE_LIMITED'
  | 'SELF_APPROVAL'
  | 'ALREADY_CLAIMED'
  | 'NOT_IMPLEMENTED'
  | 'PAYMENT_INVALID'
  | 'SHIPPING_METHOD_REQUIRED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'BLOCKED'
  | 'BOT_SUSPECTED'
  | 'CSRF_REJECTED'
  | 'ACCOUNT_LOCKED'
  | 'INVALID_CREDENTIALS'
  | 'MFA_REQUIRED'
  | 'REAUTH_REQUIRED';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 409,
  TICKET_TAKEN: 409,
  TICKET_HELD: 409,
  TICKET_NOT_FOUND: 404,
  SET_NOT_ON_SALE: 409,
  NOT_ENOUGH_TICKETS: 409,
  INSUFFICIENT_FUNDS: 402,
  AGE_VERIFICATION_REQUIRED: 403,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 422,
  IDEMPOTENCY_IN_PROGRESS: 409,
  NOT_SOLD_OUT: 409,
  NOT_RECYCLABLE: 422,
  RATE_LIMITED: 429,
  SELF_APPROVAL: 403,
  ALREADY_CLAIMED: 409,
  NOT_IMPLEMENTED: 501,
  PAYMENT_INVALID: 400,
  SHIPPING_METHOD_REQUIRED: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  BLOCKED: 403,
  BOT_SUSPECTED: 429,
  CSRF_REJECTED: 403,
  ACCOUNT_LOCKED: 429,
  INVALID_CREDENTIALS: 401,
  MFA_REQUIRED: 401,
  REAUTH_REQUIRED: 401,
};

/** 可預期的業務錯誤：會轉成乾淨的 JSON 錯誤回應，且交易一律 rollback。 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
