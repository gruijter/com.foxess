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
Battery control, Homey-free so it can be tested. FoxESS has no power setpoint, only a WorkMode and
a scheduler of time slots.

  target_power_mode  the four WorkModes (scheduler off), 'schedule' (scheduler on, the owner's
                     slots) or 'homey' (scheduler on, one slot written by this app)
  target_power       in 'homey' mode the slot power: > 0 ForceCharge, < 0 ForceDischarge, 0 Backup

The Homey slot lasts SLOT_MINUTES and is renewed before it ends, so the inverter falls back to its
WorkMode within the hour when Homey stops.

Measured on an H3-G2 (2026-09-19):
- fdPwr caps the grid draw in ForceCharge (PV charges on top) and the total AC output in
  ForceDischarge (PV included), so the slot power is corrected for the latest PV reading.
- ForceCharge at 0 W still charges from PV; Backup holds the battery best, so 0 W is Backup.
- Writing slots does not switch the scheduler on (separate call).
- Reading the scheduler right after a write can return the previous slots.
*/

// target_power_mode id -> WorkMode (setting/get 'WorkMode' enumList, H3-G2)
const WORK_MODES = {
  self_use: 'SelfUse',
  feed_in: 'Feedin',
  backup: 'Backup',
  peak_shaving: 'PeakShaving',
};

const MODE_HOMEY = 'homey';
const MODE_SCHEDULE = 'schedule';

// renewed on a poll tick, so the margin must exceed a tick
const SLOT_MINUTES = 60;
const RENEW_BEFORE_END_MINUTES = 30;

const MINUTES_PER_DAY = 24 * 60;

/**
 * The inverter's local time now (scheduler slots use it), using the UTC offset in a snapshot
 * time like "2026-09-19 12:05:24 CEST+0200".
 * @param {string} snapshotTime the `time` of a real/query result
 * @param {number} [nowMs] the current time
 * @returns {{hour: number, minute: number}|null} null when the offset cannot be read
 */
const inverterNow = (snapshotTime, nowMs = Date.now()) => {
  const match = /([+-])(\d{2}):?(\d{2})\s*$/.exec(String(snapshotTime || ''));
  if (!match) return null;
  const offset = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  const local = new Date(nowMs + offset * 60000);
  return { hour: local.getUTCHours(), minute: local.getUTCMinutes() };
};

/**
 * Scheduler groups from `now` for `minutes`, split at midnight (a group ends at 23:59 at most).
 * @returns {object[]} scheduler v3 groups
 */
const slotGroups = ({
  now, minutes = SLOT_MINUTES, workMode, extraParam,
}) => {
  const start = now.hour * 60 + now.minute;
  const end = start + minutes;
  const group = (from, to) => ({
    startHour: Math.floor(from / 60),
    startMinute: from % 60,
    endHour: Math.floor(to / 60),
    endMinute: to % 60,
    workMode,
    extraParam: { ...extraParam },
  });
  if (end <= MINUTES_PER_DAY - 1) return [group(start, end)];
  // ending exactly at midnight: no 00:00-00:00 group
  if (end <= MINUTES_PER_DAY) return [group(start, MINUTES_PER_DAY - 1)];
  return [group(start, MINUTES_PER_DAY - 1), group(0, end - MINUTES_PER_DAY)];
};

const POWER_STEP_W = 50;
const REWRITE_DELTA_W = 200; // PV-corrected power change that re-writes a running slot

const roundPower = (w, maxW) => Math.min(maxW, Math.max(0, Math.round(w / POWER_STEP_W) * POWER_STEP_W));

/**
 * The slot mode and parameters for a target battery power.
 * @param {number} watts battery power: > 0 charge, < 0 discharge, 0 hold
 * @param {object} context
 * @param {number} context.minSocOnGrid the installation's discharge cutoff
 * @param {number} [context.pvW] current PV power in W, to correct fdPwr for
 * @param {number} [context.maxW] the largest fdPwr to send
 * @returns {{workMode: string, extraParam: object}}
 */
const slotForPower = (watts, { minSocOnGrid, pvW = 0, maxW = Infinity }) => {
  const target = Number(watts) || 0;
  const pv = Math.max(0, Number(pvW) || 0);
  if (target < 0) {
    return {
      workMode: 'ForceDischarge',
      extraParam: { fdPwr: roundPower(-target + pv, maxW), fdSoc: minSocOnGrid, minSocOnGrid },
    };
  }
  if (target > 0) {
    return { workMode: 'ForceCharge', extraParam: { fdPwr: roundPower(target - pv, maxW), fdSoc: 100 } };
  }
  return { workMode: 'Backup', extraParam: {} };
};

/** Whether a running Homey slot must be re-written: other mode, or power moved REWRITE_DELTA_W. */
const powerMoved = (current, next) => !current || !current.length
  || current[0].workMode !== next.workMode
  || Math.abs((current[0].extraParam?.fdPwr ?? 0) - (next.extraParam?.fdPwr ?? 0)) >= REWRITE_DELTA_W;

// The API reads back every field filled in (Backup: fdPwr 0, fdSoc 100), so power and SoC only
// count for the Force modes, where this app sets them.
const groupKey = (g) => {
  const key = [g.startHour, g.startMinute, g.endHour, g.endMinute, g.workMode];
  if (/^Force/.test(g.workMode)) {
    key.push(Math.round(Number(g.extraParam?.fdPwr ?? 0)), Math.round(Number(g.extraParam?.fdSoc ?? 0)));
  }
  return key.join('|');
};

const sameGroups = (a = [], b = []) => a.length === b.length
  && a.every((g, i) => groupKey(g) === groupKey(b[i]));

// recent Homey writes remembered, since a read can still return the previous slots
const HOMEY_HISTORY = 4;

/**
 * Whether `groups` is one of the recent Homey writes.
 * @param {object[]} groups the scheduler's slots
 * @param {object[][]} history the recent Homey writes, newest first
 */
const isHomeyWrite = (groups, history) => Array.isArray(history)
  && history.some((written) => Array.isArray(written) && written.length && sameGroups(groups, written));

const remember = (history, groups) => [groups, ...(Array.isArray(history) ? history : [])].slice(0, HOMEY_HISTORY);

/**
 * The target_power_mode that describes the inverter's current state.
 * @param {object} state
 * @param {boolean} state.schedulerOn the scheduler master switch
 * @param {object[]} state.groups the scheduler's current slots
 * @param {string} state.workMode the WorkMode setting
 * @param {object[][]} [state.homeyHistory] the recent Homey writes, newest first
 * @returns {string|undefined} a target_power_mode id, undefined for a WorkMode Homey does not know
 */
const modeFromState = ({
  schedulerOn, groups, workMode, homeyHistory,
}) => {
  if (schedulerOn) return isHomeyWrite(groups, homeyHistory) ? MODE_HOMEY : MODE_SCHEDULE;
  return Object.keys(WORK_MODES).find((id) => WORK_MODES[id] === workMode);
};

/**
 * Whether the Homey slot ends within RENEW_BEFORE_END_MINUTES or has ended (midnight-safe).
 * @returns {boolean}
 */
const needsRenewal = (homeyGroups, now) => {
  if (!homeyGroups || !homeyGroups.length || !now) return true;
  const last = homeyGroups[homeyGroups.length - 1];
  const first = homeyGroups[0];
  const start = first.startHour * 60 + first.startMinute;
  const end = last.endHour * 60 + last.endMinute;
  const nowMin = now.hour * 60 + now.minute;
  const length = (end - start + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const elapsed = (nowMin - start + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return elapsed > length || (length - elapsed) <= RENEW_BEFORE_END_MINUTES;
};

/**
 * The running slot's fdPwr for measure_power.target: ForceCharge +, ForceDischarge -, Backup 0,
 * else null. Differs from target_power by the PV correction.
 * @param {object[]} groups the scheduler's slots
 * @param {{hour: number, minute: number}|null} now inverter local time
 * @returns {number|null|undefined} undefined when the time is unknown
 */
const activeSlotPower = (groups, now) => {
  if (!now) return undefined;
  const t = now.hour * 60 + now.minute;
  const slot = (Array.isArray(groups) ? groups : []).find((g) => {
    const start = g.startHour * 60 + g.startMinute;
    const end = g.endHour * 60 + g.endMinute;
    // end minute exclusive, except 23:59
    return t >= start && (t < end || (end === MINUTES_PER_DAY - 1 && t === end));
  });
  if (!slot) return null;
  const power = Math.round(Number(slot.extraParam?.fdPwr) || 0);
  // also the undocumented '(BAT)' variants, listed by an H3-G2's scheduler properties (2026-10-04)
  if (/^ForceCharge/.test(slot.workMode)) return power;
  if (/^ForceDischarge/.test(slot.workMode)) return -power;
  if (slot.workMode === 'Backup') return 0;
  return null;
};

module.exports = {
  activeSlotPower,
  WORK_MODES,
  MODE_HOMEY,
  MODE_SCHEDULE,
  SLOT_MINUTES,
  RENEW_BEFORE_END_MINUTES,
  inverterNow,
  slotGroups,
  slotForPower,
  powerMoved,
  sameGroups,
  isHomeyWrite,
  remember,
  modeFromState,
  needsRenewal,
};
