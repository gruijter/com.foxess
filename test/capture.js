'use strict';

/*
Capture real API responses into test/captures/, so the suite stops guessing.

    node test/capture.js <api_key> [host]

    host defaults to www.foxesscloud.com; use portal.foxesscloud.us for a US account.

The API key is the same personal key the app pairs with (FoxCloud: User Profile -> API
Management), sent in the `token` header like lib/FoxEssClient.js does.

The files it writes have exactly the names test/fixtures.js looks for, so the whole suite switches
from doc-derived stubs to real data the moment they exist - no case needs changing.

Captures contain real serial numbers and plant names, which is why test/captures/ is gitignored.

Requests are spaced out deliberately. FoxESS throttles with errno 40400 and advertises no recovery
time, and a third-party HA integration reports a ceiling of 1440 calls/day per key, so a capture
run is not something to repeat in a loop.
*/

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CAPTURES = path.join(__dirname, 'captures');
const SPACING_MS = 1500;

const [, , token, hostArg] = process.argv;
const host = (hostArg && !hostArg.startsWith('--')) ? hostArg : 'www.foxesscloud.com';
const siteArgIndex = process.argv.indexOf('--site');
const siteArg = siteArgIndex !== -1 ? process.argv[siteArgIndex + 1] : undefined;

if (!token) {
  console.error('usage: node test/capture.js <api_key> [host] [--site name]');
  process.exit(1);
}

// Captures are stored one subfolder per site: test/captures/<site>/*.json. The site is taken from
// the plant name (fall back to stationID); pass --site to name it yourself.
const slug = (s) => String(s)
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
let OUT = CAPTURES; // narrowed to the site subfolder once the plant list is known

const sleep = (ms) => new Promise((r) => {
  setTimeout(r, ms);
});

const headersFor = (urlPath) => {
  const timestamp = Date.now().toString();
  const signature = crypto.createHash('md5')
    .update(`${urlPath}\r\n${token}\r\n${timestamp}`)
    .digest('hex');
  return {
    token,
    timestamp,
    signature,
    lang: 'en',
    'Content-Type': 'application/json',
  };
};

async function call(method, urlPath, { body, query } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const url = `https://${host}${urlPath}${qs}`;
  const res = await fetch(url, {
    method,
    headers: headersFor(urlPath),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({ _nonJsonStatus: res.status }));
  const errno = Number(json.errno ?? json.code);
  if (errno === 40400) throw new Error('rate limited (40400) - wait before trying again');
  return json;
}

const save = (name, data) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  const ok = Number(data.errno ?? data.code ?? 0) === 0;
  console.log(`  ${ok ? 'saved   ' : 'saved(!)'} ${name}.json${ok ? '' : `  -> errno ${data.errno ?? data.code}: ${data.msg || ''}`}`);
  return data;
};

(async () => {
  console.log(`Capturing from ${host}\n`);

  // Fetch the plant list first, name the site folder from it, then save everything under it.
  const plantListData = await call('POST', '/op/v0/plant/list', { body: { currentPage: 1, pageSize: 100 } });
  const firstPlantEntry = plantListData?.result?.data?.[0];
  const site = siteArg ? slug(siteArg) : (slug(firstPlantEntry?.name || firstPlantEntry?.stationID || 'site') || 'site');
  OUT = path.join(CAPTURES, site);
  console.log(`Writing to test/captures/${site}/\n`);
  const plantList = save('plantList', plantListData);
  await sleep(SPACING_MS);

  const plants = plantList?.result?.data || [];
  const firstPlant = plants[0]?.stationID;
  if (firstPlant) {
    save('plantDetail', await call('GET', '/op/v0/plant/detail', { query: { id: firstPlant } }));
    await sleep(SPACING_MS);
  } else {
    console.log('  skipped  plantDetail (no plants on this account)');
  }

  const deviceList = save('deviceList', await call('POST', '/op/v0/device/list', { body: { currentPage: 1, pageSize: 100 } }));
  await sleep(SPACING_MS);

  // v1 real/query with an explicit `sns` array, which is the call the app actually makes. The
  // deprecated v0 no-SN "all devices" call answers errno 0 with result:null on live accounts, so
  // the serials have to be passed. Take them from the device list just captured.
  const sns = (deviceList?.result?.data || [])
    .map((d) => d.deviceSN || d.sn || d.device_sn)
    .filter(Boolean);
  if (sns.length) {
    save('deviceDetail', await call('GET', '/op/v1/device/detail', { query: { sn: sns[0] } }));
    await sleep(SPACING_MS);
    save('deviceRealQuery', await call('POST', '/op/v1/device/real/query', { body: { sns } }));
    await sleep(SPACING_MS);
  } else {
    console.log('  skipped  deviceDetail + deviceRealQuery (no device serials on this account)');
  }

  const heatList = save('heatPumpList', await call('POST', '/op/v0/register/heat/list', { body: { currentPage: 1, pageSize: 100, sn: '' } }));
  const heatModule = (heatList?.result?.data || [])[0]?.moduleSN;
  if (heatModule) {
    await sleep(SPACING_MS);
    save('heatHeatingControls', await call('GET', '/op/v0/heat/heatingControls/get', { query: { moduleSn: heatModule } }));
    await sleep(SPACING_MS);
    save('heatDhwControls', await call('GET', '/op/v0/heat/dhwControls/get', { query: { moduleSn: heatModule } }));
  } else {
    console.log('  skipped  heat pump controls (none registered)');
  }

  console.log('\nDone. Run `node test/run.js` - the banner should now say it is using real captures.');
})().catch((err) => {
  console.error(`\nCapture failed: ${err.message}`);
  process.exit(1);
});
