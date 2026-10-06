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
Poll right after FoxESS has a new snapshot. Measured (2026-09-19): one snapshot per exactly 300 s,
always at the same second (12:05:24, 12:10:24, ...), served within seconds. So the tick is placed a
margin after the snapshot `time`; the margin grows after a tick without a new snapshot and eases
back after one with (as com.growatt's phase lock).
*/

const PERIOD_MS = 5 * 60 * 1000;

const MARGIN_MS = 20 * 1000; // upload + processing measured under 6 s
const MARGIN_STEP_MS = 15 * 1000;
const MARGIN_DECAY_MS = 5 * 1000;
const MAX_MARGIN_MS = 2 * 60 * 1000;

// snapshots of one account further apart than this fall back to the period boundary
const MAX_SPREAD_MS = 60 * 1000;

/**
 * A real/query `time` ("2026-09-19 12:05:24 CEST+0200") as epoch ms.
 * @returns {number|null} null when it cannot be read
 */
const parseSnapshotTime = (text) => {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}).*?([+-])(\d{2}):?(\d{2})\s*$/.exec(String(text || ''));
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * The tick's position within the period, from the snapshot moments of all known inverters.
 * @param {number[]} snapshotMs epoch ms of the latest snapshot of each inverter
 * @returns {number} ms after the period boundary; 0 when unknown or too spread out
 */
const tickPhase = (snapshotMs, marginMs = MARGIN_MS, periodMs = PERIOD_MS) => {
  const phases = snapshotMs.filter((t) => Number.isFinite(t)).map((t) => ((t % periodMs) + periodMs) % periodMs);
  if (!phases.length) return 0;
  // spread on a circle: the smallest arc that holds them all
  const sorted = [...phases].sort((a, b) => a - b);
  let widestGap = sorted[0] + periodMs - sorted[sorted.length - 1];
  let last = sorted[sorted.length - 1];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > widestGap) {
      widestGap = gap;
      last = sorted[i - 1];
    }
  }
  if (periodMs - widestGap > MAX_SPREAD_MS) return 0;
  return (last + marginMs) % periodMs;
};

/**
 * The margin after a tick: longer when it got no new snapshot, shorter when it did.
 * @param {number} marginMs the current margin
 * @param {boolean} gotNew whether the tick brought a snapshot newer than the one before it
 * @returns {number} the next margin
 */
const adaptMargin = (marginMs, gotNew) => (gotNew
  ? Math.max(MARGIN_MS, marginMs - MARGIN_DECAY_MS)
  : Math.min(MAX_MARGIN_MS, marginMs + MARGIN_STEP_MS));

/**
 * Time until the next moment at `phaseMs` after a period boundary, at least a second away.
 * @returns {number} ms
 */
const delayToNextTick = (nowMs, phaseMs, periodMs = PERIOD_MS) => {
  const next = Math.floor((nowMs - phaseMs) / periodMs) * periodMs + phaseMs + periodMs;
  return next - nowMs < 1000 ? next - nowMs + periodMs : next - nowMs;
};

/**
 * Today's date at the inverter (reports count in plant time): from the snapshot's UTC offset,
 * else in `timeZone`.
 * @param {string} [snapshotTime] the `time` of a real/query result
 * @param {string} [timeZone] IANA zone to fall back on, e.g. Homey's own
 * @param {number} [nowMs]
 * @returns {{year: number, month: number, day: number}}
 */
const localDate = (snapshotTime, timeZone = 'UTC', nowMs = Date.now()) => {
  const m = /([+-])(\d{2}):?(\d{2})\s*$/.exec(String(snapshotTime || ''));
  if (m) {
    const offsetMs = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000;
    const local = new Date(nowMs + offsetMs);
    return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() };
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
};

module.exports = {
  localDate,
  PERIOD_MS,
  MARGIN_MS,
  MAX_MARGIN_MS,
  parseSnapshotTime,
  tickPhase,
  adaptMargin,
  delayToNextTick,
};
