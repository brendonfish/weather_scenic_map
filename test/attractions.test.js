// 旅遊天氣景點地圖：景點庫擴充（1/2）——觀光署景點資料清理、分四層、分類
// 跑法：在 travel-weather-map 資料夾裡跑 `node --test`
// 卡片：https://trello.com/c/Y0UgCAWS （AI 小工具板）
// 只用小的假資料和暫存資料夾，不連網路。最後幾個測試檢查 repo 裡真的 data/attractions.json。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseCsv,
  readVisitors,
  nameKey,
  cleanAttractions,
  typesOf,
  weatherFitOf,
  richnessOf,
  excerptOf,
  layer3Quota,
  loadLayerConfig,
  buildAttractions,
} from '../lib/attractions.js';
import { readSpots, loadFixtureResponses, pickDays, buildTownForecast, buildForecast } from '../lib/forecast.js';
import { runPage } from './_page.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = { ratio: 0.25, min: 2, max: 10 };

// 一筆假的觀光署景點，沒給的欄位用最「空」的值（豐富度 0 分）
let seq = 0;
function attr(o = {}) {
  seq++;
  return {
    AttractionID: o.id ?? `Attraction_T_${String(seq).padStart(5, '0')}`,
    AttractionName: o.name ?? `景點${seq}`,
    Description: o.desc ?? '短描述',
    PositionLat: o.lat ?? 25,
    PositionLon: o.lng ?? 121.5,
    AttractionClasses: o.classes ?? [],
    PostalAddress: { City: o.city ?? '臺北市', Town: o.town ?? '中正區' },
    Images: o.images ?? [{ Name: '照片', URL: 'https://example.test/a.jpg' }],
    ServiceStatus: o.status ?? 1,
    WebsiteURL: o.web ?? '',
    ServiceTimeInfo: o.svc ?? '',
    AssetsClass: o.assets ?? null,
  };
}

// ---- 2. 清理 ----

test('A-1 ServiceStatus 不是 1 的拿掉（0 永久停止、3 暫停）', () => {
  const out = cleanAttractions([attr({ name: '甲' }), attr({ name: '乙', status: 0 }), attr({ name: '丙', status: 3 })]);
  assert.deepEqual(out.kept.map((a) => a.AttractionName), ['甲']);
  assert.equal(out.removedStatus, 2);
});

test('A-2 同名而且 1 公里內只留一筆；同名但距離遠的兩筆都留', () => {
  const near = [attr({ name: '龍山寺', lat: 25.0371, lng: 121.4999 }), attr({ name: '龍山寺', lat: 25.0372, lng: 121.5001 })];
  const far = [attr({ name: '龍山寺', lat: 24.0, lng: 120.6 })];
  const out = cleanAttractions([...near, ...far]);
  assert.equal(out.kept.length, 2);
  assert.equal(out.removedDup, 1);
  // 留下的是 AttractionID 排前面那一筆
  assert.ok(out.kept.some((a) => a.AttractionID === near[0].AttractionID));
});

test('A-3 比名字前去掉空白和括號，「臺」「台」當同一個字', () => {
  assert.equal(nameKey(' 臺北 (101) '), nameKey('台北101'));
  assert.equal(nameKey('九宮（四維）坑道'), nameKey('九宮四維坑道'));
  const out = cleanAttractions([attr({ name: '臺南孔廟' }), attr({ name: '台南 孔廟' })]);
  assert.equal(out.kept.length, 1);
});

// ---- 5. 類型 ----

test('A-4 每個類型的代碼對應各測一個', () => {
  assert.deepEqual(typesOf([7]), ['自然山林']);
  assert.deepEqual(typesOf([10]), ['水域溫泉']);
  assert.deepEqual(typesOf([3]), ['古蹟文化']);
  assert.deepEqual(typesOf([4]), ['宗教廟宇']);
  assert.deepEqual(typesOf([14]), ['室內場館']);
  assert.deepEqual(typesOf([13]), ['公園運動']);
  assert.deepEqual(typesOf([12]), ['農場樂園遊憩']);
  assert.deepEqual(typesOf([6]), ['商圈市集']);
  assert.deepEqual(typesOf([23]), ['其他']);
  assert.deepEqual(typesOf([999]), ['其他']); // 對不上的
  assert.deepEqual(typesOf([]), ['其他']);
  // 可以多個；照表格順序，第一個是主要類型
  assert.deepEqual(typesOf([4, 1]), ['古蹟文化', '宗教廟宇']);
});

test('A-5 代碼 18 歸「其他」；只有代碼 8 歸「其他」，8 加別的代碼就看別的', () => {
  assert.deepEqual(typesOf([18]), ['其他']);
  assert.deepEqual(typesOf([8]), ['其他']);
  assert.deepEqual(typesOf([8, 11]), ['自然山林']);
});

// ---- 6. 天氣適配 ----

test('A-6 weatherFit 三種結果', () => {
  assert.equal(weatherFitOf([16]), '好天氣才去');
  assert.equal(weatherFitOf([8]), '好天氣才去');
  assert.equal(weatherFitOf([5]), '雨天備案');
  assert.equal(weatherFitOf([7, 5]), '不分'); // 兩邊都有
  assert.equal(weatherFitOf([4]), '不分'); // 兩邊都沒有
});

// ---- 4. 資料豐富度 ----

test('A-7 richness 六項各 1 分', () => {
  assert.equal(richnessOf(attr()), 0);
  assert.equal(richnessOf(attr({ classes: [20] })), 1);
  assert.equal(richnessOf(attr({ classes: [7] })), 1);
  assert.equal(richnessOf(attr({ web: 'https://example.test' })), 1);
  const img = { Name: 'x', URL: 'https://example.test/x.jpg' };
  assert.equal(richnessOf(attr({ images: [img, img] })), 0);
  assert.equal(richnessOf(attr({ images: [img, img, img] })), 1);
  assert.equal(richnessOf(attr({ desc: '字'.repeat(279) })), 0);
  assert.equal(richnessOf(attr({ desc: '字'.repeat(280) })), 1);
  assert.equal(richnessOf(attr({ svc: '每日開放' })), 1);
  assert.equal(richnessOf(attr({ svc: '  ' })), 0);
  assert.equal(richnessOf(attr({ assets: 0 })), 0);
  assert.equal(richnessOf(attr({ assets: 5 })), 1);
  const full = attr({ classes: [8], web: 'https://x.test', images: [img, img, img], desc: '字'.repeat(300), svc: '每日', assets: 3 });
  assert.equal(richnessOf(full), 6);
});

// ---- 7. 描述 ----

test('A-8 excerpt：前 60 個字，超過加「…」，不改寫', () => {
  assert.equal(excerptOf('短的'), '短的');
  assert.equal(excerptOf('字'.repeat(60)), '字'.repeat(60));
  assert.equal(excerptOf('甲'.repeat(59) + '乙丙'), '甲'.repeat(59) + '乙…');
  assert.equal(excerptOf(undefined), '');
});

// ---- 3. 第 3 層的數量 ----

test('A-9 第 3 層取的數量：1、2、8、14、40、65 個景點 → 1、2、2、4、10、10', () => {
  assert.deepEqual([1, 2, 8, 14, 40, 65].map((n) => layer3Quota(n, CONFIG)), [1, 2, 2, 4, 10, 10]);
  assert.equal(layer3Quota(0, CONFIG), 0);
});

test('A-9b 第 3 層數量不受浮點誤差影響：100 × 0.07 剛好是 7，不會多取成 8', () => {
  const cfg = { ratio: 0.07, min: 0, max: 1000 };
  assert.equal(layer3Quota(100, cfg), 7);
  assert.equal(layer3Quota(1000, cfg), 70);
  assert.equal(layer3Quota(101, cfg), 8); // 7.07 還是要無條件進位
});

test('A-10 改 layer-config.json 的數字，結果會跟著變', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twm-layer-'));
  try {
    const file = path.join(dir, 'layer-config.json');
    fs.writeFileSync(file, JSON.stringify({ layer3: { ratio: 0.5, min: 3, max: 5 } }));
    const cfg = loadLayerConfig(file);
    assert.deepEqual([1, 2, 4, 8, 14].map((n) => layer3Quota(n, cfg)), [1, 2, 3, 4, 5]);
    // 整個流程也跟著變：一個鄉鎮 8 個景點，比例 0.5 → 最多 5 個進第 3 層
    const pool = Array.from({ length: 8 }, () => attr({ town: '萬華區' }));
    const count = (c) => buildAttractions({ attractions: pool, visitors: [], top: [], config: c }).list.filter((a) => a.layer === 3).length;
    assert.equal(count(cfg), 4);
    assert.equal(count(CONFIG), 2);
    // repo 裡的設定檔就是卡片寫的數字
    assert.deepEqual(loadLayerConfig(path.join(root, 'data', 'layer-config.json')), CONFIG);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A-11 第 3 層：依豐富度挑，同分描述長的優先，再同分用 AttractionID；不到 2 個的鄉鎮全取', () => {
  const img = { Name: 'x', URL: 'https://example.test/x.jpg' };
  const pool = [
    attr({ id: 'Attraction_T_B', town: '大同區', desc: '短' }),
    attr({ id: 'Attraction_T_A', town: '大同區', desc: '短' }),
    attr({ id: 'Attraction_T_C', town: '大同區', desc: '長一點的描述' }),
    attr({ id: 'Attraction_T_D', town: '大同區', web: 'https://x.test', images: [img, img, img] }),
    attr({ id: 'Attraction_T_E', town: '大同區' }),
    attr({ id: 'Attraction_T_F', town: '大同區' }),
    attr({ id: 'Attraction_T_G', town: '大同區' }),
    attr({ id: 'Attraction_T_H', town: '大同區' }),
    attr({ id: 'Attraction_T_Z', town: '士林區' }),
  ];
  const { list } = buildAttractions({ attractions: pool, visitors: [], top: [], config: CONFIG });
  const l3 = list.filter((a) => a.layer === 3).map((a) => a.id).sort();
  // 大同區 8 個 → 取 2 個：D（2 分），C（描述長）；士林區只有 1 個 → 全取
  assert.deepEqual(l3, ['Attraction_T_C', 'Attraction_T_D', 'Attraction_T_Z']);
  assert.equal(list.filter((a) => a.layer === 4).length, 6);
});

// ---- 人次統計 CSV ----

test('A-12 人次統計 CSV：欄位裡有換行也讀得對，只拿指定年份', () => {
  const csv =
    '﻿年別,類型,觀光遊憩區,細分,縣市,縣市別,1月,合計\n' +
    '2024,國家公園,墾丁國家公園," 鵝鑾鼻公園","屏東縣\nPingtung County",10013,5,1000\n' +
    '2024,其他,某區,"有,逗號""引號""",臺北市,63000,1,20\r\n' +
    '2023,其他,某區,舊年份,臺北市,63000,1,30\n';
  assert.equal(parseCsv(csv).length, 4);
  const rows = readVisitors(csv, '2024');
  assert.deepEqual(rows, [
    { name: '鵝鑾鼻公園', county: '屏東縣', total: 1000 },
    { name: '有,逗號"引號"', county: '臺北市', total: 20 },
  ]);
});

// ---- 3. 分四層＋合併第 1 層 ----

const TOP = [
  { name: '西門町商圈', county: '台北市', town: '萬華區', lat: 25.0446, lng: 121.5075, visitors: 25800230, setting: '商圈、夜市、老街（戶外街區）', point: '西門町' },
  { name: '國立故宮博物院', county: '台北市', town: '士林區', lat: 25.1024, lng: 121.5485, visitors: 3000000, setting: '室內', point: '國立故宮博物院' },
  { name: '沒有資料的景點', county: '台北市', town: '北投區', lat: 25.13, lng: 121.5, visitors: 10, setting: '室內外都有', point: '沒有資料的景點' },
];

test('A-13 第 1 層：沿用原本的座標、人次、室內戶外；資料庫找得到的補上照片、描述、分類', () => {
  const pool = [
    attr({ id: 'Attraction_T_X', name: '西門町', city: '臺北市', town: '萬華區', lat: 25.0421, lng: 121.5081, classes: [6], desc: '西門町是台北最熱鬧的商圈' }),
    attr({ id: 'Attraction_T_P', name: '國立故宮博物院', city: '臺北市', town: '士林區', lat: 25.1023, lng: 121.5484, classes: [5] }),
    // 同名但在 1 公里外：不是同一個
    attr({ id: 'Attraction_T_Q', name: '沒有資料的景點', city: '臺北市', town: '大安區', lat: 25.02, lng: 121.54 }),
  ];
  const { list, stats } = buildAttractions({ attractions: pool, visitors: [], top: TOP, config: CONFIG });
  const l1 = list.filter((a) => a.layer === 1);
  assert.equal(l1.length, 3);
  const xm = l1.find((a) => a.name === '西門町商圈');
  assert.equal(xm.id, 'Attraction_T_X');
  assert.equal(xm.county, '台北市'); // 原本的寫法，車程檔用它對景點
  assert.equal(xm.lat, 25.0446);
  assert.equal(xm.visitors, 25800230);
  assert.equal(xm.setting, '商圈、夜市、老街（戶外街區）');
  assert.deepEqual(xm.types, ['商圈市集']);
  assert.equal(xm.weatherFit, '好天氣才去'); // 戶外
  assert.equal(xm.excerpt, '西門町是台北最熱鬧的商圈');
  assert.deepEqual(xm.image, { url: 'https://example.test/a.jpg', name: '照片' });
  assert.equal(l1.find((a) => a.name === '國立故宮博物院').weatherFit, '雨天備案'); // 室內
  const none = l1.find((a) => a.name === '沒有資料的景點');
  assert.equal(none.image, null);
  assert.equal(none.weatherFit, '不分'); // 室內外都有
  assert.match(none.id, /^Top190_/);
  // 合併掉的那一筆不會再出現在其他層
  assert.equal(list.filter((a) => a.id === 'Attraction_T_X').length, 1);
  assert.equal(stats.layer1Merged, 2);
  // 1 公里外那一筆照常留在資料裡（第 3 層或第 4 層）
  assert.ok(list.some((a) => a.id === 'Attraction_T_Q' && a.layer >= 3));
});

test('A-14 第 2 層：名字完全一樣自動對上；部分相同列出來給人檢查；對不上的不放、不猜座標', () => {
  const pool = [
    attr({ id: 'Attraction_T_1', name: '鵝鑾鼻公園', city: '屏東縣', town: '恆春鎮' }),
    attr({ id: 'Attraction_T_2', name: '七股鹽山', city: '臺南市', town: '七股區' }),
    attr({ id: 'Attraction_T_3', name: '國立故宮博物院', city: '臺北市', town: '士林區', lat: 25.1023, lng: 121.5484 }),
  ];
  const visitors = [
    { name: '鵝鑾鼻公園', county: '屏東縣', total: 100 },
    { name: '七股鹽業遊憩區七股鹽山', county: '臺南市', total: 50 },
    { name: '找不到的地方', county: '臺東縣', total: 10 },
    { name: '國立故宮博物院', county: '臺北市', total: 999 }, // 已經在第 1 層
  ];
  const { list, stats, partial, unmatched } = buildAttractions({ attractions: pool, visitors, top: TOP, config: CONFIG });
  const l2 = list.filter((a) => a.layer === 2);
  assert.deepEqual(l2.map((a) => a.id), ['Attraction_T_1']);
  assert.equal(stats.layer2Auto, 1);
  assert.deepEqual(partial, [{ statName: '七股鹽業遊憩區七股鹽山', county: '臺南市', name: '七股鹽山', id: 'Attraction_T_2' }]);
  assert.deepEqual(unmatched, [{ statName: '找不到的地方', county: '臺東縣', reason: '資料庫找不到' }]);
  assert.equal(list.find((a) => a.id === 'Attraction_T_2').layer >= 3, true); // 待檢查的這一版不放第 2 層
  assert.equal(list.filter((a) => a.name === '找不到的地方').length, 0);
});

test('A-15 每一筆輸出都有該有的欄位，AttractionID 不重複', () => {
  const pool = [attr({ name: '甲', classes: [16], web: 'https://a.test' }), attr({ name: '乙', city: '宜蘭縣', town: '礁溪鄉' })];
  const { list } = buildAttractions({ attractions: pool, visitors: [], top: [], config: CONFIG });
  const a = list.find((x) => x.name === '甲');
  assert.deepEqual(Object.keys(a).sort(), ['county', 'excerpt', 'id', 'image', 'lat', 'layer', 'lng', 'name', 'richness', 'town', 'types', 'weatherFit', 'website'].sort());
  assert.equal(a.website, 'https://a.test');
  assert.equal(list.find((x) => x.name === '乙').website, '');
  assert.equal(new Set(list.map((x) => x.id)).size, list.length);
});

test('A-21 人次統計的景點名稱欄位裡有換行＋英文：只取第一行來比名字', () => {
  const csv = '年別,類型,觀光遊憩區,細分,縣市,縣市別,合計\n2024,其他,某區,"甲樂園\nJia Park",花蓮縣,10015,100\n';
  assert.deepEqual(readVisitors(csv, '2024'), [{ name: '甲樂園', county: '花蓮縣', total: 100 }]);
});

test('A-22 第 2 層：統計名稱對到已經併進第 1 層的景點，不算對不上；停業、暫停的標出原因', () => {
  const pool = [
    attr({ id: 'Attraction_T_8', name: '八里左岸公園', city: '新北市', town: '八里區', lat: 25.16, lng: 121.43 }),
    attr({ id: 'Attraction_T_9', name: '六十石山', city: '花蓮縣', town: '富里鄉', status: 3 }),
  ];
  const top = [{ name: '八里左岸公園及周邊地區', county: '新北市', town: '八里區', lat: 25.1601, lng: 121.4301, visitors: 1, setting: '戶外', point: '八里左岸公園' }];
  const visitors = [
    { name: '八里左岸公園', county: '新北市', total: 5 },
    { name: '六十石山', county: '花蓮縣', total: 5 },
  ];
  const { list, stats, unmatched } = buildAttractions({ attractions: pool, visitors, top, config: CONFIG });
  assert.equal(list.find((a) => a.id === 'Attraction_T_8').layer, 1);
  assert.equal(stats.layer2InLayer1, 1);
  assert.deepEqual(unmatched, [{ statName: '六十石山', county: '花蓮縣', reason: '觀光署資料標示停業或暫停' }]);
});

// ---- 8. 預報按鄉鎮存 ----

test('A-16 預報按鄉鎮存：一個鄉鎮一份，景點用縣市＋鄉鎮去查；對不到的鄉鎮列出來', () => {
  const responses = loadFixtureResponses(path.join(root, 'fixtures'));
  const spots = readSpots(path.join(root, 'data', 'spots_2025_top10.csv'));
  const nowMs = Date.parse('2026-11-19T00:00:00+08:00');
  const days = pickDays(responses, nowMs);
  const extra = [
    { name: '同鄉鎮另一個', county: '臺北市', town: '萬華區' },
    { name: '不存在', county: '臺北市', town: '不存在區' },
  ];
  const out = buildTownForecast([...spots, ...extra], responses, days, { source: 'fixture', nowMs });
  assert.equal(out.spots, undefined); // 不再每個景點存一份
  assert.equal(out.towns['臺北市|萬華區'].length, days.length);
  assert.deepEqual(out.unmatched, [{ county: '臺北市', town: '不存在區', count: 1 }]);
  // 只存景點用得到的鄉鎮
  const used = new Set(spots.map((s) => `${s.county.replace(/台/g, '臺')}|${s.town.replace(/台/g, '臺')}`));
  for (const k of Object.keys(out.towns)) assert.ok(used.has(k) || k === '臺北市|萬華區', k);
  // 跟以前「每個景點一份」算出來的一模一樣
  const old = buildForecast(spots, responses, days, { source: 'fixture', nowMs });
  for (const s of old.spots) assert.deepEqual(out.towns[`${s.county.replace(/台/g, '臺')}|${s.town.replace(/台/g, '臺')}`], s.forecast);
});

test('A-17 現有網頁只顯示第 1 層，用鄉鎮預報上色', async () => {
  const responses = loadFixtureResponses(path.join(root, 'fixtures'));
  const spots = readSpots(path.join(root, 'data', 'spots_2025_top10.csv'));
  const nowMs = Date.parse('2026-11-19T00:00:00+08:00');
  const days = pickDays(responses, nowMs);
  const forecast = buildTownForecast(spots, responses, days, { source: 'fixture', nowMs });
  const attractions = [
    ...spots.map((s, i) => ({ ...s, id: `T${i}`, layer: 1 })),
    { id: 'L2', name: '第二層景點', county: '臺北市', town: '萬華區', lat: 25, lng: 121.5, layer: 2 },
    { id: 'L3', name: '第三層景點', county: '臺北市', town: '萬華區', lat: 25, lng: 121.5, layer: 3 },
  ];
  const { els, rec } = await runPage(forecast, { attractions });
  assert.equal(rec.markers.length, 190);
  assert.ok(!rec.markers.some((m) => /第二層|第三層/.test(m.opts.title)));
  assert.match(els.info.textContent, /顯示 190 \/ 190 個景點/);
  // 顏色跟舊的「每個景點一份」一樣
  const old = buildForecast(spots, responses, days, { source: 'fixture', nowMs });
  const want = old.spots.map((s) => s.forecast[0].color);
  const got = rec.markers.map((m) => m.opts.icon.html.match(/data-color="(\w+)"/)[1]);
  assert.deepEqual(got, want);
});

// ---- build 和真的資料 ----

test('A-18 用 fixture 跑 build：讀 data/attractions.json，產出按鄉鎮的預報和網頁用的景點檔', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twm-attr-'));
  try {
    for (const sub of ['lib', 'scripts', 'data', 'fixtures']) fs.cpSync(path.join(root, sub), path.join(dir, sub), { recursive: true });
    fs.rmSync(path.join(dir, 'data', 'raw'), { recursive: true, force: true });
    const r = spawnSync(process.execPath, ['scripts/build-data.js', '--fixture'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const fc = JSON.parse(fs.readFileSync(path.join(dir, 'public', 'forecast.json'), 'utf8'));
    assert.ok(fc.towns && !fc.spots);
    const all = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'attractions.json'), 'utf8'));
    const pub = fs.readFileSync(path.join(dir, 'public', 'attractions.js'), 'utf8');
    assert.match(pub, /^window\.ATTRACTIONS_DATA = /);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'public', 'attractions.json'), 'utf8')).length, all.length);
    assert.match(r.stdout, /對不到鄉鎮預報的景點 \d+ 個/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A-19 GitHub Actions 不會去下載景點資料，排程沒改', () => {
  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'update-forecast.yml'), 'utf8');
  const site = fs.readFileSync(path.join(root, 'scripts', 'build-site.sh'), 'utf8');
  for (const text of [wf, site]) {
    assert.doesNotMatch(text, /fetch-attractions|build-attractions|taiwan\.net\.tw/);
  }
  assert.match(wf, /cron: '30 21 \* \* \*'/);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^data\/raw\/$/m);
});

test('A-20 真的 data/attractions.json：欄位齊全、原本 190 個都在第 1 層、AttractionID 不重複', () => {
  const list = JSON.parse(fs.readFileSync(path.join(root, 'data', 'attractions.json'), 'utf8'));
  assert.ok(list.length > 5000, `只有 ${list.length} 筆`);
  for (const a of list) {
    for (const k of ['name', 'county', 'town', 'layer', 'types', 'weatherFit', 'richness']) assert.ok(a[k] !== undefined && a[k] !== '', `${a.id} 少了 ${k}`);
    assert.ok(Number.isFinite(a.lat) && Number.isFinite(a.lng), `${a.id} 座標`);
    assert.ok([1, 2, 3, 4].includes(a.layer));
    assert.ok(a.types.length >= 1);
    assert.ok(['好天氣才去', '雨天備案', '不分'].includes(a.weatherFit));
    assert.ok(a.richness >= 0 && a.richness <= 6);
    // 第 1 層有些在觀光署景點資料庫找不到同一個景點（卡片：「找得到的」才補照片），沒有照片；其他每一筆都要有
    if (a.layer !== 1) assert.ok(a.image && /^https:\/\//.test(a.image.url), `${a.id} 沒有照片`);
  }
  const spots = readSpots(path.join(root, 'data', 'spots_2025_top10.csv'));
  const l1 = list.filter((a) => a.layer === 1);
  assert.equal(l1.length, 190);
  for (const s of spots) assert.ok(l1.some((a) => a.name === s.name && a.county === s.county && a.lat === s.lat && a.lng === s.lng), s.name);
  assert.equal(new Set(list.map((a) => a.id)).size, list.length);
});

// ---- 卡片 https://trello.com/c/c5TDNGOk ：第 1 層跟第 2–4 層重複的同一個地點只留一筆 ----

// 一個第 1 層景點（spots_2025_top10.csv 的欄位）
const l1spot = (o) => ({ county: '嘉義縣', town: '太保市', lat: 23.4720, lng: 120.2915, visitors: 1, setting: '室內', point: '', ...o });
// 往北移 km 公里的緯度
const north = (lat, km) => lat + km / 111.2;
const layerOf = (list, id) => list.find((a) => a.id === id)?.layer;

test('D-1 名字一邊包含另一邊、0.3 公里內：併成一筆，沒照片的補上照片，那一筆不再出現在第 2–4 層', () => {
  const top = [l1spot({ name: '國立故宮博物院南部院區' })];
  const pool = [attr({ id: 'Attraction_T_GG', name: '故宮博物院-南部院區', city: '嘉義縣', town: '太保市', lat: 23.4722, lng: 120.2917, images: [{ Name: '南院', URL: 'https://example.test/nanyuan.jpg' }] })];
  const { list } = buildAttractions({ attractions: pool, visitors: [], top, config: CONFIG });
  const l1 = list.find((a) => a.layer === 1);
  assert.equal(l1.id, 'Attraction_T_GG');
  assert.deepEqual(l1.image, { url: 'https://example.test/nanyuan.jpg', name: '南院' });
  assert.equal(l1.name, '國立故宮博物院南部院區'); // 名稱、座標照原本的
  assert.equal(l1.lat, 23.4720);
  assert.equal(list.length, 1);
});

test('D-2 名字包含但超過 0.3 公里：不併，兩筆都在', () => {
  const top = [l1spot({ name: '國立故宮博物院南部院區' })];
  const pool = [attr({ id: 'Attraction_T_FAR', name: '故宮博物院-南部院區', city: '嘉義縣', town: '太保市', lat: north(23.4720, 0.4), lng: 120.2915 })];
  const { list } = buildAttractions({ attractions: pool, visitors: [], top, config: CONFIG });
  assert.equal(list.find((a) => a.layer === 1).image, null);
  assert.ok([3, 4].includes(layerOf(list, 'Attraction_T_FAR')));
});

test('D-3 比較短的名字不到 4 個字（例如「安平」）：不併', () => {
  const top = [l1spot({ name: '安平', county: '台南市', town: '安平區', lat: 23.0015, lng: 120.1606 })];
  const pool = [attr({ id: 'Attraction_T_AP', name: '安平樹屋', city: '臺南市', town: '安平區', lat: 23.0016, lng: 120.1607 })];
  const { list } = buildAttractions({ attractions: pool, visitors: [], top, config: CONFIG });
  assert.equal(list.find((a) => a.layer === 1).image, null);
  assert.ok([3, 4].includes(layerOf(list, 'Attraction_T_AP')));
});

test('D-4 「仔」「子」不同字、名字在括號裡也對得到（蚵仔寮漁港 ↔ 潮旅梓官（蚵子寮漁港））', () => {
  const top = [l1spot({ name: '蚵仔寮漁港', county: '高雄市', town: '梓官區', lat: 22.7270, lng: 120.2440, setting: '戶外' })];
  const pool = [attr({ id: 'Attraction_T_KZ', name: '潮旅梓官（蚵子寮漁港）', city: '高雄市', town: '梓官區', lat: 22.7275, lng: 120.2443 })];
  const { list } = buildAttractions({ attractions: pool, visitors: [], top, config: CONFIG });
  assert.equal(list.find((a) => a.layer === 1).id, 'Attraction_T_KZ');
  assert.equal(list.length, 1);
});

test('D-5 第 1 層已經有照片（名字完全一樣併過）：照片不換，另一筆重複的從第 2–4 層消失', () => {
  const top = [l1spot({ name: '檜意森活村', county: '嘉義市', town: '東區', lat: 23.4870, lng: 120.4520, setting: '戶外' })];
  const pool = [
    attr({ id: 'Attraction_T_HY1', name: '檜意森活村', city: '嘉義市', town: '東區', lat: 23.4871, lng: 120.4521, images: [{ Name: '原本', URL: 'https://example.test/hy1.jpg' }] }),
    attr({ id: 'Attraction_T_HY2', name: '阿里山林業村暨檜意森活村', city: '嘉義市', town: '東區', lat: 23.4872, lng: 120.4522, images: [{ Name: '另一張', URL: 'https://example.test/hy2.jpg' }] }),
    attr({ id: 'Attraction_T_OTHER', name: '嘉義公園', city: '嘉義市', town: '東區', lat: 23.4800, lng: 120.4600 }),
  ];
  const { list, stats } = buildAttractions({ attractions: pool, visitors: [], top, config: CONFIG });
  const l1 = list.find((a) => a.layer === 1);
  assert.equal(l1.id, 'Attraction_T_HY1');
  assert.equal(l1.image.url, 'https://example.test/hy1.jpg');
  assert.equal(layerOf(list, 'Attraction_T_HY2'), undefined);
  assert.ok([3, 4].includes(layerOf(list, 'Attraction_T_OTHER')));
  assert.equal(stats.layer1Duplicates, 1);
});

test('D-6 對照表（data/layer1-aliases.csv）的那一筆會併進來；repo 裡的對照表有林口三井Outlet', () => {
  const top = [l1spot({ name: '林口三井Outlet', county: '新北市', town: '林口區', lat: 25.0703, lng: 121.3654, setting: '室內' })];
  const pool = [
    attr({ id: 'Attraction_T_MO', name: 'Mitsui Outlet Park 林口', city: '新北市', town: '林口區', lat: 25.0710, lng: 121.3660, images: [{ Name: 'Outlet', URL: 'https://example.test/mo.jpg' }] }),
    attr({ id: 'Attraction_T_LIB', name: '新北市立圖書館林口分館', city: '新北市', town: '林口區', lat: 25.0712, lng: 121.3662 }),
  ];
  const aliases = [{ name: '林口三井Outlet', id: 'Attraction_T_MO' }];
  const { list } = buildAttractions({ attractions: pool, visitors: [], top, config: CONFIG, aliases });
  assert.equal(list.find((a) => a.layer === 1).id, 'Attraction_T_MO');
  assert.ok([3, 4].includes(layerOf(list, 'Attraction_T_LIB'))); // 附近但不是同一個地點，照常留著
  // 沒給對照表時不會亂併
  assert.equal(buildAttractions({ attractions: pool, visitors: [], top, config: CONFIG }).list.find((a) => a.layer === 1).image, null);
  const rows = parseCsv(fs.readFileSync(path.join(root, 'data', 'layer1-aliases.csv'), 'utf8'));
  assert.deepEqual(rows[0], ['第 1 層名稱', '景點 ID']);
  assert.ok(rows.some((r) => r[0] === '林口三井Outlet' && r[1] === 'Attraction_382000000A_403309'));
});

test('D-7 真的 data/attractions.json：卡片列的 8 組重複都已經併掉，第 1 層沒照片的剩 20 個', () => {
  const list = JSON.parse(fs.readFileSync(path.join(root, 'data', 'attractions.json'), 'utf8'));
  const dupNames = ['彰化：台灣玻璃館', '阿里山林業村暨檜意森活村', '故宮博物院-南部院區', '土城正統鹿耳門聖母廟', '南鯤鯓代天府(大鯤園)', '潮旅梓官（蚵子寮漁港）', '西嶼西臺', 'Mitsui Outlet Park 林口'];
  for (const n of dupNames) assert.ok(!list.some((a) => a.layer !== 1 && a.name === n), `${n} 還在第 2–4 層`);
  const l1 = list.filter((a) => a.layer === 1);
  assert.equal(l1.length, 190);
  assert.equal(l1.filter((a) => !a.image).length, 20);
  assert.equal(new Set(list.map((a) => a.id)).size, list.length);
});

test('D-8 順序不影響：前面的景點不會用「名字包含」搶走後面景點名字完全一樣的那一筆，也不會搶走對照表指定的那一筆', () => {
  const pool = [
    attr({ id: 'A_KM', name: '臺南孔廟', city: '臺南市', town: '中西區', lat: 22.9905, lng: 120.2045, images: [{ Name: '孔廟', URL: 'https://example.test/km.jpg' }] }),
    attr({ id: 'A_MO', name: 'Mitsui Outlet Park 林口', city: '新北市', town: '林口區', lat: 25.0710, lng: 121.3660 }),
  ];
  const kmPark = l1spot({ name: '臺南孔廟文化園區', county: '台南市', town: '中西區', lat: 22.9906, lng: 120.2046 });
  const km = l1spot({ name: '臺南孔廟', county: '台南市', town: '中西區', lat: 22.9905, lng: 120.2045 });
  const outletPark = l1spot({ name: 'Mitsui Outlet Park', county: '新北市', town: '林口區', lat: 25.0709, lng: 121.3659 });
  const mitsui = l1spot({ name: '林口三井Outlet', county: '新北市', town: '林口區', lat: 25.0703, lng: 121.3654 });
  const aliases = [{ name: '林口三井Outlet', id: 'A_MO' }];
  for (const top of [[kmPark, km, outletPark, mitsui], [km, kmPark, mitsui, outletPark]]) {
    const { list } = buildAttractions({ attractions: pool, visitors: [], top, config: CONFIG, aliases });
    const by = (n) => list.find((a) => a.layer === 1 && a.name === n);
    assert.equal(by('臺南孔廟').id, 'A_KM', top.map((s) => s.name).join('、'));
    assert.equal(by('林口三井Outlet').id, 'A_MO', top.map((s) => s.name).join('、'));
  }
});

test('D-9 2024 人次統計自己的據點（第 2 層）不會被當成第 1 層的其他寫法拿掉', () => {
  const top = [l1spot({ name: '南鯤鯓代天府', county: '台南市', town: '北門區', lat: 23.2870, lng: 120.1390 })];
  const pool = [
    attr({ id: 'A_T', name: '南鯤鯓代天府', city: '臺南市', town: '北門區', lat: 23.2871, lng: 120.1391 }),
    attr({ id: 'A_G', name: '南鯤鯓代天府大鯤園', city: '臺南市', town: '北門區', lat: 23.2880, lng: 120.1395 }),
  ];
  const visitors = [{ name: '南鯤鯓代天府大鯤園', county: '臺南市', visitors: 1 }];
  const { list, stats } = buildAttractions({ attractions: pool, visitors, top, config: CONFIG });
  assert.equal(layerOf(list, 'A_G'), 2);
  assert.equal(stats.layer2InLayer1, 0);
  assert.equal(stats.layer1Duplicates, 0);
});

test('D-10 對照表：名稱大小寫不同也對得到；指定的景點 ID 找不到時，列在 stats.aliasMissing', () => {
  const top = [l1spot({ name: '林口三井Outlet', county: '新北市', town: '林口區', lat: 25.0703, lng: 121.3654 })];
  const pool = [attr({ id: 'A_MO', name: 'Mitsui Outlet Park 林口', city: '新北市', town: '林口區', lat: 25.0710, lng: 121.3660 })];
  const ok = buildAttractions({ attractions: pool, visitors: [], top, config: CONFIG, aliases: [{ name: '林口三井outlet', id: 'A_MO' }] });
  assert.equal(ok.list.find((a) => a.layer === 1).id, 'A_MO');
  assert.deepEqual(ok.stats.aliasMissing, []);
  const bad = buildAttractions({ attractions: pool, visitors: [], top, config: CONFIG, aliases: [{ name: '林口三井Outlet', id: 'A_TYPO' }] });
  assert.deepEqual(bad.stats.aliasMissing, [{ name: '林口三井Outlet', id: 'A_TYPO' }]);
});
