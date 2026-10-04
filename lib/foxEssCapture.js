/*
Copyright 2025 - 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.foxess.

com.foxess is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.foxess is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.foxess.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

/*
API captures in the app log, so a user's diagnostics report doubles as test material.

Homey has no diagnostics API: a report is created by the user (Homey app -> Settings -> Apps ->
FoxESS -> Create diagnostics report) and carries whatever the app wrote with this.log(). So the
job here is to write the raw API responses into that log in a form that can be read back out.

Captured once per "arm" - app start, a device (re)start, and every completed pair or repair -
rather than every poll, which would drown the log and tell us nothing new. Same idea as
com.kia_hyundai's ===VEHICLE-DEBUG-DUMP-START=== block, but chunked across several lines: there
are seven endpoints here rather than one dump, and a truncated line would cost the whole payload.

`node test/from-logs.js <report.txt>` turns the result back into test/captures/*.json.
*/

// Canonical endpoint -> capture name. These are the names test/fixtures.js looks for, so a parsed
// report drops straight into test/captures/ with nothing to rename. Any OTHER endpoint the app
// calls is captured too, under a name derived from its path (see nameFor / deriveName) - the
// recorder is not limited to this list, so a future feature's new call is captured with no edit
// here. This map only pins the stable names for endpoints the suite already asserts against, and
// folds the v0/v1 real-time endpoints onto one name.
const CAPTURE_NAMES = {
  '/op/v0/plant/list': 'plantList',
  '/op/v0/plant/detail': 'plantDetail',
  '/op/v0/device/list': 'deviceList',
  '/op/v0/device/detail': 'deviceDetail',
  '/op/v1/device/detail': 'deviceDetail',
  '/op/v0/device/real/query': 'deviceRealQuery',
  '/op/v1/device/real/query': 'deviceRealQuery',
  '/op/v0/register/heat/list': 'heatPumpList',
  '/op/v0/heat/heatingControls/get': 'heatHeatingControls',
  '/op/v0/heat/dhwControls/get': 'heatDhwControls',
};

// A stable, filesystem-safe fixture name for any endpoint without a canonical one above.
// '/op/v0/device/setting/get' -> 'deviceSettingGet', '/op/v0/device/battery/soc/get' -> 'deviceBatterySocGet'.
const deriveName = (path) => String(path)
  .replace(/\?.*$/, '')
  .replace(/^\/op\/v\d+\//, '')
  .split('/')
  .filter(Boolean)
  .map((seg, i) => (i === 0 ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)))
  .join('')
  .replace(/[^A-Za-z0-9]/g, '');

const nameFor = (path) => CAPTURE_NAMES[path] || deriveName(path);

const START = '===FOXESS-CAPTURE-START';
const END = '===FOXESS-CAPTURE-END';
const CHUNK = 700; // keeps a log line readable and well inside any line cap
const MAX_BYTES = 32 * 1024; // a runaway payload must not flood the report
const REARM_COOLDOWN = 60 * 1000;

// Contact details of the owner and installer, which plant/detail returns in full. They are of no
// use as test material and a diagnostics report goes to the developer, so they do not travel.
// Serial numbers and plant names DO stay: without them a capture cannot reproduce anything.
const PII_KEYS = new Set(['email', 'phone', 'address', 'postcode', 'city', 'country']);

const redact = (value) => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PII_KEYS.has(k)) out[k] = '<redacted>';
      else if (k === 'name' && v && typeof v === 'object') out[k] = redact(v);
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
};

// The `user` and `installer` objects are purely contact details - their `name` is a person.
const redactPayload = (payload) => {
  const copy = redact(payload);
  const result = copy && copy.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    for (const who of ['user', 'installer']) {
      if (result[who] && typeof result[who] === 'object') {
        result[who] = { ...result[who], name: '<redacted>' };
      }
    }
  }
  return copy;
};

let isArmed = false;
let capturedNames = new Set();
let reason = '';
let lastArmAt = 0;

const capture = {

  CAPTURE_NAMES,

  /**
   * Arm capturing: the next response from every distinct endpoint the app calls is logged once.
   * Not limited to a fixed list, so new endpoints (a future feature, a detection probe) are
   * captured automatically.
   * @param {string} why shown in the log, so a report says what triggered the capture
   * @param {boolean} force skip the cooldown - used for pair and repair, which are deliberate
   */
  arm(why, { force = false } = {}) {
    const now = Date.now();
    if (!force && (now - lastArmAt) < REARM_COOLDOWN) return false;
    lastArmAt = now;
    reason = why;
    isArmed = true;
    capturedNames = new Set();
    return true;
  },

  /**
   * Log one API response, if capturing is armed and this endpoint has not been captured yet in
   * this arm window. Every endpoint is eligible - the canonical ones keep a stable fixture name,
   * the rest get one derived from their path.
   * @param {string} path the API path that produced it
   * @param {*} payload the parsed response body
   * @param {Function} log the app/device logger
   */
  record(path, payload, log) {
    if (!isArmed || !payload || typeof log !== 'function') return false;
    const name = nameFor(path);
    if (!name || capturedNames.has(name)) return false;
    capturedNames.add(name);

    let text;
    try {
      text = JSON.stringify(redactPayload(payload));
    } catch (err) {
      log(`capture ${name}: could not serialise (${err.message})`);
      return false;
    }
    if (text.length > MAX_BYTES) {
      log(`capture ${name}: skipped, ${text.length} bytes exceeds the ${MAX_BYTES} byte cap`);
      return false;
    }

    const chunks = Math.ceil(text.length / CHUNK);
    log(`${START} ${name} ${chunks} (${reason})===`);
    for (let i = 0; i < chunks; i += 1) {
      log(`${name}|${i + 1}|${text.slice(i * CHUNK, (i + 1) * CHUNK)}`);
    }
    log(`${END} ${name}===`);
    return true;
  },

  /**
   * Read captures back out of a diagnostics report.
   *
   * Tolerates whatever the report wraps the lines in - timestamps, log prefixes, ANSI - by
   * anchoring on the `<name>|<index>|` marker rather than on the line starting cleanly.
   * @param {string} text the whole report
   * @returns {{captures: object, errors: string[]}} parsed payloads by capture name
   */
  parseLog(text) {
    const captures = {};
    const errors = [];
    const parts = new Map(); // name -> Map(index -> chunk)
    const expected = new Map(); // name -> chunk count

    for (const line of String(text).split(/\r?\n/)) {
      const header = line.match(new RegExp(`${START} (\\S+) (\\d+)`));
      if (header) {
        expected.set(header[1], Number(header[2]));
        parts.set(header[1], new Map());
        continue;
      }
      const body = line.match(/([A-Za-z]+)\|(\d+)\|(.*)$/);
      if (body && parts.has(body[1])) {
        parts.get(body[1]).set(Number(body[2]), body[3]);
      }
    }

    for (const [name, chunks] of parts) {
      const total = expected.get(name);
      const missing = [];
      let joined = '';
      for (let i = 1; i <= total; i += 1) {
        if (!chunks.has(i)) missing.push(i);
        else joined += chunks.get(i);
      }
      if (missing.length) {
        errors.push(`${name}: missing chunk(s) ${missing.join(', ')} of ${total} - report truncated?`);
        continue;
      }
      try {
        captures[name] = JSON.parse(joined);
      } catch (err) {
        errors.push(`${name}: reassembled text is not valid JSON (${err.message})`);
      }
    }

    return { captures, errors };
  },

};

module.exports = capture;
