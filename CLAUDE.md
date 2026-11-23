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

## 車程篩選的資料

網頁可以選出發地（鄉鎮）和車程上限，只看車程內的景點。車程是事先算好放在 `drive/` 的，網頁執行時不連任何路線服務。

- `data/towns.csv`：全台鄉鎮的名稱和座標（氣象署鄉鎮預報的預報點），當作出發地。鄉鎮改制才需要重抓：`CWA_API_KEY=授權碼 node scripts/fetch-towns.js`。
- `drive/index.js`、`drive/cNN.js`：每個鄉鎮到 190 個景點的開車分鐘數，一個縣市一個檔。要 commit。不要手改。
- 景點清單或 `data/towns.csv` 變了才要重算。每日排程不重算。重算步驟（在本機，要有 Docker）：

  ```bash
  # 1. 下載台灣路網（約 330 MB），放進 Docker 的儲存空間 osrm-tw
  curl -L -o taiwan.osm.pbf https://download.geofabrik.de/asia/taiwan-latest.osm.pbf
  docker volume create osrm-tw
  docker create --name osrm-tmp -v osrm-tw:/data osrm/osrm-backend true
  docker cp taiwan.osm.pbf osrm-tmp:/data/taiwan.osm.pbf && docker rm osrm-tmp
  # 2. 用 OSRM 內建的汽車設定處理路網（幾分鐘）
  docker run --rm -v osrm-tw:/data osrm/osrm-backend osrm-extract -p /opt/car.lua /data/taiwan.osm.pbf
  docker run --rm -v osrm-tw:/data osrm/osrm-backend osrm-partition /data/taiwan.osrm
  docker run --rm -v osrm-tw:/data osrm/osrm-backend osrm-customize /data/taiwan.osrm
  # 3. 把 OSRM 跑起來，算車程，關掉
  docker run -d --rm --name osrm-tw -p 127.0.0.1:5000:5000 -v osrm-tw:/data osrm/osrm-backend osrm-routed --algorithm mld --max-table-size 1000 /data/taiwan.osrm
  node scripts/build-drive-times.js
  docker stop osrm-tw
  ```

- 車程的算法：OSRM 內建的汽車速度（國道約 90、快速道路約 85、省道約 65、巷弄約 25 km/h，有標速限的路段用速限的八成），不算渡輪，不含塞車。開車到不了的景點（離島）是 `null`。

## 這個工具的限制

- 純 JavaScript，不用需要編譯的框架。地圖用 Leaflet（CDN 載入）。測試用 node 內建的 test，不加 npm 套件。
- 氣象署授權碼只放在兩個地方：Ray 電腦的環境變數 CWA_API_KEY，以及 GitHub repo 的 Secret CWA_API_KEY。不寫進程式、不 commit、不放進網頁。網頁只讀 public/forecast.json，平常由 GitHub Actions 定時產出，Ray 也可以在本機手動跑。
- 開發和測試只用 `fixtures/` 的假預報，不打氣象署 API。
