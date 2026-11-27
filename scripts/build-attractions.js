// 讀 data/raw/ 的觀光署資料（先跑 scripts/fetch-attractions.js），產出：
//   data/attractions.json      地圖用的景點檔（要 commit）
//   data/layer2-matches.csv    第 2 層名字「部分相同」、要人工檢查的清單（要 commit）
// 規則在 lib/attractions.js，第 3 層的比例、最少、最多在 data/layer-config.json。
// 只在手動重做景點資料時跑，不在任何排程或 GitHub Actions 裡跑。
//
// 跑法：node scripts/build-attractions.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSpots } from '../lib/forecast.js';
import { parseCsv, readVisitors, buildAttractions, loadLayerConfig } from '../lib/attractions.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, 'data');
const VISITOR_YEAR = '2024';

// spots_2025_top10.csv 的「座標取自哪個點」：合併第 1 層時，也用這個名字去資料庫找同一個景點
function readPoints(csvPath) {
  const [header, ...rows] = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const i = header.indexOf('座標取自哪個點');
  if (i < 0) throw new Error('spots_2025_top10.csv 少了欄位：座標取自哪個點');
  return rows.map((r) => r[i]);
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function main() {
  const rawFile = path.join(data, 'raw', 'AttractionList.json');
  if (!fs.existsSync(rawFile)) throw new Error('找不到 data/raw/AttractionList.json，請先跑 node scripts/fetch-attractions.js');
  const attractions = JSON.parse(fs.readFileSync(rawFile, 'utf8').replace(/^﻿/, '')).Attractions;
  const visitors = readVisitors(fs.readFileSync(path.join(data, 'raw', 'visitors.csv'), 'utf8'), VISITOR_YEAR);
  const topCsv = path.join(data, 'spots_2025_top10.csv');
  const points = readPoints(topCsv);
  const top = readSpots(topCsv).map((s, i) => ({ ...s, point: points[i] }));
  const config = loadLayerConfig(path.join(data, 'layer-config.json'));

  const { list, stats, partial, unmatched } = buildAttractions({ attractions, visitors, top, config });

  fs.writeFileSync(path.join(data, 'attractions.json'), JSON.stringify(list) + '\n');
  const lines = ['統計名稱,縣市,對到的景點名稱,景點 ID', ...partial.map((p) => [p.statName, p.county, p.name, p.id].map(csvCell).join(','))];
  fs.writeFileSync(path.join(data, 'layer2-matches.csv'), '﻿' + lines.join('\n') + '\n');

  console.log(`下載 ${stats.downloaded} 筆；ServiceStatus 不是 1 拿掉 ${stats.removedStatus} 筆；同名 1 公里內重複拿掉 ${stats.removedDup} 筆；清理後 ${stats.cleaned} 筆`);
  console.log(`第 1 層：190 個裡 ${stats.layer1Merged} 個在資料庫找到同一個景點（補上照片、描述、分類），${top.length - stats.layer1Merged} 個找不到（沒有照片）`);
  console.log(`第 2 層（${VISITOR_YEAR} 人次統計 ${visitors.length} 個，不含已在第 1 層的）：已在第 1 層 ${stats.layer2InLayer1}、自動對上 ${stats.layer2Auto}、待檢查 ${stats.layer2Partial}（data/layer2-matches.csv）、對不上 ${stats.layer2Unmatched}`);
  console.log(`四層：${Object.entries(stats.layers).map(([l, n]) => `第 ${l} 層 ${n}`).join('、')}，共 ${list.length} 筆`);
  console.log(`主要類型：${Object.entries(stats.types).map(([t, n]) => `${t} ${n}`).join('、')}`);
  console.log(`天氣適配：${Object.entries(stats.weatherFit).map(([t, n]) => `${t} ${n}`).join('、')}`);
  if (unmatched.length) {
    console.log('第 2 層對不上的名單：');
    for (const u of unmatched) console.log(`  - ${u.county} ${u.statName}（${u.reason}）`);
  }
  console.log('寫到 data/attractions.json、data/layer2-matches.csv');
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
