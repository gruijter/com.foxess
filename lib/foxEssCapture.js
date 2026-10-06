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
Raw API responses in the app log, so a user's diagnostics report doubles as test material.
Each endpoint is logged once per arm (app start, device restart, pair, repair), in chunks.
`node test/from-logs.js <report.txt>` turns a report back into test/captures/*.json.
*/

// Stable names test/fixtures.js expects; other endpoints get a name from their path (deriveName).
const CAPTURE_NAMES = {
  '/op/v0/plant/list': 'plantList',
  '/op/v0/plant/detail': 'plantDetail',
  '/op/v0/device/list': 'deviceList',
  '/op/v0/device/detail': 'deviceDetail',
  '/op/v1/device/detail': 'deviceDetail',
  '/op/v0/device/real/query': 'deviceRealQuery',
  '/op/v1/device/real/query': 'deviceRealQuery',
  '/op/v0/heat/register/list': 'heatPumpList',
  '/op/v0/module/list': 'moduleList',
  '/op/v0/heat/heatingControls': 'heatHeatingControls',
  '/op/v0/heat/dhwControls': 'heatDhwControls',
  '/op/v0/heat/genericControls': 'heatGenericControls',
  '/op/v0/heat/heatingCircuitsControls': 'heatHeatingCircuitsControls',
};

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
const CHUNK = 700; // characters per log line
const MAX_BYTES = 32 * 1024;
const REARM_COOLDOWN = 60 * 1000;

// Contact details (plant/detail) are redacted; serial numbers and plant names are kept.
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

// `user` and `installer` are contact details: their `name` is a person
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
   * Arm capturing: the next response of every endpoint is logged once.
   * @param {string} why shown in the log
   * @param {boolean} force skip the cooldown (pair and repair)
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
   * Log one API response while armed, once per endpoint per arm.
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
   * Read captures back out of a diagnostics report; anchors on `<name>|<index>|`, so line
   * prefixes don't matter.
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
