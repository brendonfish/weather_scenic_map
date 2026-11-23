// 旅遊天氣景點地圖：介面改版（手機版面、摘要、景點資訊的文字）
// 跑法：在 travel-weather-map 資料夾裡跑 `node --test`
// 只讀 index.html 和 lib/spot-view.js，不連網路。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { runPage } from './_page.js';
import { readSpots, loadFixtureResponses, buildForecast, pickDays, colorFor, COLD_AT } from '../lib/forecast.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// lib/spot-view.js 是一般的 <script>（跟 day-labels.js 一樣），測試用 node:vm 載入
function loadView() {
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib', 'spot-view.js'), 'utf8'), ctx);
  return ctx.SpotView;
}

const spot = (county, color) => ({ county, forecast: [{ color }] });

test('V-1 regionOf：22 個縣市都分得到北、中、南、東、離島', () => {
  const V = loadView();
  // 景點清單裡的每個縣市都要分得到區；少一個，那個縣市的景點就不會算進「比例最高」
  const counties = [...new Set(readSpots(path.join(root, 'data', 'spots_2025_top10.csv')).map((x) => x.county))];
  assert.equal(counties.length, 22);
  for (const c of counties) assert.notEqual(V.regionOf(c), null, c);
  for (const c of ['台北市', '宜蘭縣']) assert.equal(V.regionOf(c), '北部');
  for (const c of ['苗栗縣', '雲林縣']) assert.equal(V.regionOf(c), '中部');
  for (const c of ['嘉義市', '屏東縣']) assert.equal(V.regionOf(c), '南部');
  for (const c of ['花蓮縣', '台東縣']) assert.equal(V.regionOf(c), '東部');
  for (const c of ['澎湖縣', '金門縣', '連江縣']) assert.equal(V.regionOf(c), '離島');
  // 「臺」和「台」都認得；不認得的縣市回 null，不亂猜
  assert.equal(V.regionOf('臺東縣'), '東部');
  assert.equal(V.regionOf('火星縣'), null);
});

test('V-2 summarize：算綠色有幾個，並挑出綠色比例最高的那一區', () => {
  const V = loadView();
  const spots = [
    spot('台北市', 'green'), spot('台北市', 'red'), spot('新北市', 'red'), spot('桃園市', 'red'),
    spot('花蓮縣', 'green'), spot('台東縣', 'green'),
    spot('高雄市', 'yellow'), { county: '台南市', forecast: null },
  ];
  const s = V.summarize(spots, 0);
  assert.equal(s.green, 3);
  assert.equal(s.gray, 1);
  assert.equal(s.total, 8);
  // 北部 1/4、東部 2/2：看比例不看個數（東部景點本來就少）
  assert.equal(s.bestRegion, '東部');
});

test('V-3 summarize：沒有綠色時不挑區；比例一樣時挑綠色個數多的', () => {
  const V = loadView();
  assert.equal(V.summarize([spot('台北市', 'red')], 0).bestRegion, null);
  const tie = [spot('台北市', 'green'), spot('花蓮縣', 'green'), spot('台東縣', 'green')];
  assert.equal(V.summarize(tie, 0).bestRegion, '東部');
});

test('V-4 summaryText：一句話講完，沒有綠色也講得清楚', () => {
  const V = loadView();
  assert.equal(V.summaryText({ green: 41, total: 190, bestRegion: '東部' }), '41 個景點不太會下雨 · 東部比例最高');
  assert.equal(V.summaryText({ green: 3, total: 190, bestRegion: null }), '3 個景點不太會下雨');
  assert.equal(V.summaryText({ green: 0, total: 190, bestRegion: null }), '沒有景點的降雨機率在 20% 以下');
  assert.equal(V.summaryText({ green: 0, total: 0, bestRegion: null }), '沒有景點可以顯示');
});

test('V-5 verdict：景點資訊的第一行結論，顏色門檻的意義不變', () => {
  const V = loadView();
  assert.equal(V.verdict({ color: 'green', maxPop: 10 }), '不太會下雨 · 最高 10%');
  assert.equal(V.verdict({ color: 'yellow', maxPop: 40 }), '可能會下雨 · 最高 40%');
  assert.equal(V.verdict({ color: 'red', maxPop: 80 }), '很可能下雨 · 最高 80%');
  assert.equal(V.verdict({ color: 'gray', maxPop: null }), '這天沒有完整的預報');
  assert.equal(V.verdict(null), '沒有天氣資料');
});

test('V-6 dateText：日期統一成「11/20（五）」', () => {
  const V = loadView();
  assert.equal(V.dateText('2026-11-20'), '11/20（五）');
  assert.equal(V.dateText('2026-11-22'), '11/22（日）');
  assert.equal(V.dateText('壞掉'), '壞掉');
});

test('V-7 index.html：有手機版面規則，載入 lib/spot-view.js', () => {
  assert.match(html, /@media\s*\(max-width:\s*\d+px\)/);
  assert.match(html, /<script src="lib\/spot-view\.js"><\/script>/);
  assert.match(html, /SpotView\.summarize/);
  assert.match(html, /SpotView\.verdict/);
});

test('V-8 index.html：降雨顏色的門檻說明還在，圖例寫出量的是什麼', () => {
  for (const t of ['20% 以下', '30–50%', '60% 以上', '沒資料']) assert.ok(html.includes(t), t);
  assert.match(html, /白天最高降雨機率/);
  // 偏冷要在地圖上看得到，圖例要寫門檻
  assert.ok(html.includes(`偏冷（體感 ${COLD_AT}°C 以下）`), '圖例的偏冷門檻要跟 lib/forecast.js 的 COLD_AT 一樣');
  // 圖例寫的門檻要跟 build 算顏色的規則一樣
  assert.deepEqual([20, 30, 50, 60].map(colorFor), ['green', 'yellow', 'yellow', 'red']);
});

test('V-9 index.html：給一般人看的訊息不可以叫人跑指令', () => {
  // 只看畫面上會出現的字串（單引號、反引號裡的中文訊息），不看註解
  const messages = html.match(/[`'][^`'\n]*[一-鿿][^`'\n]*[`']/g) || [];
  for (const m of messages) assert.doesNotMatch(m, /node |build-data|\.json/, m);
});

test('V-10 index.html：日期按鈕有 aria-pressed，點擊目標夠大', () => {
  assert.match(html, /aria-pressed/);
  assert.match(html, /min-height:\s*44px/);
  // 標記的點擊範圍至少 32px（看起來還是小圓點）
  assert.match(html, /iconSize:\s*\[32,\s*32\]/);
});

// 用假預報做出跟 build 一樣的 190 個景點資料
function fixtureData() {
  const spots = readSpots(path.join(root, 'data', 'spots_2025_top10.csv'));
  const responses = loadFixtureResponses(path.join(root, 'fixtures'));
  const nowMs = Date.parse('2026-11-19T06:00:00+08:00');
  return buildForecast(spots, responses, pickDays(responses, nowMs), { source: 'fixture', nowMs });
}

test('V-11 網頁真的畫出 190 個標記，摘要和假資料提示都有', async () => {
  const { els, rec } = await runPage(fixtureData());
  assert.equal(rec.markers.length, 190);
  for (const m of rec.markers) {
    assert.ok(Number.isFinite(m.opts.zIndexOffset), m.opts.title);
    assert.match(m.opts.title, /：/); // 名稱：結論
    assert.match(m.opts.icon.html, /class="marker c-(green|yellow|red|gray)/);
  }
  assert.match(els.summary.textContent, /^\d+ 個景點不太會下雨/);
  assert.match(els.notice.textContent, /假資料/);
  assert.equal(els.notice.hidden, false);
  assert.match(els.info.textContent, /顯示 190 \/ 190 個景點/);
  assert.deepEqual(els.days.children.map((b) => b.attrs['aria-pressed']), ['true', 'false', 'false']);
});

test('V-12 點景點：桌機開地圖資訊框，手機開底部面板（不會被上面的面板蓋住）', async () => {
  const wide = await runPage(fixtureData());
  wide.rec.markers[0].handlers.click();
  assert.ok(wide.rec.calls.includes('openPopup'));
  assert.match(wide.rec.popupHtml, /西門町商圈/);
  assert.match(wide.rec.popupHtml, /最高 \d+%/);
  assert.equal(wide.rec.markers.length, 190);

  const phone = await runPage(fixtureData(), { narrow: true });
  phone.rec.markers[0].handlers.click();
  assert.ok(!phone.rec.calls.includes('openPopup'));
  assert.ok(phone.rec.calls.includes('panInside'));
  assert.equal(phone.els.sheet.hidden, false);
  assert.match(phone.els.sheetBody.innerHTML, /西門町商圈/);
  // 切換日期，同一個景點的資訊留著，內容換成那一天
  phone.els.days.children[2].onclick();
  assert.equal(phone.els.sheet.hidden, false);
  assert.match(phone.els.sheetBody.innerHTML, /後天/);
});

test('V-14 routeUrl：Google 地圖的開車路線，目的地用景點座標，不帶出發地（Google 會用使用者現在的位置）', () => {
  const V = loadView();
  assert.equal(V.routeUrl({ lat: 25.0421, lng: 121.5075 }), 'https://www.google.com/maps/dir/?api=1&destination=25.0421%2C121.5075&travelmode=driving');
});

test('V-15 景點資訊有「用 Google 地圖規劃路線」的按鈕，桌機和手機都有，開在新分頁', async () => {
  const wide = await runPage(fixtureData());
  wide.rec.markers[0].handlers.click();
  const link = /<a class="route" href="https:\/\/www\.google\.com\/maps\/dir\/\?api=1&amp;destination=[\d.]+%2C[\d.]+&amp;travelmode=driving" target="_blank" rel="noopener">用 Google 地圖規劃路線<\/a>/;
  assert.match(wide.rec.popupHtml, link);

  const phone = await runPage(fixtureData(), { narrow: true });
  phone.rec.markers[0].handlers.click();
  assert.match(phone.els.sheetBody.innerHTML, link);
  // 按鈕在手機上要好點
  assert.match(html, /\.detail \.route \{[^}]*min-height: 44px/);
});

test('V-13 預報過期：用一般人看得懂的話提示，不叫人跑指令', async () => {
  const { els } = await runPage({ source: 'cwa', days: ['2020-01-01'], spots: [], generatedAt: '2020-01-01T00:00:00Z' });
  assert.equal(els.notice.hidden, false);
  assert.match(els.notice.textContent, /已經過期/);
  assert.doesNotMatch(els.notice.textContent, /node|build/);
});
