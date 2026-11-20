# travel-weather-map

旅遊天氣景點地圖（MVP）：把全台熱門景點畫在台灣地圖上，用顏色標出「這個時段會不會下雨、冷不冷」，讓人一眼看出今天、明天去哪裡比較好。範圍看 Trello 卡（AI 小工具板，卡片連結寫在卡上）。共用規則看上一層的 `CLAUDE.md`。

## 三個指令

| 做什麼 | 指令 | 說明 |
| --- | --- | --- |
| 測試 | `node --test` | 只用 `data/` 和 `fixtures/` 裡的檔案，不連氣象署。要全過。 |
| 部署 | Ray 執行 `git push origin main`（工廠不 push） | push 之後 GitHub Pages 自動更新網頁；GitHub Actions 每天跑 3 次 build 自動更新預報。repo：`brendonfish/weather_scenic_map`，網址：https://brendonfish.github.io/weather_scenic_map/ |
| 驗證 | `node --test && node scripts/build-data.js --fixture && node -e "const d=require('./public/forecast.json');if(d.spots.length!==190)process.exit(1)"` | 測試全過；用假預報產出的資料剛好 190 個景點。部署後再打開公開網址的 `public/forecast.json`，確認有 190 個景點、`generatedAt` 在 12 小時內。 |

## 資料

- `data/spots_2025_top10.csv`：各縣市 2025 遊客人次前 10 名，共 190 個景點，有鄉鎮、經緯度、室內或戶外。產品 PM 整理，來源寫在檔案的欄位裡（觀光署統計資料庫、觀光署景點資料庫、維基百科、OpenStreetMap）。不要改這個檔，有錯在卡片留言。
- 天氣預報：氣象署開放資料「鄉鎮天氣預報－臺灣未來 3 天天氣預報」（逐 3 小時，有降雨機率、體感溫度）。用縣市＋鄉鎮對到景點。

## 這個工具的限制

- 純 JavaScript，不用需要編譯的框架。地圖用 Leaflet（CDN 載入）。測試用 node 內建的 test，不加 npm 套件。
- 氣象署授權碼只放在兩個地方：Ray 電腦的環境變數 CWA_API_KEY，以及 GitHub repo 的 Secret CWA_API_KEY。不寫進程式、不 commit、不放進網頁。網頁只讀 public/forecast.json，平常由 GitHub Actions 定時產出，Ray 也可以在本機手動跑。
- 開發和測試只用 `fixtures/` 的假預報，不打氣象署 API。
