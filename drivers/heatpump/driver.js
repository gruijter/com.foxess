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

// registerStatus values, from register/status/change ("pending、approved、revoked").
const APPROVED = 'approved';
const REVOKED = 'revoked';

// At most this many module serials are tried as a heat pump gateway while pairing: each try is one
// call on the same path, 1.1 s apart, and the whole list_devices handler must stay inside Homey's
// 30 s pair timeout.
const MAX_PROBED_MODULES = 8;

const listOf = (response) => response?.result?.data || response?.result?.pageList || response?.data || [];
const heatSnOf = (hp) => String(hp?.heatSN || hp?.heatSn || hp?.sn || '');
const moduleSnOf = (hp) => String(hp?.moduleSN || hp?.moduleSn || '');
const registerStatusOf = (hp) => String(hp?.registerStatus || '').toLowerCase();
const resultOf = (response) => response?.result || response?.data || null;
const reasonOf = (error) => String(error?.message || error);

/*
Beta: read-only. Pairing and polling only call query endpoints; nothing is registered (heat/register)
or written (the settings set endpoints), because what those do to an owner's heat pump has not been
seen live. Every call and its outcome is logged with a [HP] prefix, so a diagnostics report from a
beta tester shows which endpoints answer and how; the response bodies are captured (foxEssCapture).
*/
module.exports = class MyDriver extends CommonDriver {

  async onInit() {
    await super.onInit();
    this.statusCache = null;
  }

  /**
   * Heat pumps are not returned by /op/v0/device/list, so this replaces the plant/device walk in
   * CommonDriver entirely. Two read-only routes:
   * - the register list: heat pumps registered on the account, with their module serial;
   * - the account's modules (data loggers): a module whose heating controls can be read is a heat
   *   pump gateway, also when the register list does not have it.
   * Revoked heat pumps are not offered.
   * @param {object} args
   * @param {object} args.client
   * @returns {Promise<object[]>} the devices to show in the pair list
   */
  async onPairListDevices({ client }) {
    this.log('[HP] Pair: searching for FoxESS heat pumps (read-only)...');
    const found = new Map(); // moduleSn or heatSn -> what is known about it

    const registered = await client.getHeatPumpList().then(listOf, (error) => {
      this.log('[HP] Pair: register list failed:', reasonOf(error));
      return [];
    });
    this.log(`[HP] Pair: register list has ${registered.length} heat pump(s):`, JSON.stringify(registered));
    registered.forEach((hp) => {
      const key = moduleSnOf(hp) || heatSnOf(hp);
      if (key) found.set(key, { entry: hp, moduleSn: moduleSnOf(hp) });
    });

    const modules = await client.getModuleList().then(listOf, (error) => {
      this.log('[HP] Pair: module list failed:', reasonOf(error));
      return [];
    });
    this.log(`[HP] Pair: account has ${modules.length} module(s)`);
    const candidates = [...new Set([
      ...[...found.values()].map((f) => f.moduleSn),
      ...modules.map(moduleSnOf),
    ].filter(Boolean))].slice(0, MAX_PROBED_MODULES);

    for (const moduleSn of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await client.getHeatControls({ moduleSn, kind: 'heating' })
        .then((response) => ({ ok: Boolean(resultOf(response)), result: resultOf(response) }), (error) => ({ ok: false, reason: reasonOf(error) }));
      this.log(`[HP] Pair: heating controls of module ${moduleSn}:`, outcome.ok ? 'readable' : (outcome.reason || 'empty'));
      if (!outcome.ok) continue;
      const known = found.get(moduleSn) || { entry: null, moduleSn };
      found.set(moduleSn, { ...known, readable: true });
    }

    const devices = [...found.values()]
      .filter(({ entry, readable }) => (entry ? registerStatusOf(entry) !== REVOKED : readable))
      .map(({ entry, moduleSn }) => {
        const heatSn = heatSnOf(entry);
        return {
          name: `Fox ESS ${entry?.deviceType || 'Heat pump'} ${heatSn || moduleSn}`.trim(),
          data: {
            id: heatSn || moduleSn,
          },
          settings: {
            heatSn,
            moduleSn,
            deviceSn: moduleSn, // the heat controls key on the gateway module
            deviceType: 'heatpump',
            productType: String(entry?.deviceType || ''),
            masterVersion: String(entry?.masterVersion || ''),
            registerStatus: entry ? registerStatusOf(entry) : '',
          },
        };
      });

    this.log('[HP] Pair: offering:', JSON.stringify(devices));
    return devices;
  }

  /**
   * One heat pump's entry in the shared (briefly cached) register list: by its outdoor unit
   * serial, or by its module serial for a device that has no outdoor serial.
   * @returns {Promise<object|null>} the register-list entry, or null when not listed
   */
  async getHeatPumpEntry({ client, heatSn, moduleSn }) {
    if (!this.statusCache || (Date.now() - this.statusCache.time) > STATUS_CACHE_MS) {
      const response = await client.getHeatPumpList();
      this.statusCache = { time: Date.now(), list: listOf(response) };
    }
    return this.statusCache.list.find((hp) => (heatSn ? heatSnOf(hp) === heatSn : moduleSnOf(hp) === moduleSn)) || null;
  }

  /**
   * Heat pumps have no real/query support, so the register list and the heating and DHW settings
   * are merged into the flat object that CommonDevice.handleData() expects.
   *
   * The settings are read whenever a module is known, whatever the registration says: a read
   * cannot harm, and whether a pending heat pump can be read is exactly what the beta must show.
   * Throws when nothing could be read and no registration explains why.
   * @returns {Promise<object>} flat data for foxEssPointMap.heatpumpMap
   */
  async pollHeatPump({ client, heatSn, moduleSn }) {
    const id = heatSn || moduleSn;
    const entry = await this.getHeatPumpEntry({ client, heatSn, moduleSn }).catch((error) => {
      this.log(`[HP] ${id}: register list failed:`, reasonOf(error));
      return undefined;
    });
    if (entry === null) this.log(`[HP] ${id}: not in the register list`);
    const registerStatus = entry ? registerStatusOf(entry) : undefined;
    const module = moduleSnOf(entry) || moduleSn;
    const flat = {
      registerStatus,
      moduleSn: module || undefined,
      runningStatus: entry?.runningStatus,
      masterVersion: entry?.masterVersion,
    };
    const explained = registerStatus !== undefined && registerStatus !== APPROVED;
    if (!module) {
      if (explained) return flat;
      throw Error(`Heat pump ${id} has no module serial`);
    }

    const read = (kind) => client.getHeatControls({ moduleSn: module, kind })
      .then((response) => resultOf(response) || {}, (error) => {
        this.log(`[HP] ${id}: ${kind} controls of module ${module} failed:`, reasonOf(error));
        return null;
      });
    const [heating, dhw] = await Promise.all([read('heating'), read('dhw')]);
    if (!heating && !dhw) {
      if (explained) return flat;
      throw Error(`Heat pump ${id}: settings could not be read`);
    }

    return {
      ...flat,
      workMode: heating?.workMode,
      dhwEnable: dhw?.enable,
      dhwTemp: dhw?.dhwTemp,
    };
  }

};

module.exports.APPROVED = APPROVED;
