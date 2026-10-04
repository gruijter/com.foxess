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
const { HEATPUMP_POLL_EVERY_N_TICKS } = require('../../lib/foxEssConstants');
const { UNAPPROVED } = require('./driver');

module.exports = class MyDevice extends CommonDevice {

  // Settings-only device: two calls per poll for values that only change on request.
  get pollEveryNTicks() {
    return HEATPUMP_POLL_EVERY_N_TICKS;
  }

  async onInit() {
    await super.onInit();
    this.registerListeners();
    if (this.client) this.logControls().catch((error) => this.error(error));
  }

  // Beta: read-only. The write paths are not verified - the document's .../set paths are wrong for
  // the reads (see FoxEssClient), and a set endpoint takes the whole settings object, timers
  // included - so a change from Homey is refused instead of risking an owner's heating schedule.
  // Each attempt is logged, so a diagnostics report shows what testers try to control.
  registerListeners() {
    // onInit runs again on every restartDevice(), so only register once
    if (this.listenersSet) return;
    const refuse = (cap) => async (value) => {
      this.log(`[HP] ${this.getName()}: ${cap} -> ${JSON.stringify(value)} refused (read-only beta)`);
      throw Error(this.homey.__('errors.heatpumpReadOnly'));
    };
    ['thermostat_mode', 'onoff.dhw', 'target_temperature.dhw']
      .forEach((cap) => this.registerCapabilityListener(cap, refuse(cap)));
    this.listenersSet = true;
  }

  /**
   * Once per (re)start, read every settings group the document lists and log what came back, so a
   * diagnostics report carries the real shape of each (the bodies themselves are captured by
   * foxEssCapture). Only reads; the outcome never affects the device.
   */
  async logControls() {
    const { moduleSn } = this;
    if (!moduleSn) {
      this.log(`[HP] ${this.getName()}: no module serial yet, settings not read`);
      return;
    }
    for (const kind of ['heating', 'dhw', 'generic', 'heatingCircuits']) {
      // eslint-disable-next-line no-await-in-loop
      const line = await this.client.getHeatControls({ moduleSn, kind })
        .then((response) => {
          const result = response?.result;
          return result && typeof result === 'object' ? `keys ${Object.keys(result).join(',') || '(none)'}` : `result ${JSON.stringify(result)}`;
        }, (error) => `failed: ${error.message || error}`);
      this.log(`[HP] ${this.getName()}: ${kind} controls of module ${moduleSn}: ${line}`);
    }
  }

  /** The register list and the settings - see the driver's pollHeatPump(). */
  pollData() {
    return this.driver.pollHeatPump({
      client: this.client,
      heatSn: this.getSettings().heatSn || '',
      moduleSn: this.moduleSn,
    });
  }

  // A heat pump is not in the device list, so there is no device status to read.
  async pollExtra() {
    return {};
  }

  // The gateway module the heat controls key on: known from pairing, or from the register list.
  get moduleSn() {
    return this.getSettings().moduleSn || this.deviceSn || '';
  }

  async handleData(data, options) {
    if (!data) return;
    await this.setChangedSettings({
      registerStatus: data.registerStatus,
      masterVersion: data.masterVersion === undefined ? undefined : String(data.masterVersion),
      moduleSn: data.moduleSn,
    });
    const read = ['workMode', 'dhwEnable', 'dhwTemp'].some((key) => data[key] !== undefined);
    // Nothing read, and the registration says why: show that reason.
    if (!read && UNAPPROVED.includes(data.registerStatus)) {
      const key = data.registerStatus === 'revoked' ? 'errors.heatpumpRevoked' : 'errors.heatpumpPending';
      this.log(`[HP] ${this.getName()}: registration ${data.registerStatus}, settings not readable`);
      await this.setUnavailable(this.homey.__(key)).catch(this.error);
      this.lastPoll = Date.now(); // the cloud answered; this is not the 'no updates' case
      return;
    }
    this.log(`[HP] ${this.getName()}:`, JSON.stringify(data));

    // A fault or offline runningStatus raises alarm_problem / alarm_connectivity (foxEssPointMap)
    // instead of making the device unavailable: an unavailable device cannot trigger a flow.
    await super.handleData(data, options);
  }

};
