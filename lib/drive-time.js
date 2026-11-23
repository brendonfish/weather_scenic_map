// 出發地和車程篩選：選單的文字、哪些景點在車程內、景點資訊裡那一行車程。
// 只算、只組字，不碰畫面。車程是事先算好的（drive/ 裡的檔案），這裡不連任何服務。
// 這是一般的 <script>（不是 module），直接雙擊打開 index.html 也能用；測試用 node:vm 載入。
(function (root) {
  // 車程上限的選項（分鐘）：每 30 分鐘一格，到 5 小時。再遠就選「不限」。
  const LIMITS = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300];

  // 30 → 「30 分鐘內」；90 → 「1.5 小時內」
  function limitText(limit) {
    return limit < 60 ? `${limit} 分鐘內` : `${limit / 60} 小時內`;
  }

  // 景點資訊裡的那一行。minutes 是 null 表示開車到不了（例如離島）。
  function durationText(town, minutes) {
    if (minutes === null || minutes === undefined) return `從${town}開車到不了`;
    if (minutes === 0) return `就在${town}附近`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const text = (h ? `${h} 小時` : '') + (h && m ? ' ' : '') + (m ? `${m} 分` : '');
    return `從${town}開車約 ${text}（不含塞車）`;
  }

  // index.spots 是景點的順序（「縣市|景點名稱」），row 是某個出發地照這個順序排的分鐘數。
  // 回傳查詢函式；景點不在車程檔裡回 undefined。「縣市|景點名稱」要跟 lib/drive-build.js 的 spotKey 一樣。
  function minutesBySpot(index, row) {
    const at = {};
    index.spots.forEach((key, i) => { at[key] = row[i]; });
    return (county, name) => at[`${String(county ?? '').trim().replace(/臺/g, '台')}|${name}`];
  }

  // limit 是分鐘，null 是不限。到不了的景點只有在有上限時才拿掉。
  // unreachable 只算真的開車到不了的（null）；車程檔裡沒有的景點（undefined，景點清單改了還沒重算）
  // 不知道要開多久，有上限時不顯示，但不算進「到不了」。
  function apply(spots, minutes, limit) {
    const out = { visible: [], unreachable: 0 };
    for (const s of spots) {
      const m = minutes(s.county, s.name);
      if (m === null) out.unreachable++;
      if (limit === null || (typeof m === 'number' && m <= limit)) out.visible.push(s);
    }
    return out;
  }

  // 開了車程篩選時面板上的摘要。summary 是 SpotView.summarize 算的（只算車程內的景點）。
  function summaryText(summary, limit) {
    const range = `車程 ${limitText(limit)}`;
    if (!summary.total) return `${range}沒有景點`;
    if (!summary.green) return `${range}的 ${summary.total} 個景點，降雨機率都超過 20%`;
    return `${summary.green} 個景點不太會下雨 · ${range}共 ${summary.total} 個`;
  }

  root.DriveTime = { LIMITS, limitText, durationText, minutesBySpot, apply, summaryText };
})(globalThis);
