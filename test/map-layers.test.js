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

test('L-11 網頁：畫面上限 30 個，太近的合併成帶數字的點，點了拉近', async () => {
  const attractions = [];
  for (let i = 0; i < 40; i++) attractions.push(place({ id: `F${i}`, name: `遠${i}`, layer: 1, lat: 21 + i * 0.2, lng: 120 + (i % 5) * 0.4, setting: '戶外', visitors: 1 }));
  attractions.push(place({ id: 'N1', name: '近1', layer: 1, lat: 25.0, lng: 121.5, setting: '戶外', visitors: 1, richness: 6 }));
  attractions.push(place({ id: 'N2', name: '近2', layer: 1, lat: 25.0001, lng: 121.5001, setting: '戶外', visitors: 1, richness: 6 }));
  const { els, rec } = await runPage(forecast, { attractions, zoom: 8, mapConfig: ML.DEFAULTS });
  assert.equal(rec.markers.length, 30);
  const cluster = rec.markers.find((m) => /cluster/.test(m.opts.icon.html));
  assert.ok(cluster, '有合併的點');
  assert.match(cluster.opts.icon.html, />2</);
  assert.match(cluster.opts.title, /2 個景點/);
  cluster.handlers.click();
  assert.ok(rec.calls.includes('fitBounds') || rec.calls.includes('setView'));
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

test('L-20 選到的景點在合併的點裡：它自己單獨畫，其他景點照樣留在合併的點（數字少 1）', async () => {
  const attractions = [
    place({ id: 'A', name: '甲', layer: 1, lat: 25.0, lng: 121.5, setting: '戶外', visitors: 1, richness: 6 }),
    place({ id: 'B', name: '乙', layer: 1, lat: 25.0001, lng: 121.5001, setting: '戶外', visitors: 1, richness: 1 }),
    place({ id: 'C', name: '丙', layer: 1, lat: 25.0002, lng: 121.5002, setting: '戶外', visitors: 1, richness: 0 }),
  ];
  // 拉到最近（不合併），點乙，再縮小到會合併的級數
  const { els, rec } = await runPage(forecast, { attractions, mapConfig: { cap: 30, clusterPx: 40 }, zoom: 17.5 });
  assert.equal(rec.markers.length, 3);
  rec.markers.find((m) => m.opts.title.startsWith('乙')).handlers.click();
  rec.map.zoom = 8;
  rec.mapOn.moveend();
  const titles = rec.markers.map((m) => m.opts.title);
  assert.equal(rec.markers.length, 2, titles.join('、'));
  assert.ok(titles.some((t) => t.startsWith('乙')), '選到的乙單獨畫');
  const cluster = rec.markers.find((m) => /cluster/.test(m.opts.icon.html));
  assert.match(cluster.opts.icon.html, />2</);
  assert.match(els.info.textContent, /顯示 3 \/ 3 個景點/);
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
