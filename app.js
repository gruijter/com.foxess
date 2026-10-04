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
    this.tickPhaseMs = 0; // position of the poll tick within the period; see lib/foxEssTiming.js
    this.tickMarginMs = MARGIN_MS; // how long after the snapshot the tick fires; adapts per tick
    this.registerFlowListeners();
    // Arm an API capture for the diagnostics report; see lib/foxEssCapture.js
    capture.arm('app start', { force: true });
    this.startPolling();
    this.log('FoxESS app initialized');
  }

  /**
   * The API client for one key in one region, created on first use and shared from then on.
   *
   * Sharing is not an optimisation but a requirement: FoxESS rate-limits per key, and the
   * real-time batching, the device-list cache and the rate-limit cooldown in FoxEssClient only
   * cover the devices that go through the same instance.
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
   * The API key and region last used successfully, to pre-fill the next pairing with.
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

  /**
   * The app-level flow card listeners: the 'Inverter status is ...' condition, and the
   * 'Get status update' action, which polls every device immediately.
   *
   * The card is declared in .homeycompose/flow/actions/force_poll.json but had no run listener,
   * so running the flow did nothing at all.
   */
  registerFlowListeners() {
    this.homey.flow.getConditionCard('running_state_is')
      .registerRunListener(async ({ device, status }) => device.getCapabilityValue('running_state') === status);

    this.homey.flow.getActionCard('set_soc_limits')
      .registerRunListener(({ device, min, ongrid }) => device.setSocLimits({ min, ongrid }));

    this.homey.flow.getActionCard('set_export_limit')
      .registerRunListener(({ device, watts }) => device.setExportLimit(watts));

    this.homey.flow.getActionCard('force_poll')
      .registerRunListener(async () => {
        this.log('force_poll: requesting an immediate update of all devices');
        // force bypasses per-device poll cadence (see CommonDevice.isPollDue)
        this.homey.emit(POLL_EVENT, { force: true });
        return true;
      });
  }

  /**
   * Remember an inverter's latest cloud snapshot moment, and move the poll tick when the learned
   * position changes (see lib/foxEssTiming.js).
   */
  noteSnapshot(sn, at) {
    // Only paired devices count: a serial looked up while pairing but not added, or of a device
    // since deleted, would otherwise hold its own snapshot moment in the spread for good.
    const paired = this.pairedSerials();
    for (const known of this.snapshots.keys()) {
      if (!paired.has(known)) this.snapshots.delete(known);
    }
    if (!paired.has(sn)) return;
    const previous = this.snapshots.get(sn);
    this.snapshots.set(sn, at);
    // Judge the tick by the first answer after it: the old snapshot again means it came too early.
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
   * Poll tick, every PERIOD_MS, placed just after FoxESS has published a new snapshot.
   *
   * A plain setInterval drifts and, worse, spreads the devices out over time. Firing them all on
   * the same instant is what lets the client fold their calls into one request (see
   * FoxEssClient.getDeviceRealTimeData) - the com.sungrowpower scheme. Unlike there, the instant is
   * not the period boundary but the learned snapshot moment plus a margin, so every poll reads the
   * newest data instead of a nearly 5-minute-old snapshot.
   */
  scheduleNextTick() {
    if (this._everyXminutesTimeoutId) this.homey.clearTimeout(this._everyXminutesTimeoutId);
    this._everyXminutesTimeoutId = this.homey.setTimeout(() => {
      // Arm a capture once, on the first aligned tick. Unlike the staggered device inits at app
      // start - which split across several batches, so a multi-device account only ever captured
      // whichever batch happened to land first - this tick wakes every device on the same
      // instant, so their calls fold into one request and the capture covers all of them.
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
