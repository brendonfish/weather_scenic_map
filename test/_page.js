// 測試共用：在 node:vm 裡跑 index.html 最後那段程式，Leaflet 和 DOM 用假的。
// 假的 Leaflet 只有網頁真的用到的方法，名字打錯會直接丟錯，不會默默通過。
// 這支沒有測試，只給 publish.test.js 和 view.test.js 用。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 回傳 { els, rec }：els 是畫面上各個 id 的假元素，rec 記下畫了哪些標記、呼叫過哪些地圖動作
// drive：{ index, times } 假的車程檔（沒給就當作 drive/ 還沒產出）；storage：瀏覽器裡已經記住的東西
export const tick = () => new Promise((r) => setTimeout(r, 0));

// 舊的測試資料是「每個景點各帶一份預報」（data.spots[i].forecast）。網頁現在讀按鄉鎮存的預報＋景點檔，
// 這裡把舊格式換成新格式再餵給網頁。同一個鄉鎮給了不同的預報就丟錯，免得測試默默測錯東西。
function toTownFormat(data) {
  if (!data || !Array.isArray(data.spots)) return { forecast: data, attractions: [] };
  const towns = {};
  const norm = (s) => String(s ?? '').trim().replace(/台/g, '臺');
  for (const s of data.spots) {
    if (!s.forecast) continue;
    const k = norm(s.county) + '|' + norm(s.town);
    if (k in towns && JSON.stringify(towns[k]) !== JSON.stringify(s.forecast)) throw new Error(`測試資料裡 ${k} 有兩份不同的預報`);
    towns[k] = s.forecast;
  }
  const { spots, ...rest } = data;
  return { forecast: { ...rest, towns }, attractions: spots.map(({ forecast, ...a }) => ({ layer: 1, ...a })) };
}

// geo：假的 navigator.geolocation.getCurrentPosition（沒給就當瀏覽器不支援定位）
// zoom：假地圖的縮放級數；mapConfig：網頁的 MAP_CONFIG（沒給就不設上限、不合併，舊的測試照舊數得到每一個點）
// details：點開才載入的景點詳細資料（public/attraction-details.js）；preload 為 false 時等網頁自己載入
export async function runPage(input, { narrow = false, drive = null, storage = {}, geo = null, attractions: given, zoom = 8, mapConfig = { cap: Infinity, clusterPx: 0 }, details = {}, preload = true } = {}) {
  const converted = given ? { forecast: input, attractions: given } : toTownFormat(input);
  const data = converted.forecast;
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const els = {};
  const el = () => ({
    textContent: '', innerHTML: '', value: '', checked: false, hidden: false, disabled: false, open: false, children: [], onclick: null, onchange: null,
    offsetHeight: 0, offsetWidth: 0, parentNode: { offsetHeight: 0, offsetWidth: 0 },
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); },
    replaceChildren(...c) { this.children = c; },
  });
  const rec = { markers: [], calls: [], popupHtml: null, mapOn: {} };
  // 測試可以改 rec.map.zoom 再呼叫 rec.mapOn.moveend()，模擬使用者縮放地圖
  const map = {
    zoom,
    on(ev, fn) { rec.mapOn[ev] = fn; return map; },
    closePopup() { rec.calls.push('closePopup'); },
    panInside() { rec.calls.push('panInside'); },
    fitBounds(b) { rec.calls.push('fitBounds'); rec.lastFit = b; map.loaded = true; },
    setView(c, z) { rec.calls.push('setView'); map.zoom = z; map.loaded = true; },
    getZoom: () => map.zoom,
    getMaxZoom: () => 18,
    // 假地圖：整個台灣都在畫面裡；投影用簡單的等距，1 度 ≈ 256 × 2^zoom / 360 像素
    // 跟真的 Leaflet 一樣：還沒設定中心和縮放就問範圍會丟錯
    getBounds() { if (!map.loaded) throw new Error('Set map center and zoom first.'); return { contains: () => true }; },
    latLngToContainerPoint([lat, lng]) { const k = 256 * 2 ** map.zoom / 360; return { x: lng * k, y: -lat * k }; },
  };
  rec.map = map;
  const layer = { addTo: () => layer, clearLayers() { rec.markers = []; } };
  const L = {
    map: (id, opts) => { rec.mapOpts = opts; map.loaded = Boolean(opts && opts.center && opts.zoom !== undefined); return map; },
    control: { zoom: () => ({ addTo() {} }) },
    tileLayer: () => ({ addTo() {} }),
    layerGroup: () => layer,
    divIcon: (o) => o,
    marker(latlng, opts) {
      const m = { latlng, opts, handlers: {}, on(ev, fn) { m.handlers[ev] = fn; return m; }, addTo() { rec.markers.push(m); return m; } };
      return m;
    },
    popup() {
      const p = { setLatLng: () => p, setContent(h) { rec.popupHtml = h; return p; }, openOn() { rec.calls.push('openPopup'); return p; } };
      return p;
    },
  };
  const ctx = {
    window: {
      FORECAST_DATA: data, ATTRACTIONS_DATA: converted.attractions, MAP_CONFIG: mapConfig, ATTRACTION_DETAILS: preload ? details : undefined, matchMedia: () => ({ matches: narrow, addEventListener() {} }),
      DRIVE_INDEX: drive ? drive.index : undefined,
      localStorage: { getItem: (k) => storage[k] ?? null, setItem(k, v) { storage[k] = String(v); } },
      navigator: geo ? { geolocation: { getCurrentPosition: geo } } : {},
    },
    document: {
      getElementById: (id) => (els[id] ??= el()),
      createElement: () => el(),
      documentElement: { style: { setProperty() {} } },
      // 網頁用 <script> 載入一個縣市的車程檔：這裡直接把假資料放進 window，再通知載入完成
      head: { appendChild(s) {
        rec.scripts = [...(rec.scripts || []), s.src];
        if (s.src === 'public/attraction-details.js') {
          // details 給 'fail'：檔案載入失敗（onerror）；給 null：檔案載入了但沒有定義資料（例如內容壞掉）
          if (details === 'fail') { Promise.resolve().then(() => s.onerror()); return; }
          if (details) ctx.window.ATTRACTION_DETAILS = details;
          Promise.resolve().then(() => s.onload());
          return;
        }
        const county = drive.index.counties.find((c) => s.src === 'drive/' + c.file);
        if (drive.times[county.name]) (ctx.window.DRIVE_TIMES ??= {})[county.name] = drive.times[county.name];
        // 假資料裡沒有這個縣市的車程：當成檔案載入失敗
        Promise.resolve().then(() => (drive.times[county.name] ? s.onload() : s.onerror()));
      } },
    },
    L,
    fetch: async () => { throw new Error('不該用到 fetch'); },
    Date, Number, String,
  };
  for (const f of ['day-labels.js', 'spot-view.js', 'drive-time.js', 'spot-join.js', 'map-layers.js']) vm.runInNewContext(fs.readFileSync(path.join(root, 'lib', f), 'utf8'), ctx);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  vm.runInNewContext(scripts[scripts.length - 1][1], ctx);
  await tick();
  return { els, rec, storage };
}
