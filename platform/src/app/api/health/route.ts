import { deploymentMode } from '@/server/config';
import { json, route } from '@/server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const startedAt = new Date();

/**
 * GET /api/health — liveness（程序是否活著）。不連資料庫、不經限流；容器 HEALTHCHECK 與平台健康檢查使用。
 * 回傳部署狀態摘要（測試模式、金流/簡訊是否啟用；不含任何秘密）。
 */
export const GET = route(
  async () =>
    json({
      status: 'ok',
      uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      version: process.env.APP_VERSION || null,
      mode: deploymentMode(),
    }),
  { probe: true },
);
