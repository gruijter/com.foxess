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

// The solar capabilities show the AC side; one that can only show the DC side (see
// foxEssPointMap.inverterSolarSides) gets its '(DC)' title from capabilityOptions() - the '(AC)'
// ones are the manifest's. Titles as com.growatt has them, see lib/foxEssSolarTitles.js.
module.exports = class MyDevice extends CommonDevice {

  onReadings({ exportLimit }) {
    if (exportLimit !== undefined) this.exportLimit = exportLimit;
  }

  /**
   * export_limit up to the rated power - or higher when the inverter itself reports more: De Brik
   * (P3-10.0-SH, 10 kW) reads 17000. That the value is in W is the document's own example
   * ("13000"); the setting/get answer carries no unit.
   */
  capabilityOptions() {
    const max = Math.max(this.maxPowerW, Math.ceil((this.exportLimit || 0) / 100) * 100);
    const options = { export_limit: { min: 0, max, step: 100 } };
    // every solar capability titled with its side, so a rebuilt one keeps it and a switch shows
    for (const [cap, side] of Object.entries(this.getStoreValue('solarSides') || {})) {
      options[cap] = { title: solarTitle(cap, side) };
    }
    return options;
  }

  /** A repair is the moment to look at the battery again: the next full payload re-decides the sides. */
  async onRepaired() {
    await this.setStoreValue('redecideSolarSides', true);
  }

  /**
   * Which side - AC or DC - each solar capability shows. Decided at pairing (see the driver's
   * pairStore) and then kept: a capability always shows the same quantity. Only a repair decides
   * again - a battery added later moves the energy to DC, where `generation` would count its
   * discharge as yield - from the facts known then: the battery flag of the device detail onInit
   * just refreshed, and whether this first full payload carries the AC output. A fact unknown
   * then keeps the stored side (see foxEssPointMap.inverterSolarSides). A device paired before
   * the decision moved to pairing gets one the same way, from its first full payload.
   * @param {object} data a full payload
   */
  async decideSolarSides(data) {
    if (this.solarSidesDecided) return;
    this.solarSidesDecided = true;
    const previous = this.getStoreValue('solarSides');
    if (!previous || this.getStoreValue('redecideSolarSides')) {
      const hasBattery = this.getStoreValue('deviceDetail')?.hasBattery ?? this.getStoreValue('hasBattery');
      const sides = foxEssPointMap.inverterSolarSides({
        hasBattery: typeof hasBattery === 'boolean' ? hasBattery : undefined,
        acPower: data.generationPower !== undefined && data.generationPower !== null,
      }, previous || {});
      if (!previous || Object.keys(sides).some((cap) => sides[cap] !== previous[cap])) {
        this.log('solar sides decided:', JSON.stringify(previous || {}), '->', JSON.stringify(sides));
        await this.setStoreValue('solarSides', sides);
        // another counter: a Homey-timezone 'today' starts again from it rather than across both
        if (previous && sides.meter_power !== previous.meter_power) {
          await this.unsetStoreValue('todayBaseline_meter_power.today').catch((error) => this.error(error));
        }
      }
      await this.setStoreValue('redecideSolarSides', false);
    }
    // the titles to match - no write when they already do
    await DeviceMigrator.syncCapabilityOptions(this, this.capabilityOptions());
  }

  async handleData(data, options = {}) {
    if (!data) return super.handleData(data, options);
    if (data.snapshotTime) this.snapshotTime = data.snapshotTime;
    if (!options.partial) await this.decideSolarSides(data).catch((error) => this.error(error));
    const solarSides = this.getStoreValue('solarSides');
    // no decision yet (an old device whose real-time query failed): show no solar values at all
    return super.handleData({ ...data, solarSides: solarSides || {} }, options);
  }

  async onInit() {
    this.solarSidesDecided = false; // onInit runs again on every restartDevice(), a repair's too
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
   * Today's and this month's yield (see the driver's energyFields). Every Nth tick
   * only (one call per inverter), always on a forced poll. Between fetches the capabilities keep
   * their value: the fields are simply absent, and setCapability() skips undefined.
   * @returns {Promise<object>} the common extra fields, plus { pvToday, pvMonth, acToday, acMonth }
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
    return {
      ...common,
      ...(await this.driver.energyFields({ client: this.client, deviceSn: this.deviceSn, snapshotTime: this.snapshotTime })),
    };
  }

};
