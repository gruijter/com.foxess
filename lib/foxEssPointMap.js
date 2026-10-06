/*
Copyright 2025 - 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.foxess.

FoxESS Cloud OpenAPI Variable Mappings & Points for Homey Capabilities.
Reference: https://www.foxesscloud.com/public/i18n/en/OpenApiDocument.html
*/

'use strict';

const { isHeat, isBattery } = require('./foxEssFaults');

// Returns the first value that is actually PRESENT, or undefined if none are. setCapability()
// skips undefined, so a missing field leaves the capability empty instead of writing a 0 that
// reads like a genuine measurement.
//
// Presence rather than truthiness matters twice over. A `datas` entry can arrive with no `value`
// key at all - confirmed by a shipping third-party client that guards for exactly that - and the
// old `Number(x || 0)` turned such a gap into "0 W" or "0% state of charge". The same `||` chain
// also mis-read a genuine zero: with `data.pvPower || data.generationPower`, an inverter honestly
// reporting 0 kW at night fell through to the next field.
const firstNumber = (...values) => {
  const found = values.find((v) => v !== undefined && v !== null && v !== '');
  return found === undefined ? undefined : Number(found);
};

// Two opposing flows into one signed figure, in W. Undefined only when NEITHER side reported: a
// battery that reports charge but no discharge is simply charging, and that is a usable reading.
const netPowerW = (positive, negative) => {
  if (positive === undefined && negative === undefined) return undefined;
  return Math.round(((positive || 0) - (negative || 0)) * 1000);
};

const kWtoW = (kw) => (kw === undefined ? undefined : Math.round(kw * 1000));

// kWh to two decimals (10 Wh), dropping float noise like 2.0999999999999943.
const kWh = (value) => (value === undefined || Number.isNaN(value) ? value : Math.round(value * 100) / 100);

// Mapper for one variable, straight through or kW -> W.
const raw = (variable) => (data) => firstNumber(data[variable]);
const watts = (variable) => (data) => kWtoW(firstNumber(data[variable]));

// Per-pack copies of a battery variable (batVolt_1, batVolt_2, ...) come back unrequested next to
// the aggregate. Which pack or tower each index is, and how they combine, is not documented, so
// they are only a FALLBACK: used when the aggregate itself is absent or reads 0, which is what
// batVolt did live on an H3-G2 (De Brik, 2026-09-18: batVolt 0, batVolt_1 402.9, portal 404.1 V).
// With more than one non-zero pack the fallback is their average.
const withPackFallback = (...variables) => (data) => {
  const total = firstNumber(...variables.map((v) => data[v]));
  if (total) return total;
  const pattern = new RegExp(`^(${variables.join('|')})_\\d+$`);
  const packs = Object.keys(data)
    .filter((key) => pattern.test(key))
    .map((key) => firstNumber(data[key]))
    .filter((v) => v !== undefined && v !== 0 && !Number.isNaN(v));
  if (!packs.length) return total;
  return Math.round((packs.reduce((sum, v) => sum + v, 0) / packs.length) * 10) / 10;
};

// ---------------------------------------------------------------- alarms
//
// All alarms come from what the installation reports itself - never from thresholds of our own.
// Fields: currentFault / currentFaultCount / runningState (real-time query, shared by the inverter,
// battery and meter devices of one unit), faultTexts (the fault texts CommonDevice resolves from
// currentFault, see foxEssFaults.js) and deviceStatus (/op/v0/device/list: 1 online, 2 breakdown,
// 3 offline). Each alarm is undefined until its source has been reported, so it is added to a
// device like any other optional capability - a reported `false` counts.
const activeFaults = (data) => (Array.isArray(data.faultTexts) ? data.faultTexts : []);
const faultsReported = (data) => Array.isArray(data.faultTexts) || data.currentFault !== undefined;

// Catch-all: any active fault, a runningState of fault (165) or permanent fault (166), or a device
// the device list reports as broken down.
const alarmProblem = (data) => {
  const count = firstNumber(data.currentFaultCount);
  const state = firstNumber(data.runningState);
  const status = firstNumber(data.deviceStatus);
  if (count === undefined && state === undefined && status === undefined && !faultsReported(data)) return undefined;
  return count > 0 || activeFaults(data).length > 0 || state === 165 || state === 166 || status === 2;
};

const faultAlarm = (test) => (data) => (faultsReported(data) ? activeFaults(data).some(test) : undefined);

const alarmConnectivity = (data) => {
  const status = firstNumber(data.deviceStatus);
  return status === undefined ? undefined : status === 3;
};

// Each driver has BASE capabilities and OPTIONAL ones.
//
// Base capabilities are what driver.compose.json declares, in that same order - every device of
// the driver has them, and DeviceMigrator keeps them in exactly this order.
//
// Optional capabilities depend on the hardware: the number of PV strings, one or three phases, an
// EPS output, a battery that reports its health. A tile that never gets a value is noise, so an optional capability
// is only added once the device has actually reported a non-zero value for it (see
// CommonDevice#recordSeenCaps). They are always appended AFTER the base ones, so adding one never
// removes or reorders a capability a user's flows depend on. For the same reason a NEW optional
// capability must go at the END of its map: devices keep their seen ones in map order, and one
// inserted in between would make DeviceMigrator remove and re-add everything after it.
//
// Variable names, units and meanings are taken from the 'Variable table' of the official FoxESS
// OpenAPI document (v1.1.18, see the Reference above): powers in kW, voltages in V, currents in A,
// energy in kWh. Whether a given model reports a variable is not documented ("availability may
// differ depending on the specific device"), which is exactly why the optional capabilities are
// opt-in by evidence. The variables of the base capabilities are also confirmed by a real capture
// (test/captures).

// ---------------------------------------------------------------- battery

const batteryPower = (data) => netPowerW(firstNumber(data.batChargePower), firstNumber(data.batDischargePower));

// Within this band the battery counts as idle, as in com.solarwatt.
const BATTERY_IDLE_BAND_W = 10;

const batteryBase = {
  measure_power: batteryPower,
  measure_battery: withPackFallback('SoC', 'soc'),
  measure_temperature: withPackFallback('batTemperature'),
  'meter_power.charged': (data) => firstNumber(data.chargeEnergyToTal),
  'meter_power.discharged': (data) => firstNumber(data.dischargeEnergyToTal, data.totalDischargeKW),
  // from the same figures as measure_power, so the tile and the state can never disagree
  battery_charging_state: (data) => {
    const power = batteryPower(data);
    if (power === undefined) return undefined;
    if (power > BATTERY_IDLE_BAND_W) return 'charging';
    if (power < -BATTERY_IDLE_BAND_W) return 'discharging';
    return 'idle';
  },
};

// invBatCurrent is documented as "Positive Discharge, Negative Charge"; it is negated so the
// current carries the same sign as measure_power above (charging positive).
const batteryOptional = {
  measure_voltage: withPackFallback('batVolt'),
  measure_current: (data) => {
    const amps = firstNumber(data.invBatCurrent);
    return amps === undefined ? undefined : -amps;
  },
  measure_soh: withPackFallback('SOH'), // "State of Health", %
  measure_residual_energy: raw('ResidualEnergy'), // "Remaining energy in battery", kWh per the document
  'meter_power.throughput': raw('energyThroughput'), // "Total energy cycled (lifetime)", kWh
  measure_battery_cycles: raw('batCycleCount'), // "Number of charge/discharge cycles"
  alarm_problem: alarmProblem,
  alarm_battery: faultAlarm(isBattery), // battery/BMS faults only - a low SoC is normal operation
  alarm_heat: faultAlarm((text) => isHeat(text) && isBattery(text)),
  alarm_connectivity: alarmConnectivity,
  // No BMS charge/discharge limits as in com.solarwatt: maxChargeCurrent and maxDischargeCurrent
  // read a fixed 500 A on De Brik (2026-10-06), 200 kW at the battery voltage.
};

const batteryVariables = [
  'batChargePower', 'batDischargePower', 'SoC', 'batTemperature', 'chargeEnergyToTal', 'dischargeEnergyToTal', 'totalDischargeKW',
  'batVolt', 'invBatCurrent', 'SOH', 'ResidualEnergy', 'energyThroughput', 'batCycleCount',
  'currentFault', 'currentFaultCount', 'runningState',
  // not mapped to a capability: battery control corrects its slot power for PV (see
  // foxEssBatteryControl.slotForPower); free, since all devices share one real-time request
  'pvPower',
];

// ---------------------------------------------------------------- inverter

// The inverter shows its solar yield on the AC side - what the panels deliver as AC, the way
// com.growatt does (lib/growattMap.js#calcSolarAC and the yield notes there). Where only the DC side
// can be shown, the device adds "(DC)" to the capability's title (see inverterSolarSides and
// drivers/inverter/device.js). Which side a capability shows is decided at pairing and once per
// (re)start.
//
// Power. generationPower ("Total AC output power") is the inverter's AC output, battery included:
// on De Brik (2026-10-04, 5-minute history) it equalled RPower+SPower+TPower and pvPower -
// batChargePower + batDischargePower to within 1 W, and went negative while the battery charged
// from the grid. So the AC-side solar power is generationPower + (charge - discharge) * n, capped at
// pvPower * n, with n the live conversion ratio (or 98% when that is unusable). Without a battery
// the battery term is 0 and it is simply generationPower. Without generationPower: pvPower, DC.
//
// Energy. There is no AC-side solar counter for an inverter with a battery: `generation` (AC
// output) also counts battery discharge, including energy charged from the grid, and correcting it
// with the battery counters missed by a varying amount per day on De Brik (2026-10-04). So:
//   no battery  -> generation, the AC solar yield (acToday/acMonth from its daily report)
//   battery     -> PVEnergyTotal ("PV panel side"), DC - as com.growatt keeps hybrids on DC
// hasBattery comes from the device list / device detail at pairing; unknown counts as a battery,
// the safe side. pvToday/pvMonth and acToday/acMonth come from /op/v0/device/report/query (see
// drivers/inverter/driver.js#energyFields), in the plant's time zone, PV and AC both; todayYield
// (real/query, "PV" section, never sent by an H3-G2) is a DC fallback. With the
// dailyEnergyHomeyTimezone setting on, CommonDevice derives today from meter_power (todayFromTotal).
// The report carries float arithmetic as-is (3.8000000000000114), hence kWh().
const FALLBACK_EFFICIENCY = 0.98;
const MIN_DC_KW = 0.05; // below this the conversion ratio is noise

/** AC-side solar power in kW, or undefined without an AC output reading. */
const solarAcKw = (data) => {
  const ac = firstNumber(data.generationPower);
  if (ac === undefined || Number.isNaN(ac)) return undefined;
  const pv = firstNumber(data.pvPower);
  const charge = firstNumber(data.batChargePower) || 0;
  const discharge = firstNumber(data.batDischargePower) || 0;
  const dcIn = pv === undefined ? undefined : pv - charge + discharge;
  const live = ac > 0 && dcIn >= MIN_DC_KW ? ac / dcIn : undefined;
  // FoxESS's own figures balance to the watt (ratio ~1.000), so a ratio just over 1 is rounding of
  // the kW values, not the sampling skew com.growatt rejects it for: up to 1% over counts as 100%.
  const efficiency = live >= 0.5 && live <= 1.01 ? Math.min(live, 1) : FALLBACK_EFFICIENCY;
  const solar = Math.max(0, ac + (charge - discharge) * efficiency);
  // grid charging puts power into `charge` that never came from the panels: the array is the ceiling
  return pv === undefined ? solar : Math.min(solar, Math.max(0, pv * efficiency));
};

// [AC value, DC value] per solar capability.
const solarPairs = {
  measure_power: (data) => [solarAcKw(data), firstNumber(data.pvPower)],
  meter_power: (data) => [firstNumber(data.generation), firstNumber(data.PVEnergyTotal)],
  'meter_power.today': (data) => [firstNumber(data.acToday), firstNumber(data.pvToday, data.todayYield)],
  'meter_power.month': (data) => [firstNumber(data.acMonth), firstNumber(data.pvMonth)],
};
const present = (value) => value !== undefined && value !== null && !Number.isNaN(value);

/**
 * The side each solar capability of an inverter shows: 'ac' or 'dc'. Decided at pairing
 * (drivers/inverter/driver.js#pairStore) and again on every (re)start (drivers/inverter/device.js):
 *   energy - AC only without a battery (`generation` also counts battery discharge), else DC;
 *            an unknown battery counts as one
 *   power  - AC once the inverter has reported its AC output (generationPower), else DC
 * A fact that is unknown this time keeps the `previous` side, so one failed detail call or one
 * payload without generationPower does not flip a capability to the other quantity and back.
 * Power with no previous side and no payload to judge (acPower undefined) stays undecided:
 * reading "no data" as "no AC output" would fix it to DC for good.
 * @param {object} facts
 * @param {boolean} [facts.hasBattery] from the device detail / device list
 * @param {boolean} [facts.acPower] whether the inverter reports generationPower; undefined
 *   without a real-time reading (see acPowerReported)
 * @param {Object<string, 'ac'|'dc'>} [previous] the sides decided before
 * @returns {Object<string, 'ac'|'dc'>}
 */
const inverterSolarSides = ({ hasBattery, acPower } = {}, previous = {}) => {
  let energy = previous.meter_power || 'dc';
  if (typeof hasBattery === 'boolean') energy = hasBattery ? 'dc' : 'ac';
  let power = previous.measure_power;
  if (acPower === true) power = 'ac';
  else if (acPower === false) power = power || 'dc';
  return {
    ...(power ? { measure_power: power } : {}),
    meter_power: energy,
    'meter_power.today': energy,
    'meter_power.month': energy,
  };
};

// The value of the side in data.solarSides (the device's decision, see inverterSolarSides) - nothing else,
// so a gap leaves the capability alone rather than filling it with the other quantity, and no
// decision shows nothing. Without data.solarSides at all (pairing, before the decision is stored)
// the sides follow from the payload, the same way the decision is made.
const solarValue = (cap) => (data) => {
  const sides = data.solarSides || inverterSolarSides({ hasBattery: data.hasBattery, acPower: present(firstNumber(data.generationPower)) });
  const [ac, dc] = solarPairs[cap](data);
  if (sides[cap] === 'ac') return ac;
  return sides[cap] === 'dc' ? dc : undefined;
};

const inverterBase = {
  measure_power: (data) => kWtoW(solarValue('measure_power')(data)),
  meter_power: solarValue('meter_power'),
  'meter_power.today': (data) => kWh(solarValue('meter_power.today')(data)),
  measure_temperature: (data) => firstNumber(data.invTemperation, data.ambientTemperation),
};

// runningState, from the document's 'Appendix For Enum Variable'. A code the appendix does not list
// (a model or firmware it does not cover) shows as 'unknown' rather than being dropped, so the
// capability still says "the inverter reported something" - the raw code is in the diagnostics
// capture.
const RUNNING_STATES = {
  160: 'self_test',
  161: 'waiting',
  162: 'checking',
  163: 'on_grid',
  164: 'off_grid',
  165: 'fault',
  166: 'permanent_fault',
  167: 'standby',
  168: 'upgrading',
  169: 'fct',
  170: 'illegal',
};
const runningState = (value) => {
  const code = firstNumber(value);
  if (code === undefined || Number.isNaN(code)) return undefined;
  return RUNNING_STATES[code] || 'unknown';
};

// DC side (per PV string) and AC side (inverter output, per phase), as com.growatt splits them.
const inverterOptional = {
  'measure_power.ac_inverter': watts('generationPower'), // "Total AC output power"
  'meter_power.ac_inverter': raw('generation'), // "AC output from inverter side, affected by battery charging/discharging"
  // The document lists pv1..pv24; four strings cover the residential models this app targets.
  'measure_power.pv1': watts('pv1Power'),
  'measure_power.pv2': watts('pv2Power'),
  'measure_power.pv3': watts('pv3Power'),
  'measure_power.pv4': watts('pv4Power'),
  'measure_voltage.pv1': raw('pv1Volt'),
  'measure_voltage.pv2': raw('pv2Volt'),
  'measure_voltage.pv3': raw('pv3Volt'),
  'measure_voltage.pv4': raw('pv4Volt'),
  'measure_current.pv1': raw('pv1Current'),
  'measure_current.pv2': raw('pv2Current'),
  'measure_current.pv3': raw('pv3Current'),
  'measure_current.pv4': raw('pv4Current'),
  // "Grid R/S/T-phase": the inverter's own AC connection, not the grid meter (that is meterPowerR/S/T).
  'measure_power.1': watts('RPower'),
  'measure_power.2': watts('SPower'),
  'measure_power.3': watts('TPower'),
  'measure_current.1': raw('RCurrent'),
  'measure_current.2': raw('SCurrent'),
  'measure_current.3': raw('TCurrent'),
  'measure_power.eps': watts('epsPower'), // "EPS total output power", energy-storage models only
  'meter_power.month': (data) => kWh(solarValue('meter_power.month')(data)), // report/query, plant time zone (see inverterBase)
  running_state: (data) => runningState(data.runningState),
  // Meter 2 is the CT2 input, clamped on the AC output of an external generator - typically an
  // existing PV installation with a third-party inverter (FoxESS Community / Fox ESS Tech Hub; the
  // OpenAPI document only says "Meter 2 total active power" and has a Meter2Enable setting). It
  // reads negative while generating, so it is negated here: generation positive, as measure_power.
  'measure_power.external': (data) => {
    const w = kWtoW(firstNumber(data.meterPower2));
    return w === undefined || w === 0 ? w : -w;
  },
  'meter_power.external': raw('feedin2'), // "Total feed-in energy of Meter 2"
  alarm_problem: alarmProblem,
  alarm_heat: faultAlarm((text) => isHeat(text) && !isBattery(text)), // battery heat is the battery's
  alarm_connectivity: alarmConnectivity,
  // the fault texts themselves; null (no value) while none is active
  active_faults: (data) => {
    if (!faultsReported(data)) return undefined;
    const texts = activeFaults(data);
    return texts.length ? texts.join(', ') : null;
  },
  // "Grid" section of the variable table. Not reported by an H3-G2 (De Brik, 2026-10-04).
  measure_power_factor: raw('PowerFactor'),
  measure_reactive_power: watts('ReactivePower'), // kVar -> var
  measure_apparent_power: (data) => {
    const p = firstNumber(data.generationPower);
    const q = firstNumber(data.ReactivePower);
    if (p === undefined || q === undefined || Number.isNaN(p) || Number.isNaN(q)) return undefined;
    return Math.round(Math.hypot(p, q) * 1000);
  },
};

const inverterVariables = [
  // the battery powers turn the AC output into AC-side solar power (see solarAcKw)
  'batChargePower', 'batDischargePower',
  'pvPower', 'generationPower', 'PVEnergyTotal', 'generation', 'todayYield', 'invTemperation', 'ambientTemperation',
  'pv1Power', 'pv2Power', 'pv3Power', 'pv4Power', 'pv1Volt', 'pv2Volt', 'pv3Volt', 'pv4Volt',
  'pv1Current', 'pv2Current', 'pv3Current', 'pv4Current',
  'RPower', 'SPower', 'TPower', 'RCurrent', 'SCurrent', 'TCurrent', 'epsPower', 'runningState',
  'meterPower2', 'feedin2', 'currentFault', 'currentFaultCount',
  'PowerFactor', 'ReactivePower',
];

/**
 * Whether a flat payload shows the inverter's AC output: true or false when it carries real-time
 * data, undefined when it carries none - a real/query answered with `result: null`, or a device
 * listed without data, which says nothing about the AC output.
 * @param {object} [data] the flat payload; fields from other endpoints (deviceStatus, pvToday,
 *   ...) are not real-time data
 * @returns {boolean|undefined}
 */
const acPowerReported = (data) => {
  if (!data || !inverterVariables.some((v) => present(firstNumber(data[v])))) return undefined;
  return present(firstNumber(data.generationPower));
};

// ---------------------------------------------------------------- meter

const meterBase = {
  // Import minus export. meterPower is already that net figure (positive on import, see below), so
  // it is only the fallback for when neither side is reported - never one side of the subtraction.
  measure_power: (data) => {
    const imported = firstNumber(data.gridConsumptionPower);
    const exported = firstNumber(data.feedinPower);
    if (imported !== undefined || exported !== undefined) return netPowerW(imported, exported);
    return kWtoW(firstNumber(data.meterPower));
  },
  meter_power: (data) => firstNumber(data.gridConsumption),
  measure_frequency: (data) => firstNumber(data.RFreq, data.SFreq, data.TFreq),
  'measure_voltage.1': (data) => firstNumber(data.RVolt),
  'meter_power.imported': (data) => firstNumber(data.gridConsumption),
  'meter_power.exported': (data) => firstNumber(data.feedin),
};

// The document gives no sign for meterPower. The capture shows it positive on import (meterPower
// -0.588 while feedinPower 0.588), which is Homey's convention for a grid meter; the per-phase
// meterPowerR/S/T ("Meter 1 R-phase active power") are taken to follow meterPower.
const meterOptional = {
  // Phases 2 and 3 only exist on a three-phase installation. The document has no setting that says
  // which it is (only the separate EMS devices have a singlePhase/threePhase controlMode), so like
  // every optional capability they appear once the inverter reports a non-zero voltage for them.
  'measure_voltage.2': (data) => firstNumber(data.SVolt),
  'measure_voltage.3': (data) => firstNumber(data.TVolt),
  'measure_power.1': watts('meterPowerR'),
  'measure_power.2': watts('meterPowerS'),
  'measure_power.3': watts('meterPowerT'),
  'measure_power.load': watts('loadsPower'), // "Total load power"
  alarm_problem: alarmProblem,
  alarm_connectivity: alarmConnectivity,
  'meter_power.load': raw('loads'), // "Load power consumption", kWh
  // today from the lifetime total, at Homey's midnight (drivers/meter/device.js)
  'meter_power.load_today': (data) => firstNumber(data.loadsToday),
};

// The variables that prove a grid meter is present. Pairing offers a meter device only for an
// inverter that reports one of these. loadsPower and friends exist without a meter, and so do
// RFreq/RVolt/SVolt/TVolt: the document files those under "Grid", the inverter's own grid
// connection (also on grid-tied models), not under "Meter" - so they must not count either.
const meterDetectVariables = ['gridConsumptionPower', 'meterPower', 'feedinPower', 'gridConsumption', 'feedin'];

const meterVariables = [
  ...meterDetectVariables,
  'RFreq', 'RVolt', 'SVolt', 'TVolt',
  'meterPowerR', 'meterPowerS', 'meterPowerT', 'loadsPower', 'loads',
  'currentFault', 'currentFaultCount', 'runningState',
];

// ---------------------------------------------------------------- heat pump

// Heat pumps are not reachable through /op/v0/device/real/query, so unlike the other
// drivers there is no variable point list here. The OpenAPI exposes only the settings
// endpoints (/op/v0/heat/...); the live measurements (waterTankTemp, outletWaterTemp,
// heatingRealTimeConsumption, ...) are published exclusively on the Kafka stream, which
// needs a per-company FoxESS onboarding and is therefore out of reach for a Homey app.
// The driver merges the dhwControls, heatingControls and register-list responses into one
// flat object before it reaches these mappers.
const HEATING_WORK_MODES = {
  1: 'cool',
  2: 'heat',
  3: 'auto',
  4: 'off',
};

const heatpumpBase = {
  thermostat_mode: (data) => HEATING_WORK_MODES[Number(data.workMode)],
  'onoff.dhw': (data) => (data.dhwEnable === undefined ? undefined : Boolean(data.dhwEnable)),
  'target_temperature.dhw': (data) => (data.dhwTemp === undefined ? undefined : Number(data.dhwTemp)),
};

/**
 * Whether a mapped value proves the device has the hardware behind an optional capability.
 *
 * A zero does not: an unconnected PV string, an idle EPS output or a phase that does not exist
 * all read 0, and would otherwise put a permanently empty-looking tile on the device. The real
 * hardware produces a non-zero reading soon enough, and the capability is added then.
 */
const isEvidence = (value) => value !== undefined && value !== null
  && !(typeof value === 'number' && (Number.isNaN(value) || value === 0));

// ---------------------------------------------------------------- evidence
//
// By default a non-zero value proves an optional capability (see isEvidence). Some values are
// legitimately zero on hardware that certainly has them, and would then only be added - and the
// device migrated - the first time they move:
// - battery current: 0 A whenever the battery idles. A battery that reports its voltage has a
//   current, so the current is shown once both are reported.
// - this month's yield: 0 kWh until the first sunny hour of a month. The energy report always
//   answers every day of the month, so a reported month counts, zero or not.
const batteryEvidence = {
  measure_current: (data) => firstNumber(data.invBatCurrent) !== undefined
    && isEvidence(batteryOptional.measure_voltage(data)),
};

const inverterEvidence = {
  'meter_power.month': (data) => present(solarValue('meter_power.month')(data)),
  active_faults: faultsReported, // a fault-free unit reports no text, yet does report on its faults
  // a reactive power proves the apparent power, which is otherwise never 0 while producing
  measure_apparent_power: (data) => isEvidence(firstNumber(data.ReactivePower)),
};

// the day's load counts from midnight, so a 0 kWh at 00:05 still shows the meter reports it
const meterEvidence = {
  'meter_power.load_today': (data) => isEvidence(firstNumber(data.loads)),
};

// ---------------------------------------------------------------- per driver

const DRIVERS = {
  inverter: {
    base: inverterBase, optional: inverterOptional, evidence: inverterEvidence, variables: inverterVariables,
  },
  battery: {
    base: batteryBase, optional: batteryOptional, evidence: batteryEvidence, variables: batteryVariables,
  },
  meter: {
    base: meterBase, optional: meterOptional, evidence: meterEvidence, variables: meterVariables,
  },
  heatpump: {
    base: heatpumpBase,
    // runningStatus from /op/v0/register/heat/list: 1 online, 2 fault, 3 offline
    optional: {
      alarm_problem: (data) => {
        const status = firstNumber(data.runningStatus);
        return status === undefined ? undefined : status === 2;
      },
      alarm_connectivity: (data) => {
        const status = firstNumber(data.runningStatus);
        return status === undefined ? undefined : status === 3;
      },
    },
    variables: [],
  },
};

const driverDef = (driverId) => DRIVERS[driverId] || { base: {}, optional: {}, variables: [] };

// Tile order per driver: every capability a device of the driver can have - base, optional and
// the driver's extra (control/settings) ones - in the order com.solarwatt uses for the same
// hardware, so the two apps look alike. A device's list is this order, filtered to what it has.
const phases = (prefix) => [1, 2, 3].map((n) => `${prefix}.${n}`);
const strings = (prefix) => [1, 2, 3, 4].map((n) => `${prefix}.pv${n}`);
const ORDER = {
  inverter: [
    'measure_power', 'export_limit', 'inverter_limit_active',
    'measure_power.ac_inverter', 'measure_power.eps', 'measure_power.external',
    'meter_power', 'meter_power.today', 'meter_power.month', 'meter_power.ac_inverter', 'meter_power.external',
    'measure_temperature',
    ...phases('measure_power'), ...phases('measure_current'),
    'measure_power_factor', 'measure_reactive_power', 'measure_apparent_power',
    ...strings('measure_power'), ...strings('measure_voltage'), ...strings('measure_current'),
    'running_state', 'active_faults', 'alarm_problem', 'alarm_heat', 'alarm_connectivity', 'alarm_generic.control',
  ],
  battery: [
    'measure_power', 'measure_power.target', 'target_power', 'target_power_mode',
    'measure_battery', 'battery_charging_state', 'battery_min_soc', 'battery_min_soc_ongrid', 'battery_max_soc',
    'measure_voltage', 'measure_current',
    'meter_power.charged', 'meter_power.discharged',
    'measure_temperature', 'measure_soh', 'measure_residual_energy', 'measure_battery_cycles', 'meter_power.throughput',
    'alarm_problem', 'alarm_battery', 'alarm_heat', 'alarm_connectivity', 'alarm_generic.control',
  ],
  meter: [
    'measure_power', ...phases('measure_power'), ...phases('measure_voltage'), 'measure_frequency',
    'measure_power.load',
    'meter_power', 'meter_power.imported', 'meter_power.exported', 'meter_power.load', 'meter_power.load_today',
    'alarm_problem', 'alarm_connectivity',
  ],
};

/** The tile order of a driver; base then optional for a driver without one. */
const capabilityOrder = (driverId) => ORDER[driverId]
  || [...Object.keys(driverDef(driverId).base), ...Object.keys(driverDef(driverId).optional)];

/**
 * All capability mappers of a driver, base first, then optional.
 * @param {string} driverId
 * @returns {Object<string, function(object): *>} capability id -> mapper over the flat payload
 */
const capabilityMap = (driverId) => {
  const def = driverDef(driverId);
  return { ...def.base, ...def.optional };
};

/** The capabilities every device of the driver has, in driver.compose.json order. */
const baseCapabilities = (driverId) => capabilityOrder(driverId).filter((cap) => cap in driverDef(driverId).base);

/** The capabilities a device only gets once it has reported them. */
const optionalCapabilities = (driverId) => Object.keys(driverDef(driverId).optional);

/** The real-time variables to request for a device of this driver. */
const pointList = (driverId) => [...driverDef(driverId).variables];

/**
 * The capability list a device of this driver should have: its base capabilities, the optional
 * ones it has reported, and the driver's extra ones, in the driver's tile order. A capability
 * missing from that order goes at the end (a test keeps the order complete).
 * @param {string} driverId
 * @param {Object<string, boolean>} [seenCaps] optional capability id -> reported
 * @param {string[]} [extras] the driver's extra capabilities for this device
 * @returns {string[]}
 */
const deviceCapabilities = (driverId, seenCaps = {}, extras = []) => {
  const has = new Set([
    ...Object.keys(driverDef(driverId).base),
    ...optionalCapabilities(driverId).filter((cap) => seenCaps?.[cap]),
    ...extras,
  ]);
  const order = capabilityOrder(driverId);
  return [...order.filter((cap) => has.has(cap)), ...[...has].filter((cap) => !order.includes(cap))];
};

/**
 * The optional capabilities that a flat payload gives evidence for.
 * @returns {Object<string, boolean>} capability id -> true
 */
const seenInPayload = (driverId, data) => {
  const seen = {};
  if (!data) return seen;
  const { optional, evidence = {} } = driverDef(driverId);
  for (const [cap, fn] of Object.entries(optional)) {
    if (evidence[cap] ? evidence[cap](data) : isEvidence(fn(data))) seen[cap] = true;
  }
  return seen;
};

// The map and point exports keyed by a device type, kept in the shape the rest of the app and the
// test suite have always used. Battery and meter capabilities are read from the inverter's own
// payload, hence both keys point to the same map.
const inverterMap = { inverter: capabilityMap('inverter') };
const batteryMap = { inverter: capabilityMap('battery'), battery: capabilityMap('battery') };
const meterMap = { inverter: capabilityMap('meter'), meter: capabilityMap('meter') };
const heatpumpMap = { heatpump: capabilityMap('heatpump') };

const inverterPoints = { inverter: pointList('inverter') };
const batteryPoints = { inverter: pointList('battery'), battery: pointList('battery') };
const meterPoints = { inverter: pointList('meter'), meter: pointList('meter') };

module.exports = {
  capabilityMap,
  baseCapabilities,
  capabilityOrder,
  optionalCapabilities,
  deviceCapabilities,
  seenInPayload,
  isEvidence,
  pointList,
  meterDetectVariables,
  inverterSolarSides,
  acPowerReported,
  inverterMap,
  inverterPoints,
  meterMap,
  meterPoints,
  batteryMap,
  batteryPoints,
  heatpumpMap,
  HEATING_WORK_MODES,
  RUNNING_STATES,
};
