// 把景點 CSV 和氣象署鄉鎮預報整理成網頁要用的資料。
// 只做計算，不連網路；抓資料在 lib/cwa.js。

import fs from 'node:fs';
import path from 'node:path';

// 氣象署「鄉鎮天氣預報－某縣市未來 3 天」的資料集代碼（逐 3 小時）。
// 來源：氣象署開放資料 API 文件 https://opendata.cwa.gov.tw/apidoc/v1
// F-D0047-089（臺灣未來 3 天）的 LocationName 只到縣市，對不到鄉鎮，所以改用各縣市的資料集。
export const COUNTY_DATASETS = {
  宜蘭縣: 'F-D0047-001',
  桃園市: 'F-D0047-005',
  新竹縣: 'F-D0047-009',
  苗栗縣: 'F-D0047-013',
  彰化縣: 'F-D0047-017',
  南投縣: 'F-D0047-021',
  雲林縣: 'F-D0047-025',
  嘉義縣: 'F-D0047-029',
  屏東縣: 'F-D0047-033',
  臺東縣: 'F-D0047-037',
  花蓮縣: 'F-D0047-041',
  澎湖縣: 'F-D0047-045',
  基隆市: 'F-D0047-049',
  新竹市: 'F-D0047-053',
  嘉義市: 'F-D0047-057',
  臺北市: 'F-D0047-061',
  高雄市: 'F-D0047-065',
  新北市: 'F-D0047-069',
  臺中市: 'F-D0047-073',
  臺南市: 'F-D0047-077',
  連江縣: 'F-D0047-081',
  金門縣: 'F-D0047-085',
};

const POP = '3小時降雨機率';
const AT = '體感溫度';
const WINDOW_START = '09:00';
const WINDOW_END = '18:00';
const COLD_AT = 12; // 體感溫度 12 度以下標「偏冷」

// 台／臺當成同一個字，前後空白去掉
export function normalizeName(s) {
  return String(s ?? '').trim().replace(/台/g, '臺');
}

const key = (county, town) => normalizeName(county) + '|' + normalizeName(town);

// 讀景點 CSV（檔案裡沒有引號和逗號跳脫，直接用逗號切）
export function readSpots(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
  const [header, ...lines] = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const cols = header.split(',');
  const col = (name) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`CSV 少了欄位：${name}`);
    return i;
  };
  const iName = col('景點（觀光署統計名稱）');
  const iCounty = col('縣市');
  const iTown = col('鄉鎮市區');
  const iLat = col('緯度');
  const iLng = col('經度');
  const iVisitors = col('2025 全年遊客人次');
  const iSetting = col('室內或戶外');
  return lines.map((line) => {
    const f = line.split(',');
    return {
      name: f[iName],
      county: f[iCounty],
      town: f[iTown],
      lat: Number(f[iLat]),
      lng: Number(f[iLng]),
      visitors: Number(f[iVisitors]),
      setting: f[iSetting],
    };
  });
}

// 讀 fixtures/ 裡每個縣市一份的假預報（格式跟氣象署回傳的一樣）
export function loadFixtureResponses(dir) {
  return Object.values(COUNTY_DATASETS).map((id) =>
    JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')),
  );
}

// 檢查氣象署回傳能不能用；不能用就回傳原因，能用回傳 null。
// 回傳成功卻沒有任何鄉鎮，通常是格式或查詢參數不對，要當成失敗，不要把好的資料蓋成全灰。
export function checkResponse(body) {
  if (String(body?.success) !== 'true') return '回傳 success 不是 true';
  const towns = (body?.records?.Locations ?? []).reduce((n, g) => n + (g.Location?.length ?? 0), 0);
  if (towns === 0) return '回傳裡沒有鄉鎮資料（格式可能跟預期不同）';
  // 每個鄉鎮都要有「3小時降雨機率」；因子沒有或改名，整份都不用
  for (const g of body.records.Locations) {
    for (const loc of g.Location ?? []) {
      if (!(loc.WeatherElement ?? []).some((el) => el.ElementName === POP)) {
        return `${loc.LocationName} 沒有「${POP}」這個天氣因子（格式可能跟預期不同）`;
      }
    }
  }
  // 至少要有一筆降雨機率讀得出數字、時間讀得出來；
  // 值或時間的欄位名稱改了，整份會變全灰，要當成失敗
  const readable = body.records.Locations.some((g) =>
    (g.Location ?? []).some((loc) =>
      (loc.WeatherElement ?? []).some(
        (el) =>
          el.ElementName === POP &&
          (el.Time ?? []).some(
            (tm) =>
              popNum(tm.ElementValue?.[0]?.ProbabilityOfPrecipitation) !== null &&
              Number.isFinite(Date.parse(tm.StartTime)) &&
              Number.isFinite(Date.parse(tm.EndTime)),
          ),
      ),
    ),
  );
  if (!readable) return `讀不到任何一筆${POP}的數字和時間（格式可能跟預期不同）`;
  // 體感溫度也一樣：欄位改名會讓「偏冷」全部消失，卻不會有任何提示
  const atReadable = body.records.Locations.some((g) =>
    (g.Location ?? []).some((loc) =>
      (loc.WeatherElement ?? []).some(
        (el) =>
          el.ElementName === AT &&
          (el.Time ?? []).some(
            (tm) =>
              atNum(tm.ElementValue?.[0]?.ApparentTemperature) !== null &&
              Number.isFinite(Date.parse(tm.DataTime)),
          ),
      ),
    ),
  );
  if (!atReadable) return `讀不到任何一筆${AT}的數字和時間（格式可能跟預期不同）`;
  return null;
}

// 把一個值轉成數字；「-」、空白、不是數字都當成沒有資料
function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// 降雨機率只收 0–100；體感溫度只收 -50 到 60 度（-99 這類缺值代碼當成沒有資料）
function popNum(v) {
  const n = num(v);
  return n !== null && n >= 0 && n <= 100 ? n : null;
}
function atNum(v) {
  const n = num(v);
  return n !== null && n >= -50 && n <= 60 ? n : null;
}

// 把氣象署回傳整理成 Map：「縣市|鄉鎮」→ { pop: [{start,end,value}], at: [{time,value}] }
export function indexForecast(responses) {
  const idx = new Map();
  for (const resp of responses) {
    for (const group of resp?.records?.Locations ?? []) {
      for (const loc of group.Location ?? []) {
        const entry = { pop: [], at: [] };
        for (const el of loc.WeatherElement ?? []) {
          if (el.ElementName === POP) {
            for (const tm of el.Time ?? []) {
              entry.pop.push({
                start: tm.StartTime,
                end: tm.EndTime,
                value: popNum(tm.ElementValue?.[0]?.ProbabilityOfPrecipitation),
              });
            }
          } else if (el.ElementName === AT) {
            for (const tm of el.Time ?? []) {
              entry.at.push({
                time: tm.DataTime,
                value: atNum(tm.ElementValue?.[0]?.ApparentTemperature),
              });
            }
          }
        }
        idx.set(key(group.LocationsName, loc.LocationName), entry);
      }
    }
  }
  return idx;
}

// 氣象署時間字串（例如 2026-11-19T09:00:00+08:00）→ 台灣時間的日期和「HH:MM」
function taipeiParts(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + 8 * 3600 * 1000);
  const date = d.toISOString().slice(0, 10);
  const hm = d.toISOString().slice(11, 16);
  return { date, hm, ms };
}

const windowMs = (date, hm) => Date.parse(`${date}T${hm}:00+08:00`);

// 算某一天 09:00–18:00：最高降雨機率、最低體感溫度、每 3 小時的明細
export function summarizeDay(entry, date) {
  const ws = windowMs(date, WINDOW_START);
  const we = windowMs(date, WINDOW_END);
  const slots = [];
  for (const p of entry.pop) {
    const s = taipeiParts(p.start);
    const e = taipeiParts(p.end);
    if (!s || !e) continue;
    // 時段跟 09:00–18:00 有重疊才算（06–09 和 18–21 不算）
    if (s.ms < we && e.ms > ws) {
      const temps = entry.at
        .map((a) => ({ ...a, ms: Date.parse(a.time) }))
        .filter((a) => a.ms >= s.ms && a.ms < e.ms && a.value !== null)
        .map((a) => a.value);
      slots.push({
        start: s.hm,
        end: e.hm,
        pop: p.value,
        at: temps.length ? Math.min(...temps) : null,
        ms: s.ms,
      });
    }
  }
  slots.sort((a, b) => a.ms - b.ms);
  // 有任何一段讀不到，最高值就不可信，整天留空（灰色）；明細照樣給
  const pops = slots.some((s) => s.pop === null) ? [] : slots.map((s) => s.pop);
  const ats = entry.at
    .map((a) => ({ ms: Date.parse(a.time), value: a.value }))
    // 跟降雨時段同一個規則：09:00 算、18:00 不算（18:00 屬於 18–21 那段）
    .filter((a) => a.ms >= ws && a.ms < we && a.value !== null)
    .map((a) => a.value);
  return {
    date,
    maxPop: pops.length ? Math.max(...pops) : null,
    minAT: ats.length ? Math.min(...ats) : null,
    slots: slots.map(({ ms, ...rest }) => rest),
  };
}

// 顏色：20% 以下綠、30–50% 黃、60% 以上紅、沒資料灰。
// 氣象署只給 10 的倍數；中間值的規則是未滿 30 綠、未滿 60 黃。
export function colorFor(pop) {
  if (pop === null || pop === undefined || !Number.isFinite(pop)) return 'gray';
  if (pop < 30) return 'green';
  if (pop < 60) return 'yellow';
  return 'red';
}

// 組出 public/forecast.json 的內容
export function buildForecast(spots, responses, days, { source, generatedAt } = {}) {
  const idx = indexForecast(responses);
  const unmatched = [];
  const out = spots.map((s) => {
    const entry = idx.get(key(s.county, s.town));
    if (!entry) unmatched.push({ name: s.name, county: s.county, town: s.town });
    return {
      ...s,
      forecast: entry
        ? days.map((d) => {
            const day = summarizeDay(entry, d);
            // 網頁直接用 color 和 cold，不自己再算一次
            return { ...day, color: colorFor(day.maxPop), cold: day.minAT !== null && day.minAT <= COLD_AT };
          })
        : null,
    };
  });
  return {
    generatedAt: generatedAt ?? new Date().toISOString(),
    source,
    days,
    spots: out,
    unmatched,
  };
}

// 整理完至少要有一個景點、某一天有降雨機率；全灰代表預報日期對不到（舊資料或電腦時鐘錯）。
// 有問題回傳原因，沒問題回傳 null。
export function checkForecastHasData(data) {
  const any = data.spots.some((s) => (s.forecast ?? []).some((d) => d.maxPop !== null));
  if (!any) return `預報的日期對不到 ${data.days.join('、')}，每個景點都沒有資料（可能是舊資料或電腦時鐘不對），沒有寫出 forecast.json`;
  return null;
}

// 台灣時間的今天、明天、後天（YYYY-MM-DD）
export function taipeiDays(fromMs = Date.now()) {
  return [0, 1, 2].map((i) =>
    new Date(fromMs + 8 * 3600 * 1000 + i * 86400 * 1000).toISOString().slice(0, 10),
  );
}
