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

// register list cache per client: one call per account per poll tick
const STATUS_CACHE_MS = 60 * 1000;

// registerStatus values (register/status/change: "pending、approved、revoked")
const PENDING = 'pending';
const REVOKED = 'revoked';
const UNAPPROVED = [PENDING, REVOKED];

// one call each, 1.1 s apart: stays inside Homey's 30 s pairing timeout
const MAX_PROBED_MODULES = 8;

const listOf = (response) => response?.result?.data || response?.result?.pageList || response?.data || [];
const heatSnOf = (hp) => String(hp?.heatSN || hp?.heatSn || hp?.sn || '');
const moduleSnOf = (hp) => String(hp?.moduleSN || hp?.moduleSn || '');
const registerStatusOf = (hp) => String(hp?.registerStatus || '').toLowerCase();
const resultOf = (response) => response?.result || response?.data || null;
const reasonOf = (error) => String(error?.message || error);

/*
Beta, read-only: only query endpoints are called (no heat/register, no set endpoints), as their
effect has not been seen live. Calls are logged with [HP] for diagnostics reports.
*/
module.exports = class MyDriver extends CommonDriver {

  async onInit() {
    await super.onInit();
    this.statusCache = new WeakMap(); // client -> { time, list } or { pending }
  }

  /**
   * Heat pumps are not in device/list. Offered: register-list entries (not revoked), and modules
   * whose heating controls can be read.
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
            deviceSn: moduleSn,
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
   * A heat pump's entry in the cached register list, by heat SN or else module SN.
   * @returns {Promise<object|null>} the register-list entry, or null when not listed
   */
  async getHeatPumpEntry({ client, heatSn, moduleSn }) {
    if (!this.statusCache) this.statusCache = new WeakMap();
    let cached = this.statusCache.get(client);
    if (!cached || (!cached.pending && (Date.now() - cached.time) > STATUS_CACHE_MS)) {
      const pending = client.getHeatPumpList()
        .then((response) => {
          const list = listOf(response);
          this.statusCache.set(client, { time: Date.now(), list });
          return list;
        }, (error) => {
          this.statusCache.delete(client);
          throw error;
        });
      cached = { pending };
      this.statusCache.set(client, cached);
    }
    const list = cached.pending ? await cached.pending : cached.list;
    return list.find((hp) => (heatSn ? heatSnOf(hp) === heatSn : moduleSnOf(hp) === moduleSn)) || null;
  }

  /**
   * Register-list entry plus heating and DHW settings as one flat payload. Settings are read
   * whatever the registration status; throws when nothing was read and no status explains why.
   * @returns {Promise<object>} flat data for foxEssPointMap.heatpumpMap
   */
  async pollHeatPump({ client, heatSn, moduleSn }) {
    const id = heatSn || moduleSn;
    const entry = await this.getHeatPumpEntry({ client, heatSn, moduleSn }).catch((error) => {
      this.log(`[HP] ${id}: register list failed:`, reasonOf(error));
      return undefined;
    });
    if (entry === null) this.log(`[HP] ${id}: not in the register list`);
    const registerStatus = (entry && registerStatusOf(entry)) || undefined;
    const module = moduleSnOf(entry) || moduleSn;
    const flat = {
      registerStatus,
      moduleSn: module || undefined,
      runningStatus: entry?.runningStatus,
      masterVersion: entry?.masterVersion,
    };
    const explained = UNAPPROVED.includes(registerStatus);
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

module.exports.UNAPPROVED = UNAPPROVED;
