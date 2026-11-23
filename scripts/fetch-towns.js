// 一次性：從氣象署鄉鎮預報抓全台鄉鎮的名稱和座標，寫成 data/towns.csv。
// 這些座標是車程篩選的「出發地」。鄉鎮沒有改制就不用重跑。
//
//   CWA_API_KEY=授權碼 node scripts/fetch-towns.js
//
// 授權碼只從環境變數讀，不會寫進檔案或印出來。只留鄉鎮名稱和座標，不留預報。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkApiKey, fetchCwa } from '../lib/cwa.js';
import { townsFromResponses, townsCsv } from '../lib/drive-build.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  if (!String(process.env.CWA_API_KEY ?? '').trim()) throw new Error('沒有設定環境變數 CWA_API_KEY。請在指令前面加上 CWA_API_KEY=授權碼。');
  const responses = await fetchCwa(checkApiKey(process.env.CWA_API_KEY));
  const towns = townsFromResponses(responses);
  const out = path.join(root, 'data', 'towns.csv');
  fs.writeFileSync(out, townsCsv(towns));
  console.log(`鄉鎮：${towns.length} 個，寫到 data/towns.csv`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
