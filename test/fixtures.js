'use strict';

/*
Fixture layer for the offline suite.

Two sources, one shape:

  - `test/captures/*.json`, written by `node test/capture.js <token>` against a real account.
  - otherwise, stubs built from the FoxESS OpenAPI document's documented response schemas
    (https://www.foxesscloud.com/public/i18n/en/OpenApiDocument.html).

Cases derive their expectations from the fixture rather than hard-coding numbers, so they run
against either. No network, no credentials.
*/

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const CAPTURE_DIR = path.join(__dirname, 'captures');
const APP = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Doc-derived stubs
// ---------------------------------------------------------------------------

/*
Field names and nesting come from the OpenAPI document:
  plant/list        -> result.data[]  { stationID, name, ianaTimezone }
  device/list       -> result.data[]  { deviceSN, moduleSN, stationID, stationName, status,
                                        hasPV, hasBattery, deviceType, productType }
  device/real/query -> result[]       { deviceSN, datas[] { variable, unit, name, value, time } }
  plant/detail      -> result         { stationName, ..., capacity, modules[], batteries[] }
  heat/register/list-> result.data[]  { heatSN, moduleSN, registerStatus, runningStatus,
                                        masterVersion, deviceType }  (the doc's path
                                        register/heat/list is 404 live)
  module/list       -> result.data[]  { moduleSN, stationID, status, signal, ... }

Not from the doc: an OEM-rebadged inverter has the vendor's model in deviceType ("VSN THREE 8KW")
and the FoxESS series in productType ("H3 Smart"); each real/query device object has its own
`time` as "%Y-%m-%d %H:%M:%S %Z%z". Serial numbers are invented.
*/

const PLANT_A = '52ed930c-0000-4000-8000-00000000000a';
const PLANT_B = '52ed930c-0000-4000-8000-00000000000b';
const SN_A1 = 'TESTSN0000000A1';
const SN_A2 = 'TESTSN0000000A2';
const SN_B1 = 'TESTSN0000000B1';

const CAPTURE_TIME = '2026-09-16 10:00:00 CEST+0200';

const datas = (pairs) => Object.entries(pairs).map(([variable, value]) => ({
  variable, value, unit: '', name: variable, time: CAPTURE_TIME,
}));

const docStubs = {
  plantList: {
    errno: 0,
    result: {
      currentPage: 1,
      pageSize: 100,
      total: 2,
      data: [
        { stationID: PLANT_A, name: 'Test Plant A', ianaTimezone: 'Europe/Amsterdam' },
        { stationID: PLANT_B, name: 'Test Plant B', ianaTimezone: 'Europe/Amsterdam' },
      ],
    },
  },

  // account-wide, as documented: exercises the stationID filter
  deviceList: {
    errno: 0,
    result: {
      currentPage: 1,
      pageSize: 100,
      total: 3,
      data: [
        {
          deviceSN: SN_A1, moduleSN: 'MOD-A1', stationID: PLANT_A, stationName: 'Test Plant A', status: 1, hasPV: true, hasBattery: true, deviceType: 'VSN THREE 8KW', productType: 'H3 Smart',
        },
        {
          deviceSN: SN_A2, moduleSN: 'MOD-A2', stationID: PLANT_A, stationName: 'Test Plant A', status: 1, hasPV: true, hasBattery: false, deviceType: 'H3', productType: 'H3 Smart',
        },
        {
          deviceSN: SN_B1, moduleSN: 'MOD-B1', stationID: PLANT_B, stationName: 'Test Plant B', status: 1, hasPV: true, hasBattery: false, deviceType: 'H1', productType: 'H1 Smart',
        },
      ],
    },
  },

  deviceRealQuery: {
    errno: 0,
    result: [
      {
        deviceSN: SN_A1,
        time: CAPTURE_TIME,
        datas: datas({
          pvPower: 3.0,
          PVEnergyTotal: 1000,
          todayYield: 5,
          invTemperation: 41.5,
          batChargePower: 1.2,
          batDischargePower: 0,
          SoC: 88,
          batTemperature: 24.5,
          chargeEnergyToTal: 300,
          dischargeEnergyToTal: 250,
          gridConsumptionPower: 0.4,
          feedinPower: 1.1,
          gridConsumption: 700,
          feedin: 900,
          RFreq: 50.01,
          RVolt: 231.2,
          SVolt: 230.4,
          TVolt: 229.9,
        }),
      },
      {
        deviceSN: SN_A2,
        time: CAPTURE_TIME,
        datas: datas({ pvPower: 1.5, PVEnergyTotal: 500, todayYield: 2.5 }),
      },
      {
        deviceSN: SN_B1,
        time: CAPTURE_TIME,
        datas: datas({ pvPower: 9.9, PVEnergyTotal: 42, todayYield: 9 }),
      },
    ],
  },

  plantDetail: {
    errno: 0,
    result: {
      stationName: 'Test Plant A',
      country: 'Netherlands',
      city: 'Amsterdam',
      address: 'Teststraat 1',
      createDate: '1700000000000',
      postcode: '1000AA',
      capacity: 8,
      timezone: 'Europe/Amsterdam',
      user: { name: 'test', email: 'test@example.invalid', phone: '' },
      installer: { name: 'test', email: 'test@example.invalid', phone: '' },
      modules: [{ moduleSN: 'MOD-A1', deviceSN: SN_A1 }, { moduleSN: 'MOD-A2', deviceSN: SN_A2 }],
      batteries: [],
    },
  },

  // shape as observed live; two batterySNs = two battery modules
  deviceDetail: {
    errno: 0,
    result: {
      deviceSN: SN_A1,
      moduleSN: 'MOD-A1',
      stationName: 'Test Plant A',
      stationID: PLANT_A,
      deviceType: 'H3-G2',
      productType: 'H3-G2',
      hasPV: true,
      hasBattery: true,
      capacity: 10,
      batteryDesignCapacity: 23.04,
      masterVersion: '1.49',
      slaveVersion: '1.00',
      managerVersion: '1.31',
      function: { scheduler: true },
      status: 1,
      batteryList: [
        {
          batterySN: 'TESTBAT0000001', model: 'EP12', type: 'bcu', version: '1.013',
        },
        {
          batterySN: 'TESTBAT0000001', model: 'EP12', type: 'bmu', version: '1.13', capacity: 11520,
        },
        {
          batterySN: 'TESTBAT0000002', model: 'EP12', type: 'bmu', version: '1.13', capacity: 11520,
        },
      ],
    },
  },

  heatPumpList: {
    errno: 0,
    result: {
      currentPage: 1,
      pageSize: 100,
      total: 1,
      data: [{
        heatSN: 'HEATSN00000001', moduleSN: 'HEATMOD0000001', registerStatus: 'approved', runningStatus: 1, masterVersion: '1.0.0', deviceType: 'Heat Pump',
      }],
    },
  },

  moduleList: {
    errno: 0,
    result: {
      currentPage: 1,
      pageSize: 100,
      total: 1,
      data: [{
        moduleSN: 'HEATMOD0000001', stationID: PLANT_A, status: 1, signal: 100, webVersion: '--', softVersion: '2.11',
      }],
    },
  },

  heatHeatingControls: {
    errno: 0,
    result: {
      workMode: 2, // 1 cooling, 2 heating, 3 auto, 4 off
      zone1Daily: { timerEnable: false, timers: [] },
      dhwDaily: { timerEnable: false, timers: [] },
    },
  },

  heatDhwControls: {
    errno: 0,
    result: {
      enable: true,
      dhwTemp: 52.5,
      timer: { timerEnable: false, timers: [] },
      auxiliaryHeaterSettings: { electricHeatingControl: false, hotWaterElectricHeatingEnable: false },
    },
  },

  // two variables without a `value` key: must stay empty, not become 0
  deviceRealQueryPartial: {
    errno: 0,
    result: [{
      deviceSN: SN_A1,
      time: CAPTURE_TIME,
      datas: [
        {
          variable: 'pvPower', value: 3.0, unit: 'kW', name: 'pvPower', time: CAPTURE_TIME,
        },
        {
          variable: 'batChargePower', unit: 'kW', name: 'batChargePower', time: CAPTURE_TIME,
        },
        {
          variable: 'SoC', unit: '%', name: 'SoC', time: CAPTURE_TIME,
        },
      ],
    }],
  },

  // sent with HTTP 200 (live)
  rateLimited: { errno: 40400, msg: 'The number of requests is too frequent' },
};

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

const readCaptureDir = (dir) => {
  const out = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      out[path.basename(file, '.json')] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      console.log(`    (ignoring unreadable capture ${path.join(path.basename(dir), file)}: ${err.message})`);
    }
  }
  return out;
};

// test/captures/<site>/*.json; loose *.json directly in test/captures count as site 'default'
const readSites = () => {
  const out = {};
  if (!fs.existsSync(CAPTURE_DIR)) return out;
  for (const entry of fs.readdirSync(CAPTURE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const set = readCaptureDir(path.join(CAPTURE_DIR, entry.name));
    if (Object.keys(set).length) out[entry.name] = set;
  }
  const loose = readCaptureDir(CAPTURE_DIR);
  if (Object.keys(loose).length) out.default = { ...loose, ...(out.default || {}) };
  return out;
};

const sites = readSites();
const siteNames = Object.keys(sites).sort();
// the site the helpers resolve against; null = doc stubs
let activeSite = siteNames[0] || null;
const activeCaptures = () => (activeSite ? sites[activeSite] : {});

const fixtures = {
  /** Every site with real captures, in a stable order. Empty means doc-stub mode. */
  sites: siteNames,

  /** The site the helpers currently resolve against, or null for doc-stub mode. */
  get site() {
    return activeSite;
  },

  /** Point the fixture helpers at one site's captures (null = doc stubs only). */
  useSite(name) {
    if (name != null && !sites[name]) {
      throw new Error(`No captures for site '${name}'. Have: ${siteNames.join(', ') || '(none)'}`);
    }
    activeSite = name != null ? name : null;
  },

  get source() {
    return activeSite ? 'capture' : 'doc';
  },

  get names() {
    return [...new Set([...Object.keys(docStubs), ...Object.keys(activeCaptures())])].sort();
  },

  /** A response by name, preferring the active site's real capture over the doc-derived stub. */
  get(name) {
    const cap = activeCaptures()[name];
    if (cap) return JSON.parse(JSON.stringify(cap));
    if (docStubs[name]) return JSON.parse(JSON.stringify(docStubs[name]));
    throw new Error(`No fixture '${name}'. Have: ${fixtures.names.join(', ')}`);
  },

  /** True when `name` came from the active site's capture rather than the doc. */
  isReal(name) {
    return Boolean(activeCaptures()[name]);
  },

  banner() {
    if (!siteNames.length) {
      return 'fixtures: doc-derived stubs (no captures yet - run `node test/capture.js <api_key>` or `node test/from-logs.js <report>`)';
    }
    return `fixtures: real captures for ${siteNames.length} site(s) [${siteNames.join(', ')}], doc stubs for the rest`;
  },
};

// ---------------------------------------------------------------------------
// Loading app code without a Homey runtime
// ---------------------------------------------------------------------------

let homeyStub = null;

/** Install a minimal `homey` module so app files can be required outside Homey. */
fixtures.installHomeyStub = () => {
  if (homeyStub) return homeyStub;

  class SimpleClass {

    log() {}

    error() {}

    debug() {}

  }
  homeyStub = {
    manifest: JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8')),
    App: class extends SimpleClass {},
    Device: class extends SimpleClass {},
    Driver: class extends SimpleClass {},
    SimpleClass,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };

  const original = Module._resolveFilename;
  Module._resolveFilename = function resolve(request, ...rest) {
    if (request === 'homey') return 'homey-stub';
    return original.call(this, request, ...rest);
  };
  require.cache['homey-stub'] = {
    id: 'homey-stub', filename: 'homey-stub', loaded: true, exports: homeyStub,
  };
  return homeyStub;
};

/** Require a module from the app, with the Homey runtime stubbed out. */
fixtures.app = (relative) => {
  fixtures.installHomeyStub();
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(APP, relative));
};

/** A FoxEssClient with only the HTTP layer replaced; `calls` records the requests. */
fixtures.makeClient = ({ post, get } = {}) => {
  const stub = fixtures.installHomeyStub();
  const Client = fixtures.app('lib/FoxEssClient.js');
  const client = new Client({
    homey: stub,
    apiKey: 'test-api-key',
    host: 'example.invalid',
  });
  client.homey = stub;
  client.log = () => {};
  client.error = () => {};
  client.debug = () => {};
  client.calls = [];

  client.post = async (args) => {
    client.calls.push({ method: 'POST', path: args.path, body: args.body ? JSON.parse(args.body) : undefined });
    if (post) return client.handleResult(await post(args));
    throw new Error(`Unexpected POST ${args.path}`);
  };
  client.get = async (args) => {
    client.calls.push({ method: 'GET', path: args.path, query: args.query });
    if (get) return client.handleResult(await get(args));
    throw new Error(`Unexpected GET ${args.path}`);
  };
  return client;
};

// endpoint -> fixture name
const ROUTES = {
  '/op/v0/plant/list': 'plantList',
  '/op/v0/plant/detail': 'plantDetail',
  '/op/v0/device/list': 'deviceList',
  '/op/v1/device/detail': 'deviceDetail',
  '/op/v0/device/real/query': 'deviceRealQuery',
  '/op/v1/device/real/query': 'deviceRealQuery',
  '/op/v0/heat/register/list': 'heatPumpList',
  '/op/v0/module/list': 'moduleList',
  '/op/v0/heat/heatingControls': 'heatHeatingControls',
  '/op/v0/heat/dhwControls': 'heatDhwControls',
};

/** A client that answers every known endpoint from the fixture source. */
fixtures.makeRoutedClient = (overrides = {}) => {
  const answer = (args) => {
    if (Object.prototype.hasOwnProperty.call(overrides, args.path)) {
      const value = overrides[args.path];
      return typeof value === 'function' ? value(args) : value;
    }
    if (!Object.prototype.hasOwnProperty.call(ROUTES, args.path)) {
      throw new Error(`No fixture route for ${args.path}`);
    }
    const name = ROUTES[args.path];
    return name ? fixtures.get(name) : { errno: 0 };
  };
  return fixtures.makeClient({ post: answer, get: answer });
};

/** A driver instance with only the logging wired up, for testing driver-level logic. */
fixtures.makeDriver = (driverId = 'inverter', { own = false } = {}) => {
  // own: the driver's own class (drivers/<id>/driver.js) instead of the common base
  const Driver = fixtures.app(own ? `drivers/${driverId}/driver.js` : 'lib/common_driver.js');
  const driver = Object.create(Driver.prototype);
  driver.id = driverId;
  driver.log = () => {};
  driver.error = () => {};
  return driver;
};

fixtures.constants = {
  PLANT_A, PLANT_B, SN_A1, SN_A2, SN_B1,
};

module.exports = fixtures;
