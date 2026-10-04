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

// registerStatus values, from register/status/change ("pending、approved、revoked"). Only an
// approved heat pump can be read or controlled.
const APPROVED = 'approved';
const REVOKED = 'revoked';

const listOf = (response) => response?.result?.data || response?.result?.pageList || response?.data || [];
const heatSnOf = (hp) => String(hp?.heatSN || hp?.heatSn || hp?.sn || '');
const moduleSnOf = (hp) => String(hp?.moduleSN || hp?.moduleSn || '');
const registerStatusOf = (hp) => String(hp?.registerStatus || '').toLowerCase();

module.exports = class MyDevice extends CommonDriver {

  async onInit() {
    await super.onInit();
    this.statusCache = null;
  }

  /**
   * The register_heatpump pair view: register the heat pump whose outdoor unit serial the user
   * entered (heat/register), unless the register list already has it. An empty serial skips
   * this, and the device list shows the heat pumps already registered on the account.
   */
  onPairHandlers(session, getClient) {
    this.pairHeatSn = '';
    session.setHandler('register_heatpump', async ({ sn } = {}) => {
      const client = getClient();
      if (!client) throw new Error(this.homey.__('errors.apiKeyRequired'));
      const heatSn = String(sn || '').trim();
      this.pairHeatSn = heatSn;
      if (!heatSn) return { registered: false };
      const listed = listOf(await client.getHeatPumpList({ sn: heatSn })).find((hp) => heatSnOf(hp) === heatSn);
      if (listed) return { registered: true, status: registerStatusOf(listed) };
      try {
        await client.registerHeatPump({ sn: heatSn });
      } catch (error) {
        throw new Error(`${this.homey.__('errors.heatpumpRegisterFailed')} ${error.message || error}`);
      }
      this.log(`[Pair] Registered heat pump ${heatSn}`);
      return { registered: true, status: 'pending' };
    });
  }

  /**
   * Heat pumps are not returned by /op/v0/device/list - they live in their own registry -
   * so this replaces the plant/device walk in CommonDriver entirely. Approved and pending heat
   * pumps are offered (a pending one becomes available once approved); revoked ones are not.
   * @param {object} args
   * @param {object} args.client
   * @returns {Promise<object[]>} the devices to show in the pair list
   */
  async onPairListDevices({ client }) {
    this.log('[Pair] Searching for FoxESS heat pumps...');

    // The whole list, and - when one was entered - the heat pump just registered, in case the
    // empty `sn` turns out not to list everything (the document does not say what `sn` does).
    const queries = [''];
    if (this.pairHeatSn) queries.push(this.pairHeatSn);
    const byHeatSn = new Map();
    for (const sn of queries) {
      // eslint-disable-next-line no-await-in-loop
      const response = await client.getHeatPumpList({ sn }).catch((err) => {
        this.error(`[Pair] Error fetching heat pump list${sn ? ` for ${sn}` : ''}:`, err.message || err);
        return null;
      });
      this.log('[Pair] Raw heat pump list response:', JSON.stringify(response));
      listOf(response).forEach((hp) => {
        const key = heatSnOf(hp) || moduleSnOf(hp);
        if (key) byHeatSn.set(key, hp);
      });
    }

    const devices = [...byHeatSn.values()]
      .filter((hp) => registerStatusOf(hp) !== REVOKED)
      .map((hp) => {
        const heatSn = heatSnOf(hp);
        const moduleSn = moduleSnOf(hp);
        return {
          name: `Fox ESS ${hp.deviceType || 'Heat pump'} ${heatSn || moduleSn}`.trim(),
          data: {
            id: heatSn || moduleSn,
          },
          settings: {
            heatSn,
            moduleSn,
            deviceSn: moduleSn, // the heat controls key on the gateway module
            deviceType: 'heatpump',
            productType: String(hp.deviceType || ''),
            masterVersion: String(hp.masterVersion || ''),
            registerStatus: registerStatusOf(hp),
          },
        };
      });

    this.log('[Pair] Found Homey devices:', JSON.stringify(devices));
    return devices;
  }

  /**
   * One heat pump's entry in the shared (briefly cached) register list: by its outdoor unit
   * serial, or by its module serial for a device that has no outdoor serial.
   * @returns {Promise<object|null>} the register-list entry, or null when not listed
   */
  async getHeatPumpEntry({ client, heatSn, moduleSn }) {
    if (!this.statusCache || (Date.now() - this.statusCache.time) > STATUS_CACHE_MS) {
      const response = await client.getHeatPumpList({ sn: '' });
      this.statusCache = { time: Date.now(), list: listOf(response) };
    }
    return this.statusCache.list.find((hp) => (heatSn ? heatSnOf(hp) === heatSn : moduleSnOf(hp) === moduleSn)) || null;
  }

  /**
   * Heat pumps have no real/query support, so the register list and the two settings endpoints
   * are merged into the flat object that CommonDevice.handleData() expects. The controls are only
   * read for an approved heat pump with a known module; otherwise the payload carries just the
   * registration, which the device shows.
   * @returns {Promise<object>} flat data for foxEssPointMap.heatpumpMap
   */
  async pollHeatPump({ client, heatSn, moduleSn }) {
    this.log(`[Poll] Polling heat pump ${heatSn || moduleSn}...`);

    const entry = await this.getHeatPumpEntry({ client, heatSn, moduleSn });
    if (!entry) throw Error(`Heat pump ${heatSn || moduleSn} is not in the register list`);
    const registerStatus = registerStatusOf(entry);
    const module = moduleSnOf(entry) || moduleSn;
    const flat = {
      registerStatus,
      moduleSn: module,
      runningStatus: entry.runningStatus,
      masterVersion: entry.masterVersion,
    };
    if (registerStatus !== APPROVED || !module) return flat;

    const [heating, dhw] = await Promise.all([
      client.getHeatHeatingControls({ moduleSn: module }).catch((err) => {
        this.error('[Poll] Error polling heatingControls:', err.message || err);
        return null;
      }),
      client.getHeatDhwControls({ moduleSn: module }).catch((err) => {
        this.error('[Poll] Error polling dhwControls:', err.message || err);
        return null;
      }),
    ]);

    const heatingResult = heating?.result || heating?.data || {};
    const dhwResult = dhw?.result || dhw?.data || {};

    return {
      ...flat,
      workMode: heatingResult.workMode,
      dhwEnable: dhwResult.enable,
      dhwTemp: dhwResult.dhwTemp,
      // kept so the device can merge a change into the current settings before writing back
      heatingControls: heating ? heatingResult : undefined,
      dhwControls: dhw ? dhwResult : undefined,
    };
  }

};

module.exports.APPROVED = APPROVED;
