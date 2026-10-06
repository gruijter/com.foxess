'use strict';

/*
Incomplete payloads.

Two ways a mapper used to invent a number:

1. A `datas` entry can arrive with no `value` key at all. A shipping third-party client
   (SoftXperience/home-assistant-foxess-api) guards for exactly that, so it happens in the field.
   `Number(x || 0)` turned the gap into "0 W" or "0% state of charge" - a plausible-looking
   reading that is simply untrue.
2. The same `||` chains mis-read a genuine zero. With `data.pvPower || data.generationPower`, an
   inverter honestly reporting 0 kW at night fell through and published a different field's value.

Both are silent in Homey: a wrong number looks exactly like a right one.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const pointMap = fixtures.app('lib/foxEssPointMap.js');
  const maps = {
    'inverter.inverter': pointMap.inverterMap.inverter,
    'battery.inverter': pointMap.batteryMap.inverter,
    'battery.battery': pointMap.batteryMap.battery,
    'meter.inverter': pointMap.meterMap.inverter,
    'meter.meter': pointMap.meterMap.meter,
  };

  // 1. nothing reported -> nothing published
  for (const [name, map] of Object.entries(maps)) {
    for (const [cap, fn] of Object.entries(map)) {
      t.eq(fn({}), undefined, `${name}.${cap} is undefined on an empty payload`);
    }
  }

  // ... including through the real poll path, on the fixture that mirrors the reference client
  const client = fixtures.makeClient({ post: async () => fixtures.get('deviceRealQueryPartial') });
  const flat = await fixtures.makeDriver('battery').pollDeviceType({
    client, deviceSn: fixtures.get('deviceRealQueryPartial').result[0].deviceSN, variables: [],
  });
  t.ok(!('batChargePower' in flat) || flat.batChargePower === undefined, 'a value-less entry does not become a number');
  for (const [cap, fn] of Object.entries(maps['battery.inverter'])) {
    t.eq(fn(flat), undefined, `battery.${cap} stays empty when the inverter sent no value`);
  }

  // 2. a genuine zero is published, and must not fall through to another field
  t.eq(maps['inverter.inverter'].measure_power({ pvPower: 0, generationPower: 5 }), 0,
    'pvPower 0 wins over generationPower instead of falling through');
  t.eq(maps['battery.inverter'].measure_battery({ SoC: 0 }), 0, 'a genuine 0% state of charge is reported');
  t.eq(maps['battery.inverter']['meter_power.discharged']({ dischargeEnergyToTal: 0, totalDischargeKW: 99 }), 0,
    'a genuine 0 kWh discharged wins over the legacy alias');
  t.eq(maps['meter.inverter'].measure_frequency({ RFreq: 0, SFreq: 50 }), 0, 'RFreq 0 does not fall through to SFreq');

  // 3. one side of a pair is enough for a meaningful reading
  t.eq(maps['battery.inverter'].measure_power({ batChargePower: 1.2 }), 1200, 'charging with no discharge field still reads');
  t.eq(maps['battery.inverter'].measure_power({ batDischargePower: 0.8 }), -800, 'discharging with no charge field still reads');
  t.eq(maps['meter.inverter'].measure_power({ feedinPower: 2 }), -2000, 'export with no import field still reads');
  // meterPower is already net (positive on import): only a fallback, never one side of import - export
  t.eq(maps['meter.inverter'].measure_power({ meterPower: -0.588, feedinPower: 0.588 }), -588, 'export with meterPower is not counted twice');
  t.eq(maps['meter.inverter'].measure_power({ meterPower: 0.4 }), 400, 'meterPower alone reads as the net grid power');

  // 4. a complete payload is unaffected by any of this
  const full = fixtures.get('deviceRealQuery').result[0];
  const values = Object.fromEntries(full.datas.map((d) => [d.variable, d.value]));
  for (const [name, map] of Object.entries(maps)) {
    for (const [cap, fn] of Object.entries(map)) {
      const v = fn(values);
      if (v === undefined) continue;
      if (cap === 'battery_charging_state') {
        t.ok(['charging', 'discharging', 'idle'].includes(v), `${name}.${cap} still maps cleanly from a full payload`);
        continue;
      }
      t.ok(typeof v === 'number' && !Number.isNaN(v), `${name}.${cap} still maps cleanly from a full payload`);
    }
  }
};
