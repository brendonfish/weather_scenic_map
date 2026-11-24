// 把觀光署景點資料庫整理成地圖用的景點檔（data/attractions.json）：清理、分四層、分類。
// 只做計算，不連網路、不用 AI，全部是寫死的規則。下載在 scripts/fetch-attractions.js。
// 規則來源：卡片 https://trello.com/c/Y0UgCAWS ，代碼對照是觀光署《觀光資料標準 V2.1》附錄二。

import fs from 'node:fs';

// 比名字用：去掉空白和括號，「台」「臺」當同一個字
export function nameKey(s) {
  return String(s ?? '')
    .replace(/[\s　]/g, '')
    .replace(/[()（）［］[\]【】「」〔〕]/g, '')
    .replace(/台/g, '臺');
}

// 兩點的距離（公里）
export function distanceKm(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// 正式的 CSV 解析：雙引號裡可以有逗號、換行，兩個雙引號代表一個雙引號
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (s[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// 讀「歷年國內主要觀光遊憩據點遊客人數月別統計」，只拿 year 那一年。
// 縣市、景點名稱欄位有的寫成「屏東縣\nPingtung County」「臺北市立動物園\nTaipei Zoo」，都只取第一行。
export function readVisitors(text, year) {
  const [header, ...rows] = parseCsv(text);
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`人次統計 CSV 少了欄位：${name}`);
    return i;
  };
  const iYear = col('年別');
  const iName = col('細分');
  const iCounty = col('縣市');
  const iTotal = col('合計');
  return rows
    .filter((r) => String(r[iYear]).trim() === String(year))
    .map((r) => ({
      name: String(r[iName]).split(/\r?\n/)[0].trim(),
      county: String(r[iCounty]).split(/\r?\n/)[0].trim(),
      total: Number(r[iTotal]),
    }));
}

// 清理：ServiceStatus 不是 1（正常營運）的拿掉；同名而且 1 公里內的只留一筆（留 AttractionID 排前面的）
export function cleanAttractions(list) {
  const active = list.filter((a) => Number(a.ServiceStatus) === 1);
  const sorted = [...active].sort((a, b) => (a.AttractionID < b.AttractionID ? -1 : a.AttractionID > b.AttractionID ? 1 : 0));
  const byName = new Map();
  const kept = [];
  let removedDup = 0;
  for (const a of sorted) {
    const k = nameKey(a.AttractionName);
    const same = byName.get(k) ?? [];
    if (same.some((b) => distanceKm(a.PositionLat, a.PositionLon, b.PositionLat, b.PositionLon) <= 1)) {
      removedDup++;
      continue;
    }
    same.push(a);
    byName.set(k, same);
    kept.push(a);
  }
  return { kept, removedStatus: list.length - active.length, removedDup };
}

// 類型（照表格順序）。代碼 18 官方叫「國家自然公園類」，但裡面多半是舊版「其他」的殘留，所以歸「其他」。
// 代碼 8（國家風景區）是管轄範圍不是類型：只有 8 沒有別的代碼時才歸「其他」。
export const TYPES = [
  ['自然山林', [2, 7, 11, 16, 17]],
  ['水域溫泉', [24, 10]],
  ['古蹟文化', [1, 3, 21, 22]],
  ['宗教廟宇', [4]],
  ['室內場館', [5, 14, 25, 26, 27]],
  ['公園運動', [13, 15, 19]],
  ['農場樂園遊憩', [9, 12, 20]],
  ['商圈市集', [6]],
];
export const OTHER = '其他';

// 回傳類型陣列，第一個是主要類型。對不到任何一類（包含 8、18、23、254）就是「其他」。
export function typesOf(classes) {
  const codes = (classes ?? []).map(Number);
  const out = TYPES.filter(([, list]) => list.some((c) => codes.includes(c))).map(([name]) => name);
  return out.length ? out : [OTHER];
}

const OUTDOOR = [2, 7, 8, 11, 13, 15, 16, 17, 19, 24];
const INDOOR = [5, 14, 25, 26, 27];
export const FIT_SUNNY = '好天氣才去';
export const FIT_RAINY = '雨天備案';
export const FIT_ANY = '不分';

// 天氣適配：只有戶外代碼＝好天氣才去；只有室內代碼＝雨天備案；兩邊都有或都沒有＝不分
export function weatherFitOf(classes) {
  const codes = (classes ?? []).map(Number);
  const out = codes.some((c) => OUTDOOR.includes(c));
  const ind = codes.some((c) => INDOOR.includes(c));
  if (out && !ind) return FIT_SUNNY;
  if (ind && !out) return FIT_RAINY;
  return FIT_ANY;
}

// 第 1 層用 spots_2025_top10.csv 原本的「室內或戶外」：戶外（含戶外街區）＝好天氣才去、室內＝雨天備案、室內外都有＝不分
export function weatherFitOfSetting(setting) {
  if (setting === '室內') return FIT_RAINY;
  if (String(setting).includes('戶外') && !String(setting).includes('室內')) return FIT_SUNNY;
  return FIT_ANY;
}

const chars = (s) => [...String(s ?? '')];

// 資料豐富度 0–6 分，每項 1 分
export function richnessOf(a) {
  const codes = (a.AttractionClasses ?? []).map(Number);
  return [
    codes.some((c) => [7, 8, 16, 20].includes(c)),
    Boolean(String(a.WebsiteURL ?? '').trim()),
    (a.Images ?? []).length >= 3,
    chars(a.Description).length >= 280,
    Boolean(String(a.ServiceTimeInfo ?? '').trim()),
    a.AssetsClass !== null && a.AssetsClass !== undefined && a.AssetsClass !== '' && Number(a.AssetsClass) !== 0,
  ].filter(Boolean).length;
}

// 描述的前 60 個字，超過加「…」（直接截斷，不改寫）
export function excerptOf(desc) {
  const c = chars(desc);
  return c.length > 60 ? c.slice(0, 60).join('') + '…' : c.join('');
}

// 照片：Images 第一張的 URL 和 Name
function imageOf(a) {
  const img = (a.Images ?? [])[0];
  return img && img.URL ? { url: img.URL, name: img.Name ?? '' } : null;
}

// 讀 data/layer-config.json：{ layer3: { ratio, min, max } }
export function loadLayerConfig(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')).layer3;
  for (const k of ['ratio', 'min', 'max']) {
    if (!Number.isFinite(cfg?.[k])) throw new Error(`${file} 的 layer3.${k} 不是數字`);
  }
  return { ratio: cfg.ratio, min: cfg.min, max: cfg.max };
}

// 一個鄉鎮要取幾個進第 3 層：景點數 × 比例，無條件進位，再套最少、最多；景點數比最少還少就全取
export function layer3Quota(n, { ratio, min, max }) {
  if (n <= 0) return 0;
  return Math.min(n, Math.max(min, Math.min(max, Math.ceil(n * ratio))));
}

// 觀光署一筆景點 → 輸出的一筆
function fromAttraction(a, layer) {
  return {
    id: a.AttractionID,
    name: a.AttractionName,
    county: a.PostalAddress?.City ?? '',
    town: a.PostalAddress?.Town ?? '',
    lat: a.PositionLat,
    lng: a.PositionLon,
    layer,
    types: typesOf(a.AttractionClasses),
    weatherFit: weatherFitOf(a.AttractionClasses),
    richness: richnessOf(a),
    image: imageOf(a),
    excerpt: excerptOf(a.Description),
    website: String(a.WebsiteURL ?? '').trim(),
  };
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// 整理成四層。
//   attractions：觀光署 AttractionList.json 的 Attractions（還沒清理）
//   visitors：readVisitors 讀出的 2024 人次統計
//   top：spots_2025_top10.csv 的 190 個（readSpots 的欄位，加上 point＝座標取自哪個點）
//   config：layer3Quota 的設定
// 回傳 { list, stats, partial（第 2 層名字部分相同、待人工檢查）, unmatched（第 2 層對不上） }
export function buildAttractions({ attractions, visitors, top, config }) {
  const { kept, removedStatus, removedDup } = cleanAttractions(attractions);
  const used = new Set(); // 已經放進第 1、2 層的 AttractionID
  const list = [];

  // 第 1 層：沿用原本的座標、人次、室內戶外。資料庫裡同名（統計名稱或座標取自的點）而且 1 公里內的，
  // 取最近的那一筆補上照片、描述、分類，合併成一筆。找不到就沒有照片。
  let layer1Merged = 0;
  top.forEach((s, i) => {
    const keys = [nameKey(s.name), nameKey(s.point)].filter(Boolean);
    const match = kept
      .filter((a) => !used.has(a.AttractionID) && keys.includes(nameKey(a.AttractionName)))
      .map((a) => ({ a, d: distanceKm(s.lat, s.lng, a.PositionLat, a.PositionLon) }))
      .filter((o) => o.d <= 1)
      .sort((p, q) => p.d - q.d)[0]?.a;
    if (match) {
      used.add(match.AttractionID);
      layer1Merged++;
    }
    const base = match
      ? fromAttraction(match, 1)
      : { id: `Top190_${String(i + 1).padStart(3, '0')}`, types: [OTHER], richness: 0, image: null, excerpt: '', website: '' };
    list.push({
      ...base,
      name: s.name,
      county: s.county,
      town: s.town,
      lat: s.lat,
      lng: s.lng,
      layer: 1,
      weatherFit: weatherFitOfSetting(s.setting),
      visitors: s.visitors,
      setting: s.setting,
    });
  });

  // 第 2 層：2024 人次統計裡不在那 190 個的。人次統計沒有座標，用名字對到資料庫（同縣市）。
  // 名字完全一樣（比 nameKey）：自動對上。一邊包含另一邊、或同名但不同縣市：列出來給人檢查，這一版不放。
  const topNames = new Set(top.map((s) => nameKey(s.name)));
  const inLayer1 = new Set(used);
  const pool = kept.filter((a) => !used.has(a.AttractionID));
  // 停業、暫停的景點（清理時拿掉的），用來在「對不上」名單標原因
  const inactive = new Set(attractions.filter((a) => Number(a.ServiceStatus) !== 1).map((a) => nameKey(a.AttractionName) + '|' + nameKey(a.PostalAddress?.City)));
  let layer2InLayer1 = 0;
  const partial = [];
  const unmatched = [];
  let layer2Auto = 0;
  for (const v of visitors) {
    const k = nameKey(v.name);
    if (topNames.has(k)) continue;
    const county = nameKey(v.county);
    // 統計名稱對到的景點已經用「座標取自哪個點」併進第 1 層：不是對不上，跳過
    if (kept.some((a) => inLayer1.has(a.AttractionID) && nameKey(a.AttractionName) === k && nameKey(a.PostalAddress?.City) === county)) {
      layer2InLayer1++;
      continue;
    }
    const sameName = pool.filter((a) => nameKey(a.AttractionName) === k);
    const exact = sameName.find((a) => nameKey(a.PostalAddress?.City) === county);
    if (exact) {
      if (used.has(exact.AttractionID)) continue; // 統計裡兩個名稱對到同一個景點
      used.add(exact.AttractionID);
      list.push(fromAttraction(exact, 2));
      layer2Auto++;
      continue;
    }
    const near = pool
      .filter((a) => nameKey(a.PostalAddress?.City) === county)
      .filter((a) => {
        const m = nameKey(a.AttractionName);
        return m.length >= 2 && k.length >= 2 && (m.includes(k) || k.includes(m));
      })
      .sort((p, q) => Math.abs(nameKey(p.AttractionName).length - k.length) - Math.abs(nameKey(q.AttractionName).length - k.length))[0] ?? sameName[0];
    if (near) partial.push({ statName: v.name, county: v.county, name: near.AttractionName, id: near.AttractionID });
    else unmatched.push({ statName: v.name, county: v.county, reason: inactive.has(k + '|' + county) ? '觀光署資料標示停業或暫停' : '資料庫找不到' });
  }

  // 第 3、4 層：剩下的以「縣市＋鄉鎮」分組，每組取資料豐富度最高的幾個進第 3 層，其餘第 4 層。
  // 同分時描述長的優先，再同分用 AttractionID。
  const groups = new Map();
  for (const a of kept) {
    if (used.has(a.AttractionID)) continue;
    const g = nameKey(a.PostalAddress?.City) + '|' + nameKey(a.PostalAddress?.Town);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(a);
  }
  for (const g of groups.values()) {
    const ranked = g
      .map((a) => ({ a, r: richnessOf(a), len: chars(a.Description).length }))
      .sort((p, q) => q.r - p.r || q.len - p.len || (p.a.AttractionID < q.a.AttractionID ? -1 : 1));
    const n = layer3Quota(ranked.length, config);
    ranked.forEach(({ a }, i) => list.push(fromAttraction(a, i < n ? 3 : 4)));
  }

  // 輸出順序固定：層，再 AttractionID（第 1 層照原本 CSV 的順序）
  const ordered = [...list.filter((a) => a.layer === 1), ...list.filter((a) => a.layer !== 1).sort((a, b) => a.layer - b.layer || byId(a, b))];
  const count = (f) => ordered.filter(f).length;
  const stats = {
    downloaded: attractions.length,
    removedStatus,
    removedDup,
    cleaned: kept.length,
    layer1Merged,
    layer2Auto,
    layer2InLayer1,
    layer2Partial: partial.length,
    layer2Unmatched: unmatched.length,
    layers: Object.fromEntries([1, 2, 3, 4].map((l) => [l, count((a) => a.layer === l)])),
    types: Object.fromEntries([...TYPES.map(([n]) => n), OTHER].map((t) => [t, count((a) => a.types[0] === t)])),
    weatherFit: Object.fromEntries([FIT_SUNNY, FIT_RAINY, FIT_ANY].map((w) => [w, count((a) => a.weatherFit === w)])),
  };
  return { list: ordered, stats, partial, unmatched };
}
