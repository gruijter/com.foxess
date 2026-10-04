'use strict';

/*
The heat pump as the OpenAPI document describes it (never tested live - no heat pump on a test
account):

- heat/register registers a heat pump by the serial of its outdoor unit;
- register/heat/list (`sn` required) lists it with a registerStatus - pending, approved or revoked,
  the values of register/status/change - and the moduleSN of its gateway;
- dhwControls / heatingControls are addressed by that moduleSn.

Pairing registers an entered serial unless it is already listed, offers approved and pending heat
pumps (not revoked ones), and a poll only reads the controls of an approved heat pump.
*/

const fixtures = require('../fixtures');

const LIST = '/op/v0/register/heat/list';
const REGISTER = '/op/v0/heat/register';

const entry = (heatSN, registerStatus, moduleSN = `MOD-${heatSN}`) => ({
  heatSN, moduleSN, registerStatus, runningStatus: 1, masterVersion: '1.0', deviceType: 'Heat Pump',
});
const listOf = (...data) => ({
  errno: 0,
  result: {
    currentPage: 1, pageSize: 100, total: data.length, data,
  },
});

const pairSession = () => {
  const handlers = {};
  return {
    handlers,
    setHandler(name, fn) {
      handlers[name] = fn; return this;
    },
  };
};

module.exports = async (t) => {
  const makeDriver = () => {
    const driver = fixtures.makeDriver('heatpump', { own: true });
    driver.homey = { __: (key) => key };
    return driver;
  };

  // --- pairing: registration ---
  {
    const driver = makeDriver();
    const client = fixtures.makeRoutedClient({ [LIST]: listOf(entry('HP-OLD', 'approved')) });
    const session = pairSession();
    driver.onPairHandlers(session, () => client);

    const fresh = await session.handlers.register_heatpump({ sn: ' HP-NEW ' });
    const registered = client.calls.filter((c) => c.path === REGISTER);
    t.eq(registered.length, 1, 'an unlisted serial is registered');
    t.eq(registered[0]?.body.sn, 'HP-NEW', 'by the trimmed outdoor unit serial');
    t.eq(fresh.status, 'pending', 'a new registration starts out pending');

    client.calls.length = 0;
    const known = await session.handlers.register_heatpump({ sn: 'HP-OLD' });
    t.eq(client.calls.filter((c) => c.path === REGISTER).length, 0, 'a listed serial is not registered again');
    t.eq(known.status, 'approved', 'its own status is reported');

    client.calls.length = 0;
    const skipped = await session.handlers.register_heatpump({ sn: '' });
    t.eq(client.calls.length, 0, 'an empty serial calls nothing');
    t.eq(skipped.registered, false, 'and registers nothing');

    let refused = null;
    try {
      const noClient = pairSession();
      driver.onPairHandlers(noClient, () => null);
      await noClient.handlers.register_heatpump({ sn: 'HP-1' });
    } catch (error) {
      refused = error;
    }
    t.ok(refused, 'registration needs an accepted API key first');
  }

  // --- pairing: the device list ---
  {
    const driver = makeDriver();
    const client = fixtures.makeRoutedClient({
      [LIST]: ({ body }) => (JSON.parse(body).sn === 'HP-NEW'
        ? listOf(entry('HP-NEW', 'pending', ''))
        : listOf(entry('HP-A', 'approved'), entry('HP-R', 'revoked'))),
    });
    const session = pairSession();
    driver.onPairHandlers(session, () => client);
    driver.pairHeatSn = 'HP-NEW';
    const devices = await driver.onPairListDevices({ client });
    const ids = devices.map((d) => d.data.id).sort().join(',');
    t.eq(ids, 'HP-A,HP-NEW', 'approved and pending heat pumps are offered, revoked ones not');
    t.ok(client.calls.filter((c) => c.path === LIST).every((c) => typeof c.body.sn === 'string'), 'every list call carries the required sn');
    const pending = devices.find((d) => d.data.id === 'HP-NEW');
    t.eq(pending.settings.registerStatus, 'pending', 'the registration shows on the settings page');
    t.eq(pending.settings.moduleSn, '', 'a pending heat pump may have no module yet');
    t.eq(devices.find((d) => d.data.id === 'HP-A').settings.moduleSn, 'MOD-HP-A', 'an approved one has its module');
  }

  // --- polling ---
  {
    const driver = makeDriver();
    const client = fixtures.makeRoutedClient({ [LIST]: listOf(entry('HP-A', 'approved'), entry('HP-P', 'pending', '')) });

    const pending = await driver.pollHeatPump({ client, heatSn: 'HP-P', moduleSn: '' });
    t.eq(pending.registerStatus, 'pending', 'a pending heat pump reports its registration');
    t.eq(client.calls.filter((c) => /heatingControls|dhwControls/.test(c.path)).length, 0, 'and its controls are not read');

    const approved = await driver.pollHeatPump({ client, heatSn: 'HP-A', moduleSn: '' });
    const controls = client.calls.filter((c) => /Controls\/get$/.test(c.path));
    t.eq(controls.length, 2, 'an approved heat pump has both controls read');
    t.ok(controls.every((c) => c.query.moduleSn === 'MOD-HP-A'), 'by the module from the register list');
    t.eq(approved.moduleSn, 'MOD-HP-A', 'which the device then stores');
    const expected = fixtures.get('heatHeatingControls').result.workMode;
    t.eq(approved.workMode, expected, 'the heating work mode comes through');
    t.eq(client.calls.filter((c) => c.path === LIST).length, 1, 'the register list is shared by both polls');

    let missing = null;
    await driver.pollHeatPump({ client, heatSn: 'HP-GONE', moduleSn: '' }).catch((error) => {
      missing = error;
    });
    t.ok(missing, 'a heat pump no longer in the register list is an error');
  }

  // --- the device: not approved means unavailable ---
  {
    const Device = fixtures.app('drivers/heatpump/device.js');
    const device = Object.create(Device.prototype);
    const state = { unavailable: null, settings: { heatSn: 'HP-P', moduleSn: '' }, superCalled: false };
    device.homey = { __: (key) => key };
    device.log = () => {};
    device.error = () => {};
    device.getSettings = () => state.settings;
    device.setChangedSettings = async (values) => Object.assign(state.settings, values);
    device.setUnavailable = async (msg) => {
      state.unavailable = msg;
    };
    await device.handleData({ registerStatus: 'pending', moduleSn: '' });
    t.eq(state.unavailable, 'errors.heatpumpPending', 'a pending heat pump is unavailable, with the reason');
    await device.handleData({ registerStatus: 'revoked', moduleSn: '' });
    t.eq(state.unavailable, 'errors.heatpumpRevoked', 'a revoked one says so');
    await device.handleData({ registerStatus: 'pending', moduleSn: 'MOD-NEW' });
    t.eq(state.settings.moduleSn, 'MOD-NEW', 'a module reported later is stored');
    t.eq(device.moduleSn, 'MOD-NEW', 'and used for the controls');
  }
};
