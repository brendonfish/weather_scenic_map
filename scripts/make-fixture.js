// 產生 fixtures/ 的假預報：每個縣市一份，格式跟氣象署「鄉鎮天氣預報－某縣市未來 3 天」一樣。
// 涵蓋 CSV 裡所有鄉鎮。數字是用名稱算出來的假值（每次跑結果都一樣），不是真的天氣。
// 跑法：node scripts/make-fixture.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSpots, normalizeName, COUNTY_DATASETS } from '../lib/forecast.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const spots = readSpots(path.join(root, 'data', 'spots_2025_top10.csv'));
const outDir = path.join(root, 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

const FIRST_DAY = '2026-11-19';

// 簡單的字串雜湊，讓假值固定
function hash(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h;
}

const pad = (n) => String(n).padStart(2, '0');
const iso = (dayIndex, hour) => {
  const d = new Date(Date.parse(`${FIRST_DAY}T00:00:00+08:00`) + (dayIndex * 24 + hour) * 3600 * 1000);
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.toISOString().slice(0, 10)}T${pad(t.getUTCHours())}:00:00+08:00`;
};

// 從第一天 06:00 開始，每 3 小時一筆，共 24 筆（3 天）
const SLOTS = Array.from({ length: 24 }, (_, i) => 6 + i * 3);

function townElements(county, town) {
  const base = hash(county + town);
  const pop = SLOTS.map((h) => {
    const day = Math.floor((h - 0) / 24);
    // 每個鄉鎮每天一個「基準」，再加一點起伏，讓三種顏色都會出現、每天不一樣
    const dayBase = hash(`${base}-${day}`) % 11; // 0..10
    const wiggle = hash(`${base}-${h}`) % 3; // 0..2
    return Math.min(10, Math.max(0, dayBase + wiggle - 1)) * 10;
  });
  const coldBias = hash(`${base}-cold`) % 4 === 0 ? -10 : 0; // 約四分之一的鄉鎮偏冷
  const at = SLOTS.map((h) => 18 + coldBias + (hash(`${base}-at-${h}`) % 9) - 4);
  return [
    {
      ElementName: '3小時降雨機率',
      Time: SLOTS.map((h, i) => ({
        StartTime: iso(0, h),
        EndTime: iso(0, h + 3),
        ElementValue: [{ ProbabilityOfPrecipitation: String(pop[i]) }],
      })),
    },
    {
      ElementName: '體感溫度',
      Time: SLOTS.map((h, i) => ({
        DataTime: iso(0, h),
        ElementValue: [{ ApparentTemperature: String(at[i]) }],
      })),
    },
  ];
}

for (const [county, id] of Object.entries(COUNTY_DATASETS)) {
  const towns = [
    ...new Set(spots.filter((s) => normalizeName(s.county) === county).map((s) => normalizeName(s.town))),
  ].sort();
  const body = {
    success: 'true',
    result: { resource_id: id, fields: [] },
    records: {
      Locations: [
        {
          DatasetDescription: '臺灣各鄉鎮市區預報資料',
          LocationsName: county,
          Dataid: id.replace('F-', ''),
          Location: towns.map((town) => ({
            LocationName: town,
            WeatherElement: townElements(county, town),
          })),
        },
      ],
    },
  };
  fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(body, null, 1) + '\n');
  console.log(`${id} ${county}：${towns.length} 個鄉鎮`);
}
