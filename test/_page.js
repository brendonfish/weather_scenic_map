// 測試共用：在 node:vm 裡跑 index.html 最後那段程式，Leaflet 和 DOM 用假的。
// 假的 Leaflet 只有網頁真的用到的方法，名字打錯會直接丟錯，不會默默通過。
// 這支沒有測試，只給 publish.test.js 和 view.test.js 用。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 回傳 { els, rec }：els 是畫面上各個 id 的假元素，rec 記下畫了哪些標記、呼叫過哪些地圖動作
export async function runPage(data, { narrow = false } = {}) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const els = {};
  const el = () => ({
    textContent: '', innerHTML: '', checked: false, hidden: false, open: false, children: [], onclick: null, onchange: null,
    offsetHeight: 0, offsetWidth: 0, parentNode: { offsetHeight: 0, offsetWidth: 0 },
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); },
  });
  const rec = { markers: [], calls: [], popupHtml: null, mapOn: {} };
  const map = {
    on(ev, fn) { rec.mapOn[ev] = fn; return map; },
    closePopup() { rec.calls.push('closePopup'); },
    panInside() { rec.calls.push('panInside'); },
    fitBounds() { rec.calls.push('fitBounds'); },
    getZoom: () => 8,
  };
  const layer = { addTo: () => layer, clearLayers() { rec.markers = []; } };
  const L = {
    map: () => map,
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
    window: { FORECAST_DATA: data, matchMedia: () => ({ matches: narrow, addEventListener() {} }) },
    document: {
      getElementById: (id) => (els[id] ??= el()),
      createElement: () => el(),
      documentElement: { style: { setProperty() {} } },
    },
    L,
    fetch: async () => { throw new Error('不該用到 fetch'); },
    Date, Number, String,
  };
  for (const f of ['day-labels.js', 'spot-view.js']) vm.runInNewContext(fs.readFileSync(path.join(root, 'lib', f), 'utf8'), ctx);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  vm.runInNewContext(scripts[scripts.length - 1][1], ctx);
  await new Promise((r) => setTimeout(r, 0));
  return { els, rec };
}
