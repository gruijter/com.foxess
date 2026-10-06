'use strict';

/*
Installation limits Homey can change, and override detection; Homey-free so it can be tested.
Capabilities as com.solarwatt.

battery/soc/set writes minSoc and minSocOnGrid as a pair. minSoc > minSocOnGrid answered errno 0
but was only half applied (2026-10-04), so such a pair is refused. A 'MaxSoc' write was accepted
and ignored, so there is no maximum.
*/

const SOC_MIN = 10; // battery/soc/set: "Minimum value: 10"
const SOC_MAX = 100;

const isSoc = (soc) => Number.isInteger(soc) && soc >= SOC_MIN && soc <= SOC_MAX;

/**
 * Whether a pair of SoC limits is one the inverter applies as a whole.
 * @param {object} limits
 * @param {number} limits.minSoc
 * @param {number} limits.minSocOnGrid
 * @returns {boolean}
 */
const socLimitsValid = ({ minSoc, minSocOnGrid }) => isSoc(minSoc) && isSoc(minSocOnGrid) && minSoc <= minSocOnGrid;

/**
 * Remember what Homey wrote.
 * @param {object} written key -> { value, at }, as kept in the device store
 * @param {object} values key -> value as written
 * @param {number} [now]
 * @returns {object} the new store value
 */
const noteWrites = (written, values, now = Date.now()) => {
  const next = { ...(written || {}) };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) next[key] = { value, at: now };
  }
  return next;
};

/**
 * The keys whose reported value differs from what Homey wrote at least `graceMs` before the read.
 * @param {object} written key -> { value, at }
 * @param {object} readings key -> value just read; undefined means not read
 * @param {number} readStartedAt when the read started
 * @param {number} graceMs
 * @returns {string[]}
 */
const overriddenKeys = (written, readings, readStartedAt, graceMs) => Object.entries(readings)
  .filter(([key, value]) => {
    const entry = (written || {})[key];
    if (!entry || value === undefined || value === null) return false;
    if (entry.at > readStartedAt - graceMs) return false;
    return value !== entry.value;
  })
  .map(([key]) => key);

module.exports = {
  SOC_MIN,
  SOC_MAX,
  socLimitsValid,
  noteWrites,
  overriddenKeys,
};
