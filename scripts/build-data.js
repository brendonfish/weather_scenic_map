// 產出網頁要用的 public/forecast.json（另外寫一份 public/forecast.js，讓直接雙擊打開 index.html 也讀得到）。
//
// 跑法：
//   node scripts/build-data.js --fixture   用 fixtures/ 的假預報，不連網路
//   CWA_API_KEY=授權碼 node scripts/build-data.js   抓氣象署真的預報（授權碼只放環境變數）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readSpots,
  loadFixtureResponses,
  buildForecast,
  taipeiDays,
  checkResponse,
  COUNTY_DATASETS,
} from '../lib/forecast.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const useFixture = process.argv.includes('--fixture');

async function fetchCwa(apiKey) {
  const responses = [];
  for (const [county, id] of Object.entries(COUNTY_DATASETS)) {
    const url = new URL(`https://opendata.cwa.gov.tw/api/v1/rest/datastore/${id}`);
    url.searchParams.set('format', 'JSON');
    url.searchParams.set('ElementName', '3小時降雨機率,體感溫度');
    // 授權碼放在 header，不放網址，避免出現在錯誤訊息裡
    const res = await fetch(url, { headers: { Authorization: apiKey } });
    if (!res.ok) throw new Error(`${county}（${id}）抓取失敗：HTTP ${res.status}`);
    const body = await res.json();
    const problem = checkResponse(body);
    if (problem) throw new Error(`${county}（${id}）${problem}，沒有寫出 forecast.json`);
    responses.push(body);
  }
  return responses;
}

// 假預報的第一天當「今天」，這樣不管哪天跑，三天都有資料
function fixtureDays(responses) {
  let min = Infinity;
  for (const r of responses)
    for (const g of r.records.Locations)
      for (const l of g.Location)
        for (const el of l.WeatherElement)
          for (const t of el.Time) min = Math.min(min, Date.parse(t.StartTime ?? t.DataTime));
  return taipeiDays(min);
}

async function main() {
  const spots = readSpots(path.join(root, 'data', 'spots_2025_top10.csv'));
  let responses;
  let days;
  if (useFixture) {
    responses = loadFixtureResponses(path.join(root, 'fixtures'));
    days = fixtureDays(responses);
  } else {
    const apiKey = process.env.CWA_API_KEY;
    if (!apiKey) {
      console.error('沒有設定環境變數 CWA_API_KEY。要用假資料請加 --fixture。');
      process.exit(1);
    }
    responses = await fetchCwa(apiKey);
    days = taipeiDays();
  }

  const data = buildForecast(spots, responses, days, { source: useFixture ? 'fixture' : 'cwa' });
  const outDir = path.join(root, 'public');
  fs.mkdirSync(outDir, { recursive: true });
  const json = JSON.stringify(data);
  fs.writeFileSync(path.join(outDir, 'forecast.json'), json + '\n');
  fs.writeFileSync(path.join(outDir, 'forecast.js'), `window.FORECAST_DATA = ${json};\n`);

  console.log(`來源：${data.source === 'fixture' ? 'fixtures 假預報' : '氣象署'}`);
  console.log(`日期：${days.join('、')}`);
  console.log(`景點：${data.spots.length} 個，寫到 public/forecast.json`);
  if (data.unmatched.length) {
    console.log(`對不到鄉鎮的景點 ${data.unmatched.length} 個（天氣留空）：`);
    for (const u of data.unmatched) console.log(`  - ${u.county}${u.town} ${u.name}`);
  } else {
    console.log('每個景點都對到鄉鎮預報。');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
