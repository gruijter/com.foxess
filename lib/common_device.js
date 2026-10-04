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

// Used when the device detail carries no rated power.
const FALLBACK_MAX_POWER_W = 5000;

module.exports = class CommonDevice extends Homey.Device {

  async onInit() {
    try {
      this.restarting = false;

      // A device paired before the switch from OAuth has no API key; only a repair can give it one.
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

      // The region in the store is the authoritative source; the setting is its readable copy.
      // setSetting() only writes when the value actually differs.
      this.setSetting('region', hostOf(region));

      this.pointIdList = foxEssPointMap.pointList(this.driver.id);

      // driver-specific setup that decides the capability list (e.g. battery control support)
      await this.onClientReady();

      // repair the capability list (existence + order) before anything writes to it
      await this.migrate();

      // A restart is the moment a user is asked for a diagnostics report, so capture then.
      // Cooled down internally, so a dozen devices starting together arm once between them.
      capture.arm(`device restart: ${this.getName()}`);

      // Refresh the physical unit's detail once per (re)start: the settings page (model, firmware,
      // battery modules - see foxEssDeviceInfo) and the inverter's stored rated and battery-design
      // capacity. The meter shows nothing from it, and a heat pump is not a device there. Being an
      // armed call it also puts device/detail in a diagnostics report, so the app can be tested
      // offline against real device metadata.
      if (!['meter', 'heatpump'].includes(this.driver.id) && typeof this.client?.getDeviceDetail === 'function') {
        const detail = await this.client.getDeviceDetail({ sn: this.deviceSn })
          .then((res) => res?.result || null)
          .catch((err) => {
            this.error('device detail refresh failed:', err.message || err);
            return null;
          });
        if (detail) {
          if (this.driver.id === 'inverter') await this.setStoreValue('deviceDetail', detail).catch((err) => this.error(err));
          await this.setChangedSettings(deviceInfoSettings(this.driver.id, detail));
        }
      }

      this.startListeners();
      // poll once
      await this.eventListenerEveryXminutes().catch((error) => this.error(error));
      this.log(this.getName(), 'has been initialized');
    } catch (error) {
      const msg = error.message && error.message.includes('"msg":') ? JSON.parse(error.message).msg : error;
      this.error(error);
      this.setUnavailable(msg).catch(this.error);
      this.restarting = false;
      this.restartDevice(60 * 1000).catch((error) => this.error(error));
    }
  }

  /**
   * Bring the capability list in line with the driver's base capabilities plus the optional ones
   * this device has reported (see recordSeenCaps). Runs on every (re)start; a no-op when nothing
   * changed. Failures are logged, never fatal - a device with a stale list still polls.
   * @returns {Promise<boolean>} whether the capability list was changed
   */
  async migrate() {
    try {
      await this.carrySeenCaps();
      const correctCaps = foxEssPointMap.deviceCapabilities(this.driver.id, this.getStoreValue('seenCaps'), this.extraCapabilities());
      const changed = await DeviceMigrator.migrateCapabilities(this, correctCaps);
      // A removed-and-re-added capability is back on the manifest's options.
      await DeviceMigrator.syncCapabilityOptions(this, this.capabilityOptions(), { force: changed });
      return changed;
    } catch (error) {
      this.error(error);
      return false;
    }
  }

  /**
   * An optional capability the device already shows a real value for counts as reported. This
   * matters when a capability moves from base to optional (meter phases 2 and 3, 2026-10-04): a
   * three-phase meter keeps its tiles and the flows that use them, while on a single-phase one -
   * where they never got a value - they are removed.
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
   * Capability options that depend on this unit, e.g. a range up to its rated power. Applied after
   * every migration, so they survive a capability being rebuilt. None by default.
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
   * Runs on every (re)start once this.client exists, before the capability list is migrated: the
   * driver's support checks (the same ones pairing ran), stored, and their readings handed to
   * onReadings(). A check that failed reports nothing, so the store keeps its last answer.
   */
  async onClientReady() {
    const { support, readings } = await this.driver.checkSupport({ client: this.client, deviceSn: this.deviceSn });
    for (const [key, value] of Object.entries(support)) {
      // eslint-disable-next-line no-await-in-loop
      await this.setStoreValue(key, value);
    }
    this.onReadings(readings);
  }

  /** Hook for the values read along with the support checks. Nothing by default. */
  onReadings(readings) { // eslint-disable-line no-unused-vars
    return undefined;
  }

  /**
   * Capabilities that do not come from the real-time payload, appended after the data-driven
   * ones (e.g. the battery's control capabilities) - decided by the driver, as at pairing.
   * @returns {string[]}
   */
  extraCapabilities() {
    return this.driver.extraCapabilities(this.getStore());
  }

  /**
   * Remember which optional capabilities this device has reported a non-zero value for, and add
   * the new ones. Write-once per capability: evidence is never withdrawn, because removing a
   * capability breaks the flows that use it, and one quiet poll proves nothing.
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
    await setTimeoutPromise(2000).catch((error) => this.error(error)); // wait 2 secs
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

  // No trigger() for '<capability>_changed' cards: Homey runs a device trigger with that id itself
  // on every setCapabilityValue() that changes the value - sub-capabilities of system capabilities
  // too (measured on HomeyDev 2026-10-04: an extra trigger() made every such flow run twice).

  /** Write the settings among `values` that differ, in one call. */
  async setChangedSettings(values) {
    const current = this.getSettings() || {};
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== undefined && current[key] !== value));
    if (!Object.keys(changed).length) return;
    this.log('New settings:', changed);
    await this.setSettings(changed).catch((error) => this.error(error));
  }

  setSetting(setting, value) {
    const settings = this.getSettings();
    if (value !== undefined && settings && settings[setting] !== value) {
      const newSettings = {};
      newSettings[setting] = value;
      this.log('New setting:', newSettings);
      this.setSettings(newSettings).catch((error) => {
        this.log(error, setting, value);
      });
    }
  }

  /**
   * Map a flat payload onto the capabilities.
   * @param {object} input the flat payload (real-time variables plus pollExtra fields)
   * @param {object} [options]
   * @param {boolean} [options.partial] true when the real-time query failed and only pollExtra
   * data is in hand (e.g. the device list saying the unit is offline). The alarms it carries are
   * still set, but the device is not marked available and the staleness clock is not reset.
   */
  async handleData(input, { partial = false } = {}) {
    if (!input) return;
    if (!partial) {
      await this.setAvailable();
      this.lastPoll = Date.now();
    }
    // resolve active fault codes into FoxESS's own texts, which decide the alarms
    const data = input.currentFault === undefined ? input
      : { ...input, faultTexts: await faultTexts(input.currentFault, this.client) };
    // map the data to homey capabilities; setCapability() skips any the device does not have
    const capFuncs = foxEssPointMap.capabilityMap(this.driver.id);
    const values = {};
    for (const [cap, func] of Object.entries(capFuncs)) values[cap] = func(data);
    // With the dailyEnergyHomeyTimezone setting on, a '.today' is derived from its lifetime
    // sibling ('meter_power.today' from 'meter_power') instead of taken from the API - the same
    // opt-in com.growatt offers for a cloud daily figure that resets at the wrong time.
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

    // A newly reported optional capability is added in the background (Homey needs a few seconds
    // per capability), then filled from this same payload rather than left empty until next poll.
    this.recordSeenCaps(data)
      .then((added) => (added.length ? setAll() : null))
      .catch((error) => this.error(error));
  }

  /**
   * Today's energy from a lifetime total, for models that do not report a daily figure (an H3-G2
   * returns no todayYield at all). The total at the first reading of each local day is stored as
   * the baseline; today is the growth since then. Same approach as com.growatt's getTodayEnergy().
   *
   * The day is resolved in Homey's own timezone: the app process runs on UTC, so new Date().getDate()
   * would roll over at 01:00 or 02:00 local time instead of at midnight.
   *
   * On the day the baseline is first set (a fresh install or pairing) the figure counts only from
   * that moment. A total that goes DOWN (counter reset, unit replaced) starts a new baseline.
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
   * Data from other endpoints than the real-time query, merged into the same flat payload before
   * it is mapped. Nothing by default; a driver's device overrides it (the inverter adds
   * the energy report). Must never throw: a failure here must not cost the real-time data.
   * @param {object} [options] the poll options ({ force } from the 'Get status update' card)
   * @returns {Promise<object>} extra flat fields
   */
  async pollExtra(options) { // eslint-disable-line no-unused-vars
    // The device list knows whether the unit is broken down or offline (alarm_problem,
    // alarm_connectivity). Shared per account by the client, so this is one call per ten minutes.
    const deviceStatus = await this.client.getDeviceStatus({ sn: this.deviceSn }).catch((error) => {
      this.error('device status failed:', error.message || error);
      return undefined;
    });
    return deviceStatus === undefined ? {} : { deviceStatus };
  }

  /**
   * The device's own reading for a tick, as a flat payload: the real-time query by default.
   * @returns {Promise<object>}
   */
  pollData() {
    return this.driver.pollDeviceType({ client: this.client, deviceSn: this.deviceSn, variables: this.pointIdList });
  }

  /**
   * Whether this tick reads the installation's own limits (SoC limits, export limit): hourly, on a
   * forced poll, and on the tick after Homey wrote one.
   */
  settingsDue(options = {}) {
    return Boolean(options.force || this.settingsDirty
      || ((this.pollTick || 1) - 1) % SETTINGS_POLL_EVERY_N_TICKS === 0);
  }

  // --- control overridden ---
  // Homey's writes are remembered (store 'homeyWrites'). When a later read shows something else -
  // a change in FoxCloud, by the installer or by an energy provider (VPP) - alarm_generic.control
  // goes on and stays on until the user controls the device from Homey again. Same behaviour as
  // com.solarwatt, where a SOLARWATT Manager takes control back.

  /** Remember what Homey wrote (key -> value), so a later read can tell when it was changed. */
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

  /**
   * Something else changed what Homey wrote: latch the alarm, and say so on the timeline - at most
   * once a day for the whole app, as one change can show on the battery and the inverter both.
   */
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

  /**
   * How many poll ticks apart this device should actually poll. 1 = every tick.
   *
   * Overridden by drivers whose data barely changes but whose calls are expensive, so a device
   * can be slowed down without giving it a second timer to keep in sync with the app's tick.
   */
  get pollEveryNTicks() {
    return 1;
  }

  /**
   * Whether this tick is one this device polls on. The 'Get status update' flow card passes
   * force, which always polls - a user asking for an update should get one.
   */
  isPollDue({ force = false } = {}) {
    this.pollTick = (this.pollTick || 0) + 1;
    if (force) return true;
    const every = this.pollEveryNTicks;
    return every <= 1 || ((this.pollTick - 1) % every === 0);
  }

  // start listeners
  startListeners() {
    this.destroyListeners();
    this.log('starting listeners', this.getName());
    this.eventListenerEveryXminutes = async (options) => {
      // A slow API answer must not let the next tick (or a 'Get status update') start a second
      // poll on top of it - mirrors com.sungrowpower's guard.
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
          // An offline unit is exactly when the real-time query fails - its alarms still count.
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
    // the event emitter ignores a returned promise, so the listener swallows its own errors
    this.pollListener = (options) => {
      this.eventListenerEveryXminutes(options).catch((error) => this.error(error));
    };
    this.homey.on(POLL_EVENT, this.pollListener);
  }

  // remove listeners
  destroyListeners() {
    this.log('removing listeners', this.getName());
    if (this.pollListener) this.homey.removeListener(POLL_EVENT, this.pollListener);
  }

};
