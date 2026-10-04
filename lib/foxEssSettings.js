'use strict';

/*
The installation's own limits that Homey can change - battery SoC limits and the export limit - and
the check whether something else changed what Homey wrote. The pure part, kept free of Homey so it
can be tested. The capabilities and their write order follow com.solarwatt, whose SOLARWATT vision
runs FoxESS inverter firmware.

SoC limits live in two places in the cloud API: battery/soc/get|set carries minSoc ("Minimum soc of
system", the off-grid floor) and minSocOnGrid as one pair, and setting/get|set key 'MaxSoc' the
ceiling. The firmware keeps minSoc <= minSocOnGrid <= maxSoc: on the vision a Modbus write breaking
that was silently ignored (com.solarwatt, deviation F-05). Through the cloud this is not verified,
so Homey refuses such a target, and writes in an order in which every step is valid too.
*/

const SOC_MIN = 10; // battery/soc/set: "Minimum value: 10"
const SOC_MAX = 100;

const isSoc = (soc) => Number.isInteger(soc) && soc >= SOC_MIN && soc <= SOC_MAX;

/**
 * Whether a set of SoC limits is one the inverter accepts.
 * @param {object} limits
 * @param {number} limits.minSoc
 * @param {number} limits.minSocOnGrid
 * @param {number} [limits.maxSoc] undefined on an inverter without a MaxSoc setting
 * @returns {boolean}
 */
const socLimitsValid = ({ minSoc, minSocOnGrid, maxSoc }) => {
  if (!isSoc(minSoc) || !isSoc(minSocOnGrid) || minSoc > minSocOnGrid) return false;
  if (maxSoc === undefined) return true;
  return isSoc(maxSoc) && minSocOnGrid <= maxSoc;
};

/**
 * The writes that take the inverter from `current` to `next`, in an order that keeps every step
 * valid: a higher ceiling first makes room, a lower ceiling last.
 * @returns {string[]} 'maxSoc' and/or 'minSoc' (the minSoc/minSocOnGrid pair), in write order
 */
const socWriteOrder = (current, next) => {
  const steps = [];
  const maxChanged = next.maxSoc !== undefined && next.maxSoc !== current.maxSoc;
  const minChanged = next.minSoc !== current.minSoc || next.minSocOnGrid !== current.minSocOnGrid;
  const raiseCeiling = maxChanged && !(next.maxSoc < current.maxSoc);
  if (raiseCeiling) steps.push('maxSoc');
  if (minChanged) steps.push('minSoc');
  if (maxChanged && !raiseCeiling) steps.push('maxSoc');
  return steps;
};

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
  socWriteOrder,
  noteWrites,
  overriddenKeys,
};
