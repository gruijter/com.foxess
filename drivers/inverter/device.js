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
const { GENERATION_POLL_EVERY_N_TICKS } = require('../../lib/foxEssConstants');

module.exports = class MyDevice extends CommonDevice {

  /**
   * Whether the inverter has an ExportLimit setting: supported once read, never withdrawn on a
   * failure. Checked on every (re)start, one call.
   */
  async onClientReady() {
    const value = await this.readExportLimit().catch((error) => {
      this.error('export limit check failed:', error.message || error);
      return undefined;
    });
    if (value !== undefined) await this.setStoreValue('exportLimitSupported', true);
  }

  extraCapabilities() {
    return this.getStoreValue('exportLimitSupported') ? ['export_limit', 'alarm_generic.control'] : [];
  }

  /**
   * export_limit up to the rated power - or higher when the inverter itself reports more: De Brik
   * (P3-10.0-SH, 10 kW) reads 17000. That the value is in W is the document's own example
   * ("13000"); the setting/get answer carries no unit.
   */
  capabilityOptions() {
    const max = Math.max(this.maxPowerW, Math.ceil((this.exportLimit || 0) / 100) * 100);
    return { export_limit: { min: 0, max, step: 100 } };
  }

  async onInit() {
    await super.onInit();
    if (!this.hasCapability('export_limit')) return;
    if (this.exportLimit !== undefined) await this.setCapability('export_limit', this.exportLimit);
    if (this.exportListenerSet) return; // onInit runs again on every restartDevice()
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

  /**
   * The 'Set export limit' flow card: as if changed on the device page, shown right away.
   */
  async setExportLimit(watts) {
    await this.onExportLimit(watts);
    await this.setCapability('export_limit', Math.max(0, Math.round(Number(watts))));
  }

  /**
   * Today's and this month's yield from /op/v0/device/generation. Every Nth tick only (one call
   * per inverter), always on a forced poll. Between fetches the capabilities keep their value:
   * the fields are simply absent, and setCapability() skips undefined.
   * @returns {Promise<object>} the common extra fields, plus { generationToday, generationMonth }
   */
  async pollExtra(options = {}) {
    const common = await super.pollExtra(options);
    if (this.hasCapability('export_limit') && this.settingsDue(options)) {
      this.settingsDirty = false;
      const startedAt = Date.now();
      try {
        const exportLimit = await this.readExportLimit();
        await this.setCapability('export_limit', exportLimit);
        await this.checkOverride({ exportLimit }, startedAt);
      } catch (error) {
        this.error('export limit failed:', error.message || error);
      }
    }
    const due = options.force || ((this.pollTick || 1) - 1) % GENERATION_POLL_EVERY_N_TICKS === 0;
    if (!due) return common;
    const response = await this.client.getDeviceGeneration({ sn: this.deviceSn }).catch((error) => {
      this.error('device generation failed:', error.message || error);
      return null;
    });
    const result = response?.result;
    if (!result) return common;
    return {
      ...common,
      generationToday: result.today,
      generationMonth: result.month,
    };
  }

};
