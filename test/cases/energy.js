'use strict';

/*
The inverter shows its solar yield on the AC side, as com.growatt does; where only the DC side can
be shown, the capability's title says '(DC)'.

- Power: generationPower (AC output) + (charge - discharge) * n, capped at pvPower * n. Measured on
  De Brik 2026-10-04: generationPower equalled RPower+SPower+TPower and pvPower - charge + discharge
  to within 1 W, and went negative while the battery charged from the grid.
- Energy: no AC solar counter exists for an inverter with a battery (generation also counts
  battery discharge), so: no battery -> generation (AC), battery or unknown -> PVEnergyTotal (DC).
- Today and this month come from /op/v0/device/report/query (dimension month), PV and AC both,
  with /op/v0/device/generation standing in for the AC side when the report fails.
- The day is the plant's own: from the UTC offset of the latest snapshot, else Homey's zone.
*/

const fixtures = require('../fixtures');

const REPORT = '/op/v0/device/report/query';
const GENERATION = '/op/v0/device/generation';

const row = (variable, values) => ({ variable, unit: 'kWh', values });
// October: 10 kWh on the 1st-3rd, `today` on the 4th, nothing yet after that
const october = (today) => Array.from({ length: 31 }, (_, i) => {
  if (i < 3) return 10;
  return i === 3 ? today : 0;
});

module.exports = async (t) => {
  const { localDate } = fixtures.app('lib/foxEssTiming.js');
  const pointMap = fixtures.app('lib/foxEssPointMap.js');
  const inv = pointMap.inverterMap.inverter;

  // --- the plant's date ---
  const at = Date.UTC(2026, 9, 3, 22, 30); // 2026-10-03 22:30 UTC = 2026-10-04 00:30 CEST
  t.eq(JSON.stringify(localDate('2026-10-03 23:55:24 CEST+0200', 'UTC', at)), JSON.stringify({ year: 2026, month: 10, day: 4 }),
    'the offset of an older snapshot gives today in plant time, not the snapshot\'s day');
  t.eq(JSON.stringify(localDate(undefined, 'Europe/Amsterdam', at)), JSON.stringify({ year: 2026, month: 10, day: 4 }),
    'without a snapshot, the given time zone');
  t.eq(JSON.stringify(localDate(undefined, 'UTC', at)), JSON.stringify({ year: 2026, month: 10, day: 3 }), 'and UTC is UTC');
  t.eq(JSON.stringify(localDate('2026-12-31 23:58:00 EST-0500', 'UTC', Date.UTC(2027, 0, 1, 5, 1))), JSON.stringify({ year: 2027, month: 1, day: 1 }),
    'a negative offset across the new year');

  // --- AC-side solar power (live De Brik samples, kW) ---
  const power = (data) => inv.measure_power(data);
  t.eq(power({
    pvPower: 1.506, generationPower: 0.175, batChargePower: 1.331, batDischargePower: 0,
  }), 1506,
  'charging from the panels: AC output plus what went into the battery');
  t.eq(power({
    pvPower: 1.489, generationPower: 2.996, batChargePower: 0, batDischargePower: 1.506,
  }), 1489,
  'discharging: the battery\'s share is taken off the AC output');
  const gridCharge = power({
    pvPower: 0.366, generationPower: -2.414, batChargePower: 2.78, batDischargePower: 0,
  });
  t.ok(gridCharge >= 0 && gridCharge <= 366, `charging from the grid never shows more than the array delivers (${gridCharge} W)`);
  t.eq(power({ pvPower: 0, generationPower: -2, batChargePower: 2 }), 0, 'at night, grid charging is no solar');
  t.eq(power({ generationPower: 3.1 }), 3100, 'without a battery or PV reading: the AC output itself');
  t.eq(power({ pvPower: 2 }), 2000, 'without an AC output reading: the DC PV power');

  // --- which side each capability shows, and only that side ---
  const sides = pointMap.inverterSolarSides;
  t.eq(sides({ acPower: true }).measure_power, 'ac', 'power is AC once the inverter reports its AC output');
  t.eq(sides({ acPower: false }).measure_power, 'dc', 'else DC');
  t.eq(sides({ hasBattery: false }).meter_power, 'ac', 'no battery: generation is the AC solar yield');
  t.eq(sides({ hasBattery: true }).meter_power, 'dc', 'a battery: generation is no solar yield, so DC');
  t.eq(sides({}).meter_power, 'dc', 'an unknown battery counts as a battery');
  t.eq(sides({ hasBattery: false })['meter_power.month'], 'ac', 'today and the month follow the same rule');
  // re-decided per (re)start: a known fact decides, an unknown one keeps the stored side
  const storedAc = sides({ hasBattery: false, acPower: true });
  t.eq(sides({ hasBattery: true, acPower: true }, storedAc).meter_power, 'dc', 'a battery added later moves the energy to DC');
  t.eq(sides({}, storedAc).meter_power, 'ac', 'a battery flag missing this time keeps the stored side');
  t.eq(sides({ acPower: false }, storedAc).measure_power, 'ac', 'a payload without the AC output keeps AC power');
  t.eq(sides({ hasBattery: false }, sides({ hasBattery: true })).meter_power, 'ac', 'a battery removed moves it back to AC');
  // no real-time data says nothing about the AC output: power stays undecided, never fixed to DC
  const reported = pointMap.acPowerReported;
  t.eq(reported({}), undefined, 'an empty reading (result:null) does not tell');
  t.eq(reported({ deviceStatus: 1, pvToday: 3.8, hasBattery: true }), undefined, 'nor do fields from other endpoints');
  t.eq(reported({ pvPower: 1.2 }), false, 'real-time data without generationPower: no AC output');
  t.eq(reported({ pvPower: 0, generationPower: 0 }), true, 'a genuine 0 kW AC output counts');
  t.eq(sides({ acPower: undefined }).measure_power, undefined, 'no reading and no stored side: power undecided');
  t.eq(sides({ acPower: undefined }, storedAc).measure_power, 'ac', 'no reading keeps a stored side');
  const fixedAc = { solarSides: sides({ hasBattery: false, acPower: true }) };
  const fixedDc = { solarSides: sides({ hasBattery: true, acPower: true }) };
  t.eq(inv.meter_power({ ...fixedDc, generation: 220, PVEnergyTotal: 194 }), 194, 'a fixed DC side shows PVEnergyTotal');
  t.eq(inv.meter_power({ ...fixedDc, generation: 220 }), undefined, 'and a gap stays a gap - never the AC counter instead');
  t.eq(inv.meter_power({ ...fixedAc, PVEnergyTotal: 194 }), undefined, 'nor the other way round');
  t.eq(inv.measure_power({ ...fixedAc, pvPower: 1.2 }), undefined, 'a poll without the AC output leaves AC power alone');
  t.eq(inv['meter_power.month']({ ...fixedAc, acMonth: 28, pvMonth: 33 }), 28, 'the month shows the fixed side');

  // --- energyFields: PV and AC from one report, else the generation endpoint ---
  const driver = fixtures.makeDriver('inverter', { own: true });
  const snapshotTime = '2026-10-04 13:40:27 CEST+0200';
  const fields = async (routes) => {
    const client = fixtures.makeRoutedClient(routes);
    const result = await driver.energyFields({ client, deviceSn: 'SN', snapshotTime });
    return { result, client };
  };
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 9, 4, 11, 40);
  try {
    const both = await fields({ [REPORT]: { errno: 0, result: [row('PVEnergyTotal', october(3.8)), row('generation', october(3))] } });
    t.eq(both.result.pvToday, 3.8, 'PV today is today\'s entry');
    t.eq(both.result.pvMonth, 33.8, 'PV month is the sum of its days');
    t.eq(both.result.acToday, 3, 'and the AC side alongside');
    const { body } = both.client.calls.find((c) => c.path === REPORT);
    t.eq(`${body.dimension} ${body.year}-${body.month}`, 'month 2026-10', 'the report asked is this month\'s, in plant time');
    t.eq(both.client.calls.filter((c) => c.path === GENERATION).length, 0, 'no second call when the report answers');

    const failed = await fields({
      [REPORT]: { errno: 41200, msg: 'not supported' },
      [GENERATION]: { errno: 0, result: { today: 3, month: 28.3, cumulative: 220.3 } },
    });
    t.eq(failed.result.acMonth, 28.3, 'a failed report falls back to the generation endpoint for the AC side');
    t.eq(failed.result.pvToday, undefined, 'which has no PV side');

    const nothing = await fields({ [REPORT]: { errno: 41200 }, [GENERATION]: { errno: 41200 } });
    t.eq(Object.keys(nothing.result).length, 0, 'nothing at all leaves the capabilities alone');

    const short = await fields({ [REPORT]: { errno: 0, result: [row('PVEnergyTotal', [1, 2]), row('generation', october(3))] } });
    t.eq(short.result.pvToday, undefined, 'a PV row without today\'s entry gives no PV');
  } finally {
    Date.now = realNow;
  }

  // --- decided at pairing, kept until a repair ---
  const pairDriver = fixtures.makeDriver('inverter', { own: true });
  t.eq(JSON.stringify(pairDriver.pairStore({ dev: { hasBattery: true }, payload: { generationPower: 0.2 }, detail: null }).solarSides),
    JSON.stringify({
      measure_power: 'ac', meter_power: 'dc', 'meter_power.today': 'dc', 'meter_power.month': 'dc',
    }), 'pairing decides the sides from the battery flag and the AC output');
  t.eq(pairDriver.pairStore({ dev: {}, payload: {}, detail: { hasBattery: false } }).solarSides.meter_power, 'ac',
    'the detail stands in for a device list without the flag');

  const Device = fixtures.app('drivers/inverter/device.js');
  const CommonDevice = fixtures.app('lib/common_device.js');
  const makeDevice = (caps, store = {}) => {
    const dev = Object.create(Device.prototype);
    const options = {};
    Object.assign(dev, {
      log: () => {},
      error: () => {},
      driver: { manifest: fixtures.installHomeyStub().manifest.drivers.find((d) => d.id === 'inverter') },
      hasCapability: (cap) => caps.includes(cap),
      getSetting: () => undefined,
      getStoreValue: (key) => store[key],
      setStoreValue: async (key, value) => {
        store[key] = value;
      },
      unsetStoreValue: async (key) => {
        delete store[key];
      },
      // as Homey: the options last set, else the manifest's
      getCapabilityOptions: (cap) => options[cap] || dev.driver.manifest.capabilitiesOptions?.[cap] || {},
      setCapabilityOptions: async (cap, value) => {
        options[cap] = value;
      },
    });
    return { dev, store, options };
  };
  const shown = [];
  const commonHandleData = CommonDevice.prototype.handleData;
  CommonDevice.prototype.handleData = async function capture(data) {
    shown.push(Object.fromEntries(['measure_power', 'meter_power'].map((cap) => [cap, inv[cap](data)])));
  };
  try {
    const paired = makeDevice(['measure_power', 'meter_power', 'meter_power.today'], {
      solarSides: pairDriver.pairStore({ dev: { hasBattery: true }, payload: { generationPower: 1 } }).solarSides,
    });
    await paired.dev.handleData({
      pvPower: 1, generationPower: 1, PVEnergyTotal: 194, generation: 220,
    });
    t.eq(paired.options.measure_power, undefined, 'AC-side power keeps its normal title');
    const manifestTitle = (cap) => paired.dev.driver.manifest.capabilitiesOptions[cap]?.title;
    t.eq(manifestTitle('measure_power')?.en, 'Solar power (AC)', 'which is the manifest\'s Solar power (AC)');
    t.eq(manifestTitle('meter_power')?.es, 'Producción solar (CA)', 'Spanish marks AC as CA');
    t.eq(manifestTitle('meter_power.month')?.nl, 'Opbrengst deze maand (AC)', 'every solar capability has its AC title');
    t.eq(paired.options.meter_power?.title?.en, 'Solar energy (DC)', 'a hybrid\'s yield is titled (DC)');
    t.eq(paired.options.meter_power?.title?.fr, 'Production solaire (CC)', 'in French (CC)');
    t.eq(paired.options['meter_power.today']?.title?.nl, 'Opbrengst vandaag (DC)', 'Dutch, as com.growatt has it');
    t.eq(paired.dev.capabilityOptions()['meter_power.month']?.title?.en, 'Solar energy this month (DC)', 'a capability added later gets its title too');
    t.eq(shown[0].meter_power, 194, 'and shows the DC counter');

    const calls = Object.keys(paired.options).length;
    const dcTitle = paired.options.meter_power;
    paired.options.meter_power = null;
    await paired.dev.handleData({ pvPower: 1.3, PVEnergyTotal: 195, generation: 221 });
    t.eq(paired.options.meter_power, null, 'titles are set once, not on every poll');
    paired.options.meter_power = dcTitle;
    t.eq(shown[1].measure_power, undefined, 'a poll without the AC output leaves the power tile alone');
    paired.store.deviceDetail = { hasBattery: false };
    await paired.dev.handleData({ generationPower: 1, PVEnergyTotal: 196, generation: 222 });
    t.eq(shown[2].meter_power, 196, 'a changed battery fact changes nothing until the next (re)start');
    t.eq(Object.keys(paired.options).length, calls, 'and costs no call');
    paired.dev.solarSidesDecided = false; // what onInit does on a restart
    await paired.dev.handleData({ generationPower: 1, PVEnergyTotal: 197, generation: 223 });
    t.eq(paired.store.solarSides.meter_power, 'dc', 'nor does a restart: the side stays as paired');
    t.eq(shown[3].meter_power, 197, 'still the DC counter');
    paired.store['todayBaseline_meter_power.today'] = { date: '2026-10-04', total: 190 };
    await paired.dev.onRepaired();
    paired.dev.solarSidesDecided = false; // the restart a repair ends with
    await paired.dev.handleData({ generationPower: 1, PVEnergyTotal: 198, generation: 224 });
    t.eq(paired.store.solarSides.meter_power, 'ac', 'a repair decides again: the battery gone moves the yield to AC');
    t.eq(shown[4].meter_power, 224, 'which shows the AC counter');
    t.eq(paired.options.meter_power?.title?.en, 'Solar energy (AC)', 'under its AC title');
    t.eq(paired.store['todayBaseline_meter_power.today'], undefined, 'and a Homey-timezone today starts again from that counter');
    t.eq(paired.store.redecideSolarSides, false, 'once');
    paired.store.deviceDetail = { hasBattery: true };
    paired.dev.solarSidesDecided = false;
    await paired.dev.handleData({ generationPower: 1, PVEnergyTotal: 199, generation: 225 });
    t.eq(paired.store.solarSides.meter_power, 'ac', 'after which a restart keeps it again');

    // a device paired before the decision moved to pairing: decided once, then kept
    const legacy = makeDevice(['measure_power', 'meter_power'], { deviceDetail: { hasBattery: false } });
    await legacy.dev.handleData({ deviceStatus: 3 }, { partial: true });
    t.eq(legacy.store.solarSides, undefined, 'a partial payload (real-time query failed) decides nothing');
    t.eq(shown[shown.length - 1].meter_power, undefined, 'and shows no solar value meanwhile');
    await legacy.dev.handleData({ generationPower: 1, generation: 220, PVEnergyTotal: 190 });
    t.eq(legacy.store.solarSides?.meter_power, 'ac', 'the first full payload decides, the same way pairing does');
    t.eq(Object.keys(legacy.options).length, 0, 'an all-AC inverter needs no titles');
    legacy.store.deviceDetail = { hasBattery: true };
    await legacy.dev.handleData({ pvPower: 1, generation: 221, PVEnergyTotal: 191 });
    t.eq(legacy.store.solarSides.meter_power, 'ac', 'and keeps it for the rest of this start');
    legacy.dev.solarSidesDecided = false;
    await legacy.dev.handleData({ pvPower: 1, generation: 222, PVEnergyTotal: 192 });
    t.eq(legacy.store.solarSides.meter_power, 'ac', 'and across a restart');
    await legacy.dev.onRepaired();
    legacy.dev.solarSidesDecided = false;
    legacy.store.deviceDetail = {}; // the detail call failed this time
    await legacy.dev.handleData({ pvPower: 1, generation: 223, PVEnergyTotal: 193 });
    t.eq(legacy.store.solarSides.meter_power, 'ac', 'a repair without the battery flag keeps the stored side');
    t.eq(legacy.store.solarSides.measure_power, 'ac', 'as does one without the AC output');
  } finally {
    CommonDevice.prototype.handleData = commonHandleData;
  }
};
