'use strict';

/*
Battery control: target_power_mode <-> FoxESS state, and the Homey scheduler slot.

FoxESS has no power setpoint, only a WorkMode and a scheduler of time slots (ForceCharge /
ForceDischarge carry a power). The Homey slot is written in inverter local time, taken from the
real-time snapshot's own time ("... CEST+0200"), and split at midnight because a slot cannot run
past 23:59.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const ctl = fixtures.app('lib/foxEssBatteryControl.js');

  // --- inverter clock from a snapshot ---
  const at = Date.UTC(2026, 8, 19, 10, 5, 0);
  t.eq(JSON.stringify(ctl.inverterNow('2026-09-19 12:05:24 CEST+0200', at)), '{"hour":12,"minute":5}', 'local time from the snapshot offset');
  t.eq(JSON.stringify(ctl.inverterNow('2026-09-19 06:05:24 EDT-0400', at)), '{"hour":6,"minute":5}', 'a negative offset');
  t.eq(ctl.inverterNow('garbage', at), null, 'no offset, no guess');

  // --- slots ---
  const one = ctl.slotGroups({
    now: { hour: 12, minute: 5 }, minutes: 60, workMode: 'ForceCharge', extraParam: { fdPwr: 1500 },
  });
  t.eq(one.length, 1, 'a daytime slot is one group');
  t.eq(`${one[0].startHour}:${one[0].startMinute}-${one[0].endHour}:${one[0].endMinute}`, '12:5-13:5', 'running from now for the slot length');
  const split = ctl.slotGroups({
    now: { hour: 23, minute: 40 }, minutes: 60, workMode: 'ForceCharge', extraParam: {},
  });
  t.eq(split.length, 2, 'a slot across midnight is split in two');
  t.eq(`${split[0].endHour}:${split[0].endMinute} ${split[1].startHour}:${split[1].startMinute}-${split[1].endHour}:${split[1].endMinute}`,
    '23:59 0:0-0:40', 'at 23:59 and on from 00:00');

  // --- power -> slot, corrected for PV (fdPwr caps grid draw / total AC output, not the battery) ---
  const charge = ctl.slotForPower(2500, { minSocOnGrid: 15, pvW: 600 });
  t.eq(charge.workMode, 'ForceCharge', 'positive power charges');
  t.eq(charge.extraParam.fdPwr, 1900, 'from the grid only what PV does not already give');
  t.eq(ctl.slotForPower(400, { minSocOnGrid: 15, pvW: 600 }).extraParam.fdPwr, 0, 'never a negative grid draw');
  const discharge = ctl.slotForPower(-1800, { minSocOnGrid: 15, pvW: 860 });
  t.eq(discharge.workMode, 'ForceDischarge', 'negative power discharges');
  t.eq(discharge.extraParam.fdPwr, 2650, 'the AC output cap is battery plus PV, rounded to 50 W');
  t.eq(discharge.extraParam.fdSoc, 15, 'and never below the installation\'s own cutoff');
  t.eq(ctl.slotForPower(-9000, { minSocOnGrid: 15, pvW: 3000, maxW: 10000 }).extraParam.fdPwr, 10000, 'capped at rated power');
  t.eq(ctl.slotForPower(0, { minSocOnGrid: 15 }).workMode, 'Backup', '0 W holds with Backup: ForceCharge 0 W still charges from PV');

  // --- re-writing a running slot ---
  const running = ctl.slotGroups({ now: { hour: 12, minute: 5 }, ...charge });
  t.ok(!ctl.powerMoved(running, ctl.slotForPower(2500, { minSocOnGrid: 15, pvW: 700 })), 'a small PV change is not worth a write');
  t.ok(ctl.powerMoved(running, ctl.slotForPower(2500, { minSocOnGrid: 15, pvW: 1000 })), 'a larger one is');
  t.ok(ctl.powerMoved(running, ctl.slotForPower(-500, { minSocOnGrid: 15 })), 'and so is another mode');

  // --- state -> mode, with the read-back lag ---
  const echoed = one.map((g) => ({
    ...g,
    extraParam: {
      ...g.extraParam, fdSoc: 0, maxSoc: 100, pvLimit: 300000,
    },
  }));
  const history = ctl.remember(ctl.remember([], one), running);
  t.eq(ctl.modeFromState({ schedulerOn: false, workMode: 'SelfUse' }), 'self_use', 'scheduler off: the WorkMode');
  t.eq(ctl.modeFromState({ schedulerOn: false, workMode: 'PeakShaving' }), 'peak_shaving', 'every WorkMode is known');
  t.eq(ctl.modeFromState({ schedulerOn: true, groups: echoed, homeyHistory: history }), 'homey',
    'scheduler on with an earlier Homey write (a lagging read-back): still homey');
  const other = [{ ...one[0], workMode: 'ForceDischarge' }];
  t.eq(ctl.modeFromState({ schedulerOn: true, groups: other, homeyHistory: history }), 'schedule', 'other slots: the owner\'s schedule');
  t.eq(ctl.modeFromState({ schedulerOn: true, groups: one }), 'schedule', 'and so it is without any history');
  const backup = ctl.slotGroups({ now: { hour: 12, minute: 5 }, ...ctl.slotForPower(0, { minSocOnGrid: 15 }) });
  const backupEcho = backup.map((g) => ({ ...g, extraParam: { fdPwr: 0, fdSoc: 100, minSocOnGrid: 10 } }));
  t.ok(ctl.isHomeyWrite(backupEcho, [backup]), 'a Backup slot is recognised although it reads back with filled-in SoC');
  t.eq(ctl.remember([1, 2, 3, 4], 0).length, 4, 'the history is bounded');

  // --- renewal ---
  t.ok(!ctl.needsRenewal(one, { hour: 12, minute: 20 }), 'a fresh slot is left alone');
  t.ok(ctl.needsRenewal(one, { hour: 12, minute: 40 }), 'it is renewed in its last half hour');
  t.ok(ctl.needsRenewal(one, { hour: 14, minute: 0 }), 'and when it has ended');
  t.ok(!ctl.needsRenewal(split, { hour: 23, minute: 50 }), 'a split slot is followed across midnight');
  t.ok(ctl.needsRenewal(split, { hour: 0, minute: 15 }), 'and renewed in its last half hour after midnight');

  // --- measure_power.target: the slot running now, read back ---
  const now = { hour: 12, minute: 30 };
  const slots = (workMode, fdPwr) => ctl.slotGroups({ now: { hour: 12, minute: 5 }, workMode, extraParam: { fdPwr } });
  t.eq(ctl.activeSlotPower(slots('ForceCharge', 1500), now), 1500, 'ForceCharge shows +fdPwr');
  t.eq(ctl.activeSlotPower(slots('ForceDischarge', 2650), now), -2650, 'ForceDischarge shows -fdPwr');
  t.eq(ctl.activeSlotPower(slots('Backup', 0), now), 0, 'a Backup hold shows 0');
  t.eq(ctl.activeSlotPower(slots('SelfUse', 0), now), null, 'another slot mode has no setpoint');
  t.eq(ctl.activeSlotPower(slots('ForceCharge', 1500), { hour: 14, minute: 0 }), null, 'no slot running now, no setpoint');
  t.eq(ctl.activeSlotPower(slots('ForceCharge', 1500), null), undefined, 'unknown inverter time leaves the tile alone');
  const late = ctl.slotGroups({ now: { hour: 23, minute: 40 }, workMode: 'ForceCharge', extraParam: { fdPwr: 900 } });
  t.eq(ctl.activeSlotPower(late, { hour: 23, minute: 59 }), 900, 'the 23:59 minute belongs to the slot ending then');
  t.eq(ctl.activeSlotPower(late, { hour: 0, minute: 10 }), 900, 'and after midnight the second half runs');
};
