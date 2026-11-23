// 網頁上的文字和統計：哪一區綠色最多、景點資訊的結論、日期寫法。
// 只算、只組字，不碰畫面。顏色（green／yellow／red／gray）是 build 算好的，這裡不重算。
// 這是一般的 <script>（不是 module），直接雙擊打開 index.html 也能用；測試用 node:vm 載入。
(function (root) {
  // 國發會的區域劃分。資料用「台」，「臺」也認得。
  const REGIONS = {
    北部: ['基隆市', '台北市', '新北市', '桃園市', '新竹市', '新竹縣', '宜蘭縣'],
    中部: ['苗栗縣', '台中市', '彰化縣', '南投縣', '雲林縣'],
    南部: ['嘉義市', '嘉義縣', '台南市', '高雄市', '屏東縣'],
    東部: ['花蓮縣', '台東縣'],
    離島: ['澎湖縣', '金門縣', '連江縣'],
  };
  const REGION_OF = {};
  for (const [region, counties] of Object.entries(REGIONS)) for (const c of counties) REGION_OF[c] = region;

  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  const VERDICTS = { green: '不太會下雨', yellow: '可能會下雨', red: '很可能下雨' };

  // 縣市 → 北部／中部／南部／東部／離島；不認得回 null
  function regionOf(county) {
    return REGION_OF[String(county ?? '').replace('臺', '台')] ?? null;
  }

  // 這個景點在第 dayIndex 天的顏色；對不到預報算灰色
  function colorOf(spot, dayIndex) {
    const day = spot.forecast ? spot.forecast[dayIndex] : null;
    return day ? day.color : 'gray';
  }

  // 算這一天綠色有幾個，並挑出綠色「比例」最高的那一區。
  // 看比例不看個數：東部只有 2 個縣，看個數永遠輸給北部。比例一樣就挑綠色個數多的。
  function summarize(spots, dayIndex) {
    const out = { green: 0, gray: 0, total: spots.length, bestRegion: null };
    const byRegion = {};
    for (const s of spots) {
      const color = colorOf(s, dayIndex);
      if (color === 'green') out.green++;
      if (color === 'gray') out.gray++;
      const region = regionOf(s.county);
      if (!region) continue;
      const r = (byRegion[region] ??= { green: 0, total: 0 });
      r.total++;
      if (color === 'green') r.green++;
    }
    let best = null;
    for (const [region, r] of Object.entries(byRegion)) {
      if (!r.green) continue;
      const ratio = r.green / r.total;
      if (!best || ratio > best.ratio || (ratio === best.ratio && r.green > best.green)) {
        best = { region, ratio, green: r.green };
      }
    }
    out.bestRegion = best ? best.region : null;
    return out;
  }

  // 面板上那一行摘要，例如「41 個景點不太會下雨 · 東部比例最高」
  function summaryText(summary) {
    if (!summary.total) return '沒有景點可以顯示';
    if (!summary.green) return '沒有景點的降雨機率在 20% 以下';
    const text = `${summary.green} 個景點不太會下雨`;
    return summary.bestRegion ? `${text} · ${summary.bestRegion}比例最高` : text;
  }

  // 景點資訊的第一行結論，例如「不太會下雨 · 最高 10%」
  function verdict(day) {
    if (!day) return '沒有天氣資料';
    const text = VERDICTS[day.color];
    if (!text || day.maxPop === null || day.maxPop === undefined) return '這天沒有完整的預報';
    return `${text} · 最高 ${day.maxPop}%`;
  }

  // 2026-11-20 → 「11/20（五）」；讀不出來就原樣還回去
  function dateText(date) {
    const ms = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(ms)) return String(date);
    const d = new Date(ms);
    return `${String(date).slice(5).replace('-', '/')}（${WEEKDAYS[d.getUTCDay()]}）`;
  }

  // Google 地圖的開車路線網址。目的地用景點座標；不帶出發地，Google 會用使用者現在的位置。
  // 只是一個連結，不用授權碼，網頁自己不連 Google。
  function routeUrl(spot) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${spot.lat},${spot.lng}`)}&travelmode=driving`;
  }

  root.SpotView = { regionOf, colorOf, summarize, summaryText, verdict, dateText, routeUrl };
})(globalThis);
