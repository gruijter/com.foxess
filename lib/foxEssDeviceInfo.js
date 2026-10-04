'use strict';

/*
The read-only device information on a device's settings page, from /op/v0/device/detail. Same
fields as com.solarwatt shows for the same hardware: model, firmware, and for the battery its
modules and design capacity. Pure, so it can be tested against a capture.

device/detail (verified on De Brik, an H3-G2): deviceType 'P3-10.0-SH', productType 'H3-G2',
masterVersion / slaveVersion / managerVersion, capacity (rated power, kW), batteryDesignCapacity
(kWh), and batteryList with one entry per BCU (battery controller), BMU (one per module, with its
capacity in Wh) and IVU.
*/

const text = (value) => (value === undefined || value === null ? '' : String(value).trim());

/** "P3-10.0-SH (H3-G2)": the model, with the product series when the detail gives it. */
const model = (detail) => {
  const type = text(detail.deviceType);
  const series = text(detail.productType);
  if (type && series && type !== series) return `${type} (${series})`;
  return type || series;
};

/** "master 1.49, slave 1.00, manager 1.31", in FoxCloud's own terms. */
const inverterFirmware = (detail) => [['master', detail.masterVersion], ['slave', detail.slaveVersion], ['manager', detail.managerVersion]]
  .filter(([, version]) => text(version))
  .map(([name, version]) => `${name} ${text(version)}`)
  .join(', ');

const batteries = (detail, type) => (Array.isArray(detail.batteryList) ? detail.batteryList : [])
  .filter((b) => String(b.type).toLowerCase() === type);

/**
 * The settings values for a device of `driverId`. Only the fields this driver shows; a field the
 * detail does not carry comes out as '' (the label stays empty rather than showing stale data).
 * @param {string} driverId inverter, battery or meter
 * @param {object} detail the result of /op/v0/device/detail
 * @returns {Object<string, string>} setting id -> value
 */
const deviceInfoSettings = (driverId, detail) => {
  // a meter has no model or firmware of its own in FoxCloud: its page shows only the inverter
  if (!detail || driverId === 'meter') return {};
  const settings = { deviceModelCode: model(detail) };
  if (driverId === 'inverter') {
    settings.firmware = inverterFirmware(detail);
    const kw = Number(detail.capacity);
    settings.ratedPower = kw > 0 ? `${kw} kW` : '';
  }
  if (driverId === 'battery') {
    const modules = batteries(detail, 'bmu');
    const bcu = batteries(detail, 'bcu')[0];
    settings.deviceModelCode = text(modules[0]?.model || bcu?.model) || settings.deviceModelCode;
    settings.firmware = bcu && text(bcu.version) ? `BMS ${text(bcu.version)}` : '';
    settings.batteryModules = modules.length ? String(modules.length) : '';
    settings.batteryModuleList = modules
      .map((m) => [text(m.batterySN), text(m.model), text(m.version) ? `(v${text(m.version)})` : ''].filter(Boolean).join(' '))
      .join(', ');
    const kWh = Number(detail.batteryDesignCapacity);
    settings.batteryDesignEnergy = kWh > 0 ? `${kWh} kWh` : '';
  }
  return settings;
};

module.exports = { deviceInfoSettings };
