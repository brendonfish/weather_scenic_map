// 旅遊天氣景點地圖：build 要選哪幾天、今天只算剩下的時段、網頁「今天／明天／後天」標籤
// 跑法：在 travel-weather-map 資料夾裡跑 `node --test`
// 卡片：https://trello.com/c/RKdT8IKA （晚上跑 build，「今天」整天灰色）
// 全部用假時鐘（固定的時間戳）和 fixtures，不連氣象署。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readSpots,
  loadFixtureResponses,
  buildForecast,
  pickDays,
  checkCountyCoverage,
  COUNTY_DATASETS,
  normalizeName,
} from '../lib/forecast.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const spots = readSpots(path.join(root, 'data', 'spots_2025_top10.csv'));
const fixtures = loadFixtureResponses(path.join(root, 'fixtures'));
const at = (s) => Date.parse(`${s}+08:00`); // 台灣時間 → 時間戳（假時鐘）
const HOUR = 3600 * 1000;

// 把一份氣象署格式回傳的所有時間往後挪 ms（輸出一樣是 +08:00 的格式）
function shift(resp, ms) {
  const fmt = (iso) => new Date(Date.parse(iso) + ms + 8 * HOUR).toISOString().slice(0, 19) + '+08:00';
  const out = structuredClone(resp);
  for (const g of out.records.Locations)
    for (const l of g.Location)
      for (const el of l.WeatherElement)
        for (const tm of el.Time) {
          for (const k of ['StartTime', 'EndTime', 'DataTime']) if (tm[k]) tm[k] = fmt(tm[k]);
        }
  return out;
}

// fixtures 的時間是 2026-11-19 06:00 到 11-22 06:00（72 小時）。
// 挪到 2026-11-21 00:00 開始：等於 2026-11-20 晚上抓到的預報（涵蓋 11/21、11/22、11/23）
const night = fixtures.map((r) => shift(r, at('2026-11-21T00:00:00') - at('2026-11-19T06:00:00')));
// 挪到 2026-11-21 12:00 開始：等於 2026-11-21 中午抓到的預報（今天 12–15 那段還在）
const noon = fixtures.map((r) => shift(r, at('2026-11-21T12:00:00') - at('2026-11-19T06:00:00')));

// forecast.json 現在按鄉鎮存：把 190 個景點接上自己鄉鎮的預報，才能用下面的 allGrayDays
const withSpots = (data) => ({
  ...data,
  spots: spots.map((s) => ({ ...s, forecast: data.towns[`${normalizeName(s.county)}|${normalizeName(s.town)}`] ?? null })),
});
const allGrayDays = (out) =>
  out.days.filter((_, i) => out.spots.every((s) => !s.forecast || s.forecast[i].color === 'gray'));

test('N-1 23:19 跑：第一天是隔天，收滿 3 天，沒有任何一天 190 個全灰', () => {
  const now = at('2026-11-20T23:19:00');
  const days = pickDays(night, now);
  assert.deepEqual(days, ['2026-11-21', '2026-11-22', '2026-11-23']);
  const out = buildForecast(spots, night, days, { source: 'cwa', nowMs: now });
  assert.equal(out.spots.length, 190);
  assert.deepEqual(allGrayDays(out), []);
  // 隔天不是「剩下的時段」：三段都在
  assert.equal(out.spots[0].forecast[0].partial, false);
  assert.equal(out.spots[0].forecast[0].slots.length, 3);
});

test('N-2 預報只涵蓋到第 3 天的清晨：只收 2 天（不收全灰的那天）', () => {
  // fixtures 原樣：2026-11-19 06:00 到 11-22 06:00；11-19 23:19 跑，11/22 白天沒有資料
  const days = pickDays(fixtures, at('2026-11-19T23:19:00'));
  assert.deepEqual(days, ['2026-11-20', '2026-11-21']);
});

test('N-3 14:00 跑：今天只有 15:00–18:00 一個時段，標成剩下的時段', () => {
  const now = at('2026-11-21T14:00:00');
  const days = pickDays(noon, now);
  assert.deepEqual(days, ['2026-11-21', '2026-11-22', '2026-11-23']);
  const out = buildForecast(spots, noon, days, { source: 'cwa', nowMs: now });
  for (const s of out.spots) {
    const today = s.forecast[0];
    assert.deepEqual(today.slots.map((x) => `${x.start}–${x.end}`), ['15:00–18:00'], s.name);
    assert.equal(today.partial, true);
    // 最高降雨機率只用剩下那一段算
    assert.equal(today.maxPop, today.slots[0].pop);
    // 明天不受影響
    assert.equal(s.forecast[1].slots.length, 3);
    assert.equal(s.forecast[1].partial, false);
  }
});

test('N-4 08:00 跑：今天三個時段都在，不是剩下的時段', () => {
  // fixtures 原樣，11-19 08:00 跑
  const now = at('2026-11-19T08:00:00');
  const days = pickDays(fixtures, now);
  assert.deepEqual(days, ['2026-11-19', '2026-11-20', '2026-11-21']);
  const out = buildForecast(spots, fixtures, days, { source: 'cwa', nowMs: now });
  for (const s of out.spots) {
    assert.deepEqual(s.forecast[0].slots.map((x) => x.start), ['09:00', '12:00', '15:00'], s.name);
    assert.equal(s.forecast[0].partial, false);
  }
});

test('N-5 今天的時段全部過了（18:30 跑）：跳過今天', () => {
  const days = pickDays(noon, at('2026-11-21T18:30:00'));
  assert.equal(days[0], '2026-11-22');
});

test('N-6 縣市門檻用新選的 days 算：晚上跑時，隔天開始的資料不算「沒資料」', () => {
  const now = at('2026-11-20T23:19:00');
  const days = pickDays(night, now);
  assert.deepEqual(checkCountyCoverage(night, days), { missing: [], error: null });
});

// 網頁的標籤邏輯放在 lib/day-labels.js（一般的 <script>，雙擊打開網頁也能用）
function loadLabels() {
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib', 'day-labels.js'), 'utf8'), ctx);
  return ctx.DayLabels;
}

test('N-7 網頁標籤：資料從 11/21 開始、打開日期是 11/21，顯示「今天 11/21」', () => {
  const L = loadLabels();
  const days = ['2026-11-21', '2026-11-22', '2026-11-23'];
  // 2026-11-21 00:42 台灣時間打開
  const today = L.taipeiDate(at('2026-11-21T00:42:00'));
  assert.equal(today, '2026-11-21');
  assert.deepEqual(days.map((d) => L.buttonText(d, today)), ['今天 11/21', '明天 11/22', '後天 11/23']);
  // 同一份資料，11/20 23:30 打開（剛跑完 build）：第一天是明天
  assert.deepEqual(
    days.map((d) => L.buttonText(d, L.taipeiDate(at('2026-11-20T23:30:00')))),
    ['明天 11/21', '後天 11/22', '大後天 11/23'],
  );
  // 預設選「今天」那顆；沒有今天就選第一顆
  assert.equal(L.defaultIndex(days, '2026-11-22'), 1);
  assert.equal(L.defaultIndex(days, '2026-11-20'), 0);
});

test('N-8 網頁：資料最後一天比今天還早才提醒重跑 build', () => {
  const L = loadLabels();
  const days = ['2026-11-21', '2026-11-22', '2026-11-23'];
  assert.equal(L.isStale(days, '2026-11-21'), false);
  assert.equal(L.isStale(days, '2026-11-23'), false);
  assert.equal(L.isStale(days, '2026-11-24'), true);
});

test('N-9 index.html 有載入 lib/day-labels.js，按鈕和景點資訊用它的標籤', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<script src="lib\/day-labels\.js"><\/script>/);
  assert.match(html, /DayLabels\.buttonText/);
  assert.match(html, /DayLabels\.isStale/);
  assert.match(html, /剩下的時段/);
  assert.ok(!html.includes("DAY_LABELS = ['今天', '明天', '後天']"), '不可以再固定把 days[0] 當今天');
});

// 整支 build-data.js 正式模式：fetch 換成讀暫存資料夾裡的假預報，Date.now 固定
function runBuild(responses, nowMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twm-days-'));
  try {
    for (const sub of ['lib', 'scripts', 'data']) fs.cpSync(path.join(root, sub), path.join(dir, sub), { recursive: true });
    fs.mkdirSync(path.join(dir, 'mock'));
    const ids = Object.values(COUNTY_DATASETS);
    responses.forEach((r, i) => fs.writeFileSync(path.join(dir, 'mock', `${ids[i]}.json`), JSON.stringify(r)));
    const mock =
      `import fs from 'node:fs';` +
      `globalThis.fetch = async (url) => { const id = String(url).match(/F-D0047-\\d+/)[0];` +
      ` const body = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'mock'))} + '/' + id + '.json', 'utf8'));` +
      ` return { ok: true, status: 200, json: async () => body }; };` +
      `Date.now = () => ${nowMs};`;
    const r = spawnSync(
      process.execPath,
      ['--import', 'data:text/javascript,' + encodeURIComponent(mock), path.join(dir, 'scripts', 'build-data.js')],
      { env: { ...process.env, CWA_API_KEY: 'FAKE-SECRET' }, encoding: 'utf8' },
    );
    const file = path.join(dir, 'public', 'forecast.json');
    return { ...r, data: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('N-10 build-data.js 23:19 跑：forecast.json 的 days 是 11/21、11/22、11/23，沒有全灰的一天', () => {
  const r = runBuild(night, at('2026-11-20T23:19:00'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.data.days, ['2026-11-21', '2026-11-22', '2026-11-23']);
  assert.equal(withSpots(r.data).spots.filter((x) => x.forecast).length, 190);
  assert.deepEqual(allGrayDays(withSpots(r.data)), []);
  assert.match(r.stdout, /日期：2026-11-21、2026-11-22、2026-11-23/);
});

test('N-11 build-data.js 第 3 天沒資料：只收 2 天，終端機說明', () => {
  // fixtures 原樣（到 11-22 06:00），11-19 23:19 跑
  const r = runBuild(fixtures, at('2026-11-19T23:19:00'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.data.days, ['2026-11-20', '2026-11-21']);
  assert.match(r.stdout, /只收 2 天/);
});

test('N-12 build-data.js 14:00 跑：今天只剩 15:00–18:00，標成剩下的時段', () => {
  const r = runBuild(noon, at('2026-11-21T14:00:00'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.data.days[0], '2026-11-21');
  const today = withSpots(r.data).spots[0].forecast[0];
  assert.deepEqual(today.slots.map((x) => x.start), ['15:00']);
  assert.equal(today.partial, true);
});

// 第一輪檢查找到的問題（2026-11-21）
test('N-13 預報只涵蓋到某天中午：那天不收（不把只有 09–12 的一天當成完整的 09:00–18:00）', () => {
  // 預報 11/20 12:00 開始、涵蓋到 11/23 12:00；11/20 16:00 跑
  const resp = fixtures.map((r) => shift(r, at('2026-11-20T12:00:00') - at('2026-11-19T06:00:00')));
  assert.deepEqual(pickDays(resp, at('2026-11-20T16:00:00')), ['2026-11-21', '2026-11-22']);
});

test('N-14 白天跑：最低體感溫度只用剩下的時段（13:30 跑，14:00 那筆不算）', async () => {
  const { summarizeDay } = await import('../lib/forecast.js');
  const entry = { pop: [], at: [] };
  for (const h of ['09', '12', '15'])
    entry.pop.push({ start: `2026-11-21T${h}:00:00+08:00`, end: `2026-11-21T${Number(h) + 3}:00:00+08:00`, value: 10 });
  for (let h = 9; h < 18; h++)
    entry.at.push({ time: `2026-11-21T${String(h).padStart(2, '0')}:00:00+08:00`, value: h === 14 ? 5 : 20 });
  const d = summarizeDay(entry, '2026-11-21', at('2026-11-21T13:30:00'));
  assert.deepEqual(d.slots.map((x) => x.start), ['15:00']);
  assert.equal(d.minAT, 20);
});

test('N-15 縣市門檻：已經過去的時段不算有資料', () => {
  // 21 個縣市的預報只到 11/21 12:00（舊資料），1 個縣市是新的；11/21 14:00 跑
  const stale = fixtures.map((r) => shift(r, at('2026-11-21T12:00:00') - at('2026-11-22T06:00:00')));
  const resp = stale.map((r, i) => (i === 0 ? noon[0] : r));
  const now = at('2026-11-21T14:00:00');
  const days = pickDays(resp, now);
  const cov = checkCountyCoverage(resp, days, now);
  assert.equal(cov.missing.length, 21);
  assert.match(cov.error, /21 個縣市/);
});

test('N-16 build-data.js：縣市沒資料的訊息寫實際的日期，不寫「今天到後天」', () => {
  const resp = night.map((r, i) => (i < 3 ? shift(r, -30 * 86400 * 1000) : r));
  const r = runBuild(resp, at('2026-11-20T23:19:00'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 個縣市沒有 2026-11-21、2026-11-22、2026-11-23 的資料/);
  assert.ok(!r.stdout.includes('今天到後天'), r.stdout);
});

// 2026-11-21 16:46 Ray 決定 (a)：每個景點各自檢查自己的預報有沒有涵蓋到 18:00
test('N-17 抓到一半氣象署更新（21 縣市舊版、金門新版）：第 3 天舊版的 180 個景點灰色、標「預報只到 12:00」，金門照常', () => {
  // 舊版：11/20 12:00–11/23 12:00；新版：11/20 18:00–11/23 18:00；11/20 17:31 跑
  const oldIssue = fixtures.map((r) => shift(r, at('2026-11-20T12:00:00') - at('2026-11-19T06:00:00')));
  const newIssue = fixtures.map((r) => shift(r, at('2026-11-20T18:00:00') - at('2026-11-19T06:00:00')));
  const kinmen = Object.keys(COUNTY_DATASETS).indexOf('金門縣');
  const mixed = oldIssue.map((r, i) => (i === kinmen ? newIssue[i] : r));
  const now = at('2026-11-20T17:31:00');
  const days = pickDays(mixed, now);
  assert.deepEqual(days, ['2026-11-21', '2026-11-22', '2026-11-23']); // pickDays 規則不改
  const out = buildForecast(spots, mixed, days, { source: 'cwa', nowMs: now });
  const day3 = out.spots.map((s) => ({ county: s.county, f: s.forecast[2] }));
  const others = day3.filter((x) => x.county !== '金門縣');
  const km = day3.filter((x) => x.county === '金門縣');
  assert.equal(others.length, 180);
  assert.equal(km.length, 10);
  for (const x of others) {
    assert.equal(x.f.color, 'gray');
    assert.equal(x.f.maxPop, null);
    assert.equal(x.f.minAT, null);
    assert.equal(x.f.cold, false);
    assert.equal(x.f.coverUntil, '12:00');
  }
  for (const x of km) {
    assert.notEqual(x.f.color, 'gray');
    assert.equal(x.f.coverUntil, null);
    assert.equal(x.f.slots.length, 3);
  }
  // 前兩天大家都涵蓋到 18:00，照常
  for (const s of out.spots) for (const i of [0, 1]) assert.equal(s.forecast[i].coverUntil, null);
});

test('N-18 index.html 景點資訊會顯示「預報只到 HH:MM」', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /預報只到/);
  assert.match(html, /coverUntil/);
});
