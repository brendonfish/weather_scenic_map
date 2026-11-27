#!/usr/bin/env bash
# weatherway.good-picks.com（AWS VM）的網站同步，VM 上裝在 /usr/local/bin/weatherway-sync，
# cron 每小時跑一次（deploy/vm/weatherway.cron）。
#   程式（index.html、lib/、drive/）從 GitHub repo main 拉；
#   預報（public/forecast.*）從 GitHub Pages 抓，那邊由 GitHub Actions 每天產出 3 次。
# 這台 VM 不放氣象署授權碼。景點檔第 1 層的數量跟 data/spots_2025_top10.csv 對不上、或預報不是按鄉鎮存的，就不換，網站維持上一次的資料。
# 約定：
#   - 放哪些檔要跟 scripts/build-site.sh 一樣（test/vm-deploy.test.js 會比對）。
#   - Pages 上的預報在 public/forecast.json、public/forecast.js，景點檔在 public/attractions.json、public/attractions.js（build-site.sh 放的位置）。
#   - 每個 .html、.js、.json 旁邊放一份先壓好的 .gz（Caddyfile 的 precompressed gzip 會直接送），
#     檔案時間沿用原檔：內容沒變時間就不變，瀏覽器才拿得到 304。VM 重新 clone 時時間會變，只是多下載一次。
#   - VM 要有 git、curl、python3；BASE、LIVE 的上一層要讓跑的人能寫；LIVE 第一次不能是實體資料夾。
# 環境變數可以換掉來源和目錄，只給測試用（cron 的 log 路徑寫死在 /opt/weatherway）。
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/brendonfish/weather_scenic_map.git}
PAGES=${PAGES:-https://brendonfish.github.io/weather_scenic_map}
BASE=${BASE:-/opt/weatherway}
LIVE=${LIVE:-/var/www/weatherway}   # Caddy 的網站根目錄，是一個指到 releases/ 某一版的連結
REPO=$BASE/repo

if [ -d "$REPO/.git" ]; then
  git -C "$REPO" fetch -q origin main
  git -C "$REPO" reset -q --hard origin/main
else
  git clone -q --depth 1 --branch main "$REPO_URL" "$REPO"
fi

mkdir -p "$BASE/releases"
NEW=$(mktemp -d "$BASE/releases/$(date -u +%Y%m%dT%H%M%S)-XXXX")
chmod 755 "$NEW"
mkdir -p "$NEW/lib" "$NEW/public"
# 保留檔案時間（cp -p、curl -R）：內容沒變的檔時間就不變，瀏覽器問「有沒有變」時 Caddy 才回 304
cp -p "$REPO/index.html" "$NEW/"
cp -p "$REPO/lib/day-labels.js" "$REPO/lib/spot-view.js" "$REPO/lib/drive-time.js" "$REPO/lib/spot-join.js" "$NEW/lib/"
cp -Rp "$REPO/drive" "$NEW/drive"
curl -fsSR --max-time 60 -o "$NEW/public/forecast.json" "$PAGES/public/forecast.json"
curl -fsSR --max-time 60 -o "$NEW/public/forecast.js" "$PAGES/public/forecast.js"
curl -fsSR --max-time 60 -o "$NEW/public/attractions.json" "$PAGES/public/attractions.json"
curl -fsSR --max-time 60 -o "$NEW/public/attractions.js" "$PAGES/public/attractions.js"

# 防呆：預報要是按鄉鎮存的（有 towns），景點檔第 1 層的數量要跟 repo 的景點清單一樣多，不然丟掉這一版
if ! python3 - "$NEW/public/forecast.json" "$NEW/public/attractions.json" "$REPO/data/spots_2025_top10.csv" <<'PY'
import csv, json, sys
towns = json.load(open(sys.argv[1], encoding="utf-8")).get("towns")
if not isinstance(towns, dict) or not towns:
    sys.exit("預報裡沒有按鄉鎮存的 towns，不換")
n = sum(1 for a in json.load(open(sys.argv[2], encoding="utf-8")) if a.get("layer") == 1)
want = sum(1 for _ in csv.DictReader(open(sys.argv[3], encoding="utf-8-sig")))
if n != want:
    sys.exit(f"景點檔第 1 層有 {n} 個景點，景點清單有 {want} 個，不換")
PY
then
  rm -rf "$NEW"
  exit 1
fi

# 先壓好 .gz，Caddy 直接送，不用每個請求重壓（省 CPU）。gzip 會沿用原檔的時間。
find "$NEW" -type f \( -name '*.html' -o -name '*.js' -o -name '*.json' \) -exec gzip -k -9 -n {} +

ln -sfn "$NEW" "$LIVE"
# 只留最近 5 版
ls -1d "$BASE"/releases/* | sort -r | tail -n +6 | xargs rm -rf
echo "$(date -u +%FT%TZ) 已更新到 $(basename "$NEW")"
