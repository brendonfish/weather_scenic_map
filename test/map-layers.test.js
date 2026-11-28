// 天氣旅圖：景點庫擴充（2/2）——地圖四層顯示、畫面上限、太近合併、篩選面板、資訊框縮圖
// 跑法：在 travel-weather-map 資料夾裡跑 `node --test`
// 卡片：https://trello.com/c/AULA6cHZ （AI 小工具板）
// 只用小的假資料，不連網路、不連氣象署。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPage, tick } from './_page.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function loadMapLayers() {
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib', 'map-layers.js'), 'utf8'), ctx);
  return ctx.MapLayers;
}
const ML = loadMapLayers();
const ALL = () => ({ types: [...ML.TYPES], fits: [...ML.FITS], onlyGood: false, hideIndoor: false });

// 一個景點；forecast 是第 0 天的顏色
let seq = 0;
function spot(o = {}) {
  seq++;
  return {
    id: o.id ?? `S${seq}`, name: o.name ?? `景點${seq}`, county: '臺北市', town: '萬華區',
    lat: o.lat ?? 25 + seq * 0.01, lng: o.lng ?? 121.5, layer: o.layer ?? 3, richness: o.richness ?? 0,
    types: o.types ?? ['古蹟文化'], weatherFit: o.weatherFit ?? '不分', setting: o.setting,
    forecast: o.color === undefined ? [{ color: 'green' }] : o.color ? [{ color: o.color }] : null,
  };
}

// ---- 1. 依縮放選層 ----

test('L-1 依縮放級數選層：全台 1 層、一兩個縣市 2 層、鄉鎮 3 層、拉到最近 4 層', () => {
  const [z2, z3, z4] = ML.DEFAULTS.layerZooms;
  assert.ok(z2 < z3 && z3 < z4);
  assert.equal(ML.maxLayer(7.5), 1);
  assert.equal(ML.maxLayer(z2 - 0.25), 1);
  assert.equal(ML.maxLayer(z2), 2);
  assert.equal(ML.maxLayer(z3), 3);
  assert.equal(ML.maxLayer(z4), 4);
  assert.equal(ML.maxLayer(18), 4);
});

test('L-2 有打開篩選時層放寬一級，最多到第 4 層', () => {
  const [z2, , z4] = ML.DEFAULTS.layerZooms;
  assert.equal(ML.maxLayer(7.5, true), 2);
  assert.equal(ML.maxLayer(z2, true), 3);
  assert.equal(ML.maxLayer(z4, true), 4);
  assert.equal(ML.filtersActive(ALL()), false);
  assert.equal(ML.filtersActive({ ...ALL(), types: ML.TYPES.slice(1) }), true);
  assert.equal(ML.filtersActive({ ...ALL(), fits: ['雨天備案'] }), true);
  assert.equal(ML.filtersActive({ ...ALL(), onlyGood: true }), true);
  assert.equal(ML.filtersActive({ ...ALL(), hideIndoor: true }), true);
});

// ---- 2、3. 畫面上限、太近合併 ----

const far = (s) => ({ x: s.lng * 1e5, y: -s.lat * 1e5 }); // 每個點都離得很遠（相差 1000 像素以上），不會合併

test('L-3 畫面上限：單獨的景點最多 30 個，先比層（小的優先），同層比 richness（高的優先）', () => {
  const spots = [];
  for (let i = 0; i < 20; i++) spots.push(spot({ layer: 3, richness: i % 7 }));
  for (let i = 0; i < 20; i++) spots.push(spot({ layer: 2, richness: i % 5 }));
  for (let i = 0; i < 10; i++) spots.push(spot({ layer: 4, richness: 6 }));
  const { groups, overflow } = ML.place(spots, far, { cap: 30, clusterPx: 40 });
  assert.equal(groups.length, 30);
  assert.equal(overflow, 20);
  const leads = groups.map((g) => g.lead);
  assert.equal(leads.filter((s) => s.layer === 2).length, 20); // 第 2 層全部先進來
  assert.ok(leads.every((s) => s.layer !== 4)); // 第 4 層 richness 再高也排在後面
  const l3 = leads.filter((s) => s.layer === 3);
  const minPicked = Math.min(...l3.map((s) => s.richness));
  const maxLeft = Math.max(...spots.filter((s) => s.layer === 3 && !leads.includes(s)).map((s) => s.richness));
  assert.ok(minPicked >= maxLeft, `第 3 層選進來的 richness 最低 ${minPicked}，沒選進來的最高 ${maxLeft}`);
});

test('L-4 太近的景點合併成一個帶數字的點：代表的是排名最前面的那個', () => {
  const a = spot({ layer: 3, richness: 1, lat: 25.0, lng: 121.5 });
  const b = spot({ layer: 2, richness: 0, lat: 25.0001, lng: 121.5001 });
  const c = spot({ layer: 3, richness: 5, lat: 23.0, lng: 120.2 });
  const near = (s) => ({ x: s.lng * 100, y: -s.lat * 100 });
  const { groups } = ML.place([a, b, c], near, { cap: 30, clusterPx: 40 });
  assert.equal(groups.length, 2);
  const g = groups.find((x) => x.members.length === 2);
  assert.equal(g.lead, b);
  assert.deepEqual(new Set(g.members), new Set([a, b]));
});

// ---- 4. 篩選 ----

const colorOf = (s, d) => (s.forecast ? s.forecast[d].color : 'gray');

test('L-5 類型篩選：景點的類型有任何一個被勾選就留下', () => {
  const spots = [spot({ types: ['自然山林'] }), spot({ types: ['宗教廟宇', '古蹟文化'] }), spot({ types: ['商圈市集'] })];
  const out = ML.applyFilters(spots, { ...ALL(), types: ['古蹟文化'] }, colorOf, 0);
  assert.deepEqual(out, [spots[1]]);
});

test('L-6 天氣適配篩選', () => {
  const spots = [spot({ weatherFit: '好天氣才去' }), spot({ weatherFit: '雨天備案' }), spot({ weatherFit: '不分' })];
  assert.deepEqual(ML.applyFilters(spots, { ...ALL(), fits: ['雨天備案', '不分'] }, colorOf, 0), [spots[1], spots[2]]);
});

test('L-7 只看好天氣：只留選定那天是綠色的景點', () => {
  const spots = [spot({ color: 'green' }), spot({ color: 'yellow' }), spot({ color: 'red' }), spot({ color: null })];
  assert.deepEqual(ML.applyFilters(spots, { ...ALL(), onlyGood: true }, colorOf, 0), [spots[0]]);
});

test('L-8 三個篩選一起用', () => {
  const keep = spot({ types: ['自然山林'], weatherFit: '好天氣才去', color: 'green' });
  const spots = [
    keep,
    spot({ types: ['自然山林'], weatherFit: '好天氣才去', color: 'red' }),
    spot({ types: ['自然山林'], weatherFit: '雨天備案', color: 'green' }),
    spot({ types: ['宗教廟宇'], weatherFit: '好天氣才去', color: 'green' }),
  ];
  const out = ML.applyFilters(spots, { ...ALL(), types: ['自然山林'], fits: ['好天氣才去'], onlyGood: true }, colorOf, 0);
  assert.deepEqual(out, [keep]);
});

test('L-9 「只看戶外」也併在這裡：第 1 層看室內戶外欄位，其他層看主要類型（室內場館、商圈市集）', () => {
  const spots = [
    spot({ layer: 1, setting: '室內' }),
    spot({ layer: 1, setting: '商圈、夜市、老街（戶外街區）' }),
    spot({ layer: 1, setting: '戶外' }),
    spot({ layer: 3, types: ['室內場館'] }),
    spot({ layer: 3, types: ['商圈市集'] }),
    spot({ layer: 3, types: ['自然山林'] }),
  ];
  const out = ML.applyFilters(spots, { ...ALL(), hideIndoor: true }, colorOf, 0);
  assert.deepEqual(out, [spots[2], spots[5]]);
});

// ---- 網頁 ----

const DAY = { date: '2026-11-19', color: 'green', maxPop: 10, minAT: 20, cold: false, slots: [{ start: '09:00', end: '12:00', pop: 10 }] };
const forecast = { source: 'fixture', generatedAt: '2026-11-19T00:00:00Z', days: ['2026-11-19'], towns: { '臺北市|萬華區': [DAY] } };
const place = (o) => ({ county: '臺北市', town: '萬華區', richness: 0, weatherFit: '不分', types: ['古蹟文化'], ...o });

test('L-10 網頁：全台只畫第 1 層；打開篩選時放寬一級，第 2 層也畫出來', async () => {
  const attractions = [
    place({ id: 'A1', name: '一層', layer: 1, lat: 25.04, lng: 121.50, setting: '戶外', visitors: 1 }),
    place({ id: 'A2', name: '二層', layer: 2, lat: 25.05, lng: 121.51 }),
    place({ id: 'A3', name: '三層', layer: 3, lat: 25.06, lng: 121.52 }),
  ];
  const { els, rec } = await runPage(forecast, { attractions, zoom: 7.5 });
  assert.deepEqual(rec.markers.map((m) => m.opts.title.split('：')[0]), ['一層']);
  els.onlyGood.checked = true;
  els.onlyGood.onchange();
  assert.deepEqual(rec.markers.map((m) => m.opts.title.split('：')[0]).sort(), ['一層', '二層']);
});

test('L-11 網頁：畫面上限 30 個，太近的合併成帶數字的點；景點少（10 個以下）點了列名單、不拉近', async () => {
  const attractions = [];
  for (let i = 0; i < 40; i++) attractions.push(place({ id: `F${i}`, name: `遠${i}`, layer: 1, lat: 21 + i * 0.2, lng: 120 + (i % 5) * 0.4, setting: '戶外', visitors: 1 }));
  attractions.push(place({ id: 'N1', name: '近1', layer: 1, lat: 25.0, lng: 121.5, setting: '戶外', visitors: 1, richness: 6 }));
  attractions.push(place({ id: 'N2', name: '近2', layer: 1, lat: 25.0001, lng: 121.5001, setting: '戶外', visitors: 1, richness: 6 }));
  const { els, rec } = await runPage(forecast, { attractions, zoom: 8, mapConfig: ML.DEFAULTS });
  assert.equal(rec.markers.length, 30);
  const cluster = rec.markers.find((m) => /cluster/.test(m.opts.icon.html));
  assert.ok(cluster, '有合併的點');
  assert.match(cluster.opts.icon.html, />2</);
  assert.match(cluster.opts.title, /2 個景點：點了看名單/);
  rec.calls.length = 0; // 一打開網頁對準全台的那一次不算
  cluster.handlers.click();
  // 2026-11-28 Ray：一個點有好幾個景點時，點了列名單，不要拉到太細的尺度（卡片 NcGEXBn9）
  assert.ok(!rec.calls.includes('fitBounds') && !rec.calls.includes('setView'), rec.calls.join(','));
  assert.match(rec.popupHtml, /data-pick="N1"/);
  assert.match(rec.popupHtml, /data-pick="N2"/);
  assert.match(els.info.textContent, /畫面上 30 個點/);
  assert.match(els.info.textContent, /拉近/);
});

test('L-12 資訊框：縮圖（固定寬度、延遲載入、載不到改顯示類型圖示）、描述、標籤、官方網站；第 2–4 層沒有遊客人次', async () => {
  const attractions = [
    place({ id: 'A1', name: '一層', layer: 1, lat: 25.04, lng: 121.50, setting: '戶外', visitors: 12345 }),
    place({ id: 'A2', name: '二層', layer: 2, lat: 25.05, lng: 121.51, types: ['自然山林'], weatherFit: '好天氣才去' }),
  ];
  const details = {
    A1: { image: { url: 'https://example.test/a1.jpg', name: '一層照片' }, excerpt: '一層的描述', website: '' },
    A2: { image: { url: 'https://example.test/a2.jpg', name: '二層照片' }, excerpt: '二層的描述', website: 'https://example.test/' },
  };
  const { els, rec } = await runPage(forecast, { attractions, zoom: 9, details });
  const open = (n) => { rec.markers.find((m) => m.opts.title.startsWith(n)).handlers.click(); return rec.popupHtml; };
  const one = open('一層');
  assert.match(one, /<img[^>]+src="https:\/\/example\.test\/a1\.jpg"/);
  assert.match(one, /<img[^>]+loading="lazy"/);
  assert.match(one, /<img[^>]+width="\d+"/);
  assert.match(one, /onerror=/);
  assert.match(one, /一層的描述/);
  assert.match(one, /遊客 12,345 人次/);
  assert.doesNotMatch(one, /官方網站/);
  const two = open('二層');
  assert.match(two, /二層的描述/);
  assert.match(two, /自然山林/);
  assert.match(two, /好天氣才去/);
  assert.match(two, /<a [^>]*href="https:\/\/example\.test\/"[^>]*target="_blank"[^>]*>官方網站<\/a>/);
  assert.doesNotMatch(two, /遊客/);
  assert.ok(els);
});

test('L-13 資訊框：沒有照片時直接顯示類型的圖示，不放 <img>', async () => {
  const attractions = [place({ id: 'A1', name: '一層', layer: 1, lat: 25.04, lng: 121.50, setting: '戶外', visitors: 1, types: ['宗教廟宇'] })];
  const { rec } = await runPage(forecast, { attractions, details: { A1: { image: null, excerpt: '', website: '' } } });
  rec.markers[0].handlers.click();
  assert.doesNotMatch(rec.popupHtml, /<img/);
  assert.ok(rec.popupHtml.includes(ML.typeIcon('宗教廟宇')));
});

test('L-14 詳細資料點開才載入：第一次點景點才載 public/attraction-details.js', async () => {
  const attractions = [place({ id: 'A1', name: '一層', layer: 1, lat: 25.04, lng: 121.50, setting: '戶外', visitors: 1 })];
  const details = { A1: { image: { url: 'https://example.test/a1.jpg', name: '照片' }, excerpt: '延遲載入的描述', website: '' } };
  const { rec } = await runPage(forecast, { attractions, details, preload: false });
  assert.ok(!(rec.scripts || []).includes('public/attraction-details.js'), '一打開網頁就載了');
  rec.markers[0].handlers.click();
  await tick();
  await tick();
  assert.ok(rec.scripts.includes('public/attraction-details.js'));
  assert.match(rec.popupHtml, /延遲載入的描述/);
});

test('L-15 篩選面板：九類、三種天氣適配預設全勾，「只看戶外」只有一個（併進篩選面板）', () => {
  assert.match(html, /<details class="filters" id="filters">/);
  assert.equal((html.match(/id="hideIndoor"/g) || []).length, 1);
  const filters = html.slice(html.indexOf('id="filters"'), html.indexOf('</details>', html.indexOf('id="filters"')));
  assert.match(filters, /id="hideIndoor"/);
  assert.match(filters, /id="onlyGood"/);
  assert.match(filters, /id="typeFilters"/);
  assert.match(filters, /id="fitFilters"/);
  assert.equal(ML.TYPES.length, 9);
  assert.deepEqual([...ML.FITS], ['好天氣才去', '雨天備案', '不分']);
});

test('L-16 頁尾有「景點資料與照片來源：交通部觀光署」，氣象署、OpenStreetMap 標示還在；GA4 追蹤碼還在 <head>', () => {
  assert.match(html, /景點資料與照片來源：交通部觀光署/);
  assert.match(html, /天氣資料來源：交通部中央氣象署/);
  assert.match(html, /OpenStreetMap/);
  const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
  assert.match(head, /G-TM7NLQ9HVG/);
});

test('L-17 build：景點檔拆成畫點用的精簡檔（不到 2 MB）和點開才載入的詳細資料', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twm-split-'));
  try {
    for (const sub of ['lib', 'scripts', 'data', 'fixtures']) fs.cpSync(path.join(root, sub), path.join(dir, sub), { recursive: true });
    const env = { ...process.env };
    delete env.CWA_API_KEY;
    const r = spawnSync('node', ['scripts/build-data.js', '--fixture'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const pub = path.join(dir, 'public');
    const compact = JSON.parse(fs.readFileSync(path.join(pub, 'attractions.json'), 'utf8'));
    const details = JSON.parse(fs.readFileSync(path.join(pub, 'attraction-details.json'), 'utf8'));
    const full = JSON.parse(fs.readFileSync(path.join(root, 'data', 'attractions.json'), 'utf8'));
    assert.equal(compact.length, full.length);
    assert.ok(compact.every((a) => !('image' in a) && !('excerpt' in a) && !('website' in a)));
    assert.ok(compact.every((a) => a.id && a.layer && Array.isArray(a.types) && a.weatherFit && typeof a.richness === 'number'));
    const one = full.find((a) => a.image && a.website);
    assert.deepEqual(details[one.id], { image: one.image, excerpt: one.excerpt, website: one.website });
    assert.ok(fs.statSync(path.join(pub, 'attractions.js')).size < 2 * 1024 * 1024);
    assert.match(fs.readFileSync(path.join(pub, 'attraction-details.js'), 'utf8'), /^window\.ATTRACTION_DETAILS = /);
    // 網頁一打開只載精簡檔，詳細資料不在 <script src> 裡
    assert.match(html, /<script src="public\/attractions\.js"><\/script>/);
    assert.doesNotMatch(html, /<script src="public\/attraction-details\.js">/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 第一輪檢查找到的問題（2026-11-28） ----

for (const [label, details] of [['載入失敗', 'fail'], ['載入了但沒有資料', null]]) {
  test(`L-18 詳細資料${label}：資訊框照樣打開（天氣照常），不重試、不卡住，只是沒有照片`, async () => {
    const attractions = [place({ id: 'A1', name: '一層', layer: 1, lat: 25.04, lng: 121.50, setting: '戶外', visitors: 1 })];
    const { rec } = await runPage(forecast, { attractions, details, preload: false });
    rec.markers[0].handlers.click();
    for (let i = 0; i < 5; i++) await tick();
    assert.match(rec.popupHtml || '', /不太會下雨/);
    assert.equal((rec.scripts || []).filter((x) => x === 'public/attraction-details.js').length, 1);
    // 再點一次也不會一直重試
    rec.markers[0].handlers.click();
    for (let i = 0; i < 5; i++) await tick();
    assert.ok((rec.scripts || []).filter((x) => x === 'public/attraction-details.js').length <= 2);
  });
}

test('L-19 官方網站只接受 http、https 開頭的網址（擋 javascript: 之類）', async () => {
  const attractions = [place({ id: 'A1', name: '一層', layer: 1, lat: 25.04, lng: 121.50, setting: '戶外', visitors: 1 })];
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x']) {
    const { rec } = await runPage(forecast, { attractions, details: { A1: { image: null, excerpt: '', website: bad } } });
    rec.markers[0].handlers.click();
    assert.doesNotMatch(rec.popupHtml, /官方網站/, bad);
  }
  const { rec } = await runPage(forecast, { attractions, details: { A1: { image: null, excerpt: '', website: 'http://example.test/' } } });
  rec.markers[0].handlers.click();
  assert.match(rec.popupHtml, /href="http:\/\/example\.test\/"[^>]*>官方網站/);
});

test('L-20 選到的景點在「點了拉近看」的合併點裡（超過 10 個）：它自己單獨畫，其他景點照樣留在合併的點（數字少 1）', async () => {
  // 2026-11-28 改：10 個以下的合併點改成點了列名單、選到也不拆（L-33），所以這裡用 12 個
  const attractions = crowd(12);
  const { els, rec } = await runPage(forecast, { attractions, mapConfig: { cap: 30, clusterPx: 40 }, zoom: 17.5 });
  rec.markers.find((m) => m.opts.title.startsWith('擠5')).handlers.click();
  rec.map.zoom = 8;
  rec.mapOn.moveend();
  const titles = rec.markers.map((m) => m.opts.title);
  assert.equal(rec.markers.length, 2, titles.join('、'));
  assert.ok(titles.some((t) => t.startsWith('擠5')), '選到的單獨畫');
  const cluster = rec.markers.find((m) => /cluster/.test(m.opts.icon.html));
  assert.match(cluster.opts.icon.html, />11</);
  assert.match(cluster.opts.title, /點了拉近看/);
  assert.match(els.info.textContent, /顯示 12 \/ 12 個景點/);
});

test('L-21 選到的景點被畫面上限擠掉時：還是畫出來（資訊框開著，地圖上就要有那個點）', async () => {
  const attractions = [
    place({ id: 'TOP', name: '熱門', layer: 1, lat: 22.0, lng: 120.0, setting: '戶外', visitors: 1 }),
    place({ id: 'SEL', name: '選到的', layer: 2, lat: 25.0, lng: 121.5, types: ['自然山林'] }),
  ];
  const { els, rec } = await runPage(forecast, { attractions, mapConfig: { cap: 1, clusterPx: 0 }, zoom: 9 });
  // 只看自然山林：熱門（古蹟文化）被篩掉，畫面上只有選到的
  els.typeFilters.children.forEach((label) => { const box = label.children[0]; box.checked = box.value === '自然山林'; });
  els.typeFilters.children[0].children[0].onchange();
  rec.markers.find((m) => m.opts.title.startsWith('選到的')).handlers.click();
  // 全部勾回來：熱門排名比較前面，上限 1 個
  els.typeFilters.children.forEach((label) => { label.children[0].checked = true; });
  els.typeFilters.children[0].children[0].onchange();
  const titles = rec.markers.map((m) => m.opts.title);
  assert.ok(titles.some((t) => t.startsWith('選到的')), titles.join('、'));
});

test('L-22 網頁的九類和天氣適配，跟 build（lib/attractions.js）產出的一模一樣', async () => {
  const { buildAttractions } = await import('../lib/attractions.js');
  const { stats } = buildAttractions({ attractions: [], visitors: [], top: [], config: { ratio: 0.25, min: 2, max: 10 } });
  assert.deepEqual([...ML.TYPES], Object.keys(stats.types));
  assert.deepEqual([...ML.FITS], Object.keys(stats.weatherFit));
});

// ---- 第二輪檢查找到的問題（2026-11-28），Ray 說修完再合併 ----

test('L-23 座標完全一樣的景點：拉到最近還疊在一起，點那個點列出名單，點名字打開那個景點', async () => {
  const attractions = [
    place({ id: 'H1', name: '慈湖', layer: 1, lat: 24.84037, lng: 121.29427, setting: '戶外', visitors: 1 }),
    place({ id: 'H2', name: '慈湖陵寢', layer: 4, lat: 24.84037, lng: 121.29427 }),
    place({ id: 'H3', name: '大溪慈湖步道', layer: 4, lat: 24.84037, lng: 121.29427 }),
  ];
  const { els, rec } = await runPage(forecast, { attractions, mapConfig: { cap: 30, clusterPx: 36 }, zoom: 17.5 });
  assert.equal(rec.markers.length, 1, '疊在一起的三個畫成一個點');
  const m = rec.markers[0];
  assert.match(m.opts.icon.html, />3</);
  assert.match(m.opts.title, /3 個景點：點了看名單/);
  rec.calls.length = 0;
  m.handlers.click();
  assert.ok(!rec.calls.includes('fitBounds'), '已經拉到最近，不再拉近');
  for (const n of ['慈湖', '慈湖陵寢', '大溪慈湖步道']) assert.match(rec.popupHtml, new RegExp(`data-pick="[^"]+">${n}<`));
  // 點名單裡的「慈湖陵寢」
  rec.docOn.click({ target: { closest: (sel) => (sel === '[data-pick]' ? { dataset: { pick: 'H2' } } : null) } });
  assert.match(rec.popupHtml, /<div class="name">慈湖陵寢/);
});

// 很多個景點擠在一起（超過 10 個）
const crowd = (n, lat = 25.0, lng = 121.5) => Array.from({ length: n }, (_, i) => place({ id: `C${i}`, name: `擠${i}`, layer: 1, lat: lat + i * 0.0002, lng: lng + i * 0.0002, setting: '戶外', visitors: 1 }));

test('L-24 景點多（超過 10 個）：點了拉近，但最多拉到鄉鎮尺度（13 級），不拉到街道', async () => {
  const { rec } = await runPage(forecast, { attractions: crowd(12), mapConfig: { cap: 30, clusterPx: 36 }, zoom: 8 });
  assert.equal(rec.markers.length, 1);
  assert.match(rec.markers[0].opts.title, /12 個景點：點了拉近看/);
  rec.calls.length = 0;
  rec.markers[0].handlers.click();
  assert.ok(rec.calls.includes('fitBounds'));
  assert.equal(rec.lastFitOpts.maxZoom, ML.DEFAULTS.zoomCap);
  assert.equal(ML.DEFAULTS.zoomCap, 13);
  assert.equal(ML.DEFAULTS.listMax, 10);
});

test('L-32 已經拉到鄉鎮尺度（13 級以上），景點多的點也直接列名單（不然點了沒反應）', async () => {
  const { rec } = await runPage(forecast, { attractions: crowd(12), mapConfig: { cap: 30, clusterPx: 36 }, zoom: 13 });
  assert.match(rec.markers[0].opts.title, /12 個景點：點了看名單/);
  rec.calls.length = 0;
  rec.markers[0].handlers.click();
  assert.ok(!rec.calls.includes('fitBounds'));
  assert.equal((rec.popupHtml.match(/data-pick=/g) || []).length, 12);
});

for (const narrow of [false, true]) {
  test(`L-25 詳細資料晚到（${narrow ? '手機' : '桌機'}）：使用者已經拖動或縮放地圖，就只換內容、不移動地圖`, async () => {
    const attractions = [place({ id: 'A1', name: '一層', layer: 1, lat: 25.04, lng: 121.50, setting: '戶外', visitors: 1 })];
    const details = { A1: { image: null, excerpt: '晚到的描述', website: '' } };
    const { els, rec } = await runPage(forecast, { attractions, details, preload: false, narrow });
    rec.markers[0].handlers.click();
    rec.mapOn.dragstart(); // 使用者把地圖拖走
    const opened = rec.calls.filter((c) => c === 'openPopup' || c === 'panInside').length;
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(rec.calls.filter((c) => c === 'openPopup' || c === 'panInside').length, opened, rec.calls.join(','));
    const html = narrow ? els.sheetBody.innerHTML : rec.popupHtml;
    assert.match(html, /晚到的描述/);
    if (!narrow) assert.equal(rec.popupAutoPan, false, '換內容時不自動移動地圖');
  });

  test(`L-25b 詳細資料晚到（${narrow ? '手機' : '桌機'}）：使用者沒動過地圖，照片撐高資訊框後照常把選到的點移到看得見的地方`, async () => {
    const attractions = [place({ id: 'A1', name: '一層', layer: 1, lat: 25.04, lng: 121.50, setting: '戶外', visitors: 1 })];
    const details = { A1: { image: { url: 'https://example.test/a.jpg', name: '照片' }, excerpt: '晚到的描述', website: '' } };
    const { rec } = await runPage(forecast, { attractions, details, preload: false, narrow });
    rec.markers[0].handlers.click();
    const pans = rec.calls.filter((c) => c === 'panInside').length;
    for (let i = 0; i < 5; i++) await tick();
    if (narrow) assert.equal(rec.calls.filter((c) => c === 'panInside').length, pans + 1);
    else assert.notEqual(rec.popupAutoPan, false);
    assert.equal(rec.calls.filter((c) => c === 'openPopup').length, narrow ? 0 : 1, '不重新打開');
  });
}

test('L-26 點合併的點拉近：避開左上的面板（跟一開始對準全台一樣）', async () => {
  const attractions = crowd(12);
  for (const narrow of [false, true]) {
    const { rec } = await runPage(forecast, { attractions, mapConfig: { cap: 30, clusterPx: 40 }, zoom: 8, narrow });
    rec.markers[0].handlers.click();
    const o = rec.lastFitOpts || {};
    assert.ok(Array.isArray(o.paddingTopLeft) && Array.isArray(o.paddingBottomRight), JSON.stringify(o));
  }
});

// ---- 第三輪檢查找到的問題（2026-11-28） ----

test('L-27 手機底部面板的關閉鈕樣式只套在關閉鈕，不會套到名單的按鈕', () => {
  assert.doesNotMatch(html, /\.sheet button\s*\{[^}]*position:\s*absolute/);
  assert.match(html, /#sheetClose\s*\{[^}]*position:\s*absolute/);
});

const stack = [
  place({ id: 'H1', name: '慈湖', layer: 1, lat: 24.84037, lng: 121.29427, setting: '戶外', visitors: 1 }),
  place({ id: 'H2', name: '慈湖陵寢', layer: 4, lat: 24.84037, lng: 121.29427, types: ['古蹟文化'] }),
];
const pick = (rec, id) => rec.docOn.click({ target: { closest: (sel) => (sel === '[data-pick]' ? { dataset: { pick: id } } : null) } });

test('L-28 拉到最近從名單選了一個：疊在一起的點照樣是一個合併點（標成選到），點它再列名單，另一個不會被蓋住', async () => {
  const { rec } = await runPage(forecast, { attractions: stack, mapConfig: { cap: 30, clusterPx: 36 }, zoom: 17.5 });
  rec.markers[0].handlers.click();
  pick(rec, 'H2');
  assert.match(rec.popupHtml, /<div class="name">慈湖陵寢/);
  assert.equal(rec.markers.length, 1, rec.markers.map((m) => m.opts.title).join('、'));
  assert.match(rec.markers[0].opts.icon.html, /cluster[^"]* sel/);
  rec.markers[0].handlers.click();
  assert.match(rec.popupHtml, /data-pick="H1"/);
  assert.match(rec.popupHtml, /data-pick="H2"/);
});

test('L-29 名單開著時篩選或縮小地圖、名單裡的景點不再顯示：名單收起來', async () => {
  for (const change of ['filter', 'zoom']) {
    const { els, rec } = await runPage(forecast, { attractions: stack, mapConfig: { cap: 30, clusterPx: 36 }, zoom: 17.5 });
    rec.markers[0].handlers.click();
    assert.match(rec.popupHtml, /這裡有 2 個景點/);
    rec.calls.length = 0;
    if (change === 'filter') {
      els.onlyGood.checked = false;
      const box = els.typeFilters.children.map((l) => l.children[0]).find((b) => b.value === '古蹟文化');
      box.checked = false;
      box.onchange();
    } else {
      rec.map.zoom = 12; // 第 4 層不畫
      rec.mapOn.moveend();
    }
    assert.ok(rec.calls.includes('closePopup'), `${change}：名單沒有收起來`);
  }
});

test('L-30 資訊框開著時點別的點：Leaflet 先關資訊框再送點擊，這一下就要打開新的點（不能被重畫吃掉）', async () => {
  const attractions = [
    place({ id: 'A', name: '甲', layer: 1, lat: 25.0, lng: 121.5, setting: '戶外', visitors: 1 }),
    place({ id: 'B', name: '乙', layer: 1, lat: 23.0, lng: 120.2, setting: '戶外', visitors: 1 }),
  ];
  const { rec } = await runPage(forecast, { attractions });
  rec.markers.find((m) => m.opts.title.startsWith('甲')).handlers.click();
  // 點乙：同一次點擊裡先關掉資訊框（popupclose），再送到乙的標記
  const b = rec.markers.find((m) => m.opts.title.startsWith('乙'));
  rec.mapOn.popupclose();
  b.handlers.click();
  await tick();
  assert.match(rec.popupHtml, /<div class="name">乙/);
  assert.ok(rec.markers.some((m) => m.opts.title.startsWith('乙') && /sel/.test(m.opts.icon.html)), '乙標成選到');
});

test('L-31 手機：底部面板最高佔畫面 38%、超過就捲動，縮圖矮一點；上面的面板加底部面板不能蓋滿整個地圖', () => {
  const phone = html.slice(html.indexOf('@media (max-width: 599px)'));
  const block = phone.slice(0, phone.indexOf('\n  }\n') + 4);
  // 卡片 n28aWi9j：捲動從 .sheet 移到 #sheetBody（關閉鈕才不會跟著捲走）
  assert.match(block, /\.sheet\s*\{[^}]*max-height:\s*38%/);
  assert.match(block, /#sheetBody\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(block, /\.detail \.thumb\s*\{[^}]*height:\s*96px/);
});

// ---- 卡片 NcGEXBn9 檢查找到的問題（2026-11-28） ----

test('L-33 「點了看名單」的合併點：從名單選了一個，不拆出來（座標一樣會蓋住其他的），合併點標成選到', async () => {
  const { rec } = await runPage(forecast, { attractions: stack, mapConfig: { cap: 30, clusterPx: 36 }, zoom: 16 });
  assert.match(rec.markers[0].opts.title, /2 個景點：點了看名單/);
  rec.markers[0].handlers.click();
  pick(rec, 'H1');
  assert.match(rec.popupHtml, /<div class="name">慈湖/);
  assert.equal(rec.markers.length, 1, rec.markers.map((m) => m.opts.title).join('、'));
  assert.match(rec.markers[0].opts.icon.html, /cluster[^"]* sel/);
});

test('L-34 拉近反而不會比較近（例如矮的手機螢幕，面板把空間吃光）：改成列名單，不縮小地圖', async () => {
  const { rec } = await runPage(forecast, { attractions: crowd(12), mapConfig: { cap: 30, clusterPx: 36 }, zoom: 9, boundsZoom: 0 });
  assert.match(rec.markers[0].opts.title, /12 個景點：點了看名單/);
  rec.calls.length = 0;
  rec.markers[0].handlers.click();
  assert.ok(!rec.calls.includes('fitBounds'), rec.calls.join(','));
  assert.equal((rec.popupHtml.match(/data-pick=/g) || []).length, 12);
});

test('L-35 手機：名單只在底部面板捲動一層，不在名單裡再捲一層', () => {
  const phone = html.slice(html.indexOf('@media (max-width: 599px)'));
  const block = phone.slice(0, phone.indexOf('\n  }\n') + 4);
  assert.match(block, /\.sheet \.picklist\s*\{[^}]*max-height:\s*none/);
});

test('L-36 面板把地圖的空間吃光（扣掉面板和留白，可用高度不到 0）：合併點也列名單，不拉近', async () => {
  // 手機 360×300：上面的面板 225 高，拉近要留的上下空白共 305，比地圖還高
  const { rec } = await runPage(forecast, { attractions: crowd(12), mapConfig: { cap: 30, clusterPx: 36 }, zoom: 9, narrow: true, mapSize: { x: 360, y: 300 }, panelSize: { x: 360, y: 225 }, boundsZoom: 18 });
  assert.match(rec.markers[0].opts.title, /12 個景點：點了看名單/);
  rec.calls.length = 0;
  rec.markers[0].handlers.click();
  assert.ok(!rec.calls.includes('fitBounds'), rec.calls.join(','));
});

test('L-37 打開或收起「圖例說明與設定」「篩選景點」：重畫一次，合併點的提示文字跟著新的面板大小', async () => {
  const { els, rec } = await runPage(forecast, { attractions: crowd(12), mapConfig: { cap: 30, clusterPx: 36 }, zoom: 9 });
  for (const id of ['more', 'filters']) {
    assert.equal(typeof els[id].ontoggle, 'function', id);
    const before = rec.markers[0];
    els[id].ontoggle();
    assert.notEqual(rec.markers[0], before, `${id}：沒有重畫`);
  }
});

// ---- 卡片 https://trello.com/c/PKnw1n7J ：從名單點進景點資訊以後，可以回到名單 ----

const back = (rec) => rec.docOn.click({ target: { closest: (sel) => (sel === '[data-back-list]' ? {} : null) } });
const trio = [
  place({ id: 'H1', name: '慈湖', layer: 1, lat: 24.84037, lng: 121.29427, setting: '戶外', visitors: 1 }),
  place({ id: 'H2', name: '慈湖陵寢', layer: 1, lat: 24.84037, lng: 121.29427, setting: '戶外', visitors: 1 }),
  place({ id: 'H3', name: '大溪慈湖步道', layer: 1, lat: 24.84037, lng: 121.29427, setting: '戶外', visitors: 1 }),
];

for (const narrow of [false, true]) {
  test(`L-38 從名單點進景點（${narrow ? '手機' : '桌機'}）：最上面有「回到名單」，按了回到同一份名單，再點別的也有`, async () => {
    const { els, rec } = await runPage(forecast, { attractions: trio, mapConfig: { cap: 30, clusterPx: 36 }, zoom: 12, narrow });
    const shown = () => (narrow ? els.sheetBody.innerHTML : rec.popupHtml);
    rec.markers[0].handlers.click();
    pick(rec, 'H2');
    assert.match(shown(), /<div class="name">慈湖陵寢/);
    assert.match(shown(), /data-back-list[^>]*>← 回到名單（3 個景點）</);
    assert.ok(shown().indexOf('data-back-list') < shown().indexOf('<div class="name">'), '按鈕在最上面');
    back(rec);
    assert.match(shown(), /這裡有 3 個景點/);
    for (const id of ['H1', 'H2', 'H3']) assert.match(shown(), new RegExp(`data-pick="${id}"`));
    pick(rec, 'H3');
    assert.match(shown(), /<div class="name">大溪慈湖步道/);
    assert.match(shown(), /data-back-list/);
  });
}

test('L-39 直接點地圖上的景點打開資訊：沒有「回到名單」；從名單點進去、關掉以後再直接點：也沒有', async () => {
  const solo = [place({ id: 'S1', name: '單獨', layer: 1, lat: 23.0, lng: 120.2, setting: '戶外', visitors: 1 }), ...trio];
  const { rec } = await runPage(forecast, { attractions: solo, mapConfig: { cap: 30, clusterPx: 36 }, zoom: 12 });
  rec.markers.find((m) => m.opts.title.startsWith('單獨')).handlers.click();
  assert.doesNotMatch(rec.popupHtml, /data-back-list/);
  rec.markers.find((m) => /個景點/.test(m.opts.title)).handlers.click();
  pick(rec, 'H1');
  assert.match(rec.popupHtml, /data-back-list/);
  rec.mapOn.popupclose();
  await tick();
  rec.markers.find((m) => m.opts.title.startsWith('單獨')).handlers.click();
  assert.doesNotMatch(rec.popupHtml, /data-back-list/);
});

test('L-40 名單裡的景點被篩掉（名單已經不成立）：資訊框不顯示「回到名單」', async () => {
  const mixed = [
    place({ id: 'M1', name: '古蹟', layer: 1, lat: 24.84037, lng: 121.29427, setting: '戶外', visitors: 1, types: ['古蹟文化'] }),
    place({ id: 'M2', name: '山林', layer: 1, lat: 24.84037, lng: 121.29427, setting: '戶外', visitors: 1, types: ['自然山林'] }),
  ];
  const { els, rec } = await runPage(forecast, { attractions: mixed, mapConfig: { cap: 30, clusterPx: 36 }, zoom: 12 });
  rec.markers[0].handlers.click();
  pick(rec, 'M1');
  assert.match(rec.popupHtml, /data-back-list/);
  const box = els.typeFilters.children.map((l) => l.children[0]).find((b) => b.value === '自然山林');
  box.checked = false;
  box.onchange();
  // 選到的「古蹟」還在，資訊框重新顯示（換日期）時不再有回到名單
  els.days.children[0].onclick();
  assert.doesNotMatch(rec.popupHtml, /data-back-list/);
});

// ---- 卡片 PKnw1n7J 檢查找到的問題（2026-11-28） ----

const mixedPair = [
  place({ id: 'M1', name: '古蹟', layer: 1, lat: 24.84037, lng: 121.29427, setting: '戶外', visitors: 1, types: ['古蹟文化'] }),
  place({ id: 'M2', name: '山林', layer: 1, lat: 24.84037, lng: 121.29427, setting: '戶外', visitors: 1, types: ['自然山林'] }),
];

for (const narrow of [false, true]) {
  test(`L-41 資訊框開著時名單裡的景點被篩掉（${narrow ? '手機' : '桌機'}）：「回到名單」當下就消失，不用等換日期`, async () => {
    const { els, rec } = await runPage(forecast, { attractions: mixedPair, mapConfig: { cap: 30, clusterPx: 36 }, zoom: 12, narrow });
    const shown = () => (narrow ? els.sheetBody.innerHTML : rec.popupHtml);
    rec.markers[0].handlers.click();
    pick(rec, 'M1');
    assert.match(shown(), /data-back-list/);
    const box = els.typeFilters.children.map((l) => l.children[0]).find((b) => b.value === '自然山林');
    box.checked = false;
    box.onchange();
    assert.doesNotMatch(shown(), /data-back-list/);
    assert.match(shown(), /<div class="name">古蹟/);
  });
}

test('L-42 點進景點後把地圖拉近或拖走，名單裡有景點不在畫面上：「回到名單」消失（不會把地圖帶到別的地方）', async () => {
  const { rec } = await runPage(forecast, { attractions: trio, mapConfig: { cap: 30, clusterPx: 36 }, zoom: 12 });
  rec.markers[0].handlers.click();
  pick(rec, 'H2');
  assert.match(rec.popupHtml, /data-back-list/);
  rec.map.inView = ([lat, lng]) => !(lat === trio[2].lat && lng === trio[2].lng && false); // 都還在畫面裡
  rec.mapOn.moveend();
  assert.match(rec.popupHtml, /data-back-list/, '都在畫面裡就留著');
  const far = [place({ id: 'F1', name: '遠一', layer: 1, lat: 24.0, lng: 120.5, setting: '戶外', visitors: 1 }), place({ id: 'F2', name: '遠二', layer: 1, lat: 24.1, lng: 120.6, setting: '戶外', visitors: 1 })];
  const r2 = await runPage(forecast, { attractions: far, mapConfig: { cap: 30, clusterPx: 4000 }, zoom: 8 });
  r2.rec.markers[0].handlers.click();
  pick(r2.rec, 'F1');
  assert.match(r2.rec.popupHtml, /data-back-list/);
  r2.rec.map.inView = ([lat]) => lat < 24.05; // 拉近以後只看得到遠一
  r2.rec.mapOn.moveend();
  assert.doesNotMatch(r2.rec.popupHtml, /data-back-list/);
});

test('L-43 手機：名單往下捲再點名字，打開的景點資訊從最上面開始（看得到「回到名單」）', async () => {
  const { els, rec } = await runPage(forecast, { attractions: trio, mapConfig: { cap: 30, clusterPx: 36 }, zoom: 12, narrow: true });
  rec.markers[0].handlers.click();
  // 卡片 n28aWi9j 以後捲動的是 #sheetBody（關閉鈕才不會跟著捲走）
  els.sheetBody.scrollTop = 500;
  pick(rec, 'H3');
  assert.equal(els.sheetBody.scrollTop, 0);
  els.sheetBody.scrollTop = 300;
  back(rec);
  assert.equal(els.sheetBody.scrollTop, 0, '回到名單也從最上面開始');
});

// ---- 卡片 https://trello.com/c/zdHhqzYa ：用關鍵字搜尋景點（Ray 2026-11-28：照建議做） ----

test('S-1 比對前去掉空白、「臺」「台」當同一個字、大小寫不分；多個關鍵字用空白分開，全部都要符合', () => {
  const s = { name: '行天宮北投分宮_忠義廟', county: '臺北市', town: '北投區' };
  const ok = (q) => ML.matchesQuery(s, ML.parseQuery(q));
  assert.ok(ok('行天宮'));
  assert.ok(ok('台北 行天宮'));
  assert.ok(ok('北投區 忠義'));
  assert.ok(ok('行天宮　北投')); // 全形空白也算分隔
  assert.ok(!ok('行天宮 中山'));
  assert.ok(ML.matchesQuery({ name: 'Mitsui Outlet Park 林口', county: '新北市', town: '林口區' }, ML.parseQuery('outlet park')));
  assert.deepEqual([...ML.parseQuery('  ')], []);
});

test('S-2 縣市、鄉鎮也搜得到', () => {
  const s = { name: '某某公園', county: '高雄市', town: '鳳山區' };
  assert.ok(ML.matchesQuery(s, ML.parseQuery('鳳山')));
  assert.ok(ML.matchesQuery(s, ML.parseQuery('高雄 公園')));
  assert.ok(!ML.matchesQuery(s, ML.parseQuery('台南')));
});

const temples = [
  place({ id: 'T1', name: '行天宮', layer: 4, lat: 25.06308, lng: 121.5339, town: '中山區', types: ['宗教廟宇'] }),
  place({ id: 'T2', name: '行天宮北投分宮_忠義廟', layer: 4, lat: 25.13701, lng: 121.47757, town: '北投區', types: ['宗教廟宇'] }),
  place({ id: 'P1', name: '大安森林公園', layer: 1, lat: 25.0299, lng: 121.5362, town: '大安區', setting: '戶外', visitors: 1, types: ['公園運動'] }),
];
const typeSearch = (els, q) => { els.search.value = q; els.search.oninput(); };
const markerNames = (rec) => rec.markers.map((m) => m.opts.title.split('：')[0]);

test('S-3 搜尋時不管縮放級數：全台畫面也畫出符合的第 4 層景點；跟類型篩選一起用', async () => {
  const { els, rec } = await runPage(forecast, { attractions: temples, zoom: 7.5 });
  assert.deepEqual(markerNames(rec), ['大安森林公園']);
  typeSearch(els, '行天宮');
  assert.deepEqual(markerNames(rec).sort(), ['行天宮', '行天宮北投分宮_忠義廟']);
  assert.equal(els.filtersTitle.textContent, '篩選景點（已篩選）');
  // 跟類型一起用：只勾公園運動，行天宮都不符合
  els.typeFilters.children.forEach((l) => { const b = l.children[0]; b.checked = b.value === '公園運動'; });
  els.typeFilters.children[0].children[0].onchange();
  assert.equal(rec.markers.length, 0);
  assert.match(els.searchResults.innerHTML, /找不到符合的景點/);
});

test('S-4 搜尋結果清單：最多 20 個、先層後資料豐富度；點名字把地圖移過去並打開那個景點', async () => {
  const many = Array.from({ length: 25 }, (_, i) => place({ id: 'G' + i, name: '公園' + i, layer: 1 + (i % 4), richness: i % 7, lat: 24 + i * 0.01, lng: 121, visitors: 1 }));
  const { els, rec } = await runPage(forecast, { attractions: many, zoom: 7.5 });
  typeSearch(els, '公園');
  const ids = [...els.searchResults.innerHTML.matchAll(/data-goto="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 20);
  const order = ids.map((id) => many.find((s) => s.id === id));
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1];
    const b = order[i];
    assert.ok(a.layer < b.layer || (a.layer === b.layer && a.richness >= b.richness), a.name + ' 應該排在 ' + b.name + ' 前面');
  }
  assert.match(els.searchResults.innerHTML, /共 25 個/);
  rec.calls.length = 0;
  rec.docOn.click({ target: { closest: (sel) => (sel === '[data-goto]' ? { dataset: { goto: 'G7' } } : null) } });
  assert.ok(rec.calls.includes('setView'), rec.calls.join(','));
  assert.match(rec.popupHtml, /<div class="name">公園7/);
});

test('S-5 清除：搜尋框清空，地圖回到原本只畫第 1 層的樣子，結果清單收起來', async () => {
  const { els, rec } = await runPage(forecast, { attractions: temples, zoom: 7.5 });
  typeSearch(els, '行天宮');
  assert.equal(rec.markers.length, 2);
  els.searchClear.onclick();
  assert.equal(els.search.value, '');
  assert.deepEqual(markerNames(rec), ['大安森林公園']);
  assert.equal(els.searchResults.innerHTML, '');
  assert.equal(els.filtersTitle.textContent, '篩選景點');
});

test('S-6 搜尋框在篩選面板最上面；手機字級 16px（iPhone 才不會自動放大）', () => {
  const filters = html.slice(html.indexOf('id="filters"'), html.indexOf('</details>', html.indexOf('id="filters"')));
  assert.ok(filters.indexOf('id="search"') > 0 && filters.indexOf('id="search"') < filters.indexOf('id="typeFilters"'));
  assert.match(filters, /<input[^>]*type="search"[^>]*id="search"|<input[^>]*id="search"[^>]*type="search"/);
  assert.match(filters, /id="searchClear"/);
  assert.match(filters, /id="searchResults"/);
  const phone = html.slice(html.indexOf('@media (max-width: 599px)'));
  const block = phone.slice(0, phone.indexOf('\n  }\n') + 4);
  assert.match(block, /#search\s*\{[^}]*font-size:\s*16px/);
});

test('S-7 有搜尋時，上面的摘要算搜到的景點（不只第 1 層），不會寫「沒有景點可以顯示」', async () => {
  const { els } = await runPage(forecast, { attractions: temples, zoom: 7.5 });
  typeSearch(els, '行天宮');
  assert.doesNotMatch(els.summary.textContent, /沒有景點可以顯示/);
  assert.match(els.summary.textContent, /2 個景點/);
});

test('S-8 手機：從搜尋結果點景點，篩選面板收起來（地圖和選到的點才看得到）', async () => {
  const { els, rec } = await runPage(forecast, { attractions: temples, zoom: 7.5, narrow: true });
  els.filters.open = true;
  typeSearch(els, '北投');
  rec.docOn.click({ target: { closest: (sel) => (sel === '[data-goto]' ? { dataset: { goto: 'T2' } } : null) } });
  assert.equal(els.filters.open, false);
  assert.match(els.sheetBody.innerHTML, /<div class="name">行天宮北投分宮_忠義廟/);
});

// ---- 卡片 zdHhqzYa 檢查找到的問題（2026-11-28） ----

test('S-9 名稱、縣市、鄉鎮分開比對：關鍵字不會跨欄位對到（「…平台」＋「南投縣」不算「台南」）', () => {
  const s = { name: '九龍口大平台', county: '南投縣', town: '魚池鄉' };
  assert.ok(!ML.matchesQuery(s, ML.parseQuery('台南')));
  assert.ok(ML.matchesQuery(s, ML.parseQuery('平台 南投')));
});

test('S-10 全形英數、全形括號當成半形：搜「１０１」「ＳＯＧＯ」「（」也找得到', () => {
  assert.ok(ML.matchesQuery({ name: '台北101', county: '臺北市', town: '信義區' }, ML.parseQuery('１０１')));
  assert.ok(ML.matchesQuery({ name: 'SOGO百貨', county: '臺北市', town: '大安區' }, ML.parseQuery('ｓｏｇｏ')));
  assert.ok(ML.matchesQuery({ name: '南鯤鯓代天府(大鯤園)', county: '臺南市', town: '北門區' }, ML.parseQuery('（大鯤園）')));
});

test('S-11 注音組字還沒選字時不重畫（不清掉地圖和打開的景點）；選完字才重畫', async () => {
  const { els, rec } = await runPage(forecast, { attractions: temples, zoom: 7.5 });
  rec.markers.find((m) => m.opts.title.startsWith('大安森林公園')).handlers.click();
  assert.match(rec.popupHtml, /大安森林公園/);
  const before = rec.markers;
  els.search.value = 'ㄒ';
  els.search.oninput({ isComposing: true });
  assert.equal(rec.markers, before, '組字中重畫了');
  assert.ok(!rec.calls.includes('closePopup'));
  els.search.value = '行天宮';
  els.search.oninput({ isComposing: false });
  assert.deepEqual(markerNames(rec).sort(), ['行天宮', '行天宮北投分宮_忠義廟']);
  // 有些瀏覽器選完字只送 compositionend
  els.search.value = '北投';
  els.search.oncompositionend();
  assert.deepEqual(markerNames(rec), ['行天宮北投分宮_忠義廟']);
});

test('S-12 拖動地圖時結果清單內容沒變就不換（鍵盤焦點才不會掉）', async () => {
  const { els, rec } = await runPage(forecast, { attractions: temples, zoom: 7.5 });
  typeSearch(els, '行天宮');
  let writes = 0;
  let value = els.searchResults.innerHTML;
  Object.defineProperty(els.searchResults, 'innerHTML', { get: () => value, set: (v) => { writes++; value = v; } });
  rec.mapOn.moveend();
  rec.mapOn.moveend();
  assert.equal(writes, 0);
  typeSearch(els, '北投');
  assert.equal(writes, 1);
});

// ---- 卡片 https://trello.com/c/n28aWi9j ：手機底部景點卡片的關閉鈕固定在右上角（Ray 2026-11-28） ----

const phoneCss = () => {
  const start = html.indexOf('@media (max-width: 599px) {');
  assert.ok(start > 0, '找不到手機版 CSS');
  return html.slice(start, html.indexOf('\n  }\n', start));
};
const rule = (css, sel) => {
  const m = css.match(new RegExp('(^|\\n)\\s*' + sel.replace(/[.#[\]]/g, (c) => '\\' + c) + '\\s*\\{([^}]*)\\}'));
  return m ? m[2] : null;
};

test('X-1 手機：底部面板本身不捲動，捲動的是內容 #sheetBody（關閉鈕才不會跟著捲走）', () => {
  const css = phoneCss();
  const sheet = rule(css, '.sheet');
  assert.ok(sheet, '手機版要有 .sheet 規則');
  assert.match(sheet, /max-height:\s*38%/, '面板最高 38% 不變');
  assert.doesNotMatch(sheet, /overflow/, '.sheet 不可以捲動');
  const body = rule(css, '#sheetBody');
  assert.ok(body, '手機版要有 #sheetBody 規則');
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /min-height:\s*0/, '彈性排版裡要 min-height: 0 才捲得動');
});

test('X-2 關閉鈕直接放在 #sheet 裡，不在 #sheetBody 裡（捲動的元素裡面）', () => {
  const m = html.match(/<div class="sheet" id="sheet" hidden>([\s\S]*?)<div id="sheetBody"><\/div>\s*<\/div>/);
  assert.ok(m, '底部面板的結構變了');
  assert.match(m[1], /id="sheetClose"/);
  assert.match(rule(html, '#sheetClose') || '', /position:\s*absolute/);
});

test('X-3 底部面板用 display: flex 時，hidden 還是要藏得起來', () => {
  const css = phoneCss();
  if (/display:\s*flex/.test(rule(css, '.sheet') || '')) {
    assert.match(html, /\.sheet\[hidden\]\s*\{[^}]*display:\s*none/);
  }
});
