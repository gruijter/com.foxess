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

const crypto = require('crypto');
const { DEVICE_STATUS_CACHE_MS, REAL_QUERY_BATCH_MS } = require('./foxEssConstants');
const capture = require('./foxEssCapture');
const { parseSnapshotTime } = require('./foxEssTiming');

/*
FoxESS OpenAPI client, authenticated with the user's API key ("private token"): sent in a `token`
header (never together with `Authorization`, per the document) and signed as
md5(path + "\r\n" + key + "\r\n" + timestamp).

One client per key and region (app.js#getClient), shared by all devices of that key: FoxESS
rate-limits per key, and the batching and caches below rely on the shared instance.
The former OAuth2 client is archived in zzz_docs/oauth_archive/.
*/
module.exports = class FoxEssClient {

  // per request, so a stalled response fails before Homey's 30 s pairing timeout
  static REQUEST_TIMEOUT = 20000;

  // Throttling is HTTP 200 with errno 40400 and no reset/Retry-After header, so the client pauses
  // and leaves recovery to a later poll. The cooldown length is our own choice.
  static RATE_LIMIT_CODE = 40400;
  static RATE_LIMIT_COOLDOWN = 5 * 60 * 1000;
  static RATE_LIMIT_JITTER = 60 * 1000;

  // Document's access frequency limit, per endpoint: queries 1/s, updates 1/2 s; plus 100 ms margin.
  static QUERY_SPACING_MS = 1100;
  static WRITE_SPACING_MS = 2100;

  // update endpoints; everything else (also POST queries like heat/register/list) is a query
  static WRITE_PATH = /\/(set|enable)(\/|$)|\/heat\/register(\/status\/change)?$/;

  // v1 real/query: "Can transmit up to 50 Serial Number".
  static MAX_SNS_PER_QUERY = 50;

  /**
   * @param {object} args
   * @param {object} args.homey the Homey instance, for timers
   * @param {string} args.apiKey the user's FoxESS API key
   * @param {string} args.host the region's API host, e.g. 'www.foxesscloud.com'
   * @param {Function} [args.log]
   * @param {Function} [args.error]
   */
  constructor({
    homey, apiKey, host, log, error,
  }) {
    this.homey = homey;
    this.apiKey = apiKey;
    this.host = host;
    this.log = log || (() => {});
    this.error = error || (() => {});
    // (sn, epochMs) per snapshot in a real-time answer; the app times its poll tick with it
    this.onSnapshot = null;
    this._realQueue = [];
    this._realTimer = null;
    this._rateLimitedUntil = 0;
    // per path: tail of its queue, and last send time (see pace())
    this._pathTail = new Map();
    this._pathSentAt = new Map();
  }

  /**
   * The signed headers for one request.
   * @param {string} path the request path, without host or query string
   * @returns {object} headers
   */
  getSignatureHeaders(path) {
    const timestamp = Date.now().toString();
    const signature = crypto.createHash('md5')
      .update(`${path}\r\n${this.apiKey}\r\n${timestamp}`)
      .digest('hex');
    return {
      token: this.apiKey,
      timestamp,
      signature,
      lang: 'en',
      'Content-Type': 'application/json',
      // the document asks script callers to set their own User-Agent
      'User-Agent': `Homey com.foxess/${this.homey?.manifest?.version || 'dev'}`,
    };
  }

  /**
   * fetch() arguments for a request; throws during a rate-limit cooldown.
   * @returns {{ url: string, opts: object }}
   */
  buildRequest({
    method, path, query, body,
  }) {
    const wait = this._rateLimitedUntil - Date.now();
    if (wait > 0) {
      throw new Error(`Fox ESS rate limit active, skipping request for another ${Math.ceil(wait / 1000)}s`);
    }
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    return {
      url: `https://${this.host}${path}${qs}`,
      opts: {
        method,
        headers: this.getSignatureHeaders(path),
        body,
        signal: AbortSignal.timeout(FoxEssClient.REQUEST_TIMEOUT),
      },
    };
  }

  /**
   * Check a parsed body: FoxESS reports errors as errno, mostly with HTTP 200. The rate limit
   * starts a cooldown; any other non-zero errno throws. (An unknown key gets HTTP 401, verified live.)
   * @returns {object} the body, when it carries no error
   */
  handleResult(result) {
    if (!result || typeof result !== 'object') throw new Error('Fox ESS returned an invalid response');
    const code = Number(result.errno ?? result.code);
    if (code === FoxEssClient.RATE_LIMIT_CODE) {
      const cooldown = FoxEssClient.RATE_LIMIT_COOLDOWN
        + Math.round(Math.random() * FoxEssClient.RATE_LIMIT_JITTER);
      this._rateLimitedUntil = Date.now() + cooldown;
      this.error(`[API] Rate limited (${code}); pausing requests for ${Math.round(cooldown / 1000)}s`);
      throw new Error(result.msg || 'Fox ESS rate limit reached');
    }
    if (!Number.isNaN(code) && code !== 0) {
      throw new Error(`${result.msg || 'Fox ESS API error'} (errno ${code})`);
    }
    return result;
  }

  /**
   * Resolves when a request to this path may be sent (serialized and spaced per path).
   * @param {string} path the request path
   * @returns {Promise<void>}
   */
  pace(path) {
    const spacing = FoxEssClient.WRITE_PATH.test(path) ? FoxEssClient.WRITE_SPACING_MS : FoxEssClient.QUERY_SPACING_MS;
    const turn = (this._pathTail.get(path) || Promise.resolve()).then(async () => {
      const wait = (this._pathSentAt.get(path) || 0) + spacing - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => {
          this.homey.setTimeout(resolve, wait);
        });
      }
      this._pathSentAt.set(path, Date.now());
    });
    this._pathTail.set(path, turn);
    return turn;
  }

  async request(req) {
    await this.pace(req.path);
    const { url, opts } = this.buildRequest(req);
    const response = await fetch(url, opts);
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(result?.msg || `Fox ESS HTTP ${response.status} ${response.statusText}`);
    }
    const checked = this.handleResult(result);
    // logs the raw response only while a capture is armed (see foxEssCapture.js)
    capture.record(req.path, checked, (line) => this.log(line));
    return checked;
  }

  get({ path, query }) {
    return this.request({ method: 'GET', path, query });
  }

  post({ path, body }) {
    return this.request({ method: 'POST', path, body });
  }

  // --- API Endpoints (FoxESS OpenAPI) ---

  async getPlantList() {
    const path = '/op/v0/plant/list';
    this.log(`[API] Calling ${path}...`);
    return this.post({
      path,
      body: JSON.stringify({
        pageSize: 100,
        currentPage: 1,
      }),
    });
  }

  async getDeviceList({ plantID } = {}) {
    const path = '/op/v0/device/list';
    this.log(`[API] Calling ${path}...`);
    return this.post({
      path,
      body: JSON.stringify({
        plantID,
        pageSize: 100,
        currentPage: 1,
      }),
    });
  }

  /**
   * Detail of one device: firmware, capacity, hasPV/hasBattery, batteryList. (v0 is deprecated.)
   * @returns {Promise<*>} the raw API response
   */
  async getDeviceDetail({ sn }) {
    const path = '/op/v1/device/detail';
    this.log(`[API] Calling ${path} for ${sn}...`);
    return this.get({
      path,
      query: { sn },
    });
  }

  /**
   * Energy yield today, this month and cumulative (kWh), in the plant's time zone.
   * @returns {Promise<*>} the raw API response ({ result: { today, month, cumulative } })
   */
  async getDeviceGeneration({ sn }) {
    const path = '/op/v0/device/generation';
    this.log(`[API] Calling ${path} for ${sn}...`);
    return this.get({
      path,
      query: { sn },
    });
  }

  /**
   * Energy report per variable: hourly (day), daily (month) or monthly (year), plant time zone.
   * @param {object} args
   * @param {string} args.sn
   * @param {'day'|'month'|'year'} args.dimension
   * @param {number} args.year
   * @param {number} [args.month] required for 'month' and 'day'
   * @param {number} [args.day] required for 'day'
   * @param {string[]} args.variables e.g. ['PVEnergyTotal', 'generation']
   * @returns {Promise<*>} the raw API response ({ result: [{ variable, unit, values: [] }] })
   */
  async getDeviceReport({
    sn, dimension, year, month, day, variables,
  }) {
    const path = '/op/v0/device/report/query';
    this.log(`[API] Calling ${path} ${dimension} ${year}-${month || ''}${day ? `-${day}` : ''} for ${sn}...`);
    const body = {
      sn, year, dimension, variables,
    };
    if (month) body.month = month;
    if (day) body.day = day;
    return this.post({ path, body: JSON.stringify(body) });
  }

  /**
   * A device's status from /op/v0/device/list (1 online, 2 breakdown, 3 offline). The account-wide
   * list is cached for DEVICE_STATUS_CACHE_MS and shared by concurrent callers.
   * @returns {Promise<number|undefined>} the status, or undefined when the device is not listed
   */
  async getDeviceStatus({ sn }) {
    const fresh = this._statusCache && (Date.now() - this._statusCache.time) < DEVICE_STATUS_CACHE_MS;
    if (!fresh) {
      if (!this._statusPending) {
        this._statusPending = this.getDeviceList()
          .then((response) => {
            const list = response?.result?.data || response?.result?.pageList || response?.data || [];
            this._statusCache = { time: Date.now(), list };
          })
          .finally(() => {
            this._statusPending = null;
          });
      }
      await this._statusPending;
    }
    const entry = this._statusCache.list.find((dev) => (dev.deviceSN || dev.sn) === sn);
    const status = Number(entry?.status);
    return Number.isNaN(status) || !entry ? undefined : status;
  }

  /**
   * FoxESS's fault code -> text table ({ errNo: { en, zh_CN } }), the same for every device.
   * @returns {Promise<*>} the raw API response
   */
  async getFaultCodes() {
    const path = '/op/v0/device/fault/get';
    this.log(`[API] Calling ${path}...`);
    return this.get({
      path,
    });
  }

  /**
   * The battery limits minSoc and minSocOnGrid.
   * @returns {Promise<*>} the raw API response
   */
  async getBatterySoc({ sn }) {
    const path = '/op/v0/device/battery/soc/get';
    this.log(`[API] Calling ${path} for ${sn}...`);
    return this.get({
      path,
      query: { sn },
    });
  }

  /**
   * Set both minimum SoCs at once; the endpoint requires the pair (10-100 each per the document).
   * @returns {Promise<*>} the raw API response
   */
  async setBatterySoc({ sn, minSoc, minSocOnGrid }) {
    const path = '/op/v0/device/battery/soc/set';
    this.log(`[API] Calling ${path} minSoc=${minSoc} minSocOnGrid=${minSocOnGrid} for ${sn}...`);
    return this.post({ path, body: JSON.stringify({ sn, minSoc, minSocOnGrid }) });
  }

  // --- Battery control ---
  // No direct power setpoint: a chosen power is a ForceCharge/ForceDischarge slot in scheduler v3;
  // without the scheduler the inverter follows its WorkMode setting.

  /**
   * One inverter setting (setting/get), e.g. key 'WorkMode'.
   * @returns {Promise<*>} the raw API response ({ result: { value, enumList, range } })
   */
  async getSetting({ sn, key }) {
    const path = '/op/v0/device/setting/get';
    this.log(`[API] Calling ${path} ${key} for ${sn}...`);
    return this.post({ path, body: JSON.stringify({ sn, key }) });
  }

  async setSetting({ sn, key, value }) {
    const path = '/op/v0/device/setting/set';
    this.log(`[API] Calling ${path} ${key}=${value} for ${sn}...`);
    return this.post({ path, body: JSON.stringify({ sn, key, value: String(value) }) });
  }

  /**
   * The scheduler master switch: { support, enable } (booleans in v1).
   * @returns {Promise<*>} the raw API response
   */
  async getSchedulerFlag({ sn }) {
    const path = '/op/v1/device/scheduler/get/flag';
    this.log(`[API] Calling ${path} for ${sn}...`);
    return this.post({ path, body: JSON.stringify({ deviceSN: sn }) });
  }

  async setSchedulerFlag({ sn, enable }) {
    const path = '/op/v1/device/scheduler/set/flag';
    this.log(`[API] Calling ${path} enable=${enable ? 1 : 0} for ${sn}...`);
    return this.post({ path, body: JSON.stringify({ deviceSN: sn, enable: enable ? 1 : 0 }) });
  }

  /**
   * Scheduler v3: { enable, groups, properties, maxGroupCount }; `properties` holds the device's
   * ranges (fdPwr in W, SoCs) and accepted slot work modes.
   * @returns {Promise<*>} the raw API response
   */
  async getScheduler({ sn }) {
    const path = '/op/v3/device/scheduler/get';
    this.log(`[API] Calling ${path} for ${sn}...`);
    return this.post({ path, body: JSON.stringify({ deviceSN: sn }) });
  }

  /**
   * Replace the scheduler v3 slots. Fields left out of a slot's extraParam keep their value.
   * @param {object} args
   * @param {string} args.sn
   * @param {object[]} args.groups [{ startHour, startMinute, endHour, endMinute, workMode, extraParam }]
   * @returns {Promise<*>} the raw API response
   */
  async setScheduler({ sn, groups }) {
    const path = '/op/v3/device/scheduler/enable';
    this.log(`[API] Calling ${path} with ${groups.length} slot(s) for ${sn}...`);
    return this.post({ path, body: JSON.stringify({ deviceSN: sn, isDefault: false, groups }) });
  }

  /**
   * The inverter's own clock. Scheduler slots are in inverter local time.
   * @returns {Promise<*>} the raw API response ({ result: { year, month, day, hour, minute, second } })
   */
  async getDeviceTime({ sn }) {
    const path = '/op/v0/device/time/get';
    this.log(`[API] Calling ${path} for ${sn}...`);
    return this.post({ path, body: JSON.stringify({ sn }) });
  }

  /**
   * Real-time data. Calls within REAL_QUERY_BATCH_MS (one poll tick; inverter, battery and meter
   * devices share a serial) are joined into one v1 request; each caller picks its serials from
   * the shared reply. (v0 without SNs answers `result: null`, verified 2026-09.)
   * @param {object} args
   * @param {string} [args.sn] a single serial (convenience; folded into `sns`)
   * @param {string[]} [args.sns] the serials this caller needs in the reply
   * @param {string[]} [args.variables] the variables to fetch; omitted means all
   * @returns {Promise<*>} the raw API response, covering every serial requested in the batch
   */
  getDeviceRealTimeData({ sn, sns, variables } = {}) {
    const serials = [...(sns || []), ...(sn ? [sn] : [])];
    return new Promise((resolve, reject) => {
      this._realQueue.push({
        sns: serials, variables, resolve, reject,
      });
      if (this._realTimer) return;
      this._realTimer = this.homey.setTimeout(() => {
        this._realTimer = null;
        this._flushRealQueue().catch((err) => this.error('real/query batch failed', err));
      }, REAL_QUERY_BATCH_MS);
    });
  }

  async _flushRealQueue() {
    const queue = this._realQueue;
    this._realQueue = [];
    if (!queue.length) return;

    const variables = [...new Set(queue.flatMap((item) => item.variables || []))];
    const sns = [...new Set(queue.flatMap((item) => item.sns || []))];
    const path = '/op/v1/device/real/query';
    this.log(`[API] Calling ${path} once for ${queue.length} device poll(s), ${sns.length} serial(s), ${variables.length} variable(s)...`);

    try {
      // at most 50 serials per request; no variables means all
      const chunks = [];
      for (let i = 0; i < sns.length; i += FoxEssClient.MAX_SNS_PER_QUERY) {
        chunks.push(sns.slice(i, i + FoxEssClient.MAX_SNS_PER_QUERY));
      }
      if (!chunks.length) chunks.push([]);
      let response = null;
      for (const chunk of chunks) {
        const body = { sns: chunk };
        if (variables.length) body.variables = variables;
        // eslint-disable-next-line no-await-in-loop
        const part = await this.post({
          path,
          body: JSON.stringify(body),
        });
        response = response
          ? { ...response, result: [...(response.result || []), ...(Array.isArray(part?.result) ? part.result : [])] }
          : part;
      }
      queue.forEach((item) => item.resolve(response));
      if (this.onSnapshot && Array.isArray(response?.result)) {
        response.result.forEach((dev) => {
          const at = parseSnapshotTime(dev.time);
          if (at) this.onSnapshot(dev.deviceSN, at);
        });
      }
    } catch (error) {
      queue.forEach((item) => item.reject(error));
    }
  }

  // --- Heat pump endpoints (read only) ---
  // Heat pumps have their own registry and are read by module (gateway) serial. These paths are
  // the live ones, not the document's, which answered 404 (2026-10-04).

  /**
   * The registered heat pumps; `sn` is optional in practice.
   * @returns {Promise<*>} the raw API response ({ result: { data: [{ heatSN, moduleSN, registerStatus, runningStatus, ... }] } })
   */
  async getHeatPumpList({ sn = '', currentPage = 1, pageSize = 100 } = {}) {
    const path = '/op/v0/heat/register/list';
    this.log(`[API] Calling ${path}${sn ? ` for ${sn}` : ''}...`);
    const body = { currentPage, pageSize };
    if (sn) body.sn = sn;
    return this.post({
      path,
      body: JSON.stringify(body),
    });
  }

  /**
   * The account's data loggers (modules).
   * @returns {Promise<*>} the raw API response ({ result: { data: [{ moduleSN, stationID, status, ... }] } })
   */
  async getModuleList() {
    const path = '/op/v0/module/list';
    this.log(`[API] Calling ${path}...`);
    return this.post({
      path,
      body: JSON.stringify({ currentPage: 1, pageSize: 100 }),
    });
  }

  /**
   * One group of heat pump settings, read by module serial.
   * @param {object} args
   * @param {string} args.moduleSn
   * @param {'heating'|'dhw'|'generic'|'heatingCircuits'} args.kind
   * @returns {Promise<*>} the raw API response
   */
  async getHeatControls({ moduleSn, kind }) {
    if (!FoxEssClient.HEAT_CONTROLS.includes(kind)) throw new Error(`Unknown heat pump controls: ${kind}`);
    const path = `/op/v0/heat/${kind}Controls`;
    this.log(`[API] Calling ${path} for module ${moduleSn}...`);
    return this.get({
      path,
      query: { moduleSn },
    });
  }

  static HEAT_CONTROLS = ['heating', 'dhw', 'generic', 'heatingCircuits'];

};
