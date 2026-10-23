-- CHIAKI platform — IP 分類精簡為 5 類（以日系動漫為主）：經典少年、新世代人氣、機甲・特攝、遊戲・角色、原創
-- 舊值對應：少年漫畫/經典・兒童→經典少年；青年・少女漫畫/動畫・輕小說→新世代人氣；遊戲/角色・療癒/歐美→遊戲・角色；
--           特攝・機甲→機甲・特攝；原創→原創
ALTER TABLE ips DROP CONSTRAINT ips_category_check;
UPDATE ips SET category = CASE category
  WHEN '少年漫畫' THEN '經典少年'
  WHEN '經典・兒童' THEN '經典少年'
  WHEN '青年・少女漫畫' THEN '新世代人氣'
  WHEN '動畫・輕小說' THEN '新世代人氣'
  WHEN '遊戲' THEN '遊戲・角色'
  WHEN '角色・療癒' THEN '遊戲・角色'
  WHEN '歐美' THEN '遊戲・角色'
  WHEN '特攝・機甲' THEN '機甲・特攝'
  ELSE category END
WHERE category IS NOT NULL;
ALTER TABLE ips ADD CONSTRAINT ips_category_check CHECK (category IN ('經典少年', '新世代人氣', '機甲・特攝', '遊戲・角色', '原創'));
