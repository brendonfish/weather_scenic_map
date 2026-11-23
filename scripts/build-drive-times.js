// 事先算好「每個鄉鎮 → 每個景點」的開車時間，寫到 drive/（要 commit，網頁直接讀）。
// 景點清單或 data/towns.csv 變了才需要重跑。平常的每日排程不跑這支。
//
//   node scripts/build-drive-times.js            問本機的 OSRM（http://127.0.0.1:5000）
//   OSRM_URL=http://… node scripts/build-drive-times.js
//
// 要先在本機用 Docker 把 OSRM 跑起來，步驟寫在 CLAUDE.md。不連任何外部服務。
// 車程用 OSRM 內建的汽車速度（國道約 90、省道約 65、巷弄約 25 km/h），不算渡輪，不含塞車。
// 每個點只接到 2 公里內的路，小島不會被算成跟本島相連。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSpots } from '../lib/forecast.js';
import { readTowns, nearestUrl, onRoad, tableUrl, minutesFromTable, expandRow, driveFiles } from '../lib/drive-build.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.env.OSRM_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');

try {
  const spots = readSpots(path.join(root, 'data', 'spots_2025_top10.csv'));
  const towns = readTowns(path.join(root, 'data', 'towns.csv'));
  const get = async (url) => (await fetch(url)).json();
  // 附近沒有路的景點（要爬山或搭船才到得了）不問車程，直接算開車到不了
  const reachable = [];
  for (const s of spots) {
    reachable.push(onRoad(await get(nearestUrl(base, s))));
    if (!reachable.at(-1)) console.log(`注意：${s.county}${s.name} 附近沒有開車的路，算開車到不了`);
  }
  const drivable = spots.filter((_, i) => reachable[i]);
  const matrix = [];
  for (const town of towns) {
    if (!onRoad(await get(nearestUrl(base, town)))) throw new Error(`${town.county}${town.town} 的座標附近沒有開車的路，請檢查 data/towns.csv`);
    const row = expandRow(reachable, minutesFromTable(await get(tableUrl(base, town, drivable))));
    // 小島上的鄉鎮（例如蘭嶼、東引）本來就可能一個景點都到不了，印出來讓人核對
    if (row.every((m) => m === null)) console.log(`注意：${town.county}${town.town} 開車到不了任何景點`);
    matrix.push(row);
  }
  const dir = path.join(root, 'drive');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const files = driveFiles(towns, spots, matrix);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  console.log(`車程：${towns.length} 個鄉鎮 × ${spots.length} 個景點，寫到 drive/（${Object.keys(files).length} 個檔）`);
} catch (e) {
  console.error(e.cause?.code === 'ECONNREFUSED' ? `連不到 OSRM（${base}）。請先照 CLAUDE.md 把 OSRM 跑起來。` : e.message);
  process.exit(1);
}
