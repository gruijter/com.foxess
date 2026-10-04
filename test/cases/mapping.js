'use strict';

/*
Every driver's capability map, run over the fixture's real-time payload.

The failure this protects against is silent: a FoxESS variable that changes name turns a mapper
into NaN or undefined, and Homey renders that as an empty tile rather than an error. With real
captures in place it also catches the API drifting away from the document.
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

    // A real capture only carries the variables the drivers paired at capture time asked for, so
    // an inverter-only account yields no battery or meter variables at all. That is a fixture the
    // case genuinely cannot exercise - skip it rather than fail. A capture that DOES carry the
    // driver's variables still has to map at least one, so a rename is still caught.
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
      t.ok(typeof value === 'number' || (cap === 'running_state' && typeof value === 'string'), `${driverId}.${cap} is numeric (or the status enum)`);
      mapped += 1;
    }
    t.ok(mapped > 0, `${driverId} mapped at least one capability from ${sn}`);
  }

  // A mapper must never invent a zero: an absent field stays undefined so setCapability() skips
  // it, while a genuine zero is still reported.
  const { inverter } = pointMap.inverterMap;
  t.eq(inverter.measure_power({}), undefined, 'measure_power is undefined when nothing reported it');
  t.eq(inverter.measure_power({ pvPower: 0 }), 0, 'measure_power still reports a genuine zero');
  t.eq(inverter.measure_power({ pvPower: 2 }), 2000, 'measure_power converts kW to W');

  // Heat pump: enum + setpoints, no telemetry (that is Kafka-only).
  const hp = pointMap.heatpumpMap.heatpump;
  t.eq(hp.thermostat_mode({ workMode: 2 }), 'heat', 'workMode 2 maps to heat');
  t.eq(hp.thermostat_mode({ workMode: 4 }), 'off', 'workMode 4 maps to off');
  t.eq(hp.thermostat_mode({}), undefined, 'missing workMode maps to undefined');
  t.eq(hp['target_temperature.dhw']({ dhwTemp: 52.5 }), 52.5, 'dhw target passes through');
};
