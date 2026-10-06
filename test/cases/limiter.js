'use strict';

/*
Rate limiting (errno 40400 with HTTP 200, cooldown) and request timeouts.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const Client = fixtures.app('lib/FoxEssClient.js');
  const limited = fixtures.get('rateLimited');
  const code = Number(limited.errno ?? limited.code);

  t.eq(code, Client.RATE_LIMIT_CODE, 'the fixture carries the rate-limit code the client watches for');

  const client = fixtures.makeClient();
  let raised = null;
  try {
    client.handleResult(limited);
  } catch (err) {
    raised = err;
  }
  t.ok(raised, 'a 200 carrying 40400 is raised as an error, not returned as data');

  const remaining = client._rateLimitedUntil - Date.now();
  t.ok(remaining > 0, 'a cooldown was armed');
  t.ok(remaining <= Client.RATE_LIMIT_COOLDOWN + Client.RATE_LIMIT_JITTER, 'the cooldown stays within its bound');
  t.ok(remaining > Client.RATE_LIMIT_COOLDOWN - 1000, 'the cooldown is at least the base delay');

  // during the cooldown no request is built
  let blocked = null;
  try {
    client.buildRequest({ method: 'POST', path: '/op/v1/device/real/query' });
  } catch (err) {
    blocked = err;
  }
  t.ok(blocked, 'no request is built during the cooldown');
  t.ok(/rate limit/i.test(blocked.message), 'and the reason says so');

  // a healthy response is untouched
  const fresh = fixtures.makeClient();
  const ok = fixtures.get('deviceRealQuery');
  const passed = fresh.handleResult(ok);
  t.ok(passed === ok, 'a normal response passes straight through');

  // every request carries an abort signal
  const built = fresh.buildRequest({ method: 'POST', path: '/op/v1/device/real/query', body: '{}' });
  t.ok(built.opts.signal instanceof AbortSignal, 'an AbortSignal is attached');
  t.ok(Client.REQUEST_TIMEOUT > 0 && Client.REQUEST_TIMEOUT < 30000, 'the timeout fits inside Homey\'s 30s pair budget');
};
