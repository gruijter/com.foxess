'use strict';

/*
The device information on the settings page (lib/foxEssDeviceInfo.js), from device/detail.
Model was empty on every device: pairing never filled deviceModelCode.
*/

const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../fixtures');

module.exports = async (t) => {
  const { deviceInfoSettings } = fixtures.app('lib/foxEssDeviceInfo.js');
  const detail = {
    deviceType: 'P3-10.0-SH',
    productType: 'H3-G2',
    masterVersion: '1.49',
    slaveVersion: '1.00',
    managerVersion: '1.31',
    capacity: 10,
    batteryDesignCapacity: 23.04,
    batteryList: [
      {
        batterySN: 'BAT1', model: 'EP12', type: 'bcu', version: '1.013',
      },
      {
        batterySN: 'BAT1', model: 'EP12', type: 'bmu', version: '1.13', capacity: 11520,
      },
      {
        batterySN: 'BAT2', model: 'EP12', type: 'bmu', version: '1.13', capacity: 11520,
      },
      {
        batterySN: 'BAT1', model: 'EP12', type: 'ivu', version: '0.00',
      },
    ],
  };
  const inv = deviceInfoSettings('inverter', detail);
  t.eq(inv.deviceModelCode, 'P3-10.0-SH (H3-G2)', 'inverter model with its series');
  t.eq(inv.firmware, 'master 1.49, slave 1.00, manager 1.31', 'inverter firmware in FoxCloud terms');
  t.eq(inv.ratedPower, '10 kW', 'rated power');
  const bat = deviceInfoSettings('battery', detail);
  t.eq(bat.deviceModelCode, 'EP12', 'battery model from its modules');
  t.eq(bat.firmware, 'BMS 1.013', 'battery firmware is the BCU version');
  t.eq(bat.batteryModules, '2', 'one module per BMU');
  t.eq(bat.batteryModuleList, 'BAT1 EP12 (v1.13), BAT2 EP12 (v1.13)', 'modules with model and version');
  t.eq(bat.batteryDesignEnergy, '23.04 kWh', 'design capacity');
  t.eq(Object.keys(deviceInfoSettings('meter', detail)).length, 0, 'a meter shows nothing from the detail');
  t.eq(deviceInfoSettings('inverter', { deviceType: 'H1-5.0' }).firmware, '', 'missing versions leave the label empty');

  // every value lands in a setting the driver actually declares
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'app.json'), 'utf8'));
  for (const [id, values] of [['inverter', inv], ['battery', bat]]) {
    const ids = new Set();
    const walk = (list) => list.forEach((s) => (s.children ? walk(s.children) : ids.add(s.id)));
    walk(app.drivers.find((d) => d.id === id).settings || []);
    t.eq(Object.keys(values).filter((k) => !ids.has(k)).join(','), '', `${id}: every info value has a declared setting`);
  }

  // pairing fills them
  const [pairedInv] = await fixtures.makeDriver('inverter', { own: true }).onPairListDevices({ client: fixtures.makeRoutedClient() });
  if (pairedInv) t.ok(pairedInv.settings.deviceModelCode, `paired inverter has a model (${pairedInv.settings.deviceModelCode})`);
};
