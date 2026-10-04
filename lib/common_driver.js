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
  // A device's list is its driver's base capabilities, the optional ones it has reported
  // (store seenCaps) and the extra ones its stored support facts allow. Pairing works all three
  // out the same way the device does, so a new device starts complete instead of being migrated
  // on its first poll.

  /**
   * Fields from other endpoints than the real-time query that give evidence for optional
   * capabilities - what CommonDevice.pollExtra adds on a poll. At pairing the device list entry
   * is already in hand: its status feeds alarm_connectivity and alarm_problem.
   * @returns {Promise<object>} flat fields to merge into the real-time payload
   */
  async pairExtraData({ dev }) {
    const status = Number(dev?.status);
    return Number.isNaN(status) ? {} : { deviceStatus: status };
  }

  /**
   * What the unit supports beyond its readings (control, settings), and what was read along the
   * way. Must never throw: a failed check just reports nothing.
   * @returns {Promise<{support: object, readings: object}>} support facts for the store
   */
  async checkSupport({ client, deviceSn }) { // eslint-disable-line no-unused-vars
    return { support: {}, readings: {} };
  }

  /**
   * Capabilities that follow from stored support facts, appended after the data-driven ones.
   * @param {object} store the device store (or the store a pairing is about to give it)
   * @returns {string[]}
   */
  extraCapabilities(store) { // eslint-disable-line no-unused-vars
    return [];
  }

  /**
   * Run one support check: its value, or null when it failed.
   */
  async tryCall(label, fn) {
    try {
      return await fn();
    } catch (error) {
      this.error(`${label} failed:`, error.message || error);
      return null;
    }
  }

  /**
   * Check an API key and region by listing the account's plants, and return the client for them.
   *
   * FoxESS answers an unknown key with HTTP 401, which FoxEssClient throws; the message is
   * prefixed with a translated one, since this surfaces in the pair view.
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
    // remembered for the next pairing, whichever driver it is for
    this.homey.app.setSavedCredentials({ apiKey: key, region });
    this.log(`API key accepted (${hostOf(region)})`);
    return client;
  }

  /**
   * Pairing: API key and region (the login_apikey view), then the device list.
   *
   * The view is pre-filled with the key and region used last, so adding a second device - a
   * battery or meter on the same inverter, or another driver altogether - is one tap.
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
        // A fresh pairing is the richest capture there is: plant list, device list and the first
        // real-time answer, all for an account we have never seen.
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
            // the store's region drives the client; this is the readable copy for the settings page
            region: hostOf(credentials.region),
          },
        }));
      })
      .setHandler('disconnect', async () => this.log('Pair session disconnected'));
    this.onPairHandlers(session, () => client);
  }

  /**
   * Hook for a driver's own pair views between login and the device list. Nothing by default.
   * @param {PairSession} session
   * @param {function(): (FoxEssClient|null)} getClient the client once the key was accepted
   */
  onPairHandlers(session, getClient) { // eslint-disable-line no-unused-vars
    return undefined;
  }

  /**
   * Repair: enter a new API key (or change the region) for an existing device.
   *
   * The view is pre-filled with the device's own key - or, for a device paired before the switch
   * from OAuth, which has none, with the key used last.
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
      // /op/v0/plant/list calls the id `stationID`; it was missing from this chain entirely, so
      // plantID came out undefined and every plantId setting was the string "undefined".
      const plantID = site.stationID || site.plantID || site.ps_id || site.id;
      const plantName = site.name || site.ps_name || 'Fox ESS Plant';

      // Fetch the devices under this plant. Only physical devices become Homey devices - there is
      // deliberately no virtual "plant" aggregate device; one Homey device maps to one real unit.
      const deviceResponse = await client.getDeviceList({ plantID }).catch((err) => {
        this.error(`[Pair] Error fetching device list for plant ${plantID}:`, err);
        return null;
      });

      this.log(`[Pair] Raw device list response for plant ${plantID}:`, JSON.stringify(deviceResponse));

      const allDevices = deviceResponse?.result?.data || deviceResponse?.result?.pageList || deviceResponse?.data || [];

      // /op/v0/device/list documents no plantID parameter at all - it returns "the list of
      // inverters owned by this account". Passing plantID above is harmless, but the answer must
      // be assumed to cover every plant, so filter on each device's own stationID. Without this,
      // an account with two plants would attach all devices to both of them.
      const devList = allDevices.filter((dev) => {
        const owner = dev.stationID || dev.plantID;
        return !owner || String(owner) === String(plantID);
      });

      // Detect which units this driver represents rather than guessing from a single-device
      // account. device/list only ever returns inverters, and a battery/meter is not its own
      // device - it lives inside an inverter. So:
      //   inverter -> every entry
      //   battery  -> entries whose inverter reports a battery (the hasBattery flag)
      //   meter    -> entries whose inverter reports grid-meter readings. FoxESS exposes no
      //               hasMeter flag and no meter endpoint (verified live: /op/v0/meter/list is
      //               404), so meter presence is read from the device's own real-time payload.
      // The same single real-time answer also tells which optional capabilities (PV strings,
      // phases, EPS...) each unit has, so a new device starts out complete instead of being
      // migrated on its first poll.
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

        // Pull the per-device detail too: firmware, rated capacity and the battery module list.
        // It is genuinely useful (a future battery feature needs the design capacity) and, being
        // captured, it lets the app be tested offline against real device metadata.
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
   * One real-time query for all `serials`, flattened per serial.
   *
   * A failed query yields an empty map: pairing then still offers inverters and batteries (with
   * their base capabilities only) and simply finds no meter, as before.
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

  /**
   * Whether a flat payload carries at least one of `variables` with a value.
   *
   * Used to detect a meter at pair time: FoxESS has no hasMeter flag and no meter endpoint, so
   * the only honest signal that an inverter has grid metering is that its real-time payload
   * carries those variables with a value.
   */
  reportsAnyOf(flat, variables) {
    if (!flat) return false;
    return variables.some((v) => flat[v] !== undefined && flat[v] !== null);
  }

  // poll device from client
  async pollDeviceType({ client, deviceSn, variables }) {
    try {
      this.log(`[Poll] Polling device SN ${deviceSn}...`);
      const response = await client.getDeviceRealTimeData({ sns: [deviceSn], variables });
      const rawData = Array.isArray(response?.result) ? response.result : null;

      const formattedData = {};
      if (rawData) {
        // The response covers every serial requested in the batch (see
        // FoxEssClient.getDeviceRealTimeData), so falling back to rawData[0] on a miss
        // would silently feed this device another inverter's readings. A miss is an error.
        const devItem = rawData.find((d) => d.deviceSN === deviceSn);
        if (!devItem) throw Error(`Device ${deviceSn} was not in the real-time response`);
        // the snapshot's own time, in inverter local time with its UTC offset
        if (devItem.time) formattedData.snapshotTime = devItem.time;
        if (Array.isArray(devItem.datas)) {
          for (const item of devItem.datas) {
            formattedData[item.variable] = item.value;
          }
        }
      } else {
        // No array in the reply (e.g. result:null): leave the reading empty rather than publish
        // the raw envelope ({errno,msg,result}) as if it were device data.
        this.log(`[Poll] Device ${deviceSn}: no real-time data returned`);
      }

      return formattedData;
    } catch (error) {
      this.error('[Poll] Error polling device:', error);
      throw error;
    }
  }

};
