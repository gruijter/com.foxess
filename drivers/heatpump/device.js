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

const CommonDevice = require('../../lib/common_device');
const { HEATING_WORK_MODES } = require('../../lib/foxEssPointMap');
const { HEATPUMP_POLL_EVERY_N_TICKS } = require('../../lib/foxEssConstants');
const { APPROVED } = require('./driver');

const WORK_MODE_IDS = Object.entries(HEATING_WORK_MODES)
  .reduce((acc, [id, mode]) => ({ ...acc, [mode]: Number(id) }), {});

module.exports = class MyDevice extends CommonDevice {

  // Settings-only device: two calls per poll for values that only change on request.
  get pollEveryNTicks() {
    return HEATPUMP_POLL_EVERY_N_TICKS;
  }

  async onInit() {
    await super.onInit();
    this.registerListeners();
  }

  // register capability listeners
  registerListeners() {
    // onInit runs again on every restartDevice(), so only register once
    if (this.listenersSet) return;
    this.log('registering capability listeners');
    this.registerCapabilityListener('thermostat_mode', (value) => this.setWorkMode(value));
    this.registerCapabilityListener('onoff.dhw', (value) => this.setDhw({ enable: value }));
    this.registerCapabilityListener('target_temperature.dhw', (value) => this.setDhw({ dhwTemp: value }));
    this.listenersSet = true;
  }

  /** The register list and, once approved, the settings - see the driver's pollHeatPump(). */
  pollData() {
    return this.driver.pollHeatPump({
      client: this.client,
      heatSn: this.getSettings().heatSn || '',
      moduleSn: this.moduleSn,
    });
  }

  // The gateway module the heat controls key on: known from pairing, or once the registration
  // was approved.
  get moduleSn() {
    return this.getSettings().moduleSn || this.deviceSn || '';
  }

  async handleData(data, options) {
    if (data?.registerStatus !== undefined) {
      await this.setChangedSettings({ registerStatus: data.registerStatus, masterVersion: data.masterVersion });
    }
    // The module can only be known once the registration was approved; the controls key on it.
    if (data?.moduleSn) await this.setChangedSettings({ moduleSn: data.moduleSn });
    // A heat pump that is not (or no longer) approved cannot be read or controlled.
    if (data?.registerStatus !== undefined && data.registerStatus !== APPROVED) {
      const key = data.registerStatus === 'revoked' ? 'errors.heatpumpRevoked' : 'errors.heatpumpPending';
      await this.setUnavailable(this.homey.__(key)).catch(this.error);
      this.lastPoll = Date.now(); // the cloud answered; this is not the 'no updates' case
      return;
    }

    // keep the raw settings objects so a write can merge into them rather than replace them
    if (data?.heatingControls) this.heatingControls = data.heatingControls;
    if (data?.dhwControls) this.dhwControls = data.dhwControls;

    // A fault or offline runningStatus raises alarm_problem / alarm_connectivity (foxEssPointMap)
    // instead of making the device unavailable: an unavailable device cannot trigger a flow.
    await super.handleData(data, options);
  }

  /**
   * Write a change back to a heat pump settings endpoint.
   *
   * The set endpoints take the whole settings object, so send back what the device currently
   * has with only the changed fields replaced - posting a bare `{ workMode }` would drop the
   * timers that live in the same object. Always re-read first, so a setting changed in the
   * FoxESS app since the last poll is not silently reverted.
   * @param {'heating'|'dhw'} which which settings endpoint to write
   * @param {object} changes the fields to change
   */
  async writeControls(which, changes) {
    const { client, moduleSn } = this;
    if (!moduleSn) throw Error(this.homey.__('errors.heatpumpPending'));
    try {
      const response = which === 'heating'
        ? await client.getHeatHeatingControls({ moduleSn })
        : await client.getHeatDhwControls({ moduleSn });
      const current = response?.result || response?.data || {};
      const data = { ...current, ...changes };

      if (which === 'heating') {
        await client.setHeatHeatingControls({ moduleSn, data });
        this.heatingControls = data;
      } else {
        await client.setHeatDhwControls({ moduleSn, data });
        this.dhwControls = data;
      }
      this.log(`Heat pump ${which} settings updated:`, JSON.stringify(changes));
    } catch (error) {
      this.error(error);
      const reason = error.message || error.toString();
      throw Error(`${this.homey.__('errors.heatpumpSetFailed')} ${reason}`);
    }
  }

  async setWorkMode(mode) {
    const workMode = WORK_MODE_IDS[mode];
    if (!workMode) throw Error(`${this.homey.__('errors.heatpumpSetFailed')} Unsupported mode: ${mode}`);
    return this.writeControls('heating', { workMode });
  }

  async setDhw(changes) {
    return this.writeControls('dhw', changes);
  }

};
