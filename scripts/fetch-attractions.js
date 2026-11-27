// 下載觀光署的景點資料庫和遊客人次統計，存到 data/raw/（不 commit，已在 .gitignore）。
// 只在手動重做景點資料時跑，不在任何排程或 GitHub Actions 裡跑。步驟寫在 README「怎麼手動重跑景點資料」。
//
// 跑法：node scripts/fetch-attractions.js
// 解壓縮用系統的 unzip 指令（macOS、Linux 內建）。
// 兩份都是政府資料開放授權條款第 1 版，網頁要標示「交通部觀光署」。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = path.join(root, 'data', 'raw');

const SOURCES = [
  ['Attraction-json.zip', 'https://media.taiwan.net.tw/XMLReleaseAll_public/v2.0/Zh_tw/Attraction-json.zip'],
  ['visitors.csv', 'https://media.taiwan.net.tw/od/01_PRD/' + encodeURIComponent('歷年國內主要觀光遊憩據點遊客人數月別統計') + '.csv'],
];

async function download(name, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name} 下載失敗：HTTP ${res.status}（${url}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(rawDir, name), buf);
  console.log(`${name}：${(buf.length / 1024 / 1024).toFixed(1)} MB`);
}

async function main() {
  fs.mkdirSync(rawDir, { recursive: true });
  for (const [name, url] of SOURCES) await download(name, url);
  const r = spawnSync('unzip', ['-o', '-q', 'Attraction-json.zip', 'AttractionList.json'], { cwd: rawDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`解壓縮失敗：${r.stderr || r.error?.message}`);
  console.log('已解開 data/raw/AttractionList.json。下一步：node scripts/build-attractions.js');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
