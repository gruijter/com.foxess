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
   * Control needs the scheduler (the only way FoxESS offers to charge or discharge at a chosen
   * power); SoC limits need a readable battery/soc/get. Read along the way: the scheduler switch
   * and the limits themselves. A failed check reports nothing, so the store keeps its last answer.
   */
  async checkSupport({ client, deviceSn }) {
    const support = {};
    const readings = {};
    const flag = await this.tryCall('scheduler support check', async () => (await client.getSchedulerFlag({ sn: deviceSn }))?.result);
    if (flag) {
      support.controlSupported = Boolean(flag.support);
      readings.schedulerOn = Boolean(flag.enable);
    }
    const soc = await this.tryCall('SoC limits check', async () => (await client.getBatterySoc({ sn: deviceSn }))?.result);
    const minSoc = Number(soc?.minSoc);
    const minSocOnGrid = Number(soc?.minSocOnGrid);
    if (Number.isFinite(minSoc) && Number.isFinite(minSocOnGrid)) {
      // supported once read; like an optional capability, never withdrawn on a failure
      support.socLimitsSupported = true;
      readings.socLimits = { minSoc, minSocOnGrid };
    }
    // shown, not set: a MaxSoc write is accepted and ignored (see drivers/battery/device.js)
    const rawMaxSoc = await this.tryCall('max SoC check', async () => (await client.getSetting({ sn: deviceSn, key: 'MaxSoc' }))?.result?.value);
    const maxSoc = rawMaxSoc === null || rawMaxSoc === undefined || rawMaxSoc === '' ? NaN : Number(rawMaxSoc);
    if (Number.isFinite(maxSoc)) {
      support.maxSocSupported = true;
      readings.maxSoc = maxSoc;
    }
    return { support, readings };
  }

  extraCapabilities(store) {
    const caps = store?.controlSupported ? ['measure_power.target', 'target_power', 'target_power_mode'] : [];
    if (store?.socLimitsSupported) caps.push('battery_min_soc', 'battery_min_soc_ongrid');
    if (caps.length) caps.push('alarm_generic.control');
    if (store?.maxSocSupported) caps.push('battery_max_soc');
    return caps;
  }

};
