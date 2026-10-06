'use strict';

/*
Device discovery per driver (inverter: every entry; battery: hasBattery; meter: meter variables
in the real-time payload) and plant ownership by stationID.
*/

const fixtures = require('../fixtures');

const listFor = (id, client) => fixtures.makeDriver(id).onPairListDevices({ client });

module.exports = async (t) => {
  const pointMap = fixtures.app('lib/foxEssPointMap.js');
  const client = fixtures.makeRoutedClient();
  const allDevices = fixtures.get('deviceList').result.data;

  // --- inverter: one device per physical unit, no virtual plant device ---
  const inv = await listFor('inverter', client);
  t.eq(inv.length, allDevices.length, 'inverter driver offers one device per inverter in device/list');
  t.ok(inv.every((d) => d.settings.deviceType !== 'plant'), 'no virtual plant device is offered');
  t.ok(inv.every((d) => !String(d.data.id).startsWith('plant-')), 'every device id is a physical unit');

  for (const dev of inv) {
    const source = allDevices.find((x) => x.deviceSN === dev.settings.deviceSn);
    if (!source || !source.stationID) continue;
    t.eq(dev.settings.plantId, String(source.stationID), `${dev.settings.deviceSn} attached to its own plant`);
  }
  const serials = inv.map((d) => d.settings.deviceSn);
  t.eq(new Set(serials).size, serials.length, 'no device was attached to more than one plant');

  // A rebadged inverter (vendor model in deviceType) is still offered on its own merits.
  const rebadged = allDevices.find((d) => /vsn/i.test(d.deviceType || ''));
  if (rebadged) {
    t.ok(inv.some((d) => d.settings.deviceSn === rebadged.deviceSN), `rebadged ${rebadged.deviceType} was offered as an inverter`);
  }

  // --- battery: only inverters that report a battery ---
  const bat = await listFor('battery', client);
  const expectBattery = allDevices.filter((d) => d.hasBattery).map((d) => d.deviceSN).sort();
  t.eq(bat.map((d) => d.settings.deviceSn).sort().join(','), expectBattery.join(','),
    'battery driver offers exactly the inverters with hasBattery');
  if (allDevices.some((d) => !d.hasBattery)) {
    t.ok(bat.length < allDevices.length, 'an inverter without a battery is not offered as a battery');
  }

  // --- meter: only inverters whose real-time payload carries grid-meter variables ---
  const meter = await listFor('meter', client);
  const meterVars = new Set(pointMap.meterDetectVariables);
  const real = fixtures.get('deviceRealQuery').result || [];
  const expectMeter = real
    .filter((dev) => (dev.datas || []).some((x) => meterVars.has(x.variable) && x.value !== undefined && x.value !== null))
    .map((dev) => dev.deviceSN)
    .filter((sn) => allDevices.some((d) => d.deviceSN === sn))
    .sort();
  t.eq(meter.map((d) => d.settings.deviceSn).sort().join(','), expectMeter.join(','),
    'meter driver offers exactly the inverters that report grid-meter variables');
  const noMeter = real.find((dev) => !(dev.datas || []).some((x) => meterVars.has(x.variable)));
  if (noMeter) {
    t.ok(!meter.some((d) => d.settings.deviceSn === noMeter.deviceSN), 'an inverter reporting no meter variables is not offered as a meter');
  }

  // the inverter's own grid side (document section "Grid") is no evidence of a meter
  ['RFreq', 'RVolt', 'SVolt', 'TVolt'].forEach((v) => t.ok(!meterVars.has(v), `${v} does not prove a meter`));
};
