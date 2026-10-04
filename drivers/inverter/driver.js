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

module.exports = class MyDevice extends CommonDriver {

  async onInit() {
    await super.onInit();
  }

  /**
   * Today's and this month's yield from /op/v0/device/generation, as flat payload fields.
   * @returns {Promise<object>} { generationToday, generationMonth }, or {} when unavailable
   */
  async generationFields({ client, deviceSn }) {
    const result = await this.tryCall('device generation', async () => (await client.getDeviceGeneration({ sn: deviceSn }))?.result);
    return result ? { generationToday: result.today, generationMonth: result.month } : {};
  }

  /** On top of the device status: the yield, which feeds meter_power.month. */
  async pairExtraData(args) {
    return { ...(await super.pairExtraData(args)), ...(await this.generationFields(args)) };
  }

  /**
   * The ExportLimit setting: supported once read (never withdrawn on a failure). Its value is in
   * W per the document's own example ("13000"); the setting/get answer carries no unit.
   */
  async checkSupport({ client, deviceSn }) {
    const value = await this.tryCall('export limit check', async () => Number((await client.getSetting({ sn: deviceSn, key: 'ExportLimit' }))?.result?.value));
    if (!Number.isFinite(value)) return { support: {}, readings: {} };
    return { support: { exportLimitSupported: true }, readings: { exportLimit: value } };
  }

  extraCapabilities(store) {
    return store?.exportLimitSupported ? ['export_limit', 'alarm_generic.control'] : [];
  }

};
