'use strict';

/*
API-key authentication, and the pair/repair flow around it.

FoxESS takes a personal API key in a `token` header (the OAuth form, `Authorization: Bearer`, must
not be sent alongside it) and signs every call as md5(path + "\r\n" + key + "\r\n" + timestamp).
An unknown key is answered with HTTP 401 (verified live), other failures with a non-zero errno in
an HTTP 200 body; the client throws on both, which is what pairing relies on to reject a key.

Pairing pre-fills the key and region used last, so a second device (another driver on the same
inverter) needs no retyping; every device gets the key in its store, and repair replaces it.
*/

const crypto = require('node:crypto');
const fixtures = require('../fixtures');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// A PairSession stand-in: collects the handlers so the test can call them like the view would.
const makeSession = () => {
  const handlers = {};
  const session = {
    setHandler(name, fn) {
      handlers[name] = fn;
      return session;
    },
  };
  return { session, handlers };
};

// An app stand-in with the real getClient/credential logic, backed by an in-memory settings store.
const makeHomey = (client) => {
  const App = fixtures.app('app.js');
  const settings = new Map();
  const homey = {
    __: (key) => key,
    settings: { get: (k) => settings.get(k), set: (k, v) => settings.set(k, v) },
  };
  const app = Object.create(App.prototype);
  app.homey = homey;
  app.clients = new Map();
  app.log = () => {};
  app.error = () => {};
  // hand out the routed test client instead of one that would go to the network
  app.getClient = ({ apiKey, region }) => {
    client.apiKey = apiKey;
    client.region = region;
    return client;
  };
  homey.app = app;
  return homey;
};

module.exports = async (t) => {
  // --- request signing ---
  const client = fixtures.makeClient();
  const urlPath = '/op/v1/device/real/query';
  const { url, opts } = client.buildRequest({ method: 'POST', path: urlPath, body: '{}' });
  t.eq(url, 'https://example.invalid/op/v1/device/real/query', 'the request goes to the region host');
  t.eq(opts.headers.token, 'test-api-key', 'the API key travels in the token header');
  t.ok(!('Authorization' in opts.headers), 'no Authorization header is sent alongside it');
  t.eq(opts.headers.signature, md5(`${urlPath}\r\ntest-api-key\r\n${opts.headers.timestamp}`),
    'the signature is md5(path, key, timestamp)');
  const withQuery = client.buildRequest({ method: 'GET', path: '/op/v1/device/detail', query: { sn: 'SN 1' } });
  t.eq(withQuery.url, 'https://example.invalid/op/v1/device/detail?sn=SN+1', 'the query string is appended, not signed');

  // --- error envelopes ---
  let rejected = null;
  try {
    client.handleResult({ errno: 41809, msg: 'invalid token' });
  } catch (err) {
    rejected = err;
  }
  t.ok(rejected && /invalid token/.test(rejected.message), 'a non-zero errno is thrown, with FoxESS\'s message');
  t.ok(rejected && /41809/.test(rejected.message), 'and its errno');
  t.eq(client._rateLimitedUntil, 0, 'an ordinary error does not start a rate-limit cooldown');

  // --- the shared region helper, including devices paired over OAuth ---
  const { regionIdOf, hostOf } = fixtures.app('lib/foxEssRegions.js');
  t.eq(regionIdOf({ region: 'us' }), 'us', 'the stored region wins');
  t.eq(regionIdOf({ OAuth2ConfigId: 'us' }), 'us', 'an OAuth-paired US device keeps its region');
  t.eq(regionIdOf({ OAuth2ConfigId: 'default' }), 'eu', 'the OAuth default config is Europe');
  t.eq(regionIdOf({}), 'eu', 'an unknown region falls back to Europe');
  t.eq(hostOf('us'), 'portal.foxesscloud.us', 'the US host');

  // --- pairing: login validates, remembers and pre-fills ---
  const routed = fixtures.makeRoutedClient();
  const homey = makeHomey(routed);
  const driver = fixtures.makeDriver('inverter');
  driver.homey = homey;

  const first = makeSession();
  await driver.onPair(first.session);
  t.eq((await first.handlers.get_credentials()).apiKey, '', 'a first pairing starts with an empty key');
  t.eq((await first.handlers.get_credentials()).region, 'eu', 'and Europe selected');

  let blank = null;
  try {
    await first.handlers.login({ apiKey: '  ', region: 'eu' });
  } catch (err) {
    blank = err;
  }
  t.ok(blank, 'an empty key is refused');

  const loginResult = await first.handlers.login({ apiKey: ' my-key ', region: 'us' });
  t.eq(loginResult.done, false, 'pairing moves on to the device list after login');
  t.ok(routed.calls.some((c) => c.path === '/op/v0/plant/list'), 'the key is checked against the plant list');
  const devices = await first.handlers.list_devices();
  t.ok(devices.length > 0, 'devices are listed after login');
  t.ok(devices.every((d) => d.store.apiKey === 'my-key' && d.store.region === 'us'), 'every device stores the trimmed key and region');
  t.ok(devices.every((d) => d.settings.region === 'portal.foxesscloud.us'), 'the settings show the region host');

  const second = makeSession();
  const battery = fixtures.makeDriver('battery');
  battery.homey = homey;
  await battery.onPair(second.session);
  const prefill = await second.handlers.get_credentials();
  t.eq(prefill.apiKey, 'my-key', 'the next pairing, for any driver, is pre-filled with the key');
  t.eq(prefill.region, 'us', 'and the region');

  // a key FoxESS refuses is reported and not remembered
  const refusing = fixtures.makeRoutedClient({ '/op/v0/plant/list': () => ({ errno: 41809, msg: 'invalid token' }) });
  const badHomey = makeHomey(refusing);
  const badDriver = fixtures.makeDriver('inverter');
  badDriver.homey = badHomey;
  const bad = makeSession();
  await badDriver.onPair(bad.session);
  let refused = null;
  try {
    await bad.handlers.login({ apiKey: 'wrong', region: 'eu' });
  } catch (err) {
    refused = err;
  }
  t.ok(refused && /errors.loginFailed/.test(refused.message) && /invalid token/.test(refused.message),
    'a refused key is reported with a translated prefix and FoxESS\'s reason');
  t.eq((await bad.handlers.get_credentials()).apiKey, '', 'and is not remembered');

  // --- repair: a device paired over OAuth gets a key ---
  const store = { OAuth2SessionId: 'old', OAuth2ConfigId: 'us' };
  let restarted = false;
  const device = {
    getStore: () => ({ ...store }),
    setStoreValue: async (k, v) => {
      store[k] = v;
    },
    setSettings: async () => {},
    restartDevice: async () => {
      restarted = true;
    },
  };
  const repair = makeSession();
  await driver.onRepair(repair.session, device);
  const repairPrefill = await repair.handlers.get_credentials();
  t.eq(repairPrefill.region, 'us', 'repair keeps the region of an OAuth-paired device');
  t.eq(repairPrefill.apiKey, 'my-key', 'and offers the key used last when the device has none');
  const repairResult = await repair.handlers.login({ apiKey: 'new-key', region: 'us' });
  t.eq(repairResult.done, true, 'repair ends after login');
  t.eq(store.apiKey, 'new-key', 'the device stores the new key');
  t.eq(store.region, 'us', 'and its region');
  t.ok(restarted, 'and restarts to use it');
};
