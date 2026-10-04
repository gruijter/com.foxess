'use strict';

/*
Two ways a battery or inverter reading is recovered when the aggregate variable is not usable.

1. Per-pack copies (batVolt_1, SoC_2, ...) are a fallback only. The aggregate wins whenever it has
   a non-zero value; the copies are used when it is absent or 0 (live on an H3-G2: batVolt 0,
   batVolt_1 402.9), averaged when there is more than one pack.
2. 'Energy today' is derived from the lifetime total when the API sends no todayYield (an H3-G2
   never does), with the baseline reset at local midnight in Homey's timezone.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const pointMap = fixtures.app('lib/foxEssPointMap.js');
  const bat = pointMap.batteryMap.battery;

  // --- 1. per-pack fallback ---
  t.eq(bat.measure_voltage({ batVolt: 404.1, batVolt_1: 402.9 }), 404.1, 'the aggregate wins over a pack copy');
  t.eq(bat.measure_voltage({ batVolt: 0, batVolt_1: 402.9 }), 402.9, 'a 0 aggregate falls back to the only pack');
  t.eq(bat.measure_voltage({ batVolt_1: 400, batVolt_2: 404 }), 402, 'several packs are averaged');
  t.eq(bat.measure_voltage({ batVolt: 0, batVolt_1: 0, batVolt_2: 401 }), 401, 'a pack reading 0 is not averaged in');
  t.eq(bat.measure_voltage({ batVolt: 0 }), 0, 'a 0 aggregate with no packs stays 0');
  t.eq(bat.measure_voltage({}), undefined, 'nothing reported stays undefined');
  t.eq(bat.measure_battery({ SoC: 55, SoC_1: 100 }), 55, 'SoC: the aggregate wins');
  t.eq(bat.measure_battery({ SoC_1: 80, SoC_2: 90 }), 85, 'SoC: packs are only a fallback');
  t.eq(bat.measure_temperature({ batTemperature: 31.4, batTemperature_1: 99 }), 31.4, 'temperature: the aggregate wins');
  t.eq(bat.measure_voltage({ batVolt: 0, batVoltage_1: 400 }), 0, 'only exact <variable>_<n> keys count as packs');

  // --- 2. energy today from the lifetime total ---
  const CommonDevice = fixtures.app('lib/common_device.js');
  const store = {};
  const device = Object.create(CommonDevice.prototype);
  device.homey = { clock: { getTimezone: () => 'Europe/Amsterdam' } };
  device.error = () => {};
  device.getStoreValue = (key) => store[key];
  device.setStoreValue = async (key, value) => {
    store[key] = value;
  };

  t.eq(device.todayFromTotal('meter_power.today', undefined), undefined, 'no total, no daily figure');
  t.eq(device.todayFromTotal('meter_power.today', 52.6), 0, 'the first reading of the day is the baseline');
  t.eq(device.todayFromTotal('meter_power.today', 53.4), 0.8, 'later readings count up from it');
  store['todayBaseline_meter_power.today'].date = '2000-01-01';
  t.eq(device.todayFromTotal('meter_power.today', 60), 0, 'a new local day starts a new baseline');
  t.eq(device.todayFromTotal('meter_power.today', 10), 0, 'a total that went down starts a new baseline');
  t.eq(device.todayFromTotal('meter_power.today', 10.5), 0.5, 'and counts up from there');
};
