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
const util = require('util');

const foxEssPointMap = require('./foxEssPointMap');
const DeviceMigrator = require('./DeviceMigrator');
const { faultTexts } = require('./foxEssFaults');
const { hostOf, regionIdOf } = require('./foxEssRegions');
const {
  POLL_EVENT, SETTINGS_POLL_EVERY_N_TICKS, OVERRIDE_GRACE_MS, OVERRIDE_NOTIFICATION_INTERVAL_MS,
} = require('./foxEssConstants');
const settings = require('./foxEssSettings');
const capture = require('./foxEssCapture');
const { deviceInfoSettings } = require('./foxEssDeviceInfo');

const setTimeoutPromise = util.promisify(setTimeout);

const FALLBACK_MAX_POWER_W = 5000; // when the device detail has no rated power

module.exports = class CommonDevice extends Homey.Device {

  async onInit() {
    try {
      this.restarting = false;

      // devices paired with OAuth have no API key until repaired
      const apiKey = this.getStoreValue('apiKey');
      if (!apiKey) {
        this.error(`${this.getName()} has no API key, waiting for a repair`);
        await this.setUnavailable(this.homey.__('errors.noApiKey'));
        return;
      }
      const region = regionIdOf(this.getStore());
      this.client = this.homey.app.getClient({ apiKey, region });

      await this.setAvailable();

      this.plantId = this.getSettings().plantId || this.getData().id;
      this.deviceSn = this.getSettings().deviceSn || this.getData().id;
      this.deviceType = (this.getSettings().deviceType || this.driver.id).toLowerCase();

      // the store holds the region; the setting is a read-only copy
      await this.setSetting('region', hostOf(region));

      this.pointIdList = foxEssPointMap.pointList(this.driver.id);

      await this.onClientReady();

      // users are asked to restart before a diagnostics report; arm() has its own cooldown
      capture.arm(`device restart: ${this.getName()}`);

      // Device detail: info settings, stored detail and rated power, before migrate() applies the
      // ranges that depend on it.
      if (!['meter', 'heatpump'].includes(this.driver.id) && typeof this.client?.getDeviceDetail === 'function') {
        const detail = await this.client.getDeviceDetail({ sn: this.deviceSn })
          .then((res) => res?.result || null)
          .catch((err) => {
            this.error('device detail refresh failed:', err.message || err);
            return null;
          });
        if (detail) {
          if (this.driver.id === 'inverter') await this.setStoreValue('deviceDetail', detail).catch((err) => this.error(err));
          if (Number(detail.capacity) > 0 && detail.capacity !== this.getStoreValue('capacity')) {
            await this.setStoreValue('capacity', detail.capacity).catch((err) => this.error(err));
          }
          await this.setChangedSettings(deviceInfoSettings(this.driver.id, detail));
        }
      }

      // repair the capability list (existence + order) before anything writes to it
      await this.migrate();

      this.startListeners();
      await this.eventListenerEveryXminutes().catch((error) => this.error(error));
      this.log(this.getName(), 'has been initialized');
    } catch (error) {
      this.error(error);
      this.setUnavailable(error.message || String(error)).catch(this.error);
      this.restarting = false;
      this.restartDevice(60 * 1000).catch((error) => this.error(error));
    }
  }

  /**
   * Bring the capability list in line with base + reported optional + extra capabilities.
   * Failures are logged, never fatal.
   * @returns {Promise<boolean>} whether the capability list was changed
   */
  async migrate() {
    try {
      await this.carrySeenCaps();
      const correctCaps = foxEssPointMap.deviceCapabilities(this.driver.id, this.getStoreValue('seenCaps'), this.extraCapabilities());
      const changed = await DeviceMigrator.migrateCapabilities(this, correctCaps);
      // a re-added capability is back on the manifest's options
      await DeviceMigrator.syncCapabilityOptions(this, this.capabilityOptions(), { force: changed });
      return changed;
    } catch (error) {
      this.error(error);
      return false;
    }
  }

  /**
   * An optional capability that already shows a real value counts as reported, so a capability
   * moved from base to optional is kept where it has data.
   */
  async carrySeenCaps() {
    const seen = this.getStoreValue('seenCaps') || {};
    const carried = foxEssPointMap.optionalCapabilities(this.driver.id)
      .filter((cap) => !seen[cap] && this.hasCapability(cap) && foxEssPointMap.isEvidence(this.getCapabilityValue(cap)));
    if (!carried.length) return;
    carried.forEach((cap) => {
      seen[cap] = true;
    });
    await this.setStoreValue('seenCaps', seen);
    this.log(`${this.getName()} keeps the capabilities it already reported:`, carried);
  }

  /**
   * Unit-specific capability options (e.g. a range up to the rated power), applied after migrate().
   * @returns {Object<string, object>} capability id -> options
   */
  capabilityOptions() {
    return {};
  }

  // the inverter's rated power in W (device detail `capacity`, kW)
  get maxPowerW() {
    const kw = Number(this.getStoreValue('capacity'));
    return kw > 0 ? Math.round(kw * 1000) : FALLBACK_MAX_POWER_W;
  }

  /**
   * On every (re)start, before migrate(): rerun the driver's pairing support checks and store them.
   * A failed check reports nothing, so the store keeps its last answer.
   */
  async onClientReady() {
    const { support, readings } = await this.driver.checkSupport({ client: this.client, deviceSn: this.deviceSn });
    for (const [key, value] of Object.entries(support)) {
      // eslint-disable-next-line no-await-in-loop
      await this.setStoreValue(key, value);
    }
    this.onReadings(readings);
  }

  /** Hook for the values read along with the support checks. */
  onReadings(readings) { // eslint-disable-line no-unused-vars
    return undefined;
  }

  /**
   * Capabilities not from the real-time payload (e.g. battery control), decided by the driver.
   * @returns {string[]}
   */
  extraCapabilities() {
    return this.driver.extraCapabilities(this.getStore());
  }

  /**
   * Record newly evidenced optional capabilities and add them. Never withdrawn: removing a
   * capability breaks the flows that use it.
   * @param {object} data the flat real-time payload
   * @returns {Promise<string[]>} the capabilities added by this call
   */
  async recordSeenCaps(data) {
    const seen = this.getStoreValue('seenCaps') || {};
    const fresh = Object.keys(foxEssPointMap.seenInPayload(this.driver.id, data)).filter((cap) => !seen[cap]);
    if (!fresh.length) return [];
    fresh.forEach((cap) => {
      seen[cap] = true;
    });
    await this.setStoreValue('seenCaps', seen);
    this.log(`${this.getName()} reports new capabilities:`, fresh);
    await this.migrate();
    return fresh;
  }

  onDeleted() {
    this.destroyListeners();
    this.log('Device was deleted', this.getName());
  }

  async onUninit() {
    this.log('unInit', this.getName());
    this.destroyListeners();
    await setTimeoutPromise(2000).catch((error) => this.error(error));
  }

  /** Runs after a repair stored new credentials, before the restart. */
  async onRepaired() {
    return undefined;
  }

  onAdded() {
    this.log('added', this.getName());
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed', this.getName(), newSettings);
    this.restartDevice(1000).catch((error) => this.error(error));
  }

  onRenamed(name) {
    this.log('Device was renamed', name);
  }

  async restartDevice(delay) {
    this.destroyListeners();
    if (this.restarting) return;
    this.restarting = true;
    const dly = delay || 1000 * 5;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    await setTimeoutPromise(dly);
    this.onInit().catch((error) => this.error(error));
  }

  async setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined && !Number.isNaN(value)) {
      await this.setCapabilityValue(capability, value).catch((error) => {
        this.log(error, capability, value);
      });
    }
  }

  // Never trigger() '<capability>_changed' cards: Homey runs them itself, also for
  // sub-capabilities (an extra trigger() ran flows twice, 2026-10-04).

  /** Write the settings among `values` that differ, in one call. */
  async setChangedSettings(values) {
    const current = this.getSettings() || {};
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== undefined && current[key] !== value));
    if (!Object.keys(changed).length) return;
    this.log('New settings:', changed);
    await this.setSettings(changed).catch((error) => this.error(error));
  }

  /** Write one setting when it differs. */
  setSetting(setting, value) {
    return this.setChangedSettings({ [setting]: value });
  }

  /**
   * Map a flat payload onto the capabilities.
   * @param {object} input the flat payload (real-time variables plus pollExtra fields)
   * @param {object} [options]
   * @param {boolean} [options.partial] only pollExtra data (real-time query failed): set what it
   *   has, but don't mark available or reset the staleness clock
   */
  async handleData(input, { partial = false } = {}) {
    if (!input) return;
    if (!partial) {
      await this.setAvailable();
      this.lastPoll = Date.now();
    }
    const data = input.currentFault === undefined ? input
      : { ...input, faultTexts: await faultTexts(input.currentFault, this.client) };
    const capFuncs = foxEssPointMap.capabilityMap(this.driver.id);
    const values = {};
    for (const [cap, func] of Object.entries(capFuncs)) values[cap] = func(data);
    // dailyEnergyHomeyTimezone: derive '.today' from its lifetime sibling (as com.growatt)
    if (this.getSetting('dailyEnergyHomeyTimezone')) {
      for (const cap of Object.keys(values)) {
        if (cap.endsWith('.today') && this.hasCapability(cap)) {
          values[cap] = this.todayFromTotal(cap, values[cap.replace(/\.today$/, '')]);
        }
      }
    }
    const setAll = () => {
      for (const [cap, value] of Object.entries(values)) {
        this.setCapability(cap, value).catch((error) => this.error(error));
      }
    };
    setAll();

    // new optional capabilities are added in the background, then filled from this payload
    this.recordSeenCaps(data)
      .then((added) => (added.length ? setAll() : null))
      .catch((error) => this.error(error));
  }

  /**
   * Today's energy as growth of a lifetime total since the first reading of the local day (Homey's
   * timezone, not the process's), as com.growatt's getTodayEnergy(). A falling total rebases.
   * @param {string} cap the '.today' capability, used to key the stored baseline
   * @param {number|undefined} total the lifetime total in kWh
   * @returns {number|undefined} kWh since local midnight, or undefined without a total
   */
  todayFromTotal(cap, total) {
    if (typeof total !== 'number' || Number.isNaN(total)) return undefined;
    const local = new Date(new Date().toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() }));
    const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
    const key = `todayBaseline_${cap}`;
    let baseline = this.getStoreValue(key);
    if (!baseline || baseline.date !== today || typeof baseline.total !== 'number' || total < baseline.total) {
      baseline = { date: today, total };
      this.setStoreValue(key, baseline).catch((error) => this.error(error));
    }
    return Math.round((total - baseline.total) * 100) / 100;
  }

  /**
   * Fields from other endpoints, merged into the flat payload. Must not throw.
   * @param {object} [options] the poll options ({ force } from the 'Get status update' card)
   * @returns {Promise<object>} extra flat fields
   */
  async pollExtra(options) { // eslint-disable-line no-unused-vars
    // for alarm_problem / alarm_connectivity; cached per account by the client
    const deviceStatus = await this.client.getDeviceStatus({ sn: this.deviceSn }).catch((error) => {
      this.error('device status failed:', error.message || error);
      return undefined;
    });
    return deviceStatus === undefined ? {} : { deviceStatus };
  }

  /**
   * The device's reading for a tick as a flat payload.
   * @returns {Promise<object>}
   */
  pollData() {
    return this.driver.pollDeviceType({ client: this.client, deviceSn: this.deviceSn, variables: this.pointIdList });
  }

  /** Whether this tick reads the installation's settings: hourly, forced, or after a Homey write. */
  settingsDue(options = {}) {
    return Boolean(options.force || this.settingsDirty
      || ((this.pollTick || 1) - 1) % SETTINGS_POLL_EVERY_N_TICKS === 0);
  }

  // --- control overridden ---
  // When a read differs from what Homey wrote (FoxCloud, installer, VPP), alarm_generic.control
  // latches until the user controls the device from Homey again (as com.solarwatt).

  /** Remember what Homey wrote (key -> value). */
  async noteWrites(values) {
    await this.setStoreValue('homeyWrites', settings.noteWrites(this.getStoreValue('homeyWrites'), values));
  }

  /**
   * Compare a read with Homey's own writes, and latch the alarm on a difference.
   * @param {object} readings key -> value just read
   * @param {number} readStartedAt when the read started
   */
  async checkOverride(readings, readStartedAt) {
    const keys = settings.overriddenKeys(this.getStoreValue('homeyWrites'), readings, readStartedAt, OVERRIDE_GRACE_MS);
    if (keys.length && !this.getStoreValue('controlOverridden')) await this.onControlOverridden(keys);
    await this.setCapability('alarm_generic.control', Boolean(this.getStoreValue('controlOverridden')));
  }

  /** Latch the alarm and notify the timeline, at most once a day app-wide. */
  async onControlOverridden(keys) {
    this.log(`${this.getName()}: control overridden elsewhere:`, keys);
    await this.setStoreValue('controlOverridden', true);
    const last = Number(this.homey.settings.get('overrideNotifiedAt')) || 0;
    if (Date.now() - last < OVERRIDE_NOTIFICATION_INTERVAL_MS) return;
    this.homey.settings.set('overrideNotifiedAt', Date.now());
    await this.homey.notifications.createNotification({
      excerpt: this.homey.__('notifications.controlOverridden', { name: this.getName() }),
    }).catch((error) => this.error(error));
  }

  /** The user controls the device from Homey again: start watching afresh. */
  async clearControlOverridden() {
    if (!this.getStoreValue('controlOverridden')) return;
    await this.setStoreValue('controlOverridden', false);
    await this.setCapability('alarm_generic.control', false);
  }

  /** Poll every N app ticks; drivers with slow-changing, expensive data override it. */
  get pollEveryNTicks() {
    return 1;
  }

  /** Whether this device polls on this tick; `force` (the 'Get status update' card) always does. */
  isPollDue({ force = false } = {}) {
    this.pollTick = (this.pollTick || 0) + 1;
    if (force) return true;
    const every = this.pollEveryNTicks;
    return every <= 1 || ((this.pollTick - 1) % every === 0);
  }

  startListeners() {
    this.destroyListeners();
    this.log('starting listeners', this.getName());
    this.eventListenerEveryXminutes = async (options) => {
      // no overlapping polls
      if (this.isPolling) return;
      this.isPolling = true;
      try {
        if (!this.isPollDue(options)) return;
        const [real, extra] = await Promise.all([
          this.pollData().then((data) => ({ data }), (error) => ({ error })),
          this.pollExtra(options).catch((error) => {
            this.error(error);
            return {};
          }),
        ]);
        if (real.data) {
          this.handleData({ ...real.data, ...extra }).catch((error) => this.error(error));
        } else if (Object.keys(extra).length) {
          // the query fails when the unit is offline; its alarms still count
          this.handleData(extra, { partial: true }).catch((error) => this.error(error));
        }
        if (real.error) throw real.error;
        if (this.lastPoll && (Date.now() - this.lastPoll) > 61 * 60 * 1000) {
          this.setUnavailable(this.homey.__('errors.noUpdates')).catch((error) => this.error(error));
        }
      } catch (error) {
        this.error(error);
        if (this.lastPoll && (Date.now() - this.lastPoll) > 61 * 60 * 1000) {
          this.setUnavailable(this.homey.__('errors.noUpdates')).catch((error) => this.error(error));
        }
      } finally {
        this.isPolling = false;
      }
    };
    this.pollListener = (options) => {
      this.eventListenerEveryXminutes(options).catch((error) => this.error(error));
    };
    this.homey.on(POLL_EVENT, this.pollListener);
  }

  destroyListeners() {
    this.log('removing listeners', this.getName());
    if (this.pollListener) this.homey.removeListener(POLL_EVENT, this.pollListener);
  }

};
