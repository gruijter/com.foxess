'use strict';

/*
Capability migration (lib/DeviceMigrator.js) and the capability lists it is driven by.

Two promises are checked. First, the base capabilities in foxEssPointMap are exactly what each
driver.compose.json declares, in the same order - otherwise every existing device would be
migrated (capabilities removed and re-added, flows broken) on the next app start. Second, adding an
optional capability only ever appends: the capabilities a user already has are left alone.
*/

const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../fixtures');

const APP = path.join(__dirname, '..', '..');

// A device with just enough of the Homey API for the migrator.
const fakeDevice = (caps, values = {}) => {
  const list = [...caps];
  const state = { ...values };
  const calls = [];
  return {
    calls,
    homey: { __: (key) => key },
    getName: () => 'test device',
    log: () => {},
    error: () => {},
    getAvailable: () => true,
    setAvailable: async () => calls.push('available'),
    setUnavailable: async () => calls.push('unavailable'),
    getCapabilities: () => [...list],
    hasCapability: (cap) => list.includes(cap),
    getCapabilityValue: (cap) => (cap in state ? state[cap] : null),
    removeCapability: async (cap) => {
      calls.push(`-${cap}`);
      list.splice(list.indexOf(cap), 1);
      delete state[cap];
    },
    addCapability: async (cap) => {
      calls.push(`+${cap}`);
      list.push(cap);
    },
    setCapabilityValue: async (cap, value) => {
      state[cap] = value;
    },
    list,
    state,
  };
};

module.exports = async (t) => {
  const pointMap = fixtures.app('lib/foxEssPointMap.js');
  const { migrateCapabilities } = fixtures.app('lib/DeviceMigrator.js');
  const opts = { settleMs: 0 };

  // --- base capabilities match the compose files, in order ---
  for (const driverId of ['inverter', 'battery', 'meter', 'heatpump']) {
    const compose = JSON.parse(fs.readFileSync(path.join(APP, 'drivers', driverId, 'driver.compose.json'), 'utf8'));
    t.eq(pointMap.baseCapabilities(driverId).join(','), compose.capabilities.join(','),
      `${driverId}: base capabilities equal driver.compose.json, in order`);
    // an optional capability is titled either per driver, or by its own custom capability file
    const titled = compose.capabilitiesOptions || {};
    const customTitle = (cap) => {
      const file = path.join(APP, '.homeycompose', 'capabilities', `${cap}.json`);
      return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).title?.en;
    };
    // (a Homey system capability such as alarm_problem brings its own title)
    const systemCap = (cap) => !cap.includes('.') && !customTitle(cap) && /^(alarm|measure|meter)_/.test(cap);
    for (const cap of pointMap.optionalCapabilities(driverId)) {
      t.ok(titled[cap]?.title?.en || customTitle(cap) || systemCap(cap), `${driverId}.${cap} has a title`);
    }
    const variables = new Set(pointMap.pointList(driverId));
    t.eq(variables.size, pointMap.pointList(driverId).length, `${driverId}: no variable requested twice`);
  }

  // --- the tile order covers every capability a device of the driver can get ---
  for (const driverId of ['inverter', 'battery', 'meter']) {
    const order = pointMap.capabilityOrder(driverId);
    const driver = fixtures.makeDriver(driverId, { own: true });
    const all = [...pointMap.baseCapabilities(driverId), ...pointMap.optionalCapabilities(driverId),
      ...driver.extraCapabilities({
        controlSupported: true, socLimitsSupported: true, exportLimitSupported: true,
      })];
    t.eq(all.filter((cap) => !order.includes(cap)).join(','), '', `${driverId}: every capability has a place in the tile order`);
    t.eq(new Set(order).size, order.length, `${driverId}: no capability twice in the tile order`);
  }

  // --- a device that is already right is not touched ---
  const inverterBase = pointMap.baseCapabilities('inverter');
  const same = fakeDevice(inverterBase);
  t.eq(await migrateCapabilities(same, inverterBase, opts), false, 'a correct device is left alone');
  t.eq(same.calls.length, 0, 'no capability calls, no unavailable flip');

  // --- appending an optional capability keeps the existing ones ---
  const grown = fakeDevice(inverterBase, { measure_power: 1200 });
  const wanted = pointMap.deviceCapabilities('inverter', { 'measure_power.pv1': true, 'measure_power.1': true });
  t.eq(await migrateCapabilities(grown, wanted, opts), true, 'a new optional capability migrates');
  t.eq(grown.list.join(','), wanted.join(','), 'the list ends up as wanted');
  t.ok(!grown.calls.some((c) => c.startsWith('-')), 'nothing was removed to append');
  t.eq(grown.state.measure_power, 1200, 'the existing value is untouched');
  t.eq(grown.calls[0], 'unavailable', 'the device is marked migrating first');
  t.eq(grown.calls[grown.calls.length - 1], 'available', 'and made available again afterwards');

  // --- wrong order is repaired from the first mismatch, values restored ---
  const shuffled = fakeDevice(['measure_power', 'meter_power.today', 'meter_power', 'measure_temperature', 'obsolete'],
    { 'meter_power.today': 3.6, meter_power: 52.6, measure_temperature: 35 });
  await migrateCapabilities(shuffled, inverterBase, opts);
  t.eq(shuffled.list.join(','), inverterBase.join(','), 'order repaired and the obsolete capability removed');
  t.ok(!shuffled.calls.includes('-measure_power'), 'the capability before the first mismatch was kept');
  t.eq(shuffled.state['meter_power.today'], 3.6, 'a re-added capability gets its value back');
  t.eq(shuffled.state.meter_power, 52.6, 'every re-added capability gets its value back');

  // --- two migrations at once run one after the other ---
  const busy = fakeDevice(inverterBase);
  const a = pointMap.deviceCapabilities('inverter', { 'measure_power.pv1': true });
  const b = pointMap.deviceCapabilities('inverter', { 'measure_power.pv1': true, 'measure_power.pv2': true });
  await Promise.all([migrateCapabilities(busy, a, opts), migrateCapabilities(busy, b, opts)]);
  t.eq(busy.list.join(','), b.join(','), 'concurrent migrations end on the last requested list');

  // --- evidence: a zero or an absent variable adds nothing ---
  t.eq(Object.keys(pointMap.seenInPayload('inverter', { pv3Power: 0, pv3Volt: 0 })).length, 0,
    'an unconnected string (all zeros) adds no capability');
  const seen = pointMap.seenInPayload('inverter', { pv1Power: 1.1, pv1Volt: 402, RCurrent: 1.6 });
  t.ok(seen['measure_power.pv1'] && seen['measure_voltage.pv1'] && seen['measure_current.1'], 'reported values count as evidence');
  t.eq(pointMap.inverterMap.inverter['measure_power.pv1']({ pv1Power: 1.1 }), 1100, 'PV string power converts kW to W');
  // runningState: every code in the document's appendix has a value in the capability, and an
  // unlisted code is kept as 'unknown' rather than dropped
  const statusCap = JSON.parse(fs.readFileSync(path.join(APP, '.homeycompose', 'capabilities', 'running_state.json'), 'utf8'));
  const enumIds = new Set(statusCap.values.map((v) => v.id));
  const state = pointMap.inverterMap.inverter.running_state;
  for (const [code, id] of Object.entries(pointMap.RUNNING_STATES)) {
    t.eq(state({ runningState: Number(code) }), id, `runningState ${code} maps to ${id}`);
    t.ok(enumIds.has(id), `running_state enum has a value for ${id}`);
  }
  t.eq(state({ runningState: 999 }), 'unknown', 'an unlisted runningState is unknown');
  t.ok(enumIds.has('unknown'), "running_state enum has 'unknown'");
  t.eq(state({}), undefined, 'no runningState, no status');
  const today = pointMap.inverterMap.inverter['meter_power.today'];
  t.eq(today({ hasBattery: false, acToday: 8.5, pvToday: 9 }), 8.5, 'energy today without a battery: the AC solar yield');
  t.eq(today({ hasBattery: true, acToday: 8.5, pvToday: 9 }), 9, 'with a battery: the DC side');
  t.eq(today({ todayYield: 3 }), 3, 'todayYield as the DC fallback');
  t.eq(today({ pvToday: 3.8000000000000114 }), 3.8, 'float noise from the report is rounded away (seen live)');
  t.eq(pointMap.inverterMap.inverter['meter_power.month']({ pvMonth: 73.2 }), 73.2, 'energy this month from the report');

  const ext = pointMap.inverterMap.inverter['measure_power.external'];
  t.eq(ext({ meterPower2: -1.2 }), 1200, 'meter 2 generation (negative) shows as positive external generation');
  t.eq(ext({ meterPower2: 0 }), 0, 'meter 2 at 0 stays a plain 0, not -0');
  t.eq(ext({}), undefined, 'no meter 2, no value');
  t.eq(Object.keys(pointMap.seenInPayload('inverter', { meterPower2: 0 })).length, 0, 'an inverter without CT2 (meterPower2 0) gets no meter 2 capability');

  t.eq(pointMap.batteryMap.battery.measure_current({ invBatCurrent: 2.5 }), -2.5,
    'battery current is negated: the API reports discharge positive, the device charge positive');

  // --- option sync: an equal title object is no change (=== rewrote it on every start) ---
  {
    const { syncCapabilityOptions } = fixtures.app('lib/DeviceMigrator.js');
    const options = {};
    let writes = 0;
    const dev = {
      driver: { manifest: { capabilitiesOptions: {} } },
      log: () => {},
      error: () => {},
      hasCapability: () => true,
      getCapabilityOptions: (cap) => {
        if (!options[cap]) throw Error(`Invalid Capability: ${cap}`);
        return options[cap];
      },
      setCapabilityOptions: async (cap, value) => {
        writes += 1;
        options[cap] = value;
      },
    };
    await syncCapabilityOptions(dev, { meter_power: { title: { en: 'Solar energy (DC)', nl: 'Zonopbrengst (DC)' } } });
    await syncCapabilityOptions(dev, { meter_power: { title: { nl: 'Zonopbrengst (DC)', en: 'Solar energy (DC)' } } });
    t.eq(writes, 1, 'a title equal to the stored one is not written again');
    await syncCapabilityOptions(dev, { meter_power: { title: { en: 'Solar energy (AC)', nl: 'Zonopbrengst (AC)' } } });
    t.eq(writes, 2, 'a different title is');
  }

  // --- meter phases 2 and 3 moved from base to optional (2026-10-04) ---
  t.ok(!pointMap.baseCapabilities('meter').includes('measure_voltage.2'), 'meter voltage 2 is no longer a base capability');
  const onePhase = pointMap.seenInPayload('meter', { RVolt: 231, SVolt: 0, TVolt: 0 });
  t.ok(!onePhase['measure_voltage.2'] && !onePhase['measure_voltage.3'], 'a single-phase payload gives no phase 2/3 voltage');
  const threePhase = pointMap.seenInPayload('meter', { RVolt: 231, SVolt: 230, TVolt: 229 });
  t.ok(threePhase['measure_voltage.2'] && threePhase['measure_voltage.3'], 'a three-phase payload adds both');

  // an existing device: what it already shows a value for is carried over, so nothing is removed
  const CommonDevice = fixtures.app('lib/common_device.js');
  const existing = (values) => {
    const dev = Object.assign(Object.create(CommonDevice.prototype), fakeDevice(Object.keys(values), values));
    const store = { seenCaps: {} };
    dev.driver = { id: 'meter' };
    dev.getStoreValue = (key) => store[key];
    dev.setStoreValue = async (key, value) => {
      store[key] = value;
    };
    return { dev, store };
  };
  const three = existing({ 'measure_voltage.2': 230.4, 'measure_voltage.3': 229.9 });
  await three.dev.carrySeenCaps();
  t.ok(three.store.seenCaps['measure_voltage.2'] && three.store.seenCaps['measure_voltage.3'], 'a three-phase meter keeps its phase 2/3 voltages');
  const single = existing({ 'measure_voltage.2': null, 'measure_voltage.3': 0 });
  await single.dev.carrySeenCaps();
  t.ok(!single.store.seenCaps['measure_voltage.2'] && !single.store.seenCaps['measure_voltage.3'], 'on a single-phase meter the empty tiles are not carried over');
  const keep = pointMap.deviceCapabilities('meter', three.store.seenCaps);
  t.ok(keep.includes('measure_voltage.2') && keep.indexOf('measure_voltage.2') < keep.indexOf('measure_frequency'),
    'a carried phase voltage stays in its tile position');
};
