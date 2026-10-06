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
const DeviceMigrator = require('../../lib/DeviceMigrator');
const foxEssPointMap = require('../../lib/foxEssPointMap');
const { solarTitle } = require('../../lib/foxEssSolarTitles');
const { GENERATION_POLL_EVERY_N_TICKS } = require('../../lib/foxEssConstants');

module.exports = class MyDevice extends CommonDevice {

  onReadings({ exportLimit }) {
    if (exportLimit !== undefined) this.exportLimit = exportLimit;
  }

  /**
   * export_limit (W, per the document's example) up to the rated power, or the reported value when
   * higher (a 10 kW P3 read 17000). Solar capabilities get the title of their side.
   */
  capabilityOptions() {
    const max = Math.max(this.maxPowerW, Math.ceil((this.exportLimit || 0) / 100) * 100);
    const options = { export_limit: { min: 0, max, step: 100 } };
    for (const [cap, side] of Object.entries(this.getStoreValue('solarSides') || {})) {
      options[cap] = { title: solarTitle(cap, side) };
    }
    return options;
  }

  /** A repair re-decides the solar sides (e.g. a battery added later). */
  async onRepaired() {
    await this.setStoreValue('redecideSolarSides', true);
  }

  /**
   * The solar sides are decided at pairing and kept, so a capability always shows the same
   * quantity. Decided here only after a repair, for older devices, or while power is undecided.
   * @param {object} data a full payload
   */
  async decideSolarSides(data) {
    if (this.solarSidesDecided) return;
    const previous = this.getStoreValue('solarSides');
    if (!previous || !previous.measure_power || this.getStoreValue('redecideSolarSides')) {
      const hasBattery = this.getStoreValue('deviceDetail')?.hasBattery ?? this.getStoreValue('hasBattery');
      const sides = foxEssPointMap.inverterSolarSides({
        hasBattery: typeof hasBattery === 'boolean' ? hasBattery : undefined,
        acPower: foxEssPointMap.acPowerReported(data),
      }, previous || {});
      const caps = new Set([...Object.keys(sides), ...Object.keys(previous || {})]);
      if (!previous || [...caps].some((cap) => sides[cap] !== previous[cap])) {
        this.log('solar sides decided:', JSON.stringify(previous || {}), '->', JSON.stringify(sides));
        await this.setStoreValue('solarSides', sides);
        // another counter: rebase the Homey-timezone 'today'
        if (previous && sides.meter_power !== previous.meter_power) {
          await this.unsetStoreValue('todayBaseline_meter_power.today').catch((error) => this.error(error));
        }
      }
      if (!sides.measure_power) return; // retry with the next payload
      await this.setStoreValue('redecideSolarSides', false);
    }
    this.solarSidesDecided = true;
    await DeviceMigrator.syncCapabilityOptions(this, this.capabilityOptions());
  }

  async handleData(data, options = {}) {
    if (!data) return super.handleData(data, options);
    if (data.snapshotTime) this.snapshotTime = data.snapshotTime;
    if (!options.partial) await this.decideSolarSides(data).catch((error) => this.error(error));
    const solarSides = this.getStoreValue('solarSides');
    // no decision yet: no solar values
    return super.handleData({ ...data, solarSides: solarSides || {} }, options);
  }

  async onInit() {
    this.solarSidesDecided = false;
    await super.onInit();
    if (!this.hasCapability('export_limit')) return;
    if (this.exportLimit !== undefined) await this.showExportLimit(this.exportLimit);
    if (this.exportListenerSet) return; // restartDevice() reruns onInit
    this.registerCapabilityListener('export_limit', (watts) => this.onExportLimit(watts));
    this.exportListenerSet = true;
  }

  /** The ExportLimit setting in W, or undefined when the answer has none. */
  async readExportLimit() {
    const value = Number((await this.client.getSetting({ sn: this.deviceSn, key: 'ExportLimit' }))?.result?.value);
    if (!Number.isFinite(value)) return undefined;
    this.exportLimit = value;
    return value;
  }

  /** The export limit, and whether it is below the rated power (as com.solarwatt). */
  async showExportLimit(watts) {
    await this.setCapability('export_limit', watts);
    if (typeof watts === 'number') await this.setCapability('inverter_limit_active', watts < this.maxPowerW);
  }

  async onExportLimit(watts) {
    const value = Math.max(0, Math.round(Number(watts)));
    this.log('export limit ->', value);
    try {
      await this.clearControlOverridden();
      await this.client.setSetting({ sn: this.deviceSn, key: 'ExportLimit', value });
      await this.noteWrites({ exportLimit: value });
      this.exportLimit = value;
    } catch (error) {
      this.error('export limit failed:', error.message || error);
      throw new Error(`${this.homey.__('errors.settingFailed')} ${error.message || error}`);
    } finally {
      this.settingsDirty = true; // read the result back on the next tick
    }
  }

  /** The 'Set export limit' flow card. */
  async setExportLimit(watts) {
    await this.onExportLimit(watts);
    await this.showExportLimit(Math.max(0, Math.round(Number(watts))));
  }

  /**
   * Adds the export limit, and every Nth tick the energy report (absent fields keep their value).
   * @returns {Promise<object>} the common extra fields, plus { pvToday, pvMonth, acToday, acMonth }
   */
  async pollExtra(options = {}) {
    const common = await super.pollExtra(options);
    if (this.hasCapability('export_limit') && this.settingsDue(options)) {
      this.settingsDirty = false;
      const startedAt = Date.now();
      try {
        const exportLimit = await this.readExportLimit();
        await this.showExportLimit(exportLimit);
        await this.checkOverride({ exportLimit }, startedAt);
      } catch (error) {
        this.error('export limit failed:', error.message || error);
      }
    }
    const due = options.force || ((this.pollTick || 1) - 1) % GENERATION_POLL_EVERY_N_TICKS === 0;
    if (!due) return common;
    return {
      ...common,
      ...(await this.driver.energyFields({ client: this.client, deviceSn: this.deviceSn, snapshotTime: this.snapshotTime })),
    };
  }

};
