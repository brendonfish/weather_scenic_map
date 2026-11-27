# 天氣旅圖（旅遊天氣景點地圖，MVP）

把全台 190 個熱門景點畫在地圖上，顏色代表選定那天 09:00–18:00 會不會下雨：
20% 以下綠色、30–50% 黃色、60% 以上紅色、沒有資料是空心的灰框。藍色外框代表偏冷（體感 12°C 以下）。

## 怎麼跑

```bash
# 用假預報（不連網路）
node scripts/build-data.js --fixture

# 用氣象署真的預報（授權碼只放環境變數，不要寫進檔案）
CWA_API_KEY=你的授權碼 node scripts/build-data.js
```

跑完會產出 `public/forecast.json` 和 `public/forecast.js`，再用瀏覽器打開 `index.html`。

測試：`node --test`

## 公開網址和自動更新

- 網址：https://brendonfish.github.io/weather_scenic_map/ （repo：`brendonfish/weather_scenic_map`）
- 自動更新：`.github/workflows/update-forecast.yml` 每天台北時間 05:30、11:30、17:30 跑一次，push 到 `main` 時也會跑。
  它跑 `scripts/build-site.sh`：抓氣象署預報，成功才把網頁和預報放進 `_site/`，再部署到 GitHub Pages。
  預報檔**不會** commit 進 repo，所以本機跑 `build-data.js --fixture` 不會影響公開網站。
- build 照下面的防呆規則不寫檔時，workflow 會標成失敗（紅色叉叉），不部署，網站繼續顯示上一次的資料。
- 網頁的「圖例說明與設定」裡會顯示「預報更新於 MM/DD HH:MM」（台北時間），看得出資料多久沒更新。桌機預設打開，手機要點開。

### 設定授權碼（只要做一次）

1. 到 GitHub 的 repo 頁面 → Settings → Secrets and variables → Actions。
2. 按「New repository secret」，Name 填 `CWA_API_KEY`，Secret 貼氣象署的授權碼，按「Add secret」。
3. 授權碼只放在這裡和自己電腦的環境變數，不要寫進任何檔案。

### 打開 GitHub Pages（只要做一次）

Settings → Pages → Build and deployment：Source 選「**GitHub Actions**」（不是 Deploy from a branch）。

### 手動觸發

repo 頁面 → Actions → 左邊選「更新天氣預報」→ 右邊「Run workflow」→ 再按一次綠色的「Run workflow」。
跑完（build 和 deploy 兩個都是綠色勾勾），打開網址看「預報更新於」有沒有變成剛剛的時間。

### 自己的網域：weatherway.good-picks.com

同一個網站也放在 AWS 的 VM（3.90.174.187，Ubuntu，GoDaddy 的 DNS 指過去）。設定檔都在 `deploy/vm/`：

- `sync.sh`：VM 上裝成 `/usr/local/bin/weatherway-sync`。程式從 GitHub repo 的 main 拉，預報從上面的 GitHub Pages 抓，剛好 190 個景點才換上去。VM 不放授權碼。
- `weatherway.cron`：放到 `/etc/cron.d/weatherway`，每小時 10 分跑一次 `sync.sh`。push 之後最多 1 小時 VM 就會跟上。
- `Caddyfile`：放到 `/etc/caddy/Caddyfile`。Caddy 自己申請和續約 HTTPS 憑證。它直接送 `sync.sh` 先壓好的 `.gz`（不用每個請求重壓），並讓瀏覽器快取 5 分鐘，過了再問有沒有變（沒變只回 304）。

換一台新 VM 時先做一次（AWS 安全群組要開 80、443；DNS 先指好，Caddy 才拿得到憑證）：

```bash
ssh -i ~/Documents/Docs/AWS/aws_key-1.pem ubuntu@新的IP 'sudo apt-get update && sudo apt-get install -y caddy git curl python3 && sudo mkdir -p /opt/weatherway /var/www && sudo chown ubuntu:ubuntu /opt/weatherway /var/www'
```

（`/var/www/weatherway` 由 `sync.sh` 建成連結，不要先建成資料夾。）接著跑下面那段指令裝設定檔。

改了 `deploy/vm/` 的檔案，也要用這段複製到 VM 上（VM 不會自動更新這三個檔）：

```bash
K=~/Documents/Docs/AWS/aws_key-1.pem; H=ubuntu@3.90.174.187
scp -i $K deploy/vm/sync.sh deploy/vm/Caddyfile deploy/vm/weatherway.cron $H:/tmp/
ssh -i $K $H 'sudo install -m 755 /tmp/sync.sh /usr/local/bin/weatherway-sync && sudo install -m 644 /tmp/weatherway.cron /etc/cron.d/weatherway && sudo install -m 644 /tmp/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy && weatherway-sync'
```

### 本機試跑

`bash scripts/build-site.sh --fixture` 會用假預報產出 `_site/`（已經在 `.gitignore` 裡），可以用瀏覽器打開 `_site/index.html` 看。

## 出發地和車程

面板上可以選出發地（縣市、鄉鎮）和車程上限（30 分鐘一格，到 5 小時），地圖只留車程內的景點，景點資訊會多一行「從○○開車約 1 小時 20 分（不含塞車）」。

- 沒選出發地時，網頁跟原本一樣。選擇只記在自己的瀏覽器。
- 按「📍 用我的位置」：瀏覽器會問要不要給位置，給了就自動選離你最近的鄉鎮當出發地（車程從那個鄉鎮的代表點算）。座標只在你的瀏覽器裡用來找鄉鎮，不存也不傳出去。離台灣的鄉鎮超過 30 公里、不給權限或拿不到位置時，會說原因，請你手動選。
- 車程是事先用 OpenStreetMap 的路網算好的（國道、省道、市區道路速度不同），是不塞車時的估計。連假會比它久。
- 出發地用的是鄉鎮裡的一個代表點，不是你家。面積很大的山區鄉鎮會比較不準。
- 開車到不了的景點（從本島出發時是澎湖、金門、馬祖、小琉球）在開了車程上限後不顯示。
- 重算車程的步驟在 `CLAUDE.md`。

景點資訊最下面有「用 Google 地圖規劃路線」的按鈕，會在新分頁打開 Google 地圖的開車路線，目的地是這個景點的座標，出發地由 Google 用你現在的位置（跟上面選的出發地無關）。這只是一個連結，網頁自己不連 Google，也不需要授權碼。

## 會收哪幾天

- 從今天開始，只收 09:00–18:00 還有預報時段的日子，收滿 3 天。晚上跑（今天的時段都過了）就從明天開始。
- 白天跑：今天只算還沒開始的時段，例如 14:00 跑只算 15:00–18:00，景點資訊標「今天（剩下的時段）」。
- 氣象署預報涵蓋不到第 3 天的白天時，只收 2 天，終端機會說明。
- 網頁的「今天、明天、後天」用打開網頁時的台灣日期算。資料最後一天比今天還早，網頁會提示「這份預報已經過期」。

## 什麼時候不會寫檔（舊的檔案保留不動）

- 22 個縣市裡，**12 個以上**沒有這次選到的日子（今天起 09:00–18:00 還有預報時段的 3 天）的降雨機率（舊資料、電腦時鐘不對、抓不到）。
  11 個以下照常寫檔，終端機會列出沒資料的縣市，那些縣市的景點在地圖上是灰色。
- 任何一個縣市的回傳格式跟預期不同（讀不到降雨機率或體感溫度）、或抓取失敗。
  注意：只要一個縣市出事，22 個縣市這次都不更新。
- 授權碼中間有空白、換行或不合法的字（前後的空白會自動去掉）。
- 參數打錯（例如 `--fixtures`）。

## 其他防呆

- 降雨機率不在 0–100、體感溫度不在 -50～60 度（例如 -99），當作沒有資料。
- 09:00–18:00 只要有一段讀不到降雨機率，當天顯示灰色，明細照樣顯示。
- 某個景點當天的預報沒有涵蓋到 18:00（例如抓到一半氣象署剛好更新，這個縣市拿到只到中午的舊版），那天這個景點顯示灰色，景點資訊寫「預報只到 HH:MM」，也不標「偏冷」。其他景點照常顯示。
- 兩個輸出檔先寫成暫存檔再換上去。

## 已知問題（MVP 先不修）

1. 某一段 3 小時預報的「時間」讀不出來時，那一段會被直接丟掉，最高降雨機率用剩下的時段算，可能被低估（顏色偏綠）。
2. 最低體感溫度沒有比照降雨機率「有一筆讀不到就留空」。最冷的那一筆是「-」時，會用其他時段的溫度，可能少標「偏冷」。
3. `forecast.js` 已經換成新的、接著 `forecast.json` 換失敗時，兩個檔內容會不一致（程式會報錯結束）。只有兩個檔都在同一個資料夾、而且只有第二個換失敗才會發生。

## 還沒驗證

- 真的氣象署回傳格式、查詢參數、授權碼放在 HTTP header 能不能用：開發時只用假資料，要用授權碼實際跑一次確認。
