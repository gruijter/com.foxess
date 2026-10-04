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

// The heat pump register list is the same response for every heat pump device, so cache it
// briefly to keep one poll cycle at a single call instead of one call per paired device.
const STATUS_CACHE_MS = 60 * 1000;

module.exports = class MyDevice extends CommonDriver {

  async onInit() {
    await super.onInit();
    this.statusCache = null;
  }

  /**
   * Heat pumps are not returned by /op/v0/device/list - they live in their own registry -
   * so this replaces the plant/device walk in CommonDriver entirely.
   * @param {object} args
   * @param {object} args.client
   * @returns {Promise<object[]>} the devices to show in the pair list
   */
  async onPairListDevices({ client }) {
    this.log('[Pair] Searching for FoxESS heat pumps...');

    const response = await client.getHeatPumpList().catch((err) => {
      this.error('[Pair] Error fetching heat pump list:', err);
      return null;
    });

    this.log('[Pair] Raw heat pump list response:', JSON.stringify(response));

    const list = response?.result?.data || response?.result?.pageList || response?.data || [];

    const devices = list
      .filter((hp) => hp.moduleSN || hp.moduleSn)
      .map((hp) => {
        const heatSn = hp.heatSN || hp.heatSn || hp.sn;
        const moduleSn = hp.moduleSN || hp.moduleSn;
        return {
          name: `Fox ESS ${hp.deviceType || 'Heat pump'} ${heatSn || ''}`.trim(),
          data: {
            id: heatSn || moduleSn,
          },
          settings: {
            heatSn: String(heatSn || ''),
            moduleSn: String(moduleSn),
            deviceName: String(heatSn || moduleSn),
            deviceSn: String(moduleSn), // CommonDevice polls on deviceSn; the heat API keys on moduleSn
            deviceType: 'heatpump',
            productType: String(hp.deviceType || ''),
            masterVersion: String(hp.masterVersion || ''),
          },
        };
      });

    this.log('[Pair] Found Homey devices:', JSON.stringify(devices));
    return devices;
  }

  /**
   * Running status for one heat pump, from the shared (briefly cached) register list.
   * @returns {Promise<object|null>} the register-list entry, or null when not listed
   */
  async getHeatPumpStatus({ client, moduleSn }) {
    if (!this.statusCache || (Date.now() - this.statusCache.time) > STATUS_CACHE_MS) {
      const response = await client.getHeatPumpList();
      const list = response?.result?.data || response?.result?.pageList || response?.data || [];
      this.statusCache = { time: Date.now(), list };
    }
    return this.statusCache.list.find((hp) => (hp.moduleSN || hp.moduleSn) === moduleSn) || null;
  }

  /**
   * Heat pumps have no /op/v0/device/real/query support, so the three settings endpoints are
   * merged into the single flat object that CommonDevice.handleData() expects.
   * @returns {Promise<object>} flat data for foxEssPointMap.heatpumpMap
   */
  async pollDeviceType({ client, deviceSn }) {
    this.log(`[Poll] Polling heat pump module ${deviceSn}...`);

    const [heating, dhw, status] = await Promise.all([
      client.getHeatHeatingControls({ moduleSn: deviceSn }).catch((err) => {
        this.error('[Poll] Error polling heatingControls:', err);
        return null;
      }),
      client.getHeatDhwControls({ moduleSn: deviceSn }).catch((err) => {
        this.error('[Poll] Error polling dhwControls:', err);
        return null;
      }),
      this.getHeatPumpStatus({ client, moduleSn: deviceSn }).catch((err) => {
        this.error('[Poll] Error polling heat pump status:', err);
        return null;
      }),
    ]);

    // Without the settings the runningStatus alone still tells fault or offline, so only give up
    // when nothing at all came back.
    if (!heating && !dhw && !status) throw Error(`No heat pump data for module ${deviceSn}`);

    const heatingResult = heating?.result || heating?.data || {};
    const dhwResult = dhw?.result || dhw?.data || {};

    return {
      workMode: heatingResult.workMode,
      dhwEnable: dhwResult.enable,
      dhwTemp: dhwResult.dhwTemp,
      runningStatus: status?.runningStatus,
      // kept so the device can merge a change into the current settings before writing back
      heatingControls: heatingResult,
      dhwControls: dhwResult,
    };
  }

};
