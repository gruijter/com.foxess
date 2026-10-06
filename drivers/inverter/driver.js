/*
Copyright 2025 - 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.foxess.

com.foxess is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.foxess is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.foxess.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const CommonDriver = require('../../lib/common_driver');
const foxEssPointMap = require('../../lib/foxEssPointMap');
const { localDate } = require('../../lib/foxEssTiming');

module.exports = class MyDevice extends CommonDriver {

  async onInit() {
    await super.onInit();
  }

  /**
   * Today's and this month's yield: { pvToday, pvMonth } (DC) and { acToday, acMonth } (AC), from
   * the month report in plant time; device/generation (AC, equals `generation`) when it fails.
   * @param {object} args
   * @param {object} args.client
   * @param {string} args.deviceSn
   * @param {string} [args.snapshotTime] the latest real-time `time`, for the plant's own date
   * @returns {Promise<object>}
   */
  async energyFields({ client, deviceSn, snapshotTime }) {
    const { year, month, day } = localDate(snapshotTime, this.homey?.clock?.getTimezone?.() || 'UTC');
    const report = await this.tryCall('energy report', async () => (await client.getDeviceReport({
      sn: deviceSn, dimension: 'month', year, month, variables: ['PVEnergyTotal', 'generation'],
    }))?.result);
    const fromReport = (variable) => {
      const row = Array.isArray(report) ? report.find((r) => r?.variable === variable) : null;
      if (!Array.isArray(row?.values)) return null;
      const today = Number(row.values[day - 1]);
      if (!Number.isFinite(today)) return null;
      const total = row.values.reduce((sum, v) => sum + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
      return { today, month: total };
    };
    const pv = fromReport('PVEnergyTotal');
    let ac = fromReport('generation');
    if (!report) {
      const generation = await this.tryCall('device generation', async () => (await client.getDeviceGeneration({ sn: deviceSn }))?.result);
      if (generation) ac = { today: generation.today, month: generation.month };
    }
    return {
      ...(pv ? { pvToday: pv.today, pvMonth: pv.month } : {}),
      ...(ac ? { acToday: ac.today, acMonth: ac.month } : {}),
    };
  }

  /** Adds hasBattery (decides the solar sides) and the yield. */
  async pairExtraData(args) {
    const hasBattery = args.dev?.hasBattery ?? args.dev?.hasbattery;
    return {
      ...(await super.pairExtraData(args)),
      ...(typeof hasBattery === 'boolean' ? { hasBattery } : {}),
      ...(await this.energyFields(args)),
    };
  }

  /** The solar sides, decided at pairing (foxEssPointMap.inverterSolarSides). */
  pairStore({ dev, payload, detail }) {
    const hasBattery = dev?.hasBattery ?? detail?.hasBattery;
    return {
      solarSides: foxEssPointMap.inverterSolarSides({
        hasBattery: typeof hasBattery === 'boolean' ? hasBattery : undefined,
        acPower: foxEssPointMap.acPowerReported(payload),
      }),
    };
  }

  /** Export limit support: the ExportLimit setting is readable. */
  async checkSupport({ client, deviceSn }) {
    const value = await this.tryCall('export limit check', async () => Number((await client.getSetting({ sn: deviceSn, key: 'ExportLimit' }))?.result?.value));
    if (!Number.isFinite(value)) return { support: {}, readings: {} };
    return { support: { exportLimitSupported: true }, readings: { exportLimit: value } };
  }

  extraCapabilities(store) {
    return store?.exportLimitSupported ? ['export_limit', 'alarm_generic.control', 'inverter_limit_active'] : [];
  }

};
