#!/usr/bin/env bash
# weatherway.good-picks.com（AWS VM）的網站同步，VM 上裝在 /usr/local/bin/weatherway-sync，
# cron 每小時跑一次（deploy/vm/weatherway.cron）。
#   程式（index.html、lib/、drive/）從 GitHub repo main 拉；
#   預報（public/forecast.*）從 GitHub Pages 抓，那邊由 GitHub Actions 每天產出 3 次。
# 這台 VM 不放氣象署授權碼。預報的景點數跟 data/spots_2025_top10.csv 對不上就不換，網站維持上一次的資料。
# 約定：
#   - 放哪些檔要跟 scripts/build-site.sh 一樣（test/vm-deploy.test.js 會比對）。
#   - Pages 上的預報在 public/forecast.json、public/forecast.js（build-site.sh 放的位置）。
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
cp "$REPO/index.html" "$NEW/"
cp "$REPO/lib/day-labels.js" "$REPO/lib/spot-view.js" "$REPO/lib/drive-time.js" "$NEW/lib/"
cp -R "$REPO/drive" "$NEW/drive"
curl -fsS --max-time 60 -o "$NEW/public/forecast.json" "$PAGES/public/forecast.json"
curl -fsS --max-time 60 -o "$NEW/public/forecast.js" "$PAGES/public/forecast.js"

# 防呆：預報的景點數要跟 repo 的景點清單一樣多，不然丟掉這一版
if ! python3 - "$NEW/public/forecast.json" "$REPO/data/spots_2025_top10.csv" <<'PY'
import csv, json, sys
n = len(json.load(open(sys.argv[1], encoding="utf-8"))["spots"])
want = sum(1 for _ in csv.DictReader(open(sys.argv[2], encoding="utf-8-sig")))
if n != want:
    sys.exit(f"預報有 {n} 個景點，景點清單有 {want} 個，不換")
PY
then
  rm -rf "$NEW"
  exit 1
fi

ln -sfn "$NEW" "$LIVE"
# 只留最近 5 版
ls -1d "$BASE"/releases/* | sort -r | tail -n +6 | xargs rm -rf
echo "$(date -u +%FT%TZ) 已更新到 $(basename "$NEW")"
