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

/* eslint-disable camelcase */

'use strict';

const Homey = require('homey');

const foxEssPointMap = require('./foxEssPointMap');
const { regionById, hostOf, regionIdOf } = require('./foxEssRegions');
const capture = require('./foxEssCapture');
const { deviceInfoSettings } = require('./foxEssDeviceInfo');

module.exports = class CommonDriver extends Homey.Driver {

  async onInit() {
    this.log(`${this.id} driver has been initialized`);
  }

  // --- the capability list, shared by pairing and the device ---
  // Pairing builds it the same way the device does (base + seenCaps + extras), so a new device
  // starts complete.

  /**
   * The pairing counterpart of CommonDevice.pollExtra.
   * @returns {Promise<object>} flat fields to merge into the real-time payload
   */
  async pairExtraData({ dev }) {
    const status = Number(dev?.status);
    return Number.isNaN(status) ? {} : { deviceStatus: status };
  }

  /**
   * What the unit supports beyond its readings (control, settings). Must not throw.
   * @returns {Promise<{support: object, readings: object}>} support facts for the store
   */
  async checkSupport({ client, deviceSn }) { // eslint-disable-line no-unused-vars
    return { support: {}, readings: {} };
  }

  /**
   * Store values a driver decides at pairing.
   * @param {object} args
   * @param {object} args.dev the device list entry
   * @param {object} args.payload the flat real-time payload plus pairExtraData
   * @param {object|null} args.detail the device detail
   * @returns {object}
   */
  pairStore({ dev, payload, detail }) { // eslint-disable-line no-unused-vars
    return {};
  }

  /**
   * Capabilities that follow from stored support facts.
   * @param {object} store the device store (or the store a pairing is about to give it)
   * @returns {string[]}
   */
  extraCapabilities(store) { // eslint-disable-line no-unused-vars
    return [];
  }

  /** Run one support check: its value, or null when it failed. */
  async tryCall(label, fn) {
    try {
      return await fn();
    } catch (error) {
      this.error(`${label} failed:`, error.message || error);
      return null;
    }
  }

  /**
   * Check an API key and region by listing the plants; returns their client.
   * @returns {Promise<FoxEssClient>}
   */
  async login({ apiKey, region } = {}) {
    const key = String(apiKey || '').trim();
    if (!key) throw new Error(this.homey.__('errors.apiKeyRequired'));
    if (!regionById(region)) throw new Error(`${this.homey.__('errors.unknownRegion')} ${region}`);
    const client = this.homey.app.getClient({ apiKey: key, region });
    try {
      await client.getPlantList();
    } catch (err) {
      throw new Error(`${this.homey.__('errors.loginFailed')} ${err.message || err}`);
    }
    // pre-fills the next pairing
    this.homey.app.setSavedCredentials({ apiKey: key, region });
    this.log(`API key accepted (${hostOf(region)})`);
    return client;
  }

  /**
   * Pairing: API key and region (pre-filled with the last ones used), then the device list.
   * @param {PairSession} session
   */
  onPair(session) {
    let credentials = this.homey.app.getSavedCredentials();
    let client = null;

    session
      .setHandler('get_credentials', async () => credentials)
      .setHandler('login', async (data) => {
        client = await this.login(data);
        credentials = { apiKey: client.apiKey, region: data.region };
        return { done: false };
      })
      .setHandler('list_devices', async () => {
        if (!client) throw new Error(this.homey.__('errors.apiKeyRequired'));
        capture.arm(`pairing ${this.id}`, { force: true });
        const devices = await this.onPairListDevices({ client });
        return devices.map((device) => ({
          ...device,
          store: {
            ...device.store,
            apiKey: credentials.apiKey,
            region: credentials.region,
          },
          settings: {
            ...device.settings,
            region: hostOf(credentials.region),
          },
        }));
      })
      .setHandler('disconnect', async () => this.log('Pair session disconnected'));
    this.onPairHandlers(session, () => client);
  }

  /**
   * Hook for a driver's own pair views between login and the device list.
   * @param {PairSession} session
   * @param {function(): (FoxEssClient|null)} getClient the client once the key was accepted
   */
  onPairHandlers(session, getClient) { // eslint-disable-line no-unused-vars
    return undefined;
  }

  /**
   * Repair: new API key or region; pre-filled with the device's key, else the last one used.
   * @param {PairSession} session
   * @param {Device} device the device being repaired
   */
  onRepair(session, device) {
    const store = device.getStore();
    const credentials = {
      apiKey: store.apiKey || this.homey.app.getSavedCredentials().apiKey,
      region: regionIdOf(store),
    };

    session
      .setHandler('get_credentials', async () => credentials)
      .setHandler('login', async (data) => {
        const client = await this.login(data);
        await device.setStoreValue('apiKey', client.apiKey);
        await device.setStoreValue('region', data.region);
        await device.setSettings({ region: hostOf(data.region) }).catch(this.error);
        capture.arm(`repair ${this.id}`, { force: true });
        await device.onRepaired();
        device.restartDevice(1000).catch(this.error);
        return { done: true };
      })
      .setHandler('disconnect', async () => this.log('Repair session disconnected'));
  }

  async onPairListDevices({ client }) {
    this.log('[Pair] Searching for FoxESS plants and devices...');
    const devices = [];

    const plantResponse = await client.getPlantList().catch((err) => {
      this.error('[Pair] Error fetching plant list:', err);
      return null;
    });

    this.log('[Pair] Raw plant list response:', JSON.stringify(plantResponse));

    const plantList = plantResponse?.result?.data || plantResponse?.result?.pageList || plantResponse?.data || [];

    for (const site of plantList) {
      const plantID = site.stationID || site.plantID || site.ps_id || site.id;
      const plantName = site.name || site.ps_name || 'Fox ESS Plant';

      const deviceResponse = await client.getDeviceList({ plantID }).catch((err) => {
        this.error(`[Pair] Error fetching device list for plant ${plantID}:`, err);
        return null;
      });

      this.log(`[Pair] Raw device list response for plant ${plantID}:`, JSON.stringify(deviceResponse));

      const allDevices = deviceResponse?.result?.data || deviceResponse?.result?.pageList || deviceResponse?.data || [];

      // device/list documents no plantID filter and lists the whole account
      const devList = allDevices.filter((dev) => {
        const owner = dev.stationID || dev.plantID;
        return !owner || String(owner) === String(plantID);
      });

      // device/list only has inverters; battery and meter are part of one. Battery: hasBattery.
      // Meter: no flag or endpoint (/op/v0/meter/list is 404), so its real-time readings.
      const serials = devList.map((dev) => dev.deviceSN || dev.sn || dev.device_sn).filter(Boolean);
      const realTime = await this.realTimeBySerial({ client, serials, variables: foxEssPointMap.pointList(this.id) });

      for (const dev of devList) {
        const deviceSn = dev.deviceSN || dev.sn || dev.device_sn;
        if (!deviceSn) continue;
        const rawType = (dev.deviceType || dev.device_type || this.id).toLowerCase();
        const productType = dev.productType || dev.deviceModelCode || dev.device_model_code || '';

        let wanted = false;
        if (this.id === 'inverter') wanted = true;
        else if (this.id === 'battery') wanted = Boolean(dev.hasBattery ?? dev.hasbattery);
        else if (this.id === 'meter') wanted = this.reportsAnyOf(realTime.get(deviceSn), foxEssPointMap.meterDetectVariables);

        if (!wanted) continue;

        const payload = { ...realTime.get(deviceSn), ...(await this.pairExtraData({ client, dev, deviceSn })) };
        const seenCaps = foxEssPointMap.seenInPayload(this.id, payload);
        const { support } = await this.checkSupport({ client, deviceSn });
        const capabilities = foxEssPointMap.deviceCapabilities(this.id, seenCaps, this.extraCapabilities(support));

        const detail = (await client.getDeviceDetail({ sn: deviceSn }).catch((err) => {
          this.error(`[Pair] Error fetching device detail for ${deviceSn}:`, err.message || err);
          return null;
        }))?.result || null;

        devices.push({
          name: `${plantName} ${dev.deviceSN || productType || 'Device'}`,
          data: {
            id: deviceSn,
          },
          capabilities,
          store: {
            seenCaps,
            ...support,
            ...this.pairStore({ dev, payload, detail }),
            ...(detail ? {
              capacity: detail.capacity,
              batteryDesignCapacity: detail.batteryDesignCapacity,
              hasPV: detail.hasPV,
              hasBattery: detail.hasBattery,
              masterVersion: detail.masterVersion,
              batteryModules: Array.isArray(detail.batteryList)
                ? [...new Set(detail.batteryList.map((b) => b.batterySN).filter(Boolean))]
                : [],
            } : {}),
          },
          settings: {
            plantId: String(plantID),
            plantName,
            deviceSn,
            deviceType: rawType,
            productType,
            ...deviceInfoSettings(this.id, detail),
          },
        });
      }
    }

    this.log('[Pair] Found Homey devices:', JSON.stringify(devices));
    return devices;
  }

  /**
   * One real-time query for all `serials`, flattened per serial; empty when it fails.
   * @returns {Promise<Map<string, object>>} serial -> { variable: value }
   */
  async realTimeBySerial({ client, serials, variables }) {
    const bySerial = new Map();
    if (!serials.length) return bySerial;
    try {
      const response = await client.getDeviceRealTimeData({ sns: serials, variables });
      const rawData = Array.isArray(response?.result) ? response.result : [];
      for (const devItem of rawData) {
        const flat = {};
        (Array.isArray(devItem.datas) ? devItem.datas : []).forEach((d) => {
          flat[d.variable] = d.value;
        });
        bySerial.set(devItem.deviceSN, flat);
      }
    } catch (err) {
      this.error('[Pair] real-time query failed:', err.message || err);
    }
    return bySerial;
  }

  /** Whether a flat payload has a value for at least one of `variables`. */
  reportsAnyOf(flat, variables) {
    if (!flat) return false;
    return variables.some((v) => flat[v] !== undefined && flat[v] !== null);
  }

  async pollDeviceType({ client, deviceSn, variables }) {
    try {
      this.log(`[Poll] Polling device SN ${deviceSn}...`);
      const response = await client.getDeviceRealTimeData({ sns: [deviceSn], variables });
      const rawData = Array.isArray(response?.result) ? response.result : null;

      const formattedData = {};
      if (rawData) {
        // the batched response holds other serials too: never fall back to another one
        const devItem = rawData.find((d) => d.deviceSN === deviceSn);
        if (!devItem) throw Error(`Device ${deviceSn} was not in the real-time response`);
        // inverter local time with UTC offset
        if (devItem.time) formattedData.snapshotTime = devItem.time;
        if (Array.isArray(devItem.datas)) {
          for (const item of devItem.datas) {
            formattedData[item.variable] = item.value;
          }
        }
      } else {
        this.log(`[Poll] Device ${deviceSn}: no real-time data returned`);
      }

      return formattedData;
    } catch (error) {
      this.error('[Poll] Error polling device:', error);
      throw error;
    }
  }

};
