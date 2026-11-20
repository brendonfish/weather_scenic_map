// 旅遊天氣景點地圖：資料處理的測試
// 跑法：在 travel-weather-map 資料夾裡跑 `node --test`
// 卡片：https://trello.com/c/Os0WWw2Q （AI 小工具板）
// 只用 data/ 和 fixtures/ 的檔案，不連氣象署。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readSpots,
  normalizeName,
  loadFixtureResponses,
  indexForecast,
  summarizeDay,
  colorFor,
  buildForecast,
  checkResponse,
  COUNTY_DATASETS,
} from '../lib/forecast.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = path.join(root, 'data', 'spots_2025_top10.csv');
const fixtureDir = path.join(root, 'fixtures');

// 做一份最小的氣象署格式回傳，給單元測試用
function fakeResponse(county, town, pops, temps) {
  return {
    success: 'true',
    records: {
      Locations: [
        {
          LocationsName: county,
          Location: [
            {
              LocationName: town,
              WeatherElement: [
                {
                  ElementName: '3小時降雨機率',
                  Time: pops.map(([start, end, v]) => ({
                    StartTime: start,
                    EndTime: end,
                    ElementValue: [{ ProbabilityOfPrecipitation: String(v) }],
                  })),
                },
                {
                  ElementName: '體感溫度',
                  Time: temps.map(([t, v]) => ({
                    DataTime: t,
                    ElementValue: [{ ApparentTemperature: String(v) }],
                  })),
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

const D = '2026-11-19';
const t = (date, hh) => `${date}T${hh}:00:00+08:00`;

test('W-1 CSV 讀出 190 筆，欄位都有', () => {
  const spots = readSpots(csvPath);
  assert.equal(spots.length, 190);
  const s = spots[0];
  assert.equal(s.name, '西門町商圈');
  assert.equal(s.county, '台北市');
  assert.equal(s.town, '萬華區');
  assert.equal(s.visitors, 25800230);
  assert.equal(typeof s.lat, 'number');
  assert.equal(typeof s.lng, 'number');
  assert.equal(s.setting, '商圈、夜市、老街（戶外街區）');
  for (const sp of spots) {
    assert.ok(Number.isFinite(sp.lat) && Number.isFinite(sp.lng), `${sp.name} 沒有座標`);
  }
});

test('W-2 台／臺當成同一個字', () => {
  assert.equal(normalizeName('台北市'), normalizeName('臺北市'));
  assert.equal(normalizeName('台東縣'), normalizeName('臺東縣'));
  assert.equal(normalizeName(' 台中市 '), normalizeName('臺中市'));
  assert.notEqual(normalizeName('台北市'), normalizeName('新北市'));
  // 用「台」寫的景點要對得到用「臺」寫的預報
  const idx = indexForecast([fakeResponse('臺北市', '萬華區', [], [])]);
  assert.ok(idx.has(normalizeName('台北市') + '|' + normalizeName('萬華區')));
});

test('W-3 fixture 涵蓋 22 個縣市的資料集代碼', () => {
  assert.equal(Object.keys(COUNTY_DATASETS).length, 22);
  const responses = loadFixtureResponses(fixtureDir);
  assert.equal(responses.length, 22);
});

test('W-4 每個景點的縣市＋鄉鎮在 fixture 裡都找得到', () => {
  const spots = readSpots(csvPath);
  const idx = indexForecast(loadFixtureResponses(fixtureDir));
  const missing = spots.filter(
    (s) => !idx.has(normalizeName(s.county) + '|' + normalizeName(s.town)),
  );
  assert.deepEqual(missing.map((s) => `${s.county}${s.town} ${s.name}`), []);
});

test('W-5 09:00–18:00 最高降雨機率：只算這個時段，不算前後', () => {
  const resp = fakeResponse(
    '臺北市',
    '信義區',
    [
      [t(D, '06'), t(D, '09'), 90], // 09:00 前結束，不算
      [t(D, '09'), t(D, '12'), 10],
      [t(D, '12'), t(D, '15'), 40],
      [t(D, '15'), t(D, '18'), 30],
      [t(D, '18'), t(D, '21'), 100], // 18:00 後開始，不算
      [t('2026-11-20', '09'), t('2026-11-20', '12'), 80], // 別天，不算
    ],
    [
      [t(D, '06'), 5], // 時段外，不算
      [t(D, '09'), 15],
      [t(D, '12'), 19],
      [t(D, '15'), 14],
      [t(D, '18'), 11], // 18:00 整點屬於 18–21 那段，不算（跟降雨時段同一個規則）
      [t(D, '21'), 3], // 時段外
    ],
  );
  const idx = indexForecast([resp]);
  const el = idx.get(normalizeName('臺北市') + '|' + normalizeName('信義區'));
  const day = summarizeDay(el, D);
  assert.equal(day.date, D);
  assert.equal(day.maxPop, 40);
  assert.equal(day.minAT, 14);
  assert.deepEqual(
    day.slots.map((s) => [s.start, s.end, s.pop]),
    [
      ['09:00', '12:00', 10],
      ['12:00', '15:00', 40],
      ['15:00', '18:00', 30],
    ],
  );
});

test('W-6 那天時段裡沒有資料，回傳空（不是 0）', () => {
  const resp = fakeResponse(
    '臺北市',
    '信義區',
    [[t(D, '18'), t(D, '21'), 50]],
    [[t(D, '21'), 10]],
  );
  const el = indexForecast([resp]).get(normalizeName('臺北市') + '|' + normalizeName('信義區'));
  const day = summarizeDay(el, D);
  assert.equal(day.maxPop, null);
  assert.equal(day.minAT, null);
  assert.deepEqual(day.slots, []);
});

test('W-7 降雨機率「-」或空白當作沒有資料，不當作 0', () => {
  const resp = fakeResponse(
    '臺北市',
    '信義區',
    [
      [t(D, '09'), t(D, '12'), '-'],
      [t(D, '12'), t(D, '15'), ' '],
    ],
    [],
  );
  const el = indexForecast([resp]).get(normalizeName('臺北市') + '|' + normalizeName('信義區'));
  const day = summarizeDay(el, D);
  assert.equal(day.maxPop, null);
});

test('W-8 顏色分界：20 以下綠、30–50 黃、60 以上紅、沒資料灰', () => {
  assert.equal(colorFor(0), 'green');
  assert.equal(colorFor(10), 'green');
  assert.equal(colorFor(20), 'green');
  assert.equal(colorFor(30), 'yellow');
  assert.equal(colorFor(40), 'yellow');
  assert.equal(colorFor(50), 'yellow');
  assert.equal(colorFor(60), 'red');
  assert.equal(colorFor(100), 'red');
  assert.equal(colorFor(null), 'gray');
  assert.equal(colorFor(undefined), 'gray');
  // 氣象署只會給 10 的倍數；中間值的規則：未滿 30 綠、未滿 60 黃
  assert.equal(colorFor(25), 'green');
  assert.equal(colorFor(55), 'yellow');
});

test('W-9 對不到鄉鎮的景點還是要輸出，天氣留空，並列在 unmatched', () => {
  const spots = [
    { name: 'A', county: '台北市', town: '信義區', lat: 25, lng: 121, visitors: 1, setting: '戶外' },
    { name: 'B', county: '台北市', town: '不存在區', lat: 25, lng: 121, visitors: 2, setting: '室內' },
  ];
  const resp = fakeResponse(
    '臺北市',
    '信義區',
    [[t(D, '09'), t(D, '12'), 20]],
    [[t(D, '09'), 18]],
  );
  const out = buildForecast(spots, [resp], [D, '2026-11-20', '2026-11-21'], { source: 'test' });
  assert.equal(out.spots.length, 2);
  assert.deepEqual(out.days, [D, '2026-11-20', '2026-11-21']);
  const a = out.spots.find((s) => s.name === 'A');
  const b = out.spots.find((s) => s.name === 'B');
  assert.equal(a.forecast.length, 3);
  assert.equal(a.forecast[0].maxPop, 20);
  assert.equal(a.forecast[0].minAT, 18);
  // 網頁直接用這兩個欄位，不自己算
  assert.equal(a.forecast[0].color, 'green');
  assert.equal(a.forecast[0].cold, false);
  assert.equal(a.forecast[1].color, 'gray'); // 第二天沒有資料
  assert.equal(a.forecast[1].cold, false);
  assert.equal(b.forecast, null);
  assert.deepEqual(out.unmatched, [{ name: 'B', county: '台北市', town: '不存在區' }]);
});

test('W-11 體感溫度 12 度以下標偏冷', () => {
  const mk = (v) =>
    buildForecast(
      [{ name: 'A', county: '臺北市', town: '信義區', lat: 25, lng: 121, visitors: 1, setting: '戶外' }],
      [fakeResponse('臺北市', '信義區', [[t(D, '09'), t(D, '12'), 10]], [[t(D, '09'), v]])],
      [D],
      { source: 'test' },
    ).spots[0].forecast[0].cold;
  assert.equal(mk(12), true);
  assert.equal(mk(11), true);
  assert.equal(mk(13), false);
});

test('W-12 傍晚才抓、資料從 18:00 開始：當天沒有降雨也沒有體感溫度，不標偏冷', () => {
  const resp = fakeResponse(
    '臺北市',
    '信義區',
    [[t(D, '18'), t(D, '21'), 50]],
    [[t(D, '18'), 11]],
  );
  const out = buildForecast(
    [{ name: 'A', county: '臺北市', town: '信義區', lat: 25, lng: 121, visitors: 1, setting: '戶外' }],
    [resp],
    [D],
    { source: 'test' },
  );
  const day = out.spots[0].forecast[0];
  assert.equal(day.maxPop, null);
  assert.equal(day.minAT, null);
  assert.equal(day.cold, false);
  assert.equal(day.color, 'gray');
});

test('W-13 氣象署回傳沒有任何鄉鎮資料時，當成抓取失敗', () => {
  assert.match(checkResponse({ success: 'true' }), /沒有鄉鎮資料/);
  assert.match(checkResponse({ success: 'true', records: { Locations: [] } }), /沒有鄉鎮資料/);
  assert.match(
    checkResponse({ success: 'true', records: { Locations: [{ LocationsName: '臺北市', Location: [] }] } }),
    /沒有鄉鎮資料/,
  );
  assert.match(checkResponse({ success: 'false' }), /success/);
  assert.equal(checkResponse(fakeResponse('臺北市', '信義區', [[t(D, '09'), t(D, '12'), 10]], [[t(D, '09'), 18]])), null);
});

test('W-14 有鄉鎮但沒有降雨機率（因子沒有或改名）時，也當成抓取失敗', () => {
  const noElements = {
    success: 'true',
    records: { Locations: [{ LocationsName: '臺北市', Location: [{ LocationName: '信義區', WeatherElement: [] }] }] },
  };
  assert.match(checkResponse(noElements), /降雨機率/);
  const renamed = fakeResponse('臺北市', '信義區', [[t(D, '09'), t(D, '12'), 10]], []);
  renamed.records.Locations[0].Location[0].WeatherElement[0].ElementName = '降雨機率';
  assert.match(checkResponse(renamed), /降雨機率/);
  // 只要有一個鄉鎮缺，就整份不用（不然那一區會整片灰卻沒有提示）
  const partial = fakeResponse('臺北市', '信義區', [[t(D, '09'), t(D, '12'), 10]], []);
  partial.records.Locations[0].Location.push({ LocationName: '萬華區', WeatherElement: [] });
  assert.match(checkResponse(partial), /萬華區/);
  assert.equal(checkResponse(fakeResponse('臺北市', '信義區', [[t(D, '09'), t(D, '12'), 10]], [[t(D, '09'), 18]])), null);
});

test('W-10 用 fixture 跑整份資料：190 個景點、全部對得到、三天都有三種顏色', () => {
  const spots = readSpots(csvPath);
  const responses = loadFixtureResponses(fixtureDir);
  const days = ['2026-11-19', '2026-11-20', '2026-11-21'];
  const out = buildForecast(spots, responses, days, { source: 'fixture' });
  assert.equal(out.spots.length, 190);
  assert.deepEqual(out.unmatched, []);
  for (let i = 0; i < 3; i++) {
    const colors = new Set(out.spots.map((s) => colorFor(s.forecast[i].maxPop)));
    for (const c of ['green', 'yellow', 'red']) {
      assert.ok(colors.has(c), `第 ${i + 1} 天沒有 ${c}`);
    }
  }
  // 切換日期顏色要會變：至少有景點在不同天顏色不同
  const changed = out.spots.filter(
    (s) => colorFor(s.forecast[0].maxPop) !== colorFor(s.forecast[1].maxPop),
  );
  assert.ok(changed.length > 0);
});
