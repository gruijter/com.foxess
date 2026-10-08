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
const ctl = require('../../lib/foxEssBatteryControl');
const settings = require('../../lib/foxEssSettings');
const { CONTROL_POLL_EVERY_N_TICKS } = require('../../lib/foxEssConstants');

const CONTROL_CAPS = ['target_power', 'target_power_mode'];

// capability -> battery/soc key. battery_max_soc is read-only: a MaxSoc write was ignored (2026-10-04).
const SOC_CAPS = {
  battery_min_soc: 'minSoc',
  battery_min_soc_ongrid: 'minSocOnGrid',
};

module.exports = class MyDevice extends CommonDevice {

  onReadings({ schedulerOn, socLimits, maxSoc }) {
    this.schedulerOn = schedulerOn;
    if (socLimits) this.socLimits = { ...socLimits, time: Date.now() };
    this.maxSoc = maxSoc;
  }

  capabilityOptions() {
    const max = this.maxPowerW;
    return { target_power: { min: -max, max, step: 100 } };
  }

  async onInit() {
    await super.onInit();
    if (this.socLimits) await this.showSocLimits(this.socLimits);
    if (this.maxSoc !== undefined) await this.setCapability('battery_max_soc', this.maxSoc);
    this.registerControlListeners();
  }

  registerControlListeners() {
    // restartDevice() reruns onInit: register once
    if (!this.controlListenerSet && this.hasCapability('target_power')) {
      // one listener, so power + mode from one flow card become one write
      this.registerMultipleCapabilityListener(CONTROL_CAPS, (values) => this.onControl(values), 500);
      this.controlListenerSet = true;
    }
    if (!this.socListenerSet && this.hasCapability('battery_min_soc')) {
      // the SoC limits are written as a pair
      const caps = Object.keys(SOC_CAPS).filter((cap) => this.hasCapability(cap));
      this.registerMultipleCapabilityListener(caps, (values) => this.onSocLimits(values), 500);
      this.socListenerSet = true;
    }
  }

  /** The SoC limits, as { minSoc, minSocOnGrid }. */
  async readSocLimits() {
    const soc = (await this.client.getBatterySoc({ sn: this.deviceSn }))?.result;
    const minSoc = Number(soc?.minSoc);
    const minSocOnGrid = Number(soc?.minSocOnGrid);
    if (!Number.isFinite(minSoc) || !Number.isFinite(minSocOnGrid)) throw new Error('no SoC limits in the answer');
    const limits = { minSoc, minSocOnGrid };
    this.socLimits = { ...limits, time: Date.now() };
    return limits;
  }

  /** The MaxSoc setting, or undefined when the answer has none. */
  async readMaxSoc() {
    const value = (await this.client.getSetting({ sn: this.deviceSn, key: 'MaxSoc' }))?.result?.value;
    return value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value);
  }

  async showSocLimits(limits) {
    for (const [cap, key] of Object.entries(SOC_CAPS)) {
      // eslint-disable-next-line no-await-in-loop
      if (limits[key] !== undefined) await this.setCapability(cap, limits[key]);
    }
  }

  /**
   * @param {object} values the changed SoC limit capabilities
   */
  async onSocLimits(values) {
    const next = {};
    for (const [cap, key] of Object.entries(SOC_CAPS)) next[key] = values[cap] ?? this.getCapabilityValue(cap);
    this.log('SoC limits:', values, '->', next);
    if (!settings.socLimitsValid(next)) throw new Error(this.homey.__('errors.socRange'));
    try {
      await this.clearControlOverridden();
      await this.client.setBatterySoc({ sn: this.deviceSn, minSoc: next.minSoc, minSocOnGrid: next.minSocOnGrid });
      await this.noteWrites(next);
      // the slot's discharge floor follows minSocOnGrid
      this.socLimits = { ...next, time: Date.now() };
    } catch (error) {
      this.error('SoC limits failed:', error.message || error);
      throw new Error(`${this.homey.__('errors.settingFailed')} ${error.message || error}`);
    } finally {
      this.settingsDirty = true; // read the result back on the next tick
    }
  }

  /** The 'Set SoC limits' flow card. */
  async setSocLimits({ min, ongrid }) {
    const values = { battery_min_soc: min, battery_min_soc_ongrid: ongrid };
    await this.onSocLimits(values);
    for (const [cap, value] of Object.entries(values)) {
      // eslint-disable-next-line no-await-in-loop
      await this.setCapability(cap, value);
    }
  }

  /**
   * @param {object} values the changed capabilities: target_power and/or target_power_mode
   */
  async onControl(values) {
    const mode = values.target_power_mode ?? this.getCapabilityValue('target_power_mode');
    const watts = values.target_power ?? this.getCapabilityValue('target_power') ?? 0;
    this.log('control:', values, '->', mode, watts);
    try {
      await this.clearControlOverridden();
      if (mode === ctl.MODE_HOMEY || values.target_power !== undefined) {
        await this.applyHomey(watts);
        if (mode !== ctl.MODE_HOMEY) this.setCapability('target_power_mode', ctl.MODE_HOMEY).catch(this.error);
        await this.noteWrites({ mode: ctl.MODE_HOMEY });
      } else if (mode === ctl.MODE_SCHEDULE) {
        await this.applySchedule();
        await this.noteWrites({ mode });
      } else {
        await this.applyWorkMode(mode);
        await this.noteWrites({ mode });
      }
    } catch (error) {
      this.error('control failed:', error.message || error);
      throw new Error(`${this.homey.__('errors.controlFailed')} ${error.message || error}`);
    } finally {
      this.controlDirty = true; // read the result back on the next tick
    }
  }

  /** Keep a copy of the owner's schedule before Homey overwrites it. */
  async saveOwnerSchedule() {
    if (this.getCapabilityValue('target_power_mode') !== ctl.MODE_SCHEDULE) return;
    const groups = (await this.client.getScheduler({ sn: this.deviceSn }))?.result?.groups;
    if (!Array.isArray(groups) || !groups.length) return;
    // a read right after a Homey write can still show that write; it is not the owner's
    if (ctl.isHomeyWrite(groups, this.getStoreValue('homeyHistory'))) return;
    await this.setStoreValue('ownerSchedule', groups);
  }

  async ensureScheduler(on) {
    if (this.schedulerOn === on) return;
    await this.client.setSchedulerFlag({ sn: this.deviceSn, enable: on });
    this.schedulerOn = on;
  }

  /** The inverter's local time, from the last snapshot, else from the device. */
  async inverterNow() {
    const fromSnapshot = ctl.inverterNow(this.snapshotTime);
    if (fromSnapshot) return fromSnapshot;
    const t = (await this.client.getDeviceTime({ sn: this.deviceSn }))?.result;
    if (!t) throw new Error('inverter time unknown');
    return { hour: Number(t.hour), minute: Number(t.minute) };
  }

  async minSocOnGrid() {
    const fresh = this.socLimits && (Date.now() - this.socLimits.time) < 6 * 60 * 60 * 1000;
    const value = fresh ? this.socLimits.minSocOnGrid : (await this.readSocLimits()).minSocOnGrid;
    if (!(value >= 10)) throw new Error('battery cutoff SoC unknown');
    return value;
  }

  async slotFor(watts) {
    return ctl.slotForPower(watts, {
      minSocOnGrid: await this.minSocOnGrid(),
      pvW: this.pvW,
      maxW: this.maxPowerW,
    });
  }

  /** Homey mode: one scheduler slot from now. */
  async applyHomey(watts, slot) {
    await this.saveOwnerSchedule();
    const next = slot || await this.slotFor(watts);
    const groups = ctl.slotGroups({ now: await this.inverterNow(), ...next });
    await this.client.setScheduler({ sn: this.deviceSn, groups });
    await this.ensureScheduler(true);
    await this.setStoreValue('homeyHistory', ctl.remember(this.getStoreValue('homeyHistory'), groups));
    await this.setStoreValue('homeyTarget', watts);
    const end = groups[groups.length - 1];
    this.log(`homey ${watts} W: ${next.workMode} fdPwr ${next.extraParam.fdPwr ?? '-'} W (PV ${this.pvW ?? '?'} W) until ${end.endHour}:${String(end.endMinute).padStart(2, '0')}`);
  }

  /** Schedule mode: restore the owner's slots as last seen, else use the slots stored now. */
  async applySchedule() {
    let groups = this.getStoreValue('ownerSchedule');
    if (!Array.isArray(groups) || !groups.length) {
      // the scheduler keeps its slots while it is off, and they are only read while it is on
      const stored = (await this.client.getScheduler({ sn: this.deviceSn }))?.result?.groups;
      if (!Array.isArray(stored) || !stored.length || ctl.isHomeyWrite(stored, this.getStoreValue('homeyHistory'))) {
        throw new Error(this.homey.__('errors.noSchedule'));
      }
      groups = stored;
      await this.setStoreValue('ownerSchedule', groups);
    }
    await this.client.setScheduler({ sn: this.deviceSn, groups });
    await this.ensureScheduler(true);
  }

  /** A FoxESS work mode: scheduler off, WorkMode set. */
  async applyWorkMode(mode) {
    const workMode = ctl.WORK_MODES[mode];
    if (!workMode) throw new Error(`unknown mode ${mode}`);
    await this.saveOwnerSchedule();
    await this.ensureScheduler(false);
    if (this.workMode !== workMode) {
      await this.client.setSetting({ sn: this.deviceSn, key: 'WorkMode', value: workMode });
      this.workMode = workMode;
    }
  }

  async handleData(data, options) {
    if (data?.snapshotTime) this.snapshotTime = data.snapshotTime;
    if (typeof data?.pvPower === 'number') this.pvW = Math.round(data.pvPower * 1000);
    return super.handleData(data, options);
  }

  /** Adds SoC limits, control state and Homey slot renewal. */
  async pollExtra(options = {}) {
    const common = await super.pollExtra(options);
    if (this.hasCapability('battery_min_soc') && this.settingsDue(options)) {
      this.settingsDirty = false;
      const startedAt = Date.now();
      try {
        const limits = await this.readSocLimits();
        await this.showSocLimits(limits);
        await this.checkOverride(limits, startedAt);
      } catch (error) {
        this.error('SoC limits failed:', error.message || error);
      }
    }
    if (this.hasCapability('battery_max_soc') && this.settingsDue(options)) {
      await this.readMaxSoc()
        .then((value) => this.setCapability('battery_max_soc', value))
        .catch((error) => this.error('max SoC failed:', error.message || error));
    }
    if (!this.hasCapability('target_power_mode')) return common;
    try {
      const due = options.force || this.controlDirty
        || ((this.pollTick || 1) - 1) % CONTROL_POLL_EVERY_N_TICKS === 0;
      if (due) await this.readControlState();
      if (this.getCapabilityValue('target_power_mode') === ctl.MODE_HOMEY) await this.keepHomeySlot();
    } catch (error) {
      this.error('control state failed:', error.message || error);
    }
    return common;
  }

  /** Homey mode, every tick: renew the slot before it ends, re-write it when PV moved. */
  async keepHomeySlot() {
    const [current] = this.getStoreValue('homeyHistory') || [];
    const watts = this.getStoreValue('homeyTarget') ?? 0;
    const next = await this.slotFor(watts);
    if (ctl.needsRenewal(current, ctl.inverterNow(this.snapshotTime))) {
      this.log('renewing the Homey slot');
      await this.applyHomey(watts, next);
    } else if (ctl.powerMoved(current, next)) {
      this.log('PV moved, re-writing the Homey slot');
      await this.applyHomey(watts, next);
    }
  }

  async readControlState() {
    this.controlDirty = false;
    const startedAt = Date.now();
    const flag = (await this.client.getSchedulerFlag({ sn: this.deviceSn }))?.result;
    this.schedulerOn = Boolean(flag?.enable);
    const workMode = (await this.client.getSetting({ sn: this.deviceSn, key: 'WorkMode' }))?.result?.value;
    if (workMode) this.workMode = workMode;
    let groups = [];
    if (this.schedulerOn) groups = (await this.client.getScheduler({ sn: this.deviceSn }))?.result?.groups || [];
    const mode = ctl.modeFromState({
      schedulerOn: this.schedulerOn, groups, workMode: this.workMode, homeyHistory: this.getStoreValue('homeyHistory'),
    });
    if (mode === ctl.MODE_SCHEDULE && groups.length) await this.setStoreValue('ownerSchedule', groups);
    if (mode) await this.setCapability('target_power_mode', mode);
    // no scheduler, no setpoint
    await this.setCapability('measure_power.target', this.schedulerOn
      ? ctl.activeSlotPower(groups, ctl.inverterNow(this.snapshotTime)) : null);
    await this.checkOverride({ mode }, startedAt);
  }

};
