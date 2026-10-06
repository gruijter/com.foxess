'use strict';

/*
The diagnostics-report capture path end to end: arm, log, parse back.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const capture = fixtures.app('lib/foxEssCapture.js');

  // 1. any endpoint is captured when armed, not only the named ones
  const genericLines = [];
  capture.arm('generic', { force: true });
  capture.record('/op/v0/device/setting/get', { errno: 0, result: { values: { operation_mode: 'SelfUse' } } }, (l) => genericLines.push(l));
  const generic = capture.parseLog(genericLines.join('\n'));
  t.ok(generic.captures.deviceSettingGet, 'an endpoint with no canonical name is still captured (deviceSettingGet)');
  t.eq(capture.CAPTURE_NAMES['/op/v1/device/real/query'], 'deviceRealQuery', 'canonical endpoints keep their stable fixture name');

  // 2. nothing is logged until armed
  const quiet = [];
  capture.arm('reset', { force: true });
  capture.record('/op/v0/device/list', fixtures.get('deviceList'), (l) => quiet.push(l));
  const before = quiet.length;
  capture.record('/op/v0/device/list', fixtures.get('deviceList'), (l) => quiet.push(l));
  t.ok(before > 0, 'an armed endpoint is logged');
  t.eq(quiet.length, before, 'the same endpoint is not logged again until re-armed');

  // 3. Round-trip: log every endpoint, parse it back, get the payloads unchanged.
  const lines = [];
  capture.arm('app start', { force: true });
  const sources = {};
  for (const [apiPath, name] of Object.entries(capture.CAPTURE_NAMES)) {
    let payload;
    try {
      payload = fixtures.get(name);
    } catch {
      continue;
    }
    sources[name] = payload;
    capture.record(apiPath, payload, (l) => lines.push(l));
  }
  t.ok(lines.length > 0, 'capture blocks were written to the log');

  const { captures, errors } = capture.parseLog(lines.join('\n'));
  t.eq(errors.length, 0, `parsing the log produced no errors (${errors.join('; ')})`);
  for (const name of Object.keys(sources)) {
    t.ok(captures[name], `${name} came back out of the log`);
  }

  // identical except for the redacted fields
  const PII = new Set(['email', 'phone', 'address', 'postcode', 'city', 'country']);
  const blank = (value, inContact = false) => {
    if (Array.isArray(value)) return value.map((v) => blank(v, inContact));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const contact = inContact || k === 'user' || k === 'installer';
        if (PII.has(k) || (contact && k === 'name' && typeof v !== 'object')) out[k] = '<redacted>';
        else out[k] = blank(v, contact);
      }
      return out;
    }
    return value;
  };

  // 4. A realistic report wraps every line in a timestamp and a prefix.
  const wrapped = lines.map((l, i) => `2026-09-16T10:0${i % 10}:00.000Z [log] [FoxESSApp] ${l}`).join('\r\n');
  const fromReport = capture.parseLog(wrapped);
  t.eq(fromReport.errors.length, 0, 'a timestamped, CRLF report parses cleanly');
  for (const [name, original] of Object.entries(sources)) {
    const parsed = fromReport.captures[name];
    if (!parsed) {
      t.ok(false, `${name} survived the wrapped report`); continue;
    }
    t.eq(JSON.stringify(parsed), JSON.stringify(blank(original)),
      `${name} round-trips byte-identically apart from redacted fields`);
  }

  // 5. A truncated report must say so rather than hand over half a payload.
  const truncated = lines.slice(0, Math.max(1, lines.length - 2)).join('\n');
  const partial = capture.parseLog(truncated);
  t.ok(partial.errors.length > 0 || Object.keys(partial.captures).length < Object.keys(sources).length,
    'a truncated report is reported as incomplete rather than silently accepted');

  // 6. Owner contact details must not travel in a report; serials and plant names must.
  const detailLines = [];
  capture.arm('privacy', { force: true });
  capture.record('/op/v0/plant/detail', {
    errno: 0,
    result: {
      stationName: 'Real Plant Name',
      address: 'Somestreet 12',
      postcode: '1234AB',
      city: 'Amsterdam',
      user: { name: 'A Person', email: 'a@person.example', phone: '0612345678' },
      modules: [{ deviceSN: 'KEEPME123' }],
    },
  }, (l) => detailLines.push(l));
  const text = detailLines.join('\n');
  for (const secret of ['Somestreet 12', '1234AB', 'a@person.example', '0612345678', 'A Person']) {
    t.ok(!text.includes(secret), `'${secret}' was redacted out of the capture`);
  }
  t.ok(text.includes('KEEPME123'), 'the serial number is kept - a capture is useless without it');
  t.ok(text.includes('Real Plant Name'), 'the plant name is kept');
};
