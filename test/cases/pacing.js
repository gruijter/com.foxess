'use strict';

/*
The document's access frequency limit: a query endpoint at most once per second, an update endpoint
at most once per 2 seconds, "each interface is calculated separately". FoxEssClient.request() makes
every call wait its turn per path (pace()); different paths never wait for each other.

Runs the shipped request() against a stubbed fetch, with the spacings shortened so the case is fast.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const stub = fixtures.installHomeyStub();
  const Client = fixtures.app('lib/FoxEssClient.js');

  // which paths count as updates
  const write = (path) => Client.WRITE_PATH.test(path);
  ['/op/v0/device/setting/set', '/op/v1/device/scheduler/set/flag', '/op/v3/device/scheduler/enable',
    '/op/v0/device/battery/soc/set', '/op/v0/heat/dhwControls/set', '/op/v0/heat/register']
    .forEach((path) => t.ok(write(path), `${path} is an update`));
  ['/op/v1/device/real/query', '/op/v0/device/setting/get', '/op/v1/device/scheduler/get/flag',
    '/op/v0/heat/register/list', '/op/v0/heat/heatingControls', '/op/v1/device/detail', '/op/v0/device/battery/soc/get']
    .forEach((path) => t.ok(!write(path), `${path} is a query`));

  const saved = { query: Client.QUERY_SPACING_MS, write: Client.WRITE_SPACING_MS, fetch: global.fetch };
  Client.QUERY_SPACING_MS = 60;
  Client.WRITE_SPACING_MS = 120;
  const sent = [];
  global.fetch = async (url, opts) => {
    sent.push({ path: new URL(url).pathname, at: Date.now(), headers: opts.headers });
    return { ok: true, status: 200, json: async () => ({ errno: 0, result: {} }) };
  };

  try {
    const client = new Client({ homey: stub, apiKey: 'test-api-key', host: 'example.invalid' });
    const q = '/op/v0/device/setting/get';
    const w = '/op/v0/device/setting/set';
    const other = '/op/v1/device/real/query';
    const start = Date.now();
    await Promise.all([
      client.post({ path: q, body: '{}' }),
      client.post({ path: q, body: '{}' }),
      client.post({ path: q, body: '{}' }),
      client.post({ path: other, body: '{}' }),
      client.post({ path: w, body: '{}' }),
      client.post({ path: w, body: '{}' }),
    ]);

    const times = (path) => sent.filter((s) => s.path === path).map((s) => s.at);
    const gaps = (list) => list.slice(1).map((at, i) => at - list[i]);
    const tolerance = 5; // timer granularity

    t.eq(sent.length, 6, 'every request went out');
    t.ok(gaps(times(q)).every((gap) => gap >= Client.QUERY_SPACING_MS - tolerance), `queries to one path are spaced (${gaps(times(q))} ms)`);
    t.ok(gaps(times(w)).every((gap) => gap >= Client.WRITE_SPACING_MS - tolerance), `updates to one path are spaced (${gaps(times(w))} ms)`);
    t.ok(times(other)[0] - start < Client.QUERY_SPACING_MS, 'another path does not wait for a busy one');
    t.ok(times(q)[0] - start < Client.QUERY_SPACING_MS, 'the first call to a path goes out at once');

    // a failing request does not block the path for the next one
    global.fetch = async () => {
      throw new Error('network down');
    };
    let failed = false;
    await client.post({ path: q, body: '{}' }).catch(() => {
      failed = true;
    });
    t.ok(failed, 'a network error is passed on');
    global.fetch = async (url, opts) => {
      sent.push({ path: new URL(url).pathname, at: Date.now(), headers: opts.headers });
      return { ok: true, status: 200, json: async () => ({ errno: 0 }) };
    };
    const after = await client.post({ path: q, body: '{}' });
    t.eq(after.errno, 0, 'the path keeps working after a failed request');

    t.ok(/^Homey com\.foxess\//.test(sent[0].headers['User-Agent']), 'requests carry the app\'s own User-Agent');
  } finally {
    Client.QUERY_SPACING_MS = saved.query;
    Client.WRITE_SPACING_MS = saved.write;
    global.fetch = saved.fetch;
  }
};
