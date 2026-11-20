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
  checkCountyCoverage,
} from '../lib/forecast.js';
import { checkApiKey, fetchCwa } from '../lib/cwa.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--fixture');
const useFixture = args.includes('--fixture');

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

// 兩個輸出檔先寫成暫存檔，都寫好再換上去；寫失敗就清掉暫存檔，舊檔不動
function writeOutputs(outDir, files) {
  const tmps = files.map(([name]) => path.join(outDir, `.${name}.tmp`));
  try {
    files.forEach(([, text], i) => fs.writeFileSync(tmps[i], text));
    // forecast.js 先換：網頁優先讀它，它換不上去時 forecast.json 也還沒動
    files.forEach(([name], i) => fs.renameSync(tmps[i], path.join(outDir, name)));
  } finally {
    tmps.forEach((f) => fs.rmSync(f, { force: true }));
  }
}

async function main() {
  if (unknown.length) {
    throw new Error(`不認得的參數：${unknown.join(' ')}。要用假資料請加 --fixture；抓氣象署不用加參數。`);
  }
  const spots = readSpots(path.join(root, 'data', 'spots_2025_top10.csv'));
  let responses;
  let days;
  if (useFixture) {
    responses = loadFixtureResponses(path.join(root, 'fixtures'));
    days = fixtureDays(responses);
  } else {
    const apiKey = checkApiKey(process.env.CWA_API_KEY);
    responses = await fetchCwa(apiKey);
    days = taipeiDays();
  }

  const coverage = checkCountyCoverage(responses, days);
  if (coverage.error) throw new Error(coverage.error);
  const data = buildForecast(spots, responses, days, { source: useFixture ? 'fixture' : 'cwa' });
  const outDir = path.join(root, 'public');
  fs.mkdirSync(outDir, { recursive: true });
  const json = JSON.stringify(data);
  writeOutputs(outDir, [
    ['forecast.js', `window.FORECAST_DATA = ${json};\n`],
    ['forecast.json', json + '\n'],
  ]);

  console.log(`來源：${data.source === 'fixture' ? 'fixtures 假預報' : '氣象署'}`);
  console.log(`日期：${days.join('、')}`);
  console.log(`景點：${data.spots.length} 個，寫到 public/forecast.json`);
  if (coverage.missing.length) {
    console.log(`${coverage.missing.length} 個縣市沒有今天到後天的資料（地圖上會是灰色）：${coverage.missing.join('、')}`);
  }
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
