// 旅遊天氣景點地圖：正式模式（抓氣象署）的防呆測試
// 跑法：在 travel-weather-map 資料夾裡跑 `node --test`
// 卡片：https://trello.com/c/Os0WWw2Q （AI 小工具板），2026-11-19 晚會留言的兩個修法：
//   1. 至少讀得到一筆降雨機率和時間才寫 forecast.json；讀不到就 exit 非 0，不蓋掉舊檔。
//   2. 授權碼先 trim()；中間有換行或不合法字元就報「授權碼格式不對」，不印授權碼的任何內容。
// 不連氣象署：fetch 一律換成假的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkResponse, taipeiDays, COUNTY_DATASETS } from '../lib/forecast.js';
import { checkApiKey, fetchCwa } from '../lib/cwa.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// 測試和子程序用同一個「現在」（假時鐘：台灣時間今天 08:00），跨過午夜、下午跑測試都不會對不上。
// build 只收還沒過的時段，假回傳只有今天 09–12 一段，所以「現在」要在 09:00 之前。
const NOW = Date.parse(`${taipeiDays()[0]}T08:00:00+08:00`);
// 用台灣時間的今天，正式模式才不會被「日期對不到」擋下
const D = taipeiDays(NOW)[0];
const t = (hh) => `${D}T${hh}:00:00+08:00`;

// 一份正常的氣象署格式回傳；variant 用來做出「欄位名稱跟預期不同」的版本
function cwaBody(variant = 'ok') {
  const valueKey = variant === 'valuekey' ? 'PoP3h' : 'ProbabilityOfPrecipitation';
  const atKey = variant === 'atkey' ? 'AT' : 'ApparentTemperature';
  const startKey = variant === 'timekey' ? 'startTime' : 'StartTime';
  const endKey = variant === 'timekey' ? 'endTime' : 'EndTime';
  const value = variant === 'dash' ? '-' : '30';
  return {
    success: 'true',
    records: {
      Locations: [
        {
          LocationsName: '臺北市',
          Location: [
            {
              LocationName: '信義區',
              WeatherElement: [
                {
                  ElementName: '3小時降雨機率',
                  Time: [
                    // 一段涵蓋整個 09:00–18:00：build 只收預報涵蓋到 18:00 的日子
                    { [startKey]: t('09'), [endKey]: t('18'), ElementValue: [{ [valueKey]: value }] },
                  ],
                },
                {
                  ElementName: '體感溫度',
                  Time: [{ DataTime: t('09'), ElementValue: [{ [atKey]: '18' }] }],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

const fakeFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });

// 22 個縣市各一個鄉鎮的回傳（每份格式跟 cwaBody 一樣）。
// 前 stale 個縣市的日期改成 2099-12-01，等於「這個縣市沒有今天到後天的資料」。
function allCountiesBody(variant = 'ok', stale = 0) {
  const base = cwaBody(variant);
  const loc = base.records.Locations[0].Location[0];
  base.records.Locations = Object.keys(COUNTY_DATASETS).map((county, i) => {
    let text = JSON.stringify(loc);
    if (i < stale) text = text.split(D).join('2099-12-01');
    return { LocationsName: county, Location: [JSON.parse(text)] };
  });
  return base;
}

// 跑 scripts/build-data.js 正式模式，fetch 換成假的（回傳 variant 那種格式）。
// 在暫存複本 dir 裡跑，不碰 repo 真的 public/；Date.now 固定成 now。
// 假 fetch 每被叫一次就在 stderr 印「[假fetch]」。
function runBuild(apiKey, variant, dir, { args = [], now = NOW, stale = 0 } = {}) {
  const mock =
    `const body = ${JSON.stringify(allCountiesBody(variant, stale))};` +
    `globalThis.fetch = async () => { process.stderr.write('[假fetch]\\n'); return { ok: true, status: 200, json: async () => body }; };` +
    `Date.now = () => ${now};`;
  return spawnSync(
    process.execPath,
    ['--import', 'data:text/javascript,' + encodeURIComponent(mock), path.join(dir, 'scripts', 'build-data.js'), ...args],
    { env: { ...process.env, CWA_API_KEY: apiKey }, encoding: 'utf8' },
  );
}

// 開一個暫存複本（lib、scripts、data），public/ 先放一份「舊檔」，確認失敗時沒有被蓋掉。
// 測試中途被中斷也只會留下暫存資料夾，不會動到 repo 的 public/。
function withOldOutput(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twm-test-'));
  try {
    for (const sub of ['lib', 'scripts', 'data']) fs.cpSync(path.join(root, sub), path.join(dir, sub), { recursive: true });
    const files = ['forecast.json', 'forecast.js'].map((f) => path.join(dir, 'public', f));
    fs.mkdirSync(path.join(dir, 'public'));
    files.forEach((f) => fs.writeFileSync(f, 'OLD'));
    fn(() => files.map((f) => (fs.statSync(f).isDirectory() ? 'DIR' : fs.readFileSync(f, 'utf8'))), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('W-15 降雨機率的值欄位或時間欄位改名、或值全是「-」時，checkResponse 當成失敗', () => {
  assert.equal(checkResponse(cwaBody('ok')), null);
  assert.match(checkResponse(cwaBody('valuekey')), /降雨機率/);
  assert.match(checkResponse(cwaBody('timekey')), /降雨機率/);
  assert.match(checkResponse(cwaBody('dash')), /降雨機率/);
});

test('W-16 fetchCwa：回傳讀不出降雨機率時丟錯，錯誤訊息不含授權碼', async () => {
  await assert.rejects(fetchCwa('FAKE-SECRET', fakeFetch(cwaBody('valuekey'))), (err) => {
    assert.match(err.message, /沒有寫出 forecast\.json/);
    assert.ok(!err.message.includes('FAKE-SECRET'));
    return true;
  });
  // 正常的回傳：22 個縣市都抓，回傳 22 份
  const calls = [];
  const ok = await fetchCwa('FAKE-SECRET', async (url, opts) => {
    calls.push({ url: String(url), auth: opts?.headers?.Authorization });
    return { ok: true, status: 200, json: async () => cwaBody('ok') };
  });
  assert.equal(ok.length, 22);
  assert.equal(calls.length, 22);
  assert.ok(calls.every((c) => c.auth === 'FAKE-SECRET' && !c.url.includes('FAKE-SECRET')));
});

test('W-17 build-data.js 正式模式讀不到降雨機率：exit 非 0，舊的 forecast.json 不被蓋掉', () => {
  for (const variant of ['valuekey', 'timekey', 'dash']) {
    withOldOutput((read, dir) => {
      const r = runBuild('FAKE-SECRET', variant, dir);
      assert.notEqual(r.status, 0, `${variant}：應該失敗，stdout=${r.stdout}`);
      assert.deepEqual(read(), ['OLD', 'OLD'], `${variant}：舊檔被蓋掉了`);
      assert.ok(!(r.stdout + r.stderr).includes('FAKE-SECRET'));
    });
  }
  // 對照組：正常格式會寫出新檔
  withOldOutput((read, dir) => {
    const r = runBuild('FAKE-SECRET', 'ok', dir);
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(read()[0], 'OLD');
  });
});

test('W-18 checkApiKey：前後空白去掉；中間有換行或不合法字元報「授權碼格式不對」，不印內容', () => {
  assert.equal(checkApiKey('  CWA-ABCD-1234 \n'), 'CWA-ABCD-1234');
  assert.equal(checkApiKey('CWA-ABCD-1234'), 'CWA-ABCD-1234');
  for (const bad of ['FAKE-SECRET\nAB', 'FAKE-SECRET\rAB', 'FAKE SECRET', 'FAKE-SECRET\tAB', 'FAKE-祕密']) {
    assert.throws(
      () => checkApiKey(bad),
      (err) => {
        assert.match(err.message, /授權碼格式不對/);
        assert.ok(!err.message.includes('FAKE'), `錯誤訊息印出了授權碼：${err.message}`);
        assert.ok(!err.message.includes('SECRET'));
        assert.ok(!err.message.includes('AB'));
        return true;
      },
    );
  }
  for (const empty of [undefined, '', '   ', '\n']) {
    assert.throws(() => checkApiKey(empty), /沒有設定環境變數 CWA_API_KEY/);
  }
});

test('W-19 build-data.js：授權碼中間有換行時 exit 非 0、報格式不對、終端機看不到授權碼、舊檔不被蓋掉', () => {
  withOldOutput((read, dir) => {
    const r = runBuild('FAKE-SECRET\nAB', 'ok', dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /授權碼格式不對/);
    assert.ok(!(r.stdout + r.stderr).includes('FAKE-SECRET'), r.stderr);
    assert.deepEqual(read(), ['OLD', 'OLD']);
  });
  // 前後有空白或換行（貼上時常見）照常跑
  withOldOutput((read, dir) => {
    const r = runBuild('  FAKE-SECRET\n', 'ok', dir);
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(read()[0], 'OLD');
  });
});

// 第一輪檢查找到的兩個問題（2026-11-20）
import { buildForecast, checkCountyCoverage } from '../lib/forecast.js';

test('W-20 回傳的日期全部對不到今天到後天（舊資料或電腦時鐘錯）：不寫檔、exit 非 0', () => {
  const stale = checkCountyCoverage([allCountiesBody('ok')], ['2099-12-02', '2099-12-03', '2099-12-04']);
  assert.equal(stale.missing.length, 22);
  assert.match(stale.error, /對不到/);
  const fresh = checkCountyCoverage([allCountiesBody('ok')], taipeiDays(NOW));
  assert.deepEqual(fresh, { missing: [], error: null });
  // 整支 build-data.js：假 fetch 回今天的資料，但電腦時間是 2099-12-01
  withOldOutput((read, dir) => {
    const r = runBuild('FAKE-SECRET', 'ok', dir, { now: Date.parse('2099-12-01T10:00:00+08:00') });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /對不到/);
    assert.deepEqual(read(), ['OLD', 'OLD']);
  });
});

test('W-21 降雨機率不在 0–100、體感溫度是 -99 這類缺值代碼：當成沒有資料（灰色、不標偏冷）', () => {
  const mk = (pop, at) => {
    const body = cwaBody('ok');
    const loc = body.records.Locations[0].Location[0];
    loc.WeatherElement[0].Time[0].ElementValue[0].ProbabilityOfPrecipitation = pop;
    loc.WeatherElement[1].Time[0].ElementValue[0].ApparentTemperature = at;
    const spot = { name: 'A', county: '臺北市', town: '信義區', lat: 25, lng: 121, visitors: 1, setting: '戶外' };
    return { body, day: buildForecast([spot], [body], [D], { source: 'test' }).spots[0].forecast[0] };
  };
  let { body, day } = mk('-99', '-99');
  assert.equal(day.maxPop, null);
  assert.equal(day.color, 'gray');
  assert.equal(day.minAT, null);
  assert.equal(day.cold, false);
  assert.match(checkResponse(body), /降雨機率/); // 沒有一筆讀得出合理的降雨機率
  ({ day } = mk('999', '18'));
  assert.equal(day.maxPop, null);
  ({ day } = mk('0', '-5'));
  assert.equal(day.maxPop, 0);
  assert.equal(day.minAT, -5);
  ({ day } = mk('100', '40'));
  assert.equal(day.maxPop, 100);
  assert.equal(day.minAT, 40);
});

// 第二輪檢查找到的問題（2026-11-20）
test('W-22 第二個輸出檔寫不進去時：exit 非 0，forecast.json 也不被蓋掉（兩個檔一起成功或一起不動）', () => {
  withOldOutput((read, dir) => {
    const js = path.join(dir, 'public', 'forecast.js');
    fs.rmSync(js);
    fs.mkdirSync(js); // 讓 forecast.js 寫不進去
    const r = runBuild('FAKE-SECRET', 'ok', dir);
    assert.notEqual(r.status, 0);
    assert.deepEqual(read(), ['OLD', 'DIR']);
    // 沒留下暫存檔。景點檔排在預報前面先換上去（新景點配舊預報只是少了顏色），所以會在
    // 景點檔 2026-11-28 拆成精簡檔和詳細資料（卡片 AULA6cHZ），所以多兩個
    assert.deepEqual(fs.readdirSync(path.join(dir, 'public')).sort(), ['attraction-details.js', 'attraction-details.json', 'attractions.js', 'attractions.json', 'forecast.js', 'forecast.json']);
  });
});

test('W-23 體感溫度的欄位改名、讀不到任何一筆：當成抓取失敗，不寫檔', () => {
  assert.match(checkResponse(cwaBody('atkey')), /體感溫度/);
  withOldOutput((read, dir) => {
    const r = runBuild('FAKE-SECRET', 'atkey', dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /體感溫度/);
    assert.deepEqual(read(), ['OLD', 'OLD']);
  });
});

test('W-24 09:00–18:00 有時段讀不到降雨機率：最高降雨機率留空（灰色），不只用讀得到的時段算', () => {
  const body = cwaBody('ok');
  const pop = body.records.Locations[0].Location[0].WeatherElement[0];
  pop.Time = [
    { StartTime: t('09'), EndTime: t('12'), ElementValue: [{ ProbabilityOfPrecipitation: '10' }] },
    { StartTime: t('12'), EndTime: t('15'), ElementValue: [{ ProbabilityOfPrecipitation: '-' }] },
    { StartTime: t('15'), EndTime: t('18'), ElementValue: [{ ProbabilityOfPrecipitation: '20' }] },
  ];
  const spot = { name: 'A', county: '臺北市', town: '信義區', lat: 25, lng: 121, visitors: 1, setting: '戶外' };
  const day = buildForecast([spot], [body], [D], { source: 'test' }).spots[0].forecast[0];
  assert.equal(day.maxPop, null);
  assert.equal(day.color, 'gray');
  assert.deepEqual(day.slots.map((x) => x.pop), [10, null, 20]); // 明細照樣給
});

test('W-25 不認得的參數（例如打錯成 --fixtures）：直接報錯，不抓氣象署、不寫檔', () => {
  withOldOutput((read, dir) => {
    const r = runBuild('FAKE-SECRET', 'ok', dir, { args: ['--fixtures'] });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /不認得的參數：--fixtures/);
    assert.ok(!r.stderr.includes('[假fetch]'), '不應該抓氣象署');
    assert.deepEqual(read(), ['OLD', 'OLD']);
  });
});

// 2026-11-20 早會 Ray 的決定：22 個縣市裡 12 個以上沒有今天到後天的資料就不寫檔；
// 11 個以下照常寫檔，終端機列出沒資料的縣市。
test('W-26 checkCountyCoverage：11 個縣市沒資料照常、12 個以上報錯，並列出是哪些縣市', () => {
  const days = taipeiDays(NOW);
  const counties = Object.keys(COUNTY_DATASETS);
  const r11 = checkCountyCoverage([allCountiesBody('ok', 11)], days);
  assert.equal(r11.error, null);
  assert.deepEqual(r11.missing, counties.slice(0, 11));
  const r12 = checkCountyCoverage([allCountiesBody('ok', 12)], days);
  assert.deepEqual(r12.missing, counties.slice(0, 12));
  assert.match(r12.error, /12 個縣市/);
  assert.match(r12.error, /沒有寫出 forecast\.json/);
  // 縣市整份沒抓到（回傳裡沒有這個縣市）也算沒資料；台／臺當成同一個字
  const body = allCountiesBody('ok');
  body.records.Locations = body.records.Locations.filter((g) => g.LocationsName !== '宜蘭縣');
  body.records.Locations.find((g) => g.LocationsName === '臺北市').LocationsName = '台北市';
  assert.deepEqual(checkCountyCoverage([body], days), { missing: ['宜蘭縣'], error: null });
});

test('W-27 build-data.js：11 個縣市沒資料照常寫檔並列出縣市；12 個沒資料 exit 非 0、舊檔不動', () => {
  const counties = Object.keys(COUNTY_DATASETS);
  withOldOutput((read, dir) => {
    const r = runBuild('FAKE-SECRET', 'ok', dir, { stale: 11 });
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(read()[0], 'OLD');
    const line = r.stdout.split('\n').find((l) => l.includes(`11 個縣市沒有 ${D} 的資料`));
    assert.ok(line, r.stdout);
    for (const c of counties.slice(0, 11)) assert.ok(line.includes(c), `沒列出 ${c}`);
    assert.ok(!line.includes(counties[11]), '有資料的縣市不該列出來');
  });
  withOldOutput((read, dir) => {
    const r = runBuild('FAKE-SECRET', 'ok', dir, { stale: 12 });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /12 個縣市/);
    assert.deepEqual(read(), ['OLD', 'OLD']);
  });
});
