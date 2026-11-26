// 旅遊天氣景點地圖：部署到自己的 VM（weatherway.good-picks.com）
// VM 每小時跑 deploy/vm/sync.sh：程式從 GitHub repo 拉、預報從 GitHub Pages 抓。
// 這裡用暫存資料夾假裝 repo 和 Pages（file:// 網址），不連 GitHub、不連氣象署。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYNC = path.join(root, 'deploy', 'vm', 'sync.sh');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (opts.check !== false) assert.equal(r.status, 0, `${cmd} ${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return r;
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listFiles(path.join(dir, d.name), base) : [path.relative(base, path.join(dir, d.name))]).sort();
}

// 準備：假 repo（目前的網頁程式 commit 進去）、假 Pages（build-site.sh --fixture 產出的 _site）
function withFakeWorld(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twm-vm-'));
  try {
    const repo = path.join(dir, 'repo');
    for (const sub of ['lib', 'scripts', 'data', 'fixtures', 'drive']) fs.cpSync(path.join(root, sub), path.join(repo, sub), { recursive: true });
    for (const f of ['index.html', 'README.md']) fs.copyFileSync(path.join(root, f), path.join(repo, f));
    const env = { ...process.env };
    delete env.CWA_API_KEY;
    run('bash', ['scripts/build-site.sh', '--fixture'], { cwd: repo, env });
    const pages = path.join(dir, 'pages');
    fs.renameSync(path.join(repo, '_site'), pages);
    run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    run('git', ['add', 'index.html', 'lib', 'drive', 'data'], { cwd: repo });
    run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x'], { cwd: repo });
    const vmEnv = {
      ...env,
      REPO_URL: 'file://' + repo,
      PAGES: 'file://' + pages,
      BASE: path.join(dir, 'vm'),
      LIVE: path.join(dir, 'vm', 'www'),
    };
    fn({ repo, pages, vmEnv, sync: () => run('bash', [SYNC], { env: vmEnv, check: false }) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('V-1 sync.sh：VM 上的網站檔案跟 GitHub Pages 上的一模一樣，另外每個檔都有先壓好的 .gz', () => {
  withFakeWorld(({ pages, vmEnv, sync }) => {
    const r = sync();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const pageFiles = listFiles(pages);
    assert.deepEqual(listFiles(vmEnv.LIVE), [...pageFiles, ...pageFiles.map((f) => f + '.gz')].sort());
    for (const f of pageFiles) {
      const want = fs.readFileSync(path.join(pages, f));
      assert.ok(fs.readFileSync(path.join(vmEnv.LIVE, f)).equals(want), f);
      assert.ok(zlib.gunzipSync(fs.readFileSync(path.join(vmEnv.LIVE, f + '.gz'))).equals(want), f + '.gz');
    }
    const mtimes = () => Object.fromEntries(listFiles(vmEnv.LIVE).map((f) => [f, fs.statSync(path.join(vmEnv.LIVE, f)).mtimeMs]));
    const first = mtimes();
    // 再跑一次也沒問題（每小時都會跑）；內容沒變的檔，時間也不變，瀏覽器問「有沒有變」才會拿到 304
    const r2 = sync();
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.deepEqual(mtimes(), first);
  });
});

test('V-2 Pages 上的預報不是 190 個景點：sync.sh 失敗，網站維持上一次的資料', () => {
  withFakeWorld(({ pages, vmEnv, sync }) => {
    assert.equal(sync().status, 0);
    const before = fs.realpathSync(vmEnv.LIVE);
    const f = path.join(pages, 'public', 'forecast.json');
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    d.spots = d.spots.slice(0, 10);
    fs.writeFileSync(f, JSON.stringify(d));
    const r = sync();
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.realpathSync(vmEnv.LIVE), before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(vmEnv.LIVE, 'public', 'forecast.json'), 'utf8')).spots.length, 190);
  });
});

test('V-4 景點數照 repo 的景點清單算，不寫死：清單少一筆、預報還是 190 個，就不換', () => {
  withFakeWorld(({ repo, vmEnv, sync }) => {
    assert.equal(sync().status, 0);
    const before = fs.realpathSync(vmEnv.LIVE);
    const csv = path.join(repo, 'data', 'spots_2025_top10.csv');
    fs.writeFileSync(csv, fs.readFileSync(csv, 'utf8').trimEnd().split('\n').slice(0, -1).join('\n') + '\n');
    run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'y'], { cwd: repo });
    const r = sync();
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /189/);
    assert.equal(fs.realpathSync(vmEnv.LIVE), before);
  });
});

test('V-3 VM 的設定：不碰授權碼；Caddy 和 cron 指到同一個網站目錄和同步腳本', () => {
  const sync = fs.readFileSync(SYNC, 'utf8');
  assert.doesNotMatch(sync, /CWA_API_KEY/);
  const caddy = fs.readFileSync(path.join(root, 'deploy', 'vm', 'Caddyfile'), 'utf8');
  assert.match(caddy, /^weatherway\.good-picks\.com \{/m);
  const live = sync.match(/^LIVE=\$\{LIVE:-([^}]+)\}/m)[1];
  assert.match(caddy, new RegExp(`root \\* ${live}$`, 'm'));
  const cron = fs.readFileSync(path.join(root, 'deploy', 'vm', 'weatherway.cron'), 'utf8');
  assert.match(cron, /^10 \* \* \* \* ubuntu \/usr\/local\/bin\/weatherway-sync /m);
});

test('V-5 Caddy：送先壓好的 .gz（不用每次重壓），所有檔案讓瀏覽器快取 5 分鐘', () => {
  const caddy = fs.readFileSync(path.join(root, 'deploy', 'vm', 'Caddyfile'), 'utf8');
  assert.match(caddy, /file_server \{\s*precompressed gzip\s*\}/);
  assert.match(caddy, /^\s*header Cache-Control "public, max-age=300"$/m);
});
