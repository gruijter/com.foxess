'use strict';

/*
Alarms: fault classification (lib/foxEssFaults.js), currentFault parsing and the alarm mappers.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const faults = fixtures.app('lib/foxEssFaults.js');
  const pointMap = fixtures.app('lib/foxEssPointMap.js');

  // --- classification, on texts taken from the live table ---
  const heat = ['INV Module over temperature', 'Amb Overtemperature too high', 'cEnvTempHighFault', 'AC Terminal overheating fault',
    'BMS Temperature High', 'Battery Cell temperature super high', 'battery1 Cell Over Temperature Protect'];
  const notHeat = ['BMS Temperature Low', 'cTempSensorFault', 'cEnvTempSenOpenWarning', 'battery1 Cell temperature High Invalid',
    'battery1 Cell Under Temperature Protect', 'Grid Lost Fault'];
  heat.forEach((text) => t.ok(faults.isHeat(text), `heat: ${text}`));
  notHeat.forEach((text) => t.ok(!faults.isHeat(text), `not heat: ${text}`));
  ['Bms Circuit Fault', 'battery1 Under Voltage Protect', 'cBDCHighTemp1Fault'].forEach((text) => t.ok(faults.isBattery(text), `battery: ${text}`));
  ['INV Module over temperature', 'Grid Lost Fault'].forEach((text) => t.ok(!faults.isBattery(text), `not battery: ${text}`));

  // --- currentFault parsing ---
  faults.setTable({ 145: 'INV Module over temperature', 209: 'BMS Temperature High', 1: 'Grid Lost Fault' });
  const client = {
    getFaultCodes: async () => {
      throw Error('must not fetch: table preloaded');
    },
  };
  const texts = (value) => faults.faultTexts(value, client);
  t.eq((await texts('')).length, 0, 'an empty currentFault (seen live) is no fault');
  t.eq((await texts(undefined)).length, 0, 'an absent currentFault is no fault');
  t.eq((await texts('0')).length, 0, 'a 0 code is no fault');
  t.eq((await texts('145')).join(), 'INV Module over temperature', 'a code is looked up');
  t.eq((await texts('145, 209')).join('|'), 'INV Module over temperature|BMS Temperature High', 'several codes are split');
  t.eq((await texts('99999')).join(), 'Fault 99999', 'an unknown code is kept as a fault');
  t.eq((await texts('Grid Lost Fault')).join(), 'Grid Lost Fault', 'plain text is taken as the text');
  t.eq(Object.keys(faults.compactTable({ result: { 1: { en: 'A', zh_CN: 'x' } } })).join(), '1', 'the raw table compacts to code -> en');

  // the table is only fetched once a code needs it
  faults.setTable(null);
  let fetched = 0;
  const lazy = {
    getFaultCodes: async () => {
      fetched += 1; return { result: { 7: { en: 'Battery Relay Fault' } } };
    },
  };
  await faults.faultTexts('', lazy);
  t.eq(fetched, 0, 'no active fault, no table fetch');
  t.eq((await faults.faultTexts('7', lazy)).join(), 'Battery Relay Fault', 'the table is fetched on the first code');
  await faults.faultTexts('7', lazy);
  t.eq(fetched, 1, 'and only once');

  // --- alarm mappers ---
  const inv = pointMap.inverterMap.inverter;
  const bat = pointMap.batteryMap.battery;
  const met = pointMap.meterMap.meter;
  const healthy = {
    currentFault: '', currentFaultCount: '0', runningState: '163', faultTexts: [], deviceStatus: 1,
  };
  for (const [name, map] of [['inverter', inv], ['battery', bat], ['meter', met]]) {
    t.eq(map.alarm_problem(healthy), false, `${name}: healthy (as seen live) raises no problem`);
    t.eq(map.alarm_connectivity(healthy), false, `${name}: online is connected`);
    t.eq(map.alarm_connectivity({ deviceStatus: 3 }), true, `${name}: offline raises connectivity`);
    t.eq(map.alarm_problem({ deviceStatus: 2 }), true, `${name}: breakdown raises problem`);
    t.eq(map.alarm_problem({}), undefined, `${name}: nothing reported, no alarm value`);
  }
  t.eq(inv.alarm_problem({ ...healthy, runningState: 165 }), true, 'runningState fault raises problem');
  t.eq(inv.alarm_problem({ ...healthy, runningState: 166 }), true, 'runningState permanent fault raises problem');
  t.eq(inv.alarm_problem({ ...healthy, currentFaultCount: '1' }), true, 'a fault count raises problem');
  t.eq(inv.alarm_problem({ ...healthy, faultTexts: ['Grid Lost Fault'] }), true, 'any active fault raises problem');

  t.eq(inv.alarm_heat({ ...healthy, faultTexts: ['INV Module over temperature'] }), true, 'inverter heat fault -> inverter heat');
  t.eq(bat.alarm_heat({ ...healthy, faultTexts: ['INV Module over temperature'] }), false, 'inverter heat fault is not battery heat');
  t.eq(bat.alarm_heat({ ...healthy, faultTexts: ['BMS Temperature High'] }), true, 'battery heat fault -> battery heat');
  t.eq(inv.alarm_heat({ ...healthy, faultTexts: ['BMS Temperature High'] }), false, 'battery heat fault is not inverter heat');
  t.eq(bat.alarm_battery({ ...healthy, faultTexts: ['Bms Circuit Fault'] }), true, 'a BMS fault raises the battery alarm');
  t.eq(bat.alarm_battery({ ...healthy, faultTexts: ['Grid Lost Fault'] }), false, 'a grid fault does not');
  t.eq(bat.alarm_battery({ ...healthy, SoC: 5 }), false, 'a low state of charge is never an alarm');
  t.ok(!('alarm_battery' in inv) && !('alarm_battery' in met), 'alarm_battery lives on the battery driver only');

  const hp = pointMap.heatpumpMap.heatpump;
  t.eq(hp.alarm_problem({ runningStatus: 2 }), true, 'heat pump fault raises problem');
  t.eq(hp.alarm_connectivity({ runningStatus: 3 }), true, 'heat pump offline raises connectivity');
  t.eq(hp.alarm_problem({ runningStatus: 1 }), false, 'heat pump online raises nothing');

  // every driver has the catch-all, as an optional capability at the end
  for (const driverId of ['inverter', 'battery', 'meter', 'heatpump']) {
    t.ok(pointMap.optionalCapabilities(driverId).includes('alarm_problem'), `${driverId} has alarm_problem`);
  }
  // a reported false is evidence, so the alarms appear on the first healthy poll
  const seen = pointMap.seenInPayload('battery', healthy);
  t.ok(seen.alarm_problem && seen.alarm_battery && seen.alarm_heat && seen.alarm_connectivity, 'a healthy poll adds the battery alarms');

  faults.setTable(null);
};
