// 網頁用：把景點檔（public/attractions.js）和按鄉鎮存的預報（public/forecast.js）接起來，
// 變成每個景點帶自己那個鄉鎮的預報（s.forecast），網頁其他地方照舊用。
// 這是一般的 <script>（不是 module），直接雙擊打開 index.html 也能用；測試用 node:vm 載入。
(function (root) {
  // 跟 lib/forecast.js 的 normalizeName 一樣：前後空白去掉，台寫成臺
  const norm = (s) => String(s == null ? '' : s).trim().replace(/台/g, '臺');
  const townKey = (county, town) => norm(county) + '|' + norm(town);

  // 回傳 forecast 的複本，多一個 spots：layer 不大於 maxLayer 的景點，各自帶 forecast（對不到鄉鎮是 null）
  function join(forecast, attractions, maxLayer) {
    const towns = (forecast && forecast.towns) || {};
    const spots = (attractions || [])
      .filter((a) => a.layer <= maxLayer)
      .map((a) => Object.assign({}, a, { forecast: towns[townKey(a.county, a.town)] || null }));
    return Object.assign({}, forecast, { spots });
  }

  root.SpotJoin = { townKey, join };
})(globalThis);
