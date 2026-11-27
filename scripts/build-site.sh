#!/usr/bin/env bash
# GitHub Actions（.github/workflows/update-forecast.yml）跑這支，產出要放上 GitHub Pages 的網站：
#   1. 跑 build-data.js 抓氣象署預報（授權碼從環境變數 CWA_API_KEY 讀，這支不碰它）
#   2. build 成功才把網頁要用的檔案放進 _site/，workflow 再把 _site/ 部署到 Pages
# build 照防呆規則不寫檔時會 exit 非 0：這支跟著停下來、不產出 _site/，workflow 不部署，網站維持上一次的資料。
# 預報檔不 commit 進 repo。參數原樣傳給 build-data.js（本機試跑可以加 --fixture）。
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf _site
node scripts/build-data.js "$@"

mkdir -p _site/lib _site/public
cp index.html _site/
cp lib/day-labels.js lib/spot-view.js lib/drive-time.js lib/spot-join.js lib/map-layers.js _site/lib/
# 事先算好的車程（commit 在 repo 裡，這裡不重算）
cp -R drive _site/drive
cp public/forecast.json public/forecast.js public/attractions.json public/attractions.js public/attraction-details.json public/attraction-details.js _site/public/
echo "網站檔案放在 _site/"
