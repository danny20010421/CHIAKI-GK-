/**
 * Token bucket 限流。預設為單一程序的記憶體儲存；多實例部署（Vercel serverless / 多台）時請實作 RateLimitStore
 * 改用 Redis（例如 Upstash：以 Lua script 原子地 refill + take），並在啟動時 setRateLimitStore(...)。
 * 邊緣層另應設定 WAF 限流（docs/security.md），應用層限流是第二道防線。
 */
export interface TakeResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface RateLimitStore {
  take(key: string, capacity: number, refillPerSec: number, cost?: number, nowMs?: number): Promise<TakeResult>;
  reset?(): void;
}

export class MemoryTokenBucketStore implements RateLimitStore {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly maxKeys = 100_000) {}

  async take(key: string, capacity: number, refillPerSec: number, cost = 1, nowMs = Date.now()): Promise<TakeResult> {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.evict(nowMs, capacity, refillPerSec);
      b = { tokens: capacity, at: nowMs };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(capacity, b.tokens + ((nowMs - b.at) / 1000) * refillPerSec);
      b.at = nowMs;
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
    }
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((cost - b.tokens) / refillPerSec)) };
  }

  /** 淘汰已回滿的桶（等同未使用），避免記憶體無限成長 */
  private evict(nowMs: number, capacity: number, refillPerSec: number) {
    for (const [k, v] of this.buckets) {
      if (v.tokens + ((nowMs - v.at) / 1000) * refillPerSec >= capacity) this.buckets.delete(k);
    }
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }

  reset() {
    this.buckets.clear();
  }
}

let store: RateLimitStore = new MemoryTokenBucketStore();

export function rateLimitStore(): RateLimitStore {
  return store;
}

export function setRateLimitStore(s: RateLimitStore): void {
  store = s;
}
