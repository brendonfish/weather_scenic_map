// 網頁「今天／明天／後天」標籤：用打開網頁時的台灣日期算，不固定把 days[0] 當今天。
// 這是一般的 <script>（不是 module），直接雙擊打開 index.html 也能用；測試用 node:vm 載入。
(function (root) {
  const DAY = 86400 * 1000;
  const NAMES = { '-1': '昨天', 0: '今天', 1: '明天', 2: '後天', 3: '大後天' };

  // 時間戳 → 台灣時間的日期（YYYY-MM-DD）
  function taipeiDate(ms) {
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }

  // date 比 today 晚幾天（兩個都是 YYYY-MM-DD）
  function diffDays(date, today) {
    return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / DAY);
  }

  // 「今天」「明天」…；差太多天就不加字，只顯示日期
  function dayName(date, today) {
    return NAMES[diffDays(date, today)] ?? '';
  }

  // 按鈕文字，例如「今天 11/21」
  function buttonText(date, today) {
    const md = date.slice(5).replace('-', '/');
    const name = dayName(date, today);
    return name ? `${name} ${md}` : md;
  }

  // 預設選「今天」那顆；資料裡沒有今天就選第一顆
  function defaultIndex(days, today) {
    const i = days.indexOf(today);
    return i >= 0 ? i : 0;
  }

  // 資料最後一天比今天還早：太舊，要提醒重跑 build
  function isStale(days, today) {
    return days.length === 0 || days[days.length - 1] < today;
  }

  // forecast.json 的 generatedAt → 「預報更新於 11/21 05:31」（台北時間）
  function updatedText(generatedAt) {
    const ms = Date.parse(generatedAt);
    if (Number.isNaN(ms)) return '預報更新時間不明';
    const t = new Date(ms + 8 * 3600 * 1000).toISOString();
    return `預報更新於 ${t.slice(5, 7)}/${t.slice(8, 10)} ${t.slice(11, 16)}`;
  }

  root.DayLabels = { taipeiDate, dayName, buttonText, defaultIndex, isStale, updatedText };
})(globalThis);
