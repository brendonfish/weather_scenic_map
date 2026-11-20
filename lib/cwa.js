// 正式模式：檢查授權碼、抓氣象署 22 個縣市的鄉鎮預報。
// fetch 可以換成假的，測試不連網路。

import { checkResponse, COUNTY_DATASETS } from './forecast.js';

// 授權碼先去掉前後空白；中間有空白、換行或非英數符號就不用。
// 錯誤訊息一律不帶授權碼的任何內容（Node 的 header 錯誤會把整個值印出來）。
export function checkApiKey(raw) {
  const key = String(raw ?? '').trim();
  if (key === '') throw new Error('沒有設定環境變數 CWA_API_KEY。要用假資料請加 --fixture。');
  if (!/^[\x21-\x7E]+$/.test(key)) {
    throw new Error('授權碼格式不對：中間有空白、換行或其他不合法字元。請重新複製 CWA_API_KEY。');
  }
  return key;
}

export async function fetchCwa(apiKey, fetchImpl = fetch) {
  const responses = [];
  for (const [county, id] of Object.entries(COUNTY_DATASETS)) {
    const url = new URL(`https://opendata.cwa.gov.tw/api/v1/rest/datastore/${id}`);
    url.searchParams.set('format', 'JSON');
    url.searchParams.set('ElementName', '3小時降雨機率,體感溫度');
    // 授權碼放在 header，不放網址，避免出現在錯誤訊息裡
    const res = await fetchImpl(url, { headers: { Authorization: apiKey } });
    if (!res.ok) throw new Error(`${county}（${id}）抓取失敗：HTTP ${res.status}`);
    const body = await res.json();
    const problem = checkResponse(body);
    if (problem) throw new Error(`${county}（${id}）${problem}，沒有寫出 forecast.json`);
    responses.push(body);
  }
  return responses;
}
