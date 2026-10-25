-- CHIAKI platform — 業主 2026-10（第十批）（不修改已套用的 migration）
--   1. 每日簽到改為「連續簽到」：前一天（台灣日期）有簽到才延續，漏簽任何一天即從第 1 天重新開始。
--      獎勵依連續天數在 7 天循環中的位置：第 1–6 天 2 UC幣、第 7 天 10 UC幣，第 8 天回到第 1 格（2 UC幣）…
--      member_checkins.streak = 連續天數（含當天）；seq = 循環位置 ((streak − 1) % 7) + 1。
--      week_start（舊「每週一重算」規則）改為選填、只保留於舊紀錄；舊紀錄的 streak 依連續日期回填。
--   2. VIP 等級預設值更新（業主 2026-10 第十批；後台仍可修改）：門檻、升級禮、生日禮、每月優惠券、寄存天數（總天數，非累加）、權益。
--   3. 貨幣顯示名稱「CC幣」更名為「UC幣」（只影響文案；欄位/列舉名稱 coins、COINS 不變）。

-- ───────────────────────── 1. 連續簽到 ─────────────────────────
ALTER TABLE member_checkins ADD COLUMN streak integer;
ALTER TABLE member_checkins DISABLE TRIGGER member_checkins_append_only;
UPDATE member_checkins m SET streak = x.streak
FROM (
  SELECT user_id, day, row_number() OVER (PARTITION BY user_id, grp ORDER BY day)::int AS streak
  FROM (SELECT user_id, day, day - (row_number() OVER (PARTITION BY user_id ORDER BY day))::int AS grp FROM member_checkins) g
) x
WHERE m.user_id = x.user_id AND m.day = x.day;
ALTER TABLE member_checkins ENABLE TRIGGER member_checkins_append_only;
ALTER TABLE member_checkins ALTER COLUMN streak SET NOT NULL;
ALTER TABLE member_checkins ADD CONSTRAINT member_checkins_streak_check CHECK (streak >= 1);
-- 新紀錄：循環位置 = ((streak − 1) % 7) + 1（舊紀錄的 seq 為舊「本週第 N 次」規則，不追溯檢查）
ALTER TABLE member_checkins ADD CONSTRAINT member_checkins_seq_cycle CHECK (seq = ((streak - 1) % 7) + 1) NOT VALID;
ALTER TABLE member_checkins DROP CONSTRAINT member_checkins_user_id_week_start_seq_key;
ALTER TABLE member_checkins DROP CONSTRAINT member_checkins_check;
ALTER TABLE member_checkins DROP CONSTRAINT member_checkins_week_start_check;
ALTER TABLE member_checkins ALTER COLUMN week_start DROP NOT NULL;
ALTER TABLE member_checkins ADD CONSTRAINT member_checkins_week_start_legacy
  CHECK (week_start IS NULL OR (extract(isodow FROM week_start) = 1 AND day >= week_start AND day < week_start + 7));
CREATE INDEX member_checkins_user_day_idx ON member_checkins (user_id, day DESC);

-- ───────────────────────── 2. VIP 等級預設值 ─────────────────────────
-- discountPct：5 = 95折、10 = 9折、15 = 85折、20 = 8折；perks 為該等級「新增」的權益（較高等級自動包含）
UPDATE vip_tiers SET name = v.name, spend_threshold = v.spend_threshold, upgrade_gift_coins = v.upgrade_gift_coins,
       birthday_gift_coins = v.birthday_gift_coins, monthly_coupons_json = v.monthly_coupons_json, extra_storage_days = v.extra_storage_days,
       perks_json = v.perks_json, updated_by = NULL, updated_at = now()
FROM (VALUES
  (0, '新手籤', 0::bigint, 0, 0, '[]', 0, '[]'),
  (1, '銅籤', 3000, 50, 50, '[{"discountPct":5,"qty":1}]', 0, '[]'),
  (2, '銀籤', 30000, 100, 100, '[{"discountPct":5,"qty":2}]', 0, '[{"code":"BIRTHDAY_GIFT","label":"生日禮"}]'),
  (3, '金籤', 200000, 500, 500, '[{"discountPct":5,"qty":2}]', 0, '[{"code":"LIVE_ODDS","label":"賞池頁即時機率顯示"}]'),
  (4, '白金籤', 500000, 1000, 2000, '[{"discountPct":10,"qty":3}]', 7, '[{"code":"FREE_STORAGE_PLUS_7","label":"免費保管期限 +7 天"}]'),
  (5, '鑽石籤', 1000000, 2500, 5000, '[{"discountPct":15,"qty":3},{"discountPct":20,"qty":1}]', 14, '[{"code":"DEDICATED_CS","label":"專屬客服"}]'),
  (6, '黑金籤', 2000000, 5000, 10000, '[{"discountPct":20,"qty":3}]', 14, '[{"code":"EXCLUSIVE_EVENTS","label":"專屬活動與限定賞池"}]')
) AS v(level, name, spend_threshold, upgrade_gift_coins, birthday_gift_coins, monthly_coupons_json, extra_storage_days, perks_json)
WHERE vip_tiers.level = v.level;
-- 門檻提高：既有會員的等級不因此降級（年度評等時才依新門檻重新評等）；尚未達到的等級之升級禮依新設定發放。
