// 產出網頁要用的 public/forecast.json（預報按鄉鎮存）和 public/attractions.json（景點檔，從 data/attractions.json 複製），
// 各另外寫一份 .js，讓直接雙擊打開 index.html 也讀得到。
// 景點檔 data/attractions.json 是事先做好、commit 在 repo 裡的（scripts/build-attractions.js），這支不重做、不下載。
//
// 跑法：
//   node scripts/build-data.js --fixture   用 fixtures/ 的假預報，不連網路
//   CWA_API_KEY=授權碼 node scripts/build-data.js   抓氣象署真的預報（授權碼只放環境變數）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadFixtureResponses,
  buildTownForecast,
  pickDays,
  checkCountyCoverage,
} from '../lib/forecast.js';
import { checkApiKey, fetchCwa } from '../lib/cwa.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--fixture');
const useFixture = args.includes('--fixture');

// 假預報最早的時間當「現在」，這樣不管哪天跑，三天都有資料
function fixtureNow(responses) {
  let min = Infinity;
  for (const r of responses)
    for (const g of r.records.Locations)
      for (const l of g.Location)
        for (const el of l.WeatherElement)
          for (const t of el.Time) min = Math.min(min, Date.parse(t.StartTime ?? t.DataTime));
  return min;
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
  const attractionsText = fs.readFileSync(path.join(root, 'data', 'attractions.json'), 'utf8');
  const spots = JSON.parse(attractionsText);
  let responses;
  let nowMs;
  if (useFixture) {
    responses = loadFixtureResponses(path.join(root, 'fixtures'));
    nowMs = fixtureNow(responses);
  } else {
    const apiKey = checkApiKey(process.env.CWA_API_KEY);
    responses = await fetchCwa(apiKey);
    nowMs = Date.now();
  }

  // 只收 09:00–18:00 還有預報時段的日子（晚上跑就從明天開始），收滿 3 天
  const days = pickDays(responses, nowMs);
  if (days.length === 0) {
    throw new Error('預報的日期對不到今天之後的 09:00–18:00（可能是舊資料或電腦時鐘不對），沒有寫出 forecast.json。');
  }
  const coverage = checkCountyCoverage(responses, days, nowMs);
  if (coverage.error) throw new Error(coverage.error);
  const data = buildTownForecast(spots, responses, days, { source: useFixture ? 'fixture' : 'cwa', nowMs });
  const outDir = path.join(root, 'public');
  fs.mkdirSync(outDir, { recursive: true });
  const json = JSON.stringify(data);
  const attractionsJson = JSON.stringify(spots);
  // 四個檔一起換：景點檔先換（網頁拿新景點配舊預報，只是新景點沒顏色；反過來會整片對不上）
  writeOutputs(outDir, [
    ['attractions.js', `window.ATTRACTIONS_DATA = ${attractionsJson};\n`],
    ['attractions.json', attractionsJson + '\n'],
    ['forecast.js', `window.FORECAST_DATA = ${json};\n`],
    ['forecast.json', json + '\n'],
  ]);

  console.log(`來源：${data.source === 'fixture' ? 'fixtures 假預報' : '氣象署'}`);
  console.log(`日期：${days.join('、')}`);
  if (days.length < 3) {
    console.log(`其他天的 09:00–18:00 沒有完整的預報，這次只收 ${days.length} 天。`);
  }
  if (Object.values(data.towns).some((t) => t[0]?.partial)) {
    console.log(`${days[0]} 已經過了一部分，只算還沒過的時段。`);
  }
  console.log(`景點：${spots.length} 個（第 1 層 ${spots.filter((s) => s.layer === 1).length} 個），預報 ${Object.keys(data.towns).length} 個鄉鎮，寫到 public/forecast.json、public/attractions.json`);
  if (coverage.missing.length) {
    console.log(`${coverage.missing.length} 個縣市沒有 ${days.join('、')} 的資料（地圖上會是灰色）：${coverage.missing.join('、')}`);
  }
  const unmatchedSpots = data.unmatched.reduce((n, u) => n + u.count, 0);
  console.log(`對不到鄉鎮預報的景點 ${unmatchedSpots} 個（天氣留空）${unmatchedSpots ? '：' : '。'}`);
  // 鄉鎮很多時只列前 20 個，免得洗版（全部在 forecast.json 的 unmatched）
  for (const u of data.unmatched.slice(0, 20)) console.log(`  - ${u.county}${u.town}：${u.count} 個景點`);
  if (data.unmatched.length > 20) console.log(`  …共 ${data.unmatched.length} 個鄉鎮，全部列在 forecast.json 的 unmatched`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
