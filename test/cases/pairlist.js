'use strict';

/*
A freshly paired device starts with its final capability list: the device's first start and first
poll must find nothing to add, so it is never migrated (capabilities removed and re-added) right
after pairing. Pairing therefore works the list out the same way the device does - real-time
evidence, the device status and the yield that pollExtra adds, and the driver's support checks.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const pointMap = fixtures.app('lib/foxEssPointMap.js');
  const client = fixtures.makeRoutedClient({
    '/op/v1/device/scheduler/get/flag': { errno: 0, result: { support: true, enable: false } },
    '/op/v0/device/battery/soc/get': { errno: 0, result: { minSoc: 10, minSocOnGrid: 10 } },
    '/op/v0/device/setting/get': { errno: 0, result: { value: '17000' } },
    // the energy report of this month: PV and AC per day (today is whichever day it is)
    '/op/v0/device/report/query': {
      errno: 0,
      result: [
        { variable: 'PVEnergyTotal', unit: 'kWh', values: Array(31).fill(3.2) },
        { variable: 'generation', unit: 'kWh', values: Array(31).fill(2.5) },
      ],
    },
  });
  const listing = fixtures.get('deviceList').result.data;
  const real = new Map((fixtures.get('deviceRealQuery').result || []).map((dev) => [dev.deviceSN,
    Object.fromEntries((dev.datas || []).map((d) => [d.variable, d.value]))]));

  for (const id of ['inverter', 'battery', 'meter']) {
    const driver = fixtures.makeDriver(id, { own: true });
    const paired = await driver.onPairListDevices({ client });
    for (const dev of paired) {
      const sn = dev.settings.deviceSn;
      // what the device itself would conclude at start and after its first poll
      const entry = listing.find((d) => d.deviceSN === sn) || {};
      const poll = {
        ...real.get(sn),
        deviceStatus: Number(entry.status),
        ...(typeof entry.hasBattery === 'boolean' ? { hasBattery: entry.hasBattery } : {}),
        pvToday: 3.2,
        pvMonth: 41.5,
        acToday: 2.5,
        acMonth: 38,
      };
      const seen = { ...dev.store.seenCaps, ...pointMap.seenInPayload(id, poll) };
      const wanted = pointMap.deviceCapabilities(id, seen, driver.extraCapabilities(dev.store));
      t.eq(dev.capabilities.join(','), wanted.join(','), `${id} ${sn}: paired list is the final list, no migration`);
    }
    if (!paired.length) t.skip(`${id}: no device in this fixture`);
  }

  // values that are legitimately zero on hardware that has them still count as evidence
  const seenBat = (data) => Boolean(pointMap.seenInPayload('battery', data).measure_current);
  t.ok(seenBat({ invBatCurrent: 0, batVolt: 380 }), 'an idle battery (0 A) with a voltage shows its current');
  t.ok(!seenBat({ invBatCurrent: 0 }), 'a current without a battery voltage does not');
  t.ok(!seenBat({ batVolt: 380 }), 'a voltage without a reported current does not');
  t.ok(pointMap.seenInPayload('inverter', { pvToday: 0, pvMonth: 0 })['meter_power.month'],
    'a reported month yield counts on the first of the month too (0 kWh)');
  t.ok(!pointMap.seenInPayload('inverter', {})['meter_power.month'], 'no energy report, no month');

  // the extras themselves come from the support checks
  const [bat] = await fixtures.makeDriver('battery', { own: true }).onPairListDevices({ client });
  if (bat) {
    t.ok(['target_power', 'target_power_mode', 'battery_min_soc', 'battery_min_soc_ongrid', 'alarm_generic.control']
      .every((cap) => bat.capabilities.includes(cap)), 'battery: control and SoC limits at pairing');
    t.ok(bat.store.controlSupported && bat.store.socLimitsSupported, 'battery: support facts stored');
  }
  const [inv] = await fixtures.makeDriver('inverter', { own: true }).onPairListDevices({ client });
  if (inv) {
    t.ok(inv.capabilities.includes('export_limit') && inv.store.exportLimitSupported, 'inverter: export limit at pairing');
    t.ok(inv.capabilities.includes('meter_power.month'), 'inverter: month yield at pairing');
    t.ok(inv.capabilities.includes('alarm_connectivity'), 'inverter: device status at pairing');
  }
};
