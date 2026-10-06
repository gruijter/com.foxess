'use strict';

/*
Every driver's capability map over the fixture's real-time payload, so a renamed variable is
caught instead of showing as an empty tile.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const pointMap = fixtures.app('lib/foxEssPointMap.js');
  const real = fixtures.get('deviceRealQuery');
  const devices = real.result || real.data || [];
  t.ok(devices.length > 0, 'real-time fixture contains at least one device');

  const client = fixtures.makeRoutedClient();
  const sn = devices[0].deviceSN;

  // Go through the shipped poll path rather than reshaping the payload by hand.
  for (const driverId of ['inverter', 'battery', 'meter']) {
    const driver = fixtures.makeDriver(driverId);
    const points = pointMap[`${driverId}Points`].inverter;
    const flat = await driver.pollDeviceType({ client, deviceSn: sn, variables: points });

    // a capture without this driver's variables (e.g. no battery) is skipped
    const present = new Set(Object.keys(flat));
    if (!points.some((p) => present.has(p))) {
      t.skip(`${driverId}: real-time fixture carries none of this driver's variables (pair a ${driverId} device before capturing to cover it)`);
      continue;
    }

    const caps = pointMap[`${driverId}Map`].inverter;
    let mapped = 0;
    for (const [cap, fn] of Object.entries(caps)) {
      const value = fn(flat);
      if (value === undefined) {
        t.log(`${driverId}.${cap}: no source field in this fixture`);
        continue;
      }
      t.ok(!Number.isNaN(value), `${driverId}.${cap} is not NaN (got ${JSON.stringify(value)})`);
      const text = ['running_state', 'battery_charging_state', 'active_faults'].includes(cap);
      t.ok(typeof value === 'number' || (text && (typeof value === 'string' || value === null)), `${driverId}.${cap} is numeric (or a status text)`);
      mapped += 1;
    }
    t.ok(mapped > 0, `${driverId} mapped at least one capability from ${sn}`);
  }

  // an absent field stays undefined, a genuine zero is reported
  const { inverter } = pointMap.inverterMap;
  t.eq(inverter.measure_power({}), undefined, 'measure_power is undefined when nothing reported it');
  t.eq(inverter.measure_power({ pvPower: 0 }), 0, 'measure_power still reports a genuine zero');
  t.eq(inverter.measure_power({ pvPower: 2 }), 2000, 'measure_power converts kW to W');

  // Capabilities taken over from com.solarwatt.
  const { battery } = pointMap.batteryMap;
  t.eq(battery.battery_charging_state({ batChargePower: 1.2, batDischargePower: 0 }), 'charging', 'charging above the idle band');
  t.eq(battery.battery_charging_state({ batChargePower: 0, batDischargePower: 0.5 }), 'discharging', 'discharging below the idle band');
  t.eq(battery.battery_charging_state({ batChargePower: 0.005, batDischargePower: 0 }), 'idle', 'idle within 10 W');
  t.eq(battery.battery_charging_state({}), undefined, 'no state without battery power');
  t.eq(inverter.active_faults({ faultTexts: [] }), null, 'no active fault clears the tile');
  t.eq(inverter.active_faults({ faultTexts: ['Grid lost', 'Fault 7'] }), 'Grid lost, Fault 7', 'active faults joined');
  t.eq(inverter.active_faults({}), undefined, 'faults not reported, tile untouched');
  t.ok(pointMap.seenInPayload('inverter', { currentFault: '', faultTexts: [] }).active_faults, 'a fault-free report adds the tile');
  t.eq(inverter.measure_reactive_power({ ReactivePower: -0.3 }), -300, 'reactive power kVar -> var');
  t.eq(inverter.measure_apparent_power({ generationPower: 0.4, ReactivePower: 0.3 }), 500, 'apparent power from P and Q');
  t.eq(inverter.measure_apparent_power({ generationPower: 0.4 }), undefined, 'no apparent power without Q');
  const { meter } = pointMap.meterMap;
  t.eq(meter['meter_power.load']({ loads: 1234.5 }), 1234.5, 'load total passes through');
  t.eq(meter['meter_power.load_today']({ loadsToday: 0 }), 0, 'load today keeps a genuine zero');
  t.ok(pointMap.seenInPayload('meter', { loads: 1234.5, loadsToday: 0 })['meter_power.load_today'], 'load today shows from midnight on');

  // Heat pump: enum + setpoints, no telemetry (that is Kafka-only).
  const hp = pointMap.heatpumpMap.heatpump;
  t.eq(hp.thermostat_mode({ workMode: 2 }), 'heat', 'workMode 2 maps to heat');
  t.eq(hp.thermostat_mode({ workMode: 4 }), 'off', 'workMode 4 maps to off');
  t.eq(hp.thermostat_mode({}), undefined, 'missing workMode maps to undefined');
  t.eq(hp['target_temperature.dhw']({ dhwTemp: 52.5 }), 52.5, 'dhw target passes through');
};
