// 旅遊天氣景點地圖：排程自動更新預報＋放上公開網址
// 跑法：在 travel-weather-map 資料夾裡跑 `node --test`
// 卡片：https://trello.com/c/GCGv0CTy （AI 小工具板）
// 只用 fixtures 和暫存資料夾，不連氣象署、不連 GitHub。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const WORKFLOW = path.join(root, '.github', 'workflows', 'update-forecast.yml');

function loadDayLabels() {
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib', 'day-labels.js'), 'utf8'), ctx);
  return ctx.DayLabels;
}

// 在 node:vm 裡跑 index.html 最後那段程式（Leaflet 和 DOM 用假的），回傳畫面上 #info 的文字
async function renderInfo(data) {
  const els = {};
  const el = () => ({
    textContent: '', checked: false, children: [], onclick: null, onchange: null,
    classList: { add() {}, toggle() {} },
    appendChild(c) { this.children.push(c); },
  });
  const chain = () => ({ addTo() { return this; }, bindPopup() { return this; }, clearLayers() {}, setView() { return this; } });
  const ctx = {
    window: { FORECAST_DATA: data },
    document: { getElementById: (id) => (els[id] ??= el()), createElement: () => el() },
    L: { map: chain, tileLayer: chain, layerGroup: chain, marker: chain, divIcon: () => ({}) },
    fetch: async () => { throw new Error('不該用到 fetch'); },
    Date, Number, String,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib', 'day-labels.js'), 'utf8'), ctx);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  vm.runInNewContext(scripts[scripts.length - 1][1], ctx);
  await new Promise((r) => setTimeout(r, 0));
  return els.info.textContent;
}

test('P-1 DayLabels.updatedText：generatedAt 換成台北時間「預報更新於 MM/DD HH:MM」', () => {
  const D = loadDayLabels();
  assert.equal(D.updatedText('2026-11-20T21:31:00.000Z'), '預報更新於 11/21 05:31');
  assert.equal(D.updatedText('2026-11-21T03:30:59.000Z'), '預報更新於 11/21 11:30');
  // 跨年、個位數月日也補 0
  assert.equal(D.updatedText('2026-12-31T16:05:00.000Z'), '預報更新於 01/01 00:05');
  // 讀不出時間：不要顯示 NaN
  assert.equal(D.updatedText(undefined), '預報更新時間不明');
  assert.equal(D.updatedText('壞掉'), '預報更新時間不明');
});

test('P-2 網頁顯示「預報更新於 …」（用 forecast.json 的 generatedAt 換算台北時間）', async () => {
  const today = loadDayLabels().taipeiDate(Date.now());
  const info = await renderInfo({ source: 'cwa', days: [today], spots: [], generatedAt: '2026-11-20T21:31:00.000Z' });
  assert.match(info, /預報更新於 11\/21 05:31/);
  assert.doesNotMatch(info, /NaN|Invalid/);
});

test('P-3 網頁標示「天氣資料來源：交通部中央氣象署」，OpenStreetMap 標示保留', () => {
  const panel = html.match(/<div class="panel">([\s\S]*?)<\/div>\s*<script/)[1];
  assert.match(panel, /天氣資料來源：交通部中央氣象署/);
  assert.match(html, /&copy; OpenStreetMap contributors/);
});

// 在暫存複本（lib、scripts、data、fixtures、index.html）裡跑 scripts/build-site.sh，
// 網站輸出到 dir/_site，不碰 repo 真的 public/ 和 _site/
function withCopy(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twm-site-'));
  try {
    for (const sub of ['lib', 'scripts', 'data', 'fixtures']) fs.cpSync(path.join(root, sub), path.join(dir, sub), { recursive: true });
    for (const f of ['index.html', 'README.md']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function buildSite(dir, args, env = {}) {
  const e = { ...process.env, ...env };
  if (env.CWA_API_KEY === undefined) delete e.CWA_API_KEY;
  return spawnSync('bash', [path.join(dir, 'scripts', 'build-site.sh'), ...args], { cwd: dir, env: e, encoding: 'utf8' });
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listFiles(path.join(dir, d.name), base) : [path.relative(base, path.join(dir, d.name))]).sort();
}

test('P-4 build-site.sh 用 fixture 跑：_site 只放網頁要用的檔，預報 190 個景點', () => {
  withCopy((dir) => {
    const r = buildSite(dir, ['--fixture']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /景點：190 個/);
    const site = path.join(dir, '_site');
    assert.deepEqual(listFiles(site), ['index.html', 'lib/day-labels.js', 'public/forecast.js', 'public/forecast.json']);
    // index.html 用到的本機檔案（不是 CDN 的）在 _site 裡都找得到
    const page = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
    const local = [...page.matchAll(/(?:src="|fetch\(')([^"':]+?)["']/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(local)].sort(), ['lib/day-labels.js', 'public/forecast.js', 'public/forecast.json']);
    for (const f of local) assert.ok(fs.existsSync(path.join(site, f)), f);
    assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'public', 'forecast.json'), 'utf8')).spots.length, 190);
  });
});

test('P-5 build 不寫檔時：結束代碼不是 0，不產出 _site（workflow 不部署，網站維持上一次的資料）', () => {
  withCopy((dir) => {
    assert.equal(buildSite(dir, ['--fixture']).status, 0);
    const old = fs.readFileSync(path.join(dir, 'public', 'forecast.json'), 'utf8');
    // 參數打錯、沒有授權碼、授權碼格式不對：build 都照防呆規則不寫檔
    for (const [args, env] of [[['--fixtures'], {}], [[], {}], [[], { CWA_API_KEY: 'AB\nCD' }]]) {
      const r = buildSite(dir, args, env);
      assert.notEqual(r.status, 0, `${args} 應該失敗：${r.stdout}${r.stderr}`);
      assert.doesNotMatch(r.stdout + r.stderr, /AB\nCD/);
      assert.ok(!fs.existsSync(path.join(dir, '_site')), '失敗時不應該留下 _site');
      assert.equal(fs.readFileSync(path.join(dir, 'public', 'forecast.json'), 'utf8'), old);
    }
  });
});

test('P-6 workflow：每天台北 05:30、11:30、17:30 跑，可以手動觸發，授權碼只從 Secret 讀', () => {
  const y = fs.readFileSync(WORKFLOW, 'utf8');
  // GitHub 的 cron 是 UTC：台北 05:30 = 前一天 21:30 UTC
  const crons = [...y.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(crons, ['30 21 * * *', '30 3 * * *', '30 9 * * *']);
  assert.match(y, /^\s*workflow_dispatch:/m);
  assert.match(y, /CWA_API_KEY:\s*\$\{\{\s*secrets\.CWA_API_KEY\s*\}\}/);
  // push 程式碼到 main 也重新部署一次
  assert.match(y, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(y, /run:\s*bash scripts\/build-site\.sh\s*$/m);
  assert.doesNotMatch(y, /--fixture/);
  // 用 GitHub Pages 官方的部署方式，不 commit、不 push 預報檔
  assert.match(y, /pages:\s*write/);
  assert.match(y, /id-token:\s*write/);
  assert.match(y, /uses:\s*actions\/upload-pages-artifact@v3/);
  assert.match(y, /path:\s*_site/);
  assert.match(y, /uses:\s*actions\/deploy-pages@v4/);
  assert.doesNotMatch(y, /contents:\s*write|git push|git commit/);
  // 不可以把授權碼寫進檔案，也不可以印出來
  assert.doesNotMatch(y, /CWA-[0-9A-F]{8}/i);
  assert.doesNotMatch(y, /echo[^\n]*CWA_API_KEY/);
});
