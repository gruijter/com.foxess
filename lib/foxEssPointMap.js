/*
Copyright 2025 - 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.foxess.

FoxESS Cloud OpenAPI Variable Mappings & Points for Homey Capabilities.
Reference: https://www.foxesscloud.com/public/i18n/en/OpenApiDocument.html
*/

'use strict';

const { isHeat, isBattery } = require('./foxEssFaults');

// The first PRESENT value as a Number, else undefined (setCapability skips undefined). Presence,
// not truthiness: a missing field must not become 0, and a genuine 0 must not fall through.
const firstNumber = (...values) => {
  const found = values.find((v) => v !== undefined && v !== null && v !== '');
  return found === undefined ? undefined : Number(found);
};

// Two opposing kW flows as one signed W figure; undefined only when neither side reported.
const netPowerW = (positive, negative) => {
  if (positive === undefined && negative === undefined) return undefined;
  return Math.round(((positive || 0) - (negative || 0)) * 1000);
};

const kWtoW = (kw) => (kw === undefined ? undefined : Math.round(kw * 1000));

// kWh to two decimals, dropping float noise like 2.0999999999999943.
const kWh = (value) => (value === undefined || Number.isNaN(value) ? value : Math.round(value * 100) / 100);

const raw = (variable) => (data) => firstNumber(data[variable]);
const watts = (variable) => (data) => kWtoW(firstNumber(data[variable]));

// Per-pack variables (batVolt_1, ...) are undocumented, so only a fallback for an absent or 0
// aggregate (H3-G2, 2026-09-18: batVolt 0, batVolt_1 402.9 V). Several packs: their average.
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
// Alarms come only from what the installation reports, never from own thresholds. Each stays
// undefined until its source is reported, so it is added like any optional capability.
// faultTexts: resolved from currentFault by CommonDevice. deviceStatus (/op/v0/device/list):
// 1 online, 2 breakdown, 3 offline.
const activeFaults = (data) => (Array.isArray(data.faultTexts) ? data.faultTexts : []);
const faultsReported = (data) => Array.isArray(data.faultTexts) || data.currentFault !== undefined;

// Any active fault, runningState fault (165) / permanent fault (166), or deviceStatus breakdown.
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

// Base capabilities: every device of the driver has them (driver.compose.json).
// Optional capabilities depend on the hardware (PV strings, phases, EPS, ...) and are only added
// once the device reports evidence for them (see isEvidence, CommonDevice#recordSeenCaps); the
// OpenAPI document says variable availability differs per device. Tile order: see ORDER below.
//
// Variable names and units: 'Variable table' of the OpenAPI document v1.1.18 (kW, V, A, kWh).

// ---------------------------------------------------------------- battery

const batteryPower = (data) => netPowerW(firstNumber(data.batChargePower), firstNumber(data.batDischargePower));

const BATTERY_IDLE_BAND_W = 10; // as com.solarwatt

const batteryBase = {
  measure_power: batteryPower,
  measure_battery: withPackFallback('SoC', 'soc'),
  measure_temperature: withPackFallback('batTemperature'),
  'meter_power.charged': (data) => firstNumber(data.chargeEnergyToTal),
  'meter_power.discharged': (data) => firstNumber(data.dischargeEnergyToTal, data.totalDischargeKW),
  // derived from measure_power so both always agree
  battery_charging_state: (data) => {
    const power = batteryPower(data);
    if (power === undefined) return undefined;
    if (power > BATTERY_IDLE_BAND_W) return 'charging';
    if (power < -BATTERY_IDLE_BAND_W) return 'discharging';
    return 'idle';
  },
};

const batteryOptional = {
  measure_voltage: withPackFallback('batVolt'),
  // documented "Positive Discharge, Negative Charge"; negated to match measure_power
  measure_current: (data) => {
    const amps = firstNumber(data.invBatCurrent);
    return amps === undefined ? undefined : -amps;
  },
  measure_soh: withPackFallback('SOH'),
  measure_residual_energy: raw('ResidualEnergy'),
  'meter_power.throughput': raw('energyThroughput'),
  measure_battery_cycles: raw('batCycleCount'),
  alarm_problem: alarmProblem,
  alarm_battery: faultAlarm(isBattery), // BMS faults only, not a low SoC
  alarm_heat: faultAlarm((text) => isHeat(text) && isBattery(text)),
  alarm_connectivity: alarmConnectivity,
  // No BMS limits (as com.solarwatt has): maxCharge/DischargeCurrent read a fixed 500 A (2026-10-06).
};

const batteryVariables = [
  'batChargePower', 'batDischargePower', 'SoC', 'batTemperature', 'chargeEnergyToTal', 'dischargeEnergyToTal', 'totalDischargeKW',
  'batVolt', 'invBatCurrent', 'SOH', 'ResidualEnergy', 'energyThroughput', 'batCycleCount',
  'currentFault', 'currentFaultCount', 'runningState',
  'pvPower', // unmapped; used by foxEssBatteryControl.slotForPower
];

// ---------------------------------------------------------------- inverter

// Solar is shown on the AC side, as com.growatt does; where only DC is possible the title gets
// "(DC)". The side is decided at pairing and on every (re)start (inverterSolarSides).
//
// Power: generationPower is the AC output including the battery (2026-10-04: equal to
// RPower+SPower+TPower and to pvPower - charge + discharge within 1 W; negative while grid
// charging). AC solar = generationPower + (charge - discharge) * n, capped at pvPower * n, with n
// the live conversion ratio or FALLBACK_EFFICIENCY.
//
// Energy: `generation` also counts battery discharge, and correcting it with the battery counters
// was off by a varying amount per day (2026-10-04). So without a battery `generation` (AC), with a
// battery PVEnergyTotal (DC); an unknown battery counts as one. today/month come from
// /op/v0/device/report/query (plant time zone); todayYield is a DC fallback.
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
  // FoxESS figures balance to the watt, so up to 1% over 1 is kW rounding and counts as 100%
  const efficiency = live >= 0.5 && live <= 1.01 ? Math.min(live, 1) : FALLBACK_EFFICIENCY;
  const solar = Math.max(0, ac + (charge - discharge) * efficiency);
  // grid charging adds to `charge` without coming from the panels: cap at the array
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
 * The side ('ac'|'dc') each solar capability of an inverter shows.
 *   energy - AC only without a battery, else DC
 *   power  - AC once generationPower is reported, else DC
 * An unknown fact keeps the `previous` side, so one failed call does not flip it. Power without a
 * previous side and without real-time data stays undecided.
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

// Only the decided side's value, never the other quantity as a fallback. Without data.solarSides
// (pairing) the sides are decided from the payload.
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

// runningState: 'Appendix For Enum Variable' of the OpenAPI document; unlisted codes show 'unknown'.
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

const inverterOptional = {
  'measure_power.ac_inverter': watts('generationPower'),
  'meter_power.ac_inverter': raw('generation'),
  // the document lists pv1..pv24; only four are mapped
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
  // "Grid R/S/T-phase" is the inverter's own AC connection; the grid meter is meterPowerR/S/T
  'measure_power.1': watts('RPower'),
  'measure_power.2': watts('SPower'),
  'measure_power.3': watts('TPower'),
  'measure_current.1': raw('RCurrent'),
  'measure_current.2': raw('SCurrent'),
  'measure_current.3': raw('TCurrent'),
  'measure_power.eps': watts('epsPower'),
  'meter_power.month': (data) => kWh(solarValue('meter_power.month')(data)),
  running_state: (data) => runningState(data.runningState),
  // Meter 2 (CT2) measures an external generator, e.g. an existing PV inverter (FoxESS community
  // sources; the document only says "Meter 2 total active power"). Negated: generation positive.
  'measure_power.external': (data) => {
    const w = kWtoW(firstNumber(data.meterPower2));
    return w === undefined || w === 0 ? w : -w;
  },
  'meter_power.external': raw('feedin2'),
  alarm_problem: alarmProblem,
  alarm_heat: faultAlarm((text) => isHeat(text) && !isBattery(text)), // battery heat is the battery's
  alarm_connectivity: alarmConnectivity,
  // null while no fault is active
  active_faults: (data) => {
    if (!faultsReported(data)) return undefined;
    const texts = activeFaults(data);
    return texts.length ? texts.join(', ') : null;
  },
  // not reported by an H3-G2 (2026-10-04)
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
  'batChargePower', 'batDischargePower', // for solarAcKw
  'pvPower', 'generationPower', 'PVEnergyTotal', 'generation', 'todayYield', 'invTemperation', 'ambientTemperation',
  'pv1Power', 'pv2Power', 'pv3Power', 'pv4Power', 'pv1Volt', 'pv2Volt', 'pv3Volt', 'pv4Volt',
  'pv1Current', 'pv2Current', 'pv3Current', 'pv4Current',
  'RPower', 'SPower', 'TPower', 'RCurrent', 'SCurrent', 'TCurrent', 'epsPower', 'runningState',
  'meterPower2', 'feedin2', 'currentFault', 'currentFaultCount',
  'PowerFactor', 'ReactivePower',
];

/**
 * Whether the payload reports generationPower; undefined when it holds no real-time data at all.
 * @param {object} [data] the flat payload
 * @returns {boolean|undefined}
 */
const acPowerReported = (data) => {
  if (!data || !inverterVariables.some((v) => present(firstNumber(data[v])))) return undefined;
  return present(firstNumber(data.generationPower));
};

// ---------------------------------------------------------------- meter

const meterBase = {
  // import minus export; meterPower (already net) only when neither side is reported
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

// meterPower sign is undocumented; the capture shows it positive on import (Homey's convention).
// meterPowerR/S/T are assumed to follow it.
const meterOptional = {
  'measure_voltage.2': (data) => firstNumber(data.SVolt),
  'measure_voltage.3': (data) => firstNumber(data.TVolt),
  'measure_power.1': watts('meterPowerR'),
  'measure_power.2': watts('meterPowerS'),
  'measure_power.3': watts('meterPowerT'),
  'measure_power.load': watts('loadsPower'),
  alarm_problem: alarmProblem,
  alarm_connectivity: alarmConnectivity,
  'meter_power.load': raw('loads'),
  'meter_power.load_today': (data) => firstNumber(data.loadsToday),
};

// Variables that prove a grid meter is present (pairing). Not loads* or R/S/T Freq/Volt: those
// exist without a meter (the document files them under "Grid", the inverter's own connection).
const meterDetectVariables = ['gridConsumptionPower', 'meterPower', 'feedinPower', 'gridConsumption', 'feedin'];

const meterVariables = [
  ...meterDetectVariables,
  'RFreq', 'RVolt', 'SVolt', 'TVolt',
  'meterPowerR', 'meterPowerS', 'meterPowerT', 'loadsPower', 'loads',
  'currentFault', 'currentFaultCount', 'runningState',
];

// ---------------------------------------------------------------- heat pump

// Heat pumps have no real/query data: the OpenAPI only has the /op/v0/heat/... settings; live
// measurements are Kafka-only (per-company onboarding). The driver merges the dhwControls,
// heatingControls and register-list responses into one flat object for these mappers.
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
 * Whether a mapped value proves the hardware behind an optional capability. A zero does not: an
 * unconnected PV string or a missing phase also reads 0.
 */
const isEvidence = (value) => value !== undefined && value !== null
  && !(typeof value === 'number' && (Number.isNaN(value) || value === 0));

// ---------------------------------------------------------------- evidence
//
// Overrides of isEvidence for values that are legitimately 0 on hardware that has them.
const batteryEvidence = {
  // 0 A while idle; a battery that reports its voltage has a current
  measure_current: (data) => firstNumber(data.invBatCurrent) !== undefined
    && isEvidence(batteryOptional.measure_voltage(data)),
};

const inverterEvidence = {
  'meter_power.month': (data) => present(solarValue('meter_power.month')(data)), // 0 until the first sunny hour
  active_faults: faultsReported,
  measure_apparent_power: (data) => isEvidence(firstNumber(data.ReactivePower)),
};

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

// Tile order per driver (base, optional and extra capabilities), as com.solarwatt orders them.
// A device's list is this order filtered to what it has.
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

/** The capabilities every device of the driver has, in tile order. */
const baseCapabilities = (driverId) => capabilityOrder(driverId).filter((cap) => cap in driverDef(driverId).base);

/** The capabilities a device only gets once it has reported them. */
const optionalCapabilities = (driverId) => Object.keys(driverDef(driverId).optional);

/** The real-time variables to request for a device of this driver. */
const pointList = (driverId) => [...driverDef(driverId).variables];

/**
 * A device's capability list: base, reported optional and extra capabilities, in tile order.
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

// Keyed by device type; battery and meter values come from the inverter's payload, hence both keys.
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
