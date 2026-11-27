// 網頁用：地圖上要畫哪些景點。依縮放選層、篩選、畫面上限、太近的合併成一個帶數字的點。
// 只算，不碰畫面。卡片：https://trello.com/c/AULA6cHZ
// 這是一般的 <script>（不是 module），直接雙擊打開 index.html 也能用；測試用 node:vm 載入。
(function (root) {
  // 設定值：網頁可以用 window.MAP_CONFIG 換掉其中幾個（測試用）。
  //   layerZooms：縮放到這幾級時，依序加上第 2、3、4 層。全台大約 7.5 級、一兩個縣市 9 級、鄉鎮 11 級。
  //   cap：同一個畫面最多幾個點（合併的點算一個）。
  //   clusterPx：兩個景點在畫面上距離小於這麼多像素，就合併成一個點。
  const DEFAULTS = { layerZooms: [9, 11, 13], cap: 30, clusterPx: 36 };

  // 類型和天氣適配：跟 lib/attractions.js 的 TYPES、FIT_* 一樣
  const TYPES = ['自然山林', '水域溫泉', '古蹟文化', '宗教廟宇', '室內場館', '公園運動', '農場樂園遊憩', '商圈市集', '其他'];
  const FITS = ['好天氣才去', '雨天備案', '不分'];
  const ICONS = { 自然山林: '⛰️', 水域溫泉: '♨️', 古蹟文化: '🏯', 宗教廟宇: '🛕', 室內場館: '🏛️', 公園運動: '🌳', 農場樂園遊憩: '🎡', 商圈市集: '🛍️', 其他: '📍' };
  // 「只看戶外」要藏的：第 1 層看原本的室內戶外欄位，其他層看主要類型
  const HIDE_SETTINGS = ['室內', '商圈、夜市、老街（戶外街區）'];
  const HIDE_TYPES = ['室內場館', '商圈市集'];

  const typesOf = (s) => (s.types && s.types.length ? s.types : ['其他']);
  const typeIcon = (t) => ICONS[t] || ICONS['其他'];

  // 這個縮放級數最多畫到第幾層；有打開篩選時放寬一級，不然篩完會太空
  function maxLayer(zoom, relaxed, cfg) {
    const zooms = (cfg && cfg.layerZooms) || DEFAULTS.layerZooms;
    let layer = 1;
    zooms.forEach((z, i) => { if (zoom >= z) layer = i + 2; });
    return Math.min(4, layer + (relaxed ? 1 : 0));
  }

  // 有沒有打開任何篩選（沒勾滿類型或天氣適配、只看好天氣、只看戶外）
  function filtersActive(f) {
    return f.types.length < TYPES.length || f.fits.length < FITS.length || Boolean(f.onlyGood) || Boolean(f.hideIndoor);
  }

  function isIndoorOrMarket(s) {
    return s.setting ? HIDE_SETTINGS.includes(s.setting) : HIDE_TYPES.includes(typesOf(s)[0]);
  }

  // 篩選。colorOf(spot, dayIndex) 回傳那天的顏色（green／yellow／red／gray）
  function applyFilters(spots, f, colorOf, dayIndex) {
    return spots.filter((s) => typesOf(s).some((t) => f.types.includes(t))
      && f.fits.includes(s.weatherFit || '不分')
      && (!f.onlyGood || colorOf(s, dayIndex) === 'green')
      && (!f.hideIndoor || !isIndoorOrMarket(s)));
  }

  // 排名：層小的優先，同層 richness 高的優先，再同分照原本的順序
  function rank(spots) {
    return spots
      .map((s, i) => ({ s, i }))
      .sort((p, q) => p.s.layer - q.s.layer || (q.s.richness || 0) - (p.s.richness || 0) || p.i - q.i)
      .map((o) => o.s);
  }

  // 決定畫哪些點。toPoint(spot) 回傳畫面座標 { x, y }。
  // 照排名一個一個放：離已經放的點太近，就併進那個點；點已經滿了，剩下的算 overflow（拉近才看得到）。
  // 回傳 { groups: [{ lead, members }], overflow }。lead 是代表那個點的景點（排名最前）。
  function place(spots, toPoint, cfg) {
    const cap = cfg && cfg.cap !== undefined ? cfg.cap : DEFAULTS.cap;
    const px = cfg && cfg.clusterPx !== undefined ? cfg.clusterPx : DEFAULTS.clusterPx;
    const groups = [];
    let overflow = 0;
    for (const s of rank(spots)) {
      const p = toPoint(s);
      const near = px > 0 ? groups.find((g) => Math.hypot(g.p.x - p.x, g.p.y - p.y) < px) : null;
      if (near) near.members.push(s);
      else if (groups.length < cap) groups.push({ lead: s, p, members: [s] });
      else overflow++;
    }
    return { groups: groups.map(({ lead, members }) => ({ lead, members })), overflow };
  }

  root.MapLayers = { DEFAULTS, TYPES, FITS, typeIcon, maxLayer, filtersActive, applyFilters, place };
})(globalThis);
