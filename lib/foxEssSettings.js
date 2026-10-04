'use strict';

/*
The installation's own limits that Homey can change - battery SoC limits and the export limit - and
the check whether something else changed what Homey wrote. The pure part, kept free of Homey so it
can be tested. The capabilities follow com.solarwatt, whose SOLARWATT vision
runs FoxESS inverter firmware.

SoC limits are battery/soc/get|set: minSoc ("Minimum soc of system", the off-grid floor) and
minSocOnGrid, always written as a pair. The firmware keeps minSoc <= minSocOnGrid: measured on De
Brik (2026-10-04), the pair 15/12 was answered with errno 0 but only 12 was applied - so Homey
refuses such a target instead of half-writing it. (The vision ignores the same violation over
Modbus, com.solarwatt deviation F-05.) There is no maximum: setting 'MaxSoc' reads, but a write
was accepted and ignored.
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
 * The keys whose reported value differs from what Homey wrote. Only writes made `graceMs` before
 * the read started count, so a read already under way - or a cloud that has not caught up -
 * cannot raise a false alarm.
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
