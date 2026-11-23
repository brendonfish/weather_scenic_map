// 事先算車程用的工具：鄉鎮座標清單、問 OSRM 的網址、把結果寫成網頁讀的檔案。
// 只給 scripts/fetch-towns.js 和 scripts/build-drive-times.js 用，網頁不載入這支。
// 網頁那一邊（選單文字、篩選）在 lib/drive-time.js。

import fs from 'node:fs';
import crypto from 'node:crypto';

// 選單裡縣市的順序：北到南，再東部、離島
const COUNTY_ORDER = [
  '基隆市', '台北市', '新北市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '台中市', '彰化縣', '南投縣', '雲林縣',
  '嘉義市', '嘉義縣', '台南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣',
];
const TOWNS_HEADER = '縣市,鄉鎮市區,緯度,經度';

// 景點清單和網頁都寫「台」，氣象署寫「臺」，這裡統一成「台」
const tai = (s) => String(s ?? '').trim().replace(/臺/g, '台');

// 車程檔用「縣市|景點名稱」認景點。要跟 lib/drive-time.js 的 minutesBySpot 一樣。
export const spotKey = (s) => `${tai(s.county)}|${s.name}`;

// 氣象署鄉鎮預報的回應 → [{ county, town, lat, lng }]。每個鄉鎮的座標是它預報的那個點。
export function townsFromResponses(responses) {
  const towns = [];
  for (const body of responses) {
    for (const group of body.records.Locations) {
      for (const loc of group.Location) {
        const lat = Number(loc.Latitude);
        const lng = Number(loc.Longitude);
        if (loc.Latitude == null || loc.Longitude == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
          throw new Error(`${tai(group.LocationsName)}${loc.LocationName} 沒有座標，沒有寫出 towns.csv`);
        }
        towns.push({ county: tai(group.LocationsName), town: String(loc.LocationName).trim(), lat, lng });
      }
    }
  }
  return towns;
}

export function townsCsv(towns) {
  return [TOWNS_HEADER, ...towns.map((t) => [t.county, t.town, t.lat, t.lng].join(','))].join('\n') + '\n';
}

export function readTowns(csvPath) {
  const [header, ...lines] = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (header !== TOWNS_HEADER) throw new Error(`towns.csv 的欄位不對，應該是：${TOWNS_HEADER}`);
  return lines.map((line) => {
    const [county, town, lat, lng] = line.split(',');
    return { county, town, lat: Number(lat), lng: Number(lng) };
  });
}

// 一個點最多離開車的路多遠（公尺）還算「開車到得了」。
// 不設上限的話，OSRM 會把小島上的點（綠島、蘭嶼）移到幾十公里外本島的路上，算出「綠島到台東 2 分鐘」。
// 目前鄉鎮最遠 785 公尺、景點最遠 961 公尺；超過的只有排雲山莊（要爬山）和基隆嶼（要搭船）。
export const MAX_SNAP_M = 2000;

// 問 OSRM：這個點離最近一條開車的路多遠
export function nearestUrl(base, p) {
  return `${base}/nearest/v1/driving/${p.lng},${p.lat}?number=1&exclude=ferry`;
}

export function onRoad(body) {
  return body.code === 'Ok' && body.waypoints[0].distance <= MAX_SNAP_M;
}

// 問 OSRM：一個出發點到所有景點要開多久。OSRM 的座標是「經度,緯度」。
// exclude=ferry：不算渡輪，開車到不了的（離島）會回 null。
// radiuses：每個點只能接到 MAX_SNAP_M 以內的路。附近沒有路的點不能放進來（OSRM 會整個回錯誤），先用 nearestUrl 濾掉。
export function tableUrl(base, from, spots) {
  const coords = [from, ...spots].map((p) => `${p.lng},${p.lat}`).join(';');
  const destinations = spots.map((_, i) => i + 1).join(';');
  const radiuses = [from, ...spots].map(() => MAX_SNAP_M).join(';');
  return `${base}/table/v1/driving/${coords}?sources=0&destinations=${destinations}&exclude=ferry&radiuses=${radiuses}`;
}

// minutes 只有「附近有路的景點」的結果；補回完整的一列，附近沒路的景點填 null（開車到不了）
export function expandRow(reachable, minutes) {
  let k = 0;
  return reachable.map((ok) => (ok ? minutes[k++] : null));
}

// OSRM 回的是秒，網頁用分鐘
export function minutesFromTable(body) {
  if (body.code !== 'Ok') throw new Error(`OSRM 回報 ${body.code}：${body.message ?? ''}`);
  return body.durations[0].map((sec) => (sec === null ? null : Math.round(sec / 60)));
}

// 景點和鄉鎮（名稱、順序、座標）的指紋。車程檔記下算的時候的指紋，
// 之後誰改了景點清單或 towns.csv 卻沒重算，測試（D-17）比對指紋就會擋下來。
export function inputsHash(towns, spots) {
  const text = JSON.stringify([towns.map((t) => [t.county, t.town, t.lat, t.lng]), spots.map((s) => [spotKey(s), s.lat, s.lng])]);
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

// matrix[i] 是 towns[i] 到每個景點的分鐘數（順序跟 spots 一樣）。
// 回傳 { 檔名: 內容 }：index.js 是選單和景點順序，cNN.js 是一個縣市所有鄉鎮的車程。
// 分成一個縣市一個檔，網頁選了出發地才載入那一個。用 <script> 載入，雙擊打開網頁也能用。
export function driveFiles(towns, spots, matrix) {
  const names = [...new Set(towns.map((t) => t.county))];
  const rank = (c) => (COUNTY_ORDER.includes(c) ? COUNTY_ORDER.indexOf(c) : COUNTY_ORDER.length);
  names.sort((a, b) => rank(a) - rank(b));
  const files = {};
  const counties = names.map((name, i) => {
    const file = `c${String(i).padStart(2, '0')}.js`;
    const times = {};
    towns.forEach((t, j) => { if (t.county === name) times[t.town] = matrix[j]; });
    files[file] = `(window.DRIVE_TIMES = window.DRIVE_TIMES || {})[${JSON.stringify(name)}] = ${JSON.stringify(times)};\n`;
    return { name, file, towns: Object.keys(times) };
  });
  files['index.js'] = '// 由 scripts/build-drive-times.js 產出，不要手改。車程是分鐘，不含塞車；null 是開車到不了。\n' +
    `window.DRIVE_INDEX = ${JSON.stringify({ inputs: inputsHash(towns, spots), spots: spots.map(spotKey), counties })};\n`;
  return files;
}
