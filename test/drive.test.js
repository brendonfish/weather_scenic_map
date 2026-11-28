// 旅遊天氣景點地圖：出發地和車程篩選
// 跑法：在 travel-weather-map 資料夾裡跑 `node --test`
// 不連網路、不需要 Docker：車程用這支檔案裡的小份假資料。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { runPage, tick } from './_page.js';
import { readSpots, loadFixtureResponses, buildForecast, pickDays } from '../lib/forecast.js';
import { townsFromResponses, townsCsv, readTowns, nearestUrl, onRoad, tableUrl, minutesFromTable, expandRow, driveFiles, inputsHash, spotKey } from '../lib/drive-build.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// vm 裡做出來的陣列和物件，換成這邊的，才能用 deepEqual 比
const plain = (x) => JSON.parse(JSON.stringify(x));

function loadDriveTime() {
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib', 'drive-time.js'), 'utf8'), ctx);
  return ctx.DriveTime;
}

// 氣象署鄉鎮預報的回應（只留這裡用得到的欄位）
const cwa = (county, towns) => ({
  records: { Locations: [{ LocationsName: county, Location: towns.map(([LocationName, Latitude, Longitude]) => ({ LocationName, Latitude, Longitude })) }] },
});

test('D-1 townsFromResponses：拿出縣市、鄉鎮、座標；縣市統一寫「台」', () => {
  const towns = townsFromResponses([cwa('臺北市', [['萬華區', '25.0286', '121.4979']]), cwa('宜蘭縣', [['頭城鎮', '24.8594', '121.8236']])]);
  assert.deepEqual(towns, [
    { county: '台北市', town: '萬華區', lat: 25.0286, lng: 121.4979 },
    { county: '宜蘭縣', town: '頭城鎮', lat: 24.8594, lng: 121.8236 },
  ]);
});

test('D-2 townsFromResponses：少了座標要講是哪個鄉鎮，不寫出壞資料', () => {
  assert.throws(() => townsFromResponses([cwa('宜蘭縣', [['頭城鎮', undefined, undefined]])]), /宜蘭縣頭城鎮.*座標/);
});

test('D-3 towns.csv：寫出去再讀回來一樣', () => {
  const towns = [{ county: '台北市', town: '萬華區', lat: 25.0286, lng: 121.4979 }];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'towns-')), 'towns.csv');
  fs.writeFileSync(file, townsCsv(towns));
  assert.deepEqual(readTowns(file), towns);
  assert.match(fs.readFileSync(file, 'utf8'), /^縣市,鄉鎮市區,緯度,經度\n/);
});

test('D-4 tableUrl：一個出發點對所有景點，經度在前，不算渡輪，每個點只接到 2 公里內的路', () => {
  const url = tableUrl('http://127.0.0.1:5000', { lat: 25, lng: 121.5 }, [{ lat: 24, lng: 120.5 }, { lat: 23, lng: 120 }]);
  assert.equal(url, 'http://127.0.0.1:5000/table/v1/driving/121.5,25;120.5,24;120,23?sources=0&destinations=1;2&exclude=ferry&radiuses=2000;2000;2000');
});

test('D-4b 附近沒有路的點（小島、要爬山的）不會被接到遠處的路上', () => {
  assert.equal(nearestUrl('http://x', { lat: 22.67, lng: 121.46 }), 'http://x/nearest/v1/driving/121.46,22.67?number=1&exclude=ferry');
  assert.equal(onRoad({ code: 'Ok', waypoints: [{ distance: 961 }] }), true);
  assert.equal(onRoad({ code: 'Ok', waypoints: [{ distance: 6155 }] }), false);
  assert.equal(onRoad({ code: 'NoSegment' }), false);
  // 附近沒路的景點不問車程，補回來時是 null
  assert.deepEqual(expandRow([true, false, true], [12, 40]), [12, null, 40]);
});

test('D-5 minutesFromTable：秒變成分鐘；到不了的是 null', () => {
  assert.deepEqual(minutesFromTable({ code: 'Ok', durations: [[89, 3630, null]] }), [1, 61, null]);
  assert.throws(() => minutesFromTable({ code: 'NoTable', message: '壞了' }), /NoTable/);
});

const towns2 = [
  { county: '台北市', town: '萬華區', lat: 25.03, lng: 121.5 },
  { county: '台北市', town: '北投區', lat: 25.13, lng: 121.5 },
  { county: '宜蘭縣', town: '頭城鎮', lat: 24.86, lng: 121.82 },
];
const spots3 = [
  { county: '台北市', name: '西門町商圈' }, { county: '宜蘭縣', name: '礁溪' }, { county: '澎湖縣', name: '吉貝' },
];

test('D-6 driveFiles：一份索引加每個縣市一個檔，網頁用 <script> 就能載入', () => {
  const files = driveFiles(towns2, spots3, [[5, 62, null], [28, 75, null], [60, 12, null]]);
  assert.deepEqual(Object.keys(files).sort(), ['c00.js', 'c01.js', 'index.js']);
  const window = {};
  for (const name of ['index.js', 'c00.js', 'c01.js']) vm.runInNewContext(files[name], { window });
  assert.deepEqual(plain(window.DRIVE_INDEX.spots), ['台北市|西門町商圈', '宜蘭縣|礁溪', '澎湖縣|吉貝']);
  assert.deepEqual(plain(window.DRIVE_INDEX.counties), [
    { name: '台北市', file: 'c00.js', towns: ['萬華區', '北投區'], points: [[25.03, 121.5], [25.13, 121.5]] },
    { name: '宜蘭縣', file: 'c01.js', towns: ['頭城鎮'], points: [[24.86, 121.82]] },
  ]);
  assert.deepEqual(plain(window.DRIVE_TIMES['台北市']['北投區']), [28, 75, null]);
  assert.deepEqual(plain(window.DRIVE_TIMES['宜蘭縣']['頭城鎮']), [60, 12, null]);
  assert.equal(spotKey({ county: '臺北市', name: '西門町商圈' }), '台北市|西門町商圈');
});

test('D-7 DriveTime：車程選項每 30 分鐘一格，到 5 小時', () => {
  const D = loadDriveTime();
  assert.deepEqual([...D.LIMITS], [30, 60, 90, 120, 150, 180, 210, 240, 270, 300]);
  assert.equal(D.limitText(30), '30 分鐘內');
  assert.equal(D.limitText(60), '1 小時內');
  assert.equal(D.limitText(90), '1.5 小時內');
  assert.equal(D.limitText(300), '5 小時內');
});

test('D-8 DriveTime.durationText：景點資訊裡的那一行，明講不含塞車', () => {
  const D = loadDriveTime();
  assert.equal(D.durationText('萬華區', 80), '從萬華區開車約 1 小時 20 分（不含塞車）');
  assert.equal(D.durationText('萬華區', 25), '從萬華區開車約 25 分（不含塞車）');
  assert.equal(D.durationText('萬華區', 120), '從萬華區開車約 2 小時（不含塞車）');
  assert.equal(D.durationText('萬華區', 0), '就在萬華區附近');
  assert.equal(D.durationText('萬華區', null), '從萬華區開車到不了');
});

test('D-9 DriveTime.apply：留下車程內的景點；到不了的另外數', () => {
  const D = loadDriveTime();
  const index = { spots: ['台北市|西門町商圈', '宜蘭縣|礁溪', '澎湖縣|吉貝'] };
  const minutes = D.minutesBySpot(index, [5, 62, null]);
  assert.equal(minutes('台北市', '西門町商圈'), 5);
  assert.equal(minutes('澎湖縣', '吉貝'), null);
  assert.equal(minutes('火星縣', '沒這個'), undefined);
  const r = D.apply(spots3, minutes, 60);
  assert.deepEqual(plain(r.visible.map((s) => s.name)), ['西門町商圈']);
  assert.equal(r.unreachable, 1);
  // 剛好等於上限算在內；不限（null）就全部留下，到不了的也留
  assert.deepEqual(plain(D.apply(spots3, minutes, 62).visible.map((s) => s.name)), ['西門町商圈', '礁溪']);
  assert.equal(D.apply(spots3, minutes, null).visible.length, 3);
  // 車程檔裡沒有的景點（清單改了還沒重算）：不知道要開多久，有上限時不顯示，但不能說它「開車到不了」
  const withNew = [...spots3, { county: '台北市', name: '新景點' }];
  const r2 = D.apply(withNew, minutes, 300);
  assert.equal(r2.unreachable, 1);
  assert.equal(r2.visible.length, 2);
  assert.equal(D.apply(withNew, minutes, null).visible.length, 4);
});

test('D-10 DriveTime.summaryText：開了車程篩選，摘要講車程內有幾個', () => {
  const D = loadDriveTime();
  assert.equal(D.summaryText({ green: 12, total: 31 }, 90), '12 個景點不太會下雨 · 車程 1.5 小時內共 31 個');
  assert.equal(D.summaryText({ green: 0, total: 31 }, 90), '車程 1.5 小時內的 31 個景點，降雨機率都超過 20%');
  assert.equal(D.summaryText({ green: 0, total: 0 }, 30), '車程 30 分鐘內沒有景點');
});

// ---- 網頁 ----

function fixtureData() {
  const spots = readSpots(path.join(root, 'data', 'spots_2025_top10.csv'));
  const responses = loadFixtureResponses(path.join(root, 'fixtures'));
  const nowMs = Date.parse('2026-11-19T06:00:00+08:00');
  return buildForecast(spots, responses, pickDays(responses, nowMs), { source: 'fixture', nowMs });
}

// 假車程：從萬華區出發，台北市的景點 20 分鐘、其他本島景點 100 分鐘、離島到不了
function fakeDrive(data) {
  const islands = ['澎湖縣', '金門縣', '連江縣'];
  const row = data.spots.map((s) => (islands.includes(s.county) ? null : s.county === '台北市' ? 20 : 100));
  return {
    index: {
      spots: data.spots.map(spotKey),
      counties: [
        { name: '台北市', file: 'c00.js', towns: ['萬華區', '北投區'], points: [[25.03, 121.5], [25.13, 121.5]] },
        { name: '宜蘭縣', file: 'c01.js', towns: ['頭城鎮'], points: [[24.86, 121.82]] },
      ],
    },
    times: { 台北市: { 萬華區: row, 北投區: row }, 宜蘭縣: { 頭城鎮: row } },
  };
}

test('D-11 沒選出發地：跟原本一樣 190 個標記，車程選單不能用', async () => {
  const data = fixtureData();
  const { els, rec } = await runPage(data, { drive: fakeDrive(data) });
  assert.equal(rec.markers.length, 190);
  assert.equal(els.driveLimit.disabled, true);
  assert.equal(els.driveNote.hidden, true);
  // 縣市選單：第一格是「還沒選」，後面是索引裡的縣市
  assert.deepEqual(els.originCounty.children.map((o) => o.textContent), ['選縣市', '台北市', '宜蘭縣']);
  assert.match(els.summary.textContent, /比例最高|個景點不太會下雨/);
});

test('D-12 選出發地和車程：只留車程內的景點，摘要和說明跟著變，選擇記在瀏覽器', async () => {
  const data = fixtureData();
  const page = await runPage(data, { drive: fakeDrive(data) });
  const { els, rec } = page;
  els.originCounty.value = '台北市';
  els.originCounty.onchange();
  assert.deepEqual(els.originTown.children.map((o) => o.textContent), ['選鄉鎮', '萬華區', '北投區']);
  els.originTown.value = '萬華區';
  els.originTown.onchange();
  await tick();
  assert.equal(els.driveLimit.disabled, false);
  assert.equal(rec.markers.length, 190); // 車程還是「不限」
  els.driveLimit.value = '30';
  els.driveLimit.onchange();
  assert.equal(rec.markers.length, 10);
  assert.match(els.summary.textContent, /車程 30 分鐘內共 10 個$/);
  assert.equal(els.driveNote.hidden, false);
  assert.match(els.driveNote.textContent, /24 個景點開車到不了/);
  assert.match(els.info.textContent, /顯示 10 \/ 190 個景點/);
  // 景點資訊多一行車程
  rec.markers[0].handlers.click();
  // 連縣市一起寫：「西區」「東區」很多縣市都有
  assert.match(rec.popupHtml, /從台北市萬華區開車約 20 分（不含塞車）/);
  assert.deepEqual(JSON.parse(page.storage.driveTime), { county: '台北市', town: '萬華區', limit: 30 });
});

test('D-13 下次打開：出發地和車程還在，直接套用', async () => {
  const data = fixtureData();
  const { els, rec } = await runPage(data, {
    drive: fakeDrive(data), storage: { driveTime: JSON.stringify({ county: '台北市', town: '萬華區', limit: 120 }) },
  });
  assert.equal(els.originCounty.value, '台北市');
  assert.equal(els.originTown.value, '萬華區');
  assert.equal(els.driveLimit.value, '120');
  assert.equal(rec.markers.length, 166);
});

test('D-14 目前打開的景點被車程篩掉：資訊一起收起來', async () => {
  const data = fixtureData();
  const { els, rec } = await runPage(data, {
    drive: fakeDrive(data), storage: { driveTime: JSON.stringify({ county: '台北市', town: '萬華區', limit: null }) },
  });
  rec.markers[rec.markers.length - 1].handlers.click(); // 清單最後一個是離島的景點
  rec.calls.length = 0;
  els.driveLimit.value = '30';
  els.driveLimit.onchange();
  assert.ok(rec.calls.includes('closePopup'));
});

test('D-15 沒有車程檔（還沒產出或載入失敗）：出發地那一列不顯示，其他照常', async () => {
  const { els, rec } = await runPage(fixtureData());
  assert.equal(rec.markers.length, 190);
  assert.equal(els.trip.hidden, true);
});

test('D-15b 車程檔讀不到：講清楚，不清掉上次記住的選擇', async () => {
  const data = fixtureData();
  const drive = fakeDrive(data);
  delete drive.times.台北市;
  const saved = JSON.stringify({ county: '台北市', town: '萬華區', limit: 60 });
  const { els, rec, storage } = await runPage(data, { drive, storage: { driveTime: saved } });
  assert.equal(rec.markers.length, 190);
  assert.equal(els.driveNote.hidden, false);
  assert.match(els.driveNote.textContent, /車程資料暫時讀不到/);
  assert.equal(els.driveLimit.disabled, true);
  assert.equal(storage.driveTime, saved);
});

test('D-16 index.html：車程索引和 lib/drive-time.js 都用 <script> 載入', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<script src="drive\/index\.js"><\/script>/);
  assert.match(html, /<script src="lib\/drive-time\.js"><\/script>/);
  assert.match(html, /aria-label="出發的縣市"/);
});

test('D-17 車程檔：368 個鄉鎮、190 個景點，跟 towns.csv 和景點清單對得起來', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'drive', 'index.js'), 'utf8'), { window });
  const spots = readSpots(path.join(root, 'data', 'spots_2025_top10.csv'));
  const towns = readTowns(path.join(root, 'data', 'towns.csv'));
  assert.equal(towns.length, 368);
  // 景點清單或 towns.csv 改了（名稱、順序、座標）就要重算車程：node scripts/build-drive-times.js（步驟在 CLAUDE.md）
  assert.equal(window.DRIVE_INDEX.inputs, inputsHash(towns, spots), '景點清單或 data/towns.csv 改過了，但 drive/ 還沒重算');
  assert.deepEqual(plain(window.DRIVE_INDEX.spots), spots.map(spotKey));
  assert.equal(window.DRIVE_INDEX.counties.length, 22);
  let n = 0;
  for (const c of window.DRIVE_INDEX.counties) {
    vm.runInNewContext(fs.readFileSync(path.join(root, 'drive', c.file), 'utf8'), { window });
    assert.equal(c.points.length, c.towns.length, c.name + ' 的鄉鎮和座標筆數');
    assert.deepEqual(plain(c.points), towns.filter((t) => t.county === c.name).map((t) => [t.lat, t.lng]), c.name + ' 的座標');
    for (const t of c.towns) {
      const row = window.DRIVE_TIMES[c.name][t];
      assert.equal(row.length, 190, c.name + t);
      for (const m of row) assert.ok(m === null || (Number.isInteger(m) && m >= 0 && m < 600), `${c.name}${t}: ${m}`);
      n++;
    }
  }
  assert.equal(n, 368);
});

test('D-18 DriveTime.nearestTown：找離座標最近的鄉鎮；離所有鄉鎮超過 30 公里就不選', () => {
  const DriveTime = loadDriveTime();
  const index = fakeDrive(fixtureData()).index;
  // 台北車站附近 → 萬華區（不是北投區）
  assert.deepEqual(plain(DriveTime.nearestTown(index, 25.047, 121.517)), { county: '台北市', town: '萬華區' });
  // 頭城外海一點點 → 頭城鎮
  assert.deepEqual(plain(DriveTime.nearestTown(index, 24.87, 121.85)), { county: '宜蘭縣', town: '頭城鎮' });
  // 台中（離這三個鄉鎮都超過 30 公里）、香港
  assert.equal(DriveTime.nearestTown(index, 24.14, 120.68), null);
  assert.equal(DriveTime.nearestTown(index, 22.3, 114.17), null);
  // 舊版車程檔沒有座標：不選
  assert.equal(DriveTime.nearestTown({ counties: [{ name: '台北市', towns: ['萬華區'] }] }, 25.03, 121.5), null);
});

// 假的定位：answer 是 { lat, lng } 就回座標，是數字就當錯誤代碼（1 是使用者不給權限）
const fakeGeo = (answer) => (ok, fail) => Promise.resolve().then(() =>
  typeof answer === 'number' ? fail({ code: answer }) : ok({ coords: { latitude: answer.lat, longitude: answer.lng, accuracy: 50 } }));

test('D-19 用我的位置：選最近的鄉鎮當出發地，選單跟著變；只記鄉鎮，不記座標', async () => {
  const data = fixtureData();
  const page = await runPage(data, { drive: fakeDrive(data), geo: fakeGeo({ lat: 25.12, lng: 121.51 }) });
  const { els, rec } = page;
  assert.equal(els.useLocation.hidden, false);
  els.useLocation.onclick();
  await tick(); await tick(); await tick();
  assert.equal(els.originCounty.value, '台北市');
  assert.equal(els.originTown.value, '北投區');
  assert.equal(els.originTown.disabled, false);
  assert.equal(els.driveLimit.disabled, false);
  assert.match(els.locateNote.textContent, /最近的鄉鎮是台北市北投區/);
  assert.equal(els.locateNote.hidden, false);
  assert.equal(els.useLocation.disabled, false);
  els.driveLimit.value = '30';
  els.driveLimit.onchange();
  assert.equal(rec.markers.length, 10);
  rec.markers[0].handlers.click();
  assert.match(rec.popupHtml, /從台北市北投區開車約 20 分/);
  assert.deepEqual(JSON.parse(page.storage.driveTime), { county: '台北市', town: '北投區', limit: 30 });
  // 之後自己換選單：「用你的位置」的說明收起來
  els.originTown.value = '萬華區';
  els.originTown.onchange();
  assert.equal(els.locateNote.hidden, true);
});

test('D-20 用我的位置拿不到：講清楚原因，出發地不變；瀏覽器不支援定位就不顯示按鈕', async () => {
  const data = fixtureData();
  for (const [answer, why] of [[1, /沒有拿到位置權限/], [3, /暫時拿不到你的位置/], [{ lat: 22.3, lng: 114.17 }, /離台灣的鄉鎮太遠/]]) {
    const { els } = await runPage(data, { drive: fakeDrive(data), geo: fakeGeo(answer) });
    els.useLocation.onclick();
    await tick(); await tick(); await tick();
    assert.match(els.locateNote.textContent, why);
    assert.match(els.locateNote.textContent, /手動選出發地/);
    assert.equal(els.originCounty.value, '');
    assert.equal(els.driveLimit.disabled, true);
    assert.equal(els.useLocation.disabled, false);
  }
  const { els } = await runPage(data, { drive: fakeDrive(data) });
  assert.equal(els.useLocation.hidden, true);
});

// ---- 卡片 https://trello.com/c/vZpVF2ZB ：可以展開收起的區域加上箭頭；降雨機率說明、出發地與車程也可以收起（Ray 2026-11-28） ----

const pageHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const FOLDS = ['trip', 'legendBox', 'more', 'filters'];

test('V-1 四個可以展開收起的區域都是 details，有標題列 summary', () => {
  for (const id of FOLDS) {
    assert.match(pageHtml, new RegExp('<details[^>]*id="' + id + '"[^>]*>\\s*<summary'), id);
  }
  // 降雨機率說明：標題列是那行說明，四個顏色收在裡面
  assert.match(pageHtml, /<details[^>]*id="legendBox"[^>]*>\s*<summary[^>]*>白天最高降雨機率（09:00–18:00）<\/summary>[\s\S]*?c-green[\s\S]*?id="legendGray"[\s\S]*?<\/details>/);
  // 出發地與車程：選單和「用我的位置」的說明都收在裡面
  assert.match(pageHtml, /<details[^>]*id="trip"[^>]*>\s*<summary[^>]*><span class="label">出發地與車程<\/span><span[^>]*id="tripState"[\s\S]*?id="originCounty"[\s\S]*?id="useLocation"[\s\S]*?id="locateNote"[\s\S]*?<\/details>/);
});

test('V-2 標題列有箭頭：收起朝右、打開朝下；瀏覽器原本的三角形藏起來（不會出現兩個）', () => {
  const css = pageHtml.slice(pageHtml.indexOf('<style>'), pageHtml.indexOf('</style>'));
  assert.match(css, /summary::-webkit-details-marker\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.panel summary\s*\{[^}]*list-style:\s*none/);
  const closed = css.match(/\.panel summary::after\s*\{([^}]*)\}/);
  assert.ok(closed, '要有 .panel summary::after 箭頭');
  assert.match(closed[1], /content:/);
  assert.match(closed[1], /rotate\(-45deg\)/, '收起朝右');
  assert.match(css, /\.panel details\[open\]\s*>\s*summary::after\s*\{[^}]*rotate\(45deg\)/, '打開朝下');
});

test('V-3 預設：桌機打開降雨機率說明、出發地與車程、圖例說明與設定；手機收起', async () => {
  const data = fixtureData();
  const wide = await runPage(data, { drive: fakeDrive(data) });
  for (const id of ['trip', 'legendBox', 'more']) assert.equal(wide.els[id].open, true, '桌機 ' + id);
  const phone = await runPage(data, { drive: fakeDrive(data), narrow: true });
  for (const id of ['trip', 'legendBox', 'more']) assert.equal(phone.els[id].open, false, '手機 ' + id);
});

test('V-4 出發地與車程的標題列顯示目前的選擇（收起來也看得到有沒有在篩車程）', async () => {
  const data = fixtureData();
  const none = await runPage(data, { drive: fakeDrive(data) });
  assert.equal(none.els.tripState.textContent, '：未設定');
  const saved = JSON.stringify({ county: '台北市', town: '萬華區', limit: 30 });
  const { els } = await runPage(data, { drive: fakeDrive(data), storage: { driveTime: saved } });
  await tick(); await tick();
  assert.equal(els.tripState.textContent.replace(/\u00a0/g, ' '), '：台北市萬華區 · 30 分鐘內');
  els.driveLimit.value = '';
  els.driveLimit.onchange();
  assert.equal(els.tripState.textContent, '：台北市萬華區');
  els.originCounty.value = '';
  els.originCounty.onchange();
  await tick(); await tick();
  assert.equal(els.tripState.textContent, '：未設定');
});

test('V-5 打開或收起降雨機率說明、出發地與車程：重畫一次（面板大小變了）', async () => {
  const data = fixtureData();
  const { els, rec } = await runPage(data, { drive: fakeDrive(data) });
  for (const id of ['trip', 'legendBox']) {
    assert.equal(typeof els[id].ontoggle, 'function', id);
    const before = rec.markers[0];
    els[id].ontoggle();
    assert.notEqual(rec.markers[0], before, `${id}：沒有重畫`);
  }
});

// 檢查找到的問題（2026-11-28）
test('V-6 出發地與車程的標題不會被擠到換行：標題包在不縮的 span 裡，只有目前的選擇會被省略', () => {
  assert.match(pageHtml, /<summary[^>]*><span class="label">出發地與車程<\/span><span class="state" id="tripState">/);
  const css = pageHtml.slice(pageHtml.indexOf('<style>'), pageHtml.indexOf('</style>'));
  assert.match(css, /#trip \.label\s*\{[^}]*flex:\s*none[^}]*white-space:\s*nowrap/);
});

test('V-7 用我的位置的結果出來時，出發地與車程是收起來的：自動打開，看得到說明', async () => {
  const data = fixtureData();
  for (const answer of [1, { lat: 25.12, lng: 121.51 }]) {
    const { els } = await runPage(data, { drive: fakeDrive(data), geo: fakeGeo(answer), narrow: true });
    els.trip.open = true;
    els.useLocation.onclick();
    els.trip.open = false; // 等的時候收起來
    await tick(); await tick(); await tick();
    assert.equal(els.locateNote.hidden, false);
    assert.equal(els.trip.open, true, JSON.stringify(answer));
  }
});

test('V-9 目前的選擇放不下時換到第二行（不省略），只在「·」斷開，「30 分鐘內」不拆開', async () => {
  const css = pageHtml.slice(pageHtml.indexOf('<style>'), pageHtml.indexOf('</style>'));
  const rule = css.match(/#trip \.state\s*\{([^}]*)\}/);
  assert.ok(rule);
  assert.doesNotMatch(rule[1], /ellipsis|nowrap/);
  assert.match(rule[1], /word-break:\s*keep-all/);
  const data = fixtureData();
  const saved = JSON.stringify({ county: '台北市', town: '萬華區', limit: 30 });
  const { els } = await runPage(data, { drive: fakeDrive(data), storage: { driveTime: saved } });
  await tick(); await tick();
  assert.equal(els.tripState.textContent, '：台北市萬華區 · 30\u00a0分鐘內');
});

test('V-8 車程檔讀不到：標題列不寫「未設定」，寫選了哪裡、車程讀不到', async () => {
  const data = fixtureData();
  const drive = fakeDrive(data);
  delete drive.times.台北市;
  const saved = JSON.stringify({ county: '台北市', town: '萬華區', limit: 60 });
  const { els } = await runPage(data, { drive, storage: { driveTime: saved } });
  await tick(); await tick();
  assert.equal(els.tripState.textContent, '：台北市萬華區（車程讀不到）');
});
