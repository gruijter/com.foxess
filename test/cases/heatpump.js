'use strict';

/*
The heat pump driver, read-only (beta). Paths as answered live on De Brik (2026-10-04, no heat
pump on that account): heat/register/list (errno 0, empty), GET heat/<x>Controls?moduleSn=
(41930 for a module that is not a heat pump). The document's register/heat/list and
heat/<x>Controls/get are 404.

Pairing offers registered heat pumps (not revoked ones) and modules whose heating controls can be
read; it never registers or writes. A poll reads the controls whenever a module is known, and a
change from Homey is refused.
*/

const fixtures = require('../fixtures');

const LIST = '/op/v0/heat/register/list';
const MODULES = '/op/v0/module/list';
const HEATING = '/op/v0/heat/heatingControls';
const DHW = '/op/v0/heat/dhwControls';
const NOT_A_HEAT_PUMP = { errno: 41930, msg: 'Device does not exist or is already in use', result: null };

const entry = (heatSN, registerStatus, moduleSN = `MOD-${heatSN}`) => ({
  heatSN, moduleSN, registerStatus, runningStatus: 1, masterVersion: '1.0', deviceType: 'Heat Pump',
});
const listOf = (...data) => ({
  errno: 0,
  result: {
    currentPage: 1, pageSize: 100, total: data.length, data,
  },
});
const modulesOf = (...sns) => listOf(...sns.map((moduleSN) => ({ moduleSN, status: 1 })));
const isWrite = (call) => /\/set$|\/heat\/register$|status\/change$/.test(call.path);

module.exports = async (t) => {
  const makeDriver = () => {
    const driver = fixtures.makeDriver('heatpump', { own: true });
    driver.homey = { __: (key) => key };
    return driver;
  };

  // --- pairing ---
  {
    const driver = makeDriver();
    const client = fixtures.makeRoutedClient({
      [LIST]: listOf(entry('HP-A', 'approved'), entry('HP-P', 'pending', ''), entry('HP-R', 'revoked')),
      [MODULES]: modulesOf('INV-1', 'MOD-HP-A', 'MOD-X'),
      [HEATING]: ({ query }) => (['MOD-HP-A', 'MOD-X'].includes(query.moduleSn) ? fixtures.get('heatHeatingControls') : NOT_A_HEAT_PUMP),
    });
    const devices = await driver.onPairListDevices({ client });
    const ids = devices.map((d) => d.data.id).sort().join(',');
    t.eq(ids, 'HP-A,HP-P,MOD-X', 'registered (not revoked) heat pumps and readable modules are offered');
    t.eq(client.calls.filter(isWrite).length, 0, 'pairing writes nothing');
    t.eq(devices.find((d) => d.data.id === 'HP-A').settings.moduleSn, 'MOD-HP-A', 'a registered one has its module');
    t.eq(devices.find((d) => d.data.id === 'HP-P').settings.registerStatus, 'pending', 'the registration shows on the settings page');
    t.eq(devices.find((d) => d.data.id === 'MOD-X').settings.registerStatus, '', 'an unregistered readable module has no registration');
    t.ok(!devices.some((d) => d.data.id === 'INV-1'), 'a module that is not a heat pump is not offered');
  }
  {
    const driver = makeDriver();
    const client = fixtures.makeRoutedClient({
      [LIST]: { errno: 404, msg: 'Not Found' },
      [MODULES]: modulesOf('INV-1'),
      [HEATING]: NOT_A_HEAT_PUMP,
    });
    const devices = await driver.onPairListDevices({ client });
    t.eq(devices.length, 0, 'an account without a heat pump offers nothing, without throwing');
  }

  // --- polling ---
  {
    const driver = makeDriver();
    const client = fixtures.makeRoutedClient({ [LIST]: listOf(entry('HP-A', 'approved'), entry('HP-P', 'pending', '')) });

    const pending = await driver.pollHeatPump({ client, heatSn: 'HP-P', moduleSn: '' });
    t.eq(pending.registerStatus, 'pending', 'a pending heat pump reports its registration');
    t.eq(client.calls.filter((c) => /Controls$/.test(c.path)).length, 0, 'and without a module nothing more is read');

    const approved = await driver.pollHeatPump({ client, heatSn: 'HP-A', moduleSn: '' });
    const controls = client.calls.filter((c) => /Controls$/.test(c.path));
    t.eq(controls.length, 2, 'heating and DHW controls are read');
    t.ok(controls.every((c) => c.method === 'GET' && c.query.moduleSn === 'MOD-HP-A'), 'by GET, with the module from the register list');
    t.eq(approved.moduleSn, 'MOD-HP-A', 'which the device then stores');
    t.eq(approved.workMode, fixtures.get('heatHeatingControls').result.workMode, 'the heating work mode comes through');
    t.eq(approved.dhwTemp, fixtures.get('heatDhwControls').result.dhwTemp, 'and the DHW target');
    t.eq(client.calls.filter((c) => c.path === LIST).length, 1, 'the register list is shared by both polls');

    const unlisted = await driver.pollHeatPump({ client, heatSn: '', moduleSn: 'MOD-X' });
    t.eq(unlisted.registerStatus, undefined, 'a module paired without registration has no status');
    t.ok(unlisted.workMode !== undefined, 'and is still read');

    let failed = null;
    const broken = fixtures.makeRoutedClient({ [LIST]: listOf(), [HEATING]: NOT_A_HEAT_PUMP, [DHW]: NOT_A_HEAT_PUMP });
    await makeDriver().pollHeatPump({ client: broken, heatSn: '', moduleSn: 'MOD-X' }).catch((error) => {
      failed = error;
    });
    t.ok(failed, 'nothing readable and no registration to explain it is an error');
    t.eq(client.calls.filter(isWrite).length + broken.calls.filter(isWrite).length, 0, 'polling writes nothing');
  }

  // --- the device ---
  {
    const Device = fixtures.app('drivers/heatpump/device.js');
    const device = Object.create(Device.prototype);
    const state = {
      unavailable: null, settings: { heatSn: 'HP-P', moduleSn: '' }, listeners: {},
    };
    device.homey = { __: (key) => key };
    device.log = () => {};
    device.error = () => {};
    device.getName = () => 'HP';
    device.getSettings = () => state.settings;
    device.setChangedSettings = async (values) => Object.entries(values)
      .forEach(([key, value]) => {
        if (value !== undefined) state.settings[key] = value;
      });
    device.setUnavailable = async (msg) => {
      state.unavailable = msg;
    };
    await device.handleData({ registerStatus: 'pending' });
    t.eq(state.unavailable, 'errors.heatpumpPending', 'a pending heat pump with nothing read is unavailable, with the reason');
    await device.handleData({ registerStatus: 'revoked' });
    t.eq(state.unavailable, 'errors.heatpumpRevoked', 'a revoked one says so');
    await device.handleData({ registerStatus: 'pending', moduleSn: 'MOD-NEW' });
    t.eq(state.settings.moduleSn, 'MOD-NEW', 'a module reported later is stored');
    t.eq(device.moduleSn, 'MOD-NEW', 'and used for the controls');

    device.registerCapabilityListener = (cap, fn) => {
      state.listeners[cap] = fn;
    };
    device.registerListeners();
    t.eq(Object.keys(state.listeners).sort().join(','), 'onoff.dhw,target_temperature.dhw,thermostat_mode', 'every settable capability has a listener');
    for (const [cap, fn] of Object.entries(state.listeners)) {
      let refused = null;
      await fn(cap === 'thermostat_mode' ? 'off' : true).catch((error) => {
        refused = error;
      });
      t.eq(refused?.message, 'errors.heatpumpReadOnly', `${cap}: a change from Homey is refused`);
    }
  }
};
