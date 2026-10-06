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

const Homey = require('homey');
const FoxEssClient = require('./lib/FoxEssClient');
const {
  DEFAULT_REGION, regionById, hostOf,
} = require('./lib/foxEssRegions');
const { POLL_EVENT } = require('./lib/foxEssConstants');
const {
  PERIOD_MS, MARGIN_MS, tickPhase, adaptMargin, delayToNextTick,
} = require('./lib/foxEssTiming');
const capture = require('./lib/foxEssCapture');

module.exports = class FoxEssApp extends Homey.App {

  async onInit() {
    this.clients = new Map();
    this.snapshots = new Map(); // inverter SN -> epoch ms of its latest cloud snapshot
    this.tickPhaseMs = 0; // poll tick position within the period (lib/foxEssTiming.js)
    this.tickMarginMs = MARGIN_MS;
    this.registerFlowListeners();
    capture.arm('app start', { force: true });
    this.startPolling();
    this.log('FoxESS app initialized');
  }

  /**
   * The shared API client per key and region; required, as FoxESS rate-limits per key.
   * @returns {FoxEssClient}
   */
  getClient({ apiKey, region }) {
    const host = hostOf(region);
    const id = `${host}|${apiKey}`;
    if (!this.clients.has(id)) {
      const client = new FoxEssClient({
        homey: this.homey,
        apiKey,
        host,
        log: (...args) => this.log('[client]', ...args),
        error: (...args) => this.error('[client]', ...args),
      });
      client.onSnapshot = (sn, at) => this.noteSnapshot(sn, at);
      this.clients.set(id, client);
    }
    return this.clients.get(id);
  }

  /**
   * The API key and region last used, to pre-fill pairing.
   * @returns {{ apiKey: string, region: string }}
   */
  getSavedCredentials() {
    const region = this.homey.settings.get('region');
    return {
      apiKey: this.homey.settings.get('apiKey') || '',
      region: regionById(region) ? region : DEFAULT_REGION,
    };
  }

  setSavedCredentials({ apiKey, region }) {
    this.homey.settings.set('apiKey', apiKey);
    this.homey.settings.set('region', region);
  }

  registerFlowListeners() {
    this.homey.flow.getConditionCard('running_state_is')
      .registerRunListener(async ({ device, status }) => device.getCapabilityValue('running_state') === status);

    // Homey makes no "is on" condition for boolean sub- and custom capabilities
    for (const capability of ['alarm_generic.control', 'inverter_limit_active']) {
      this.homey.flow.getConditionCard(`${capability}_is`)
        .registerRunListener(async ({ device }) => device.getCapabilityValue(capability) === true);
    }

    this.homey.flow.getActionCard('set_soc_limits')
      .registerRunListener(({ device, min, ongrid }) => device.setSocLimits({ min, ongrid }));

    this.homey.flow.getActionCard('set_export_limit')
      .registerRunListener(({ device, watts }) => device.setExportLimit(watts));

    this.homey.flow.getActionCard('force_poll')
      .registerRunListener(async () => {
        this.log('force_poll: requesting an immediate update of all devices');
        this.homey.emit(POLL_EVENT, { force: true });
        return true;
      });
  }

  /** Remember an inverter's latest snapshot moment and move the poll tick to follow it. */
  noteSnapshot(sn, at) {
    // only paired devices (not serials seen during pairing, or deleted ones)
    const paired = this.pairedSerials();
    for (const known of this.snapshots.keys()) {
      if (!paired.has(known)) this.snapshots.delete(known);
    }
    if (!paired.has(sn)) return;
    const previous = this.snapshots.get(sn);
    this.snapshots.set(sn, at);
    // the old snapshot again after a tick means the tick came too early
    if (this.tickJudgePending && previous) {
      this.tickJudgePending = false;
      const margin = adaptMargin(this.tickMarginMs, at > previous);
      if (margin !== this.tickMarginMs) {
        this.log(`poll margin ${Math.round(this.tickMarginMs / 1000)}s -> ${Math.round(margin / 1000)}s (${at > previous ? 'new' : 'no new'} snapshot on the last tick)`);
        this.tickMarginMs = margin;
      }
    }
    const phase = tickPhase([...this.snapshots.values()], this.tickMarginMs);
    if (phase === this.tickPhaseMs) return;
    this.tickPhaseMs = phase;
    this.log(`poll tick moved to ${Math.round(phase / 1000)}s after each ${PERIOD_MS / 60000}-minute mark, right after the cloud snapshot`);
    if (this._everyXminutesTimeoutId) this.scheduleNextTick();
  }

  /** The serials of every paired device, as CommonDevice resolves its deviceSn. */
  pairedSerials() {
    const serials = new Set();
    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        serials.add(device.getSettings().deviceSn || device.getData().id);
      }
    }
    return serials;
  }

  /**
   * One app-wide poll tick per PERIOD_MS, just after the snapshot, so all devices poll at the same
   * instant and their calls fold into one request.
   */
  scheduleNextTick() {
    if (this._everyXminutesTimeoutId) this.homey.clearTimeout(this._everyXminutesTimeoutId);
    this._everyXminutesTimeoutId = this.homey.setTimeout(() => {
      // the first tick polls all devices in one batch, so one capture covers them all
      if (!this._armedFullTick) {
        this._armedFullTick = true;
        capture.arm('first aligned poll', { force: true });
      }
      this.tickJudgePending = true;
      this.homey.emit(POLL_EVENT);
      this.scheduleNextTick();
    }, delayToNextTick(Date.now(), this.tickPhaseMs));
  }

  startPolling() {
    this.scheduleNextTick();
    this.log(`poll job started, every ${PERIOD_MS / 60000} minutes`);
  }

  async onUninit() {
    if (this._everyXminutesTimeoutId) this.homey.clearTimeout(this._everyXminutesTimeoutId);
  }

};
