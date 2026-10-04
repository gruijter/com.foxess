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
FoxESS OpenAPI client, authenticated with the user's own API key ("private token").

The key is generated in FoxCloud under User Profile -> API Management. Per the OpenAPI document
it travels in a `token` header - not `Authorization: Bearer`, which is the OAuth form; FoxESS
refuses a request that carries both - and every request is signed as
md5(path + "\r\n" + key + "\r\n" + timestamp).

One client exists per key and region (see app.js#getClient), shared by every device paired with
that key. That matters: FoxESS rate-limits per key, and the request batching and the device-list
cache below only work when all devices of an account go through the same instance.

Until 2026-09-19 this was an OAuth2 client on homey-oauth2app; that version is archived in
zzz_docs/oauth_archive/.
*/
module.exports = class FoxEssClient {

  // Node's fetch has no default timeout, so a response that stalls mid-stream would hang forever:
  // no error, no log, no retry, and during pairing it surfaces as Homey's opaque "Timeout after
  // 30000ms". Every request therefore carries an AbortSignal (see buildRequest).
  static REQUEST_TIMEOUT = 20000;

  // FoxESS answers a throttled call with HTTP 200 and this code in the body - not a 429, and with
  // no x-ratelimit-reset or Retry-After header to read a recovery time from (checked against the
  // live endpoint). com.sungrowpower can retry because iSolarCloud advertises its reset; here an
  // immediate retry would just be a guess that spends more of the daily quota. So the client goes
  // quiet instead and lets the next poll tick pick things up - which costs nothing, because that
  // tick is only minutes away. The cooldown length is a deliberate choice, not a documented value.
  static RATE_LIMIT_CODE = 40400;
  static RATE_LIMIT_COOLDOWN = 5 * 60 * 1000;
  static RATE_LIMIT_JITTER = 60 * 1000;

  // The document's "Access frequency limit": a query endpoint at most once per second, an update
  // endpoint at most once per 2 seconds, "each interface calculated separately". Every request
  // therefore waits its turn per path (see pace()); different paths never wait for each other.
  // 100 ms on top, so clock jitter between here and FoxESS cannot land a call just inside the limit.
  static QUERY_SPACING_MS = 1100;
  static WRITE_SPACING_MS = 2100;

  // The update endpoints: .../set, .../enable, .../set/flag, heat/register and
  // register/status/change (the app calls neither heat one). Everything else - including the POST
  // queries such as heat/register/list - is a query.
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
    // (sn, epochMs) for every snapshot a real-time answer carries; the app times its tick with it
    this.onSnapshot = null;
    this._realQueue = [];
    this._realTimer = null;
    this._rateLimitedUntil = 0;
    // path -> the tail of that path's queue, and -> when it last went out (see pace())
    this._pathTail = new Map();
    this._pathSentAt = new Map();
  }

  /**
   * The headers FoxESS requires on every call. Built per request, so the timestamp is fresh.
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
   * Turn a request description into fetch arguments. Refuses to build anything at all while the
   * key is in a rate-limit cooldown, so the quota stops being spent.
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
   * Check a parsed response body. FoxESS reports errors in the body (errno), mostly with HTTP 200.
   *
   * The rate limit starts a cooldown. Any other non-zero errno (e.g. 41811, missing permission)
   * is thrown, so a caller never mistakes an error envelope for data. An unknown API key does not
   * get this far: FoxESS answers it with HTTP 401 (verified live), which request() throws.
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
   * Wait for this path's turn: requests to one path go out one after another, spaced by the
   * document's limit for that kind of endpoint. Resolves when the request may be sent.
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
    // Write the raw response into the app log when armed, so a user's diagnostics report can be
    // turned back into test fixtures. No-op unless something armed it.
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
   * Full detail for one device: firmware versions, rated capacity, hasPV/hasBattery, and the
   * batteryList (per-module SN, model and capacity). Unlike device/list this is per-SN.
   *
   * v1: the document marks /op/v0/device/detail deprecated. Both answered identically on De Brik
   * (H3-G2, 2026-10-04: same fields, same values).
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
   * Energy yield of one inverter: today, this month and cumulative, in kWh. FoxESS computes the
   * day and month boundaries in the time zone of the plant the inverter belongs to.
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
   * An energy report: per variable, the hourly values of a day, the daily values of a month or the
   * monthly values of a year, in the time zone of the inverter's plant.
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
   * A device's status from /op/v0/device/list: 1 online, 2 breakdown, 3 offline.
   *
   * The list covers the whole account, so one answer is shared by every device on this client for
   * DEVICE_STATUS_CACHE_MS, and concurrent callers share the request in flight.
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
   * FoxESS's own table from fault code to text ({ errNo: { en, zh_CN } }). Account- and device-
   * independent, so one call serves every inverter.
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
   * The installation's own battery limits: minSoc, and minSocOnGrid ("Battery discharge cutoff
   * SOC in grid-connected state").
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

  // --- Battery control (work mode and scheduler) ---
  // FoxESS has no direct power setpoint. Charging and discharging at a chosen power is a
  // ForceCharge/ForceDischarge time slot in scheduler v3; without the scheduler, the inverter
  // follows its WorkMode setting (SelfUse, Feedin, Backup, PeakShaving).

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
   * The scheduler v3 slots: { enable, groups, properties, maxGroupCount }. `properties` carries the
   * device's own ranges (fdPwr in W, SoCs) and the work modes it accepts in a slot.
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
   * Real-time data for a set of devices, served from a single combined request.
   *
   * Every device is woken by the same poll tick, so their calls arrive within a few ms of each
   * other. They are queued for REAL_QUERY_BATCH_MS and then answered by one request instead of
   * one per device - which matters here because several Homey devices routinely sit on the SAME
   * inverter SN (foxEssPointMap has inverter/battery/meter entries all keyed 'inverter'), so the
   * old code asked the API about the same serial up to three times per cycle.
   *
   * The pattern is com.sungrowpower's request coalescing. It was first built on the deprecated
   * /op/v0/device/real/query, whose doc claims it "get[s] the real-time data of all devices ...
   * without specifying the SN" - but that account-wide, no-SN call returns errno 0 with
   * `result: null` on live accounts (verified 2026-09), so every device came up empty. The
   * recommended /op/v1/device/real/query takes the serials explicitly in an `sns` array (up to
   * 50) and returns the array of {deviceSN, datas}. So every caller passes the serial(s) it needs,
   * the batch unions them into one request, and each caller picks its own out of the shared reply.
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
      // `sns` is required by v1 - it is what makes the API return data at all (the v0 no-SN call
      // answered with result:null) - and takes at most 50 serials, so a larger account is asked in
      // chunks and the answers are joined into one. An empty variables list is omitted, since the
      // API then returns all variables by default.
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

  // --- Heat pump endpoints ---
  // Heat pumps live in their own registry, separate from /op/v0/device/list, and are read through
  // the module (gateway) serial. The paths below are the live ones, NOT the document's: checked on
  // De Brik 2026-10-04, the document's /op/v0/register/heat/list and /op/v0/heat/<x>Controls/get
  // answer 404 like any unknown path, while /op/v0/heat/register/list answers (errno 0) and GET
  // /op/v0/heat/<x>Controls answers 40257 without moduleSn, 41811 for a module of another account
  // and 41930 ("Device does not exist") for a module of this account that is not a heat pump.
  // Only reads are implemented: the write paths are unverified (see drivers/heatpump/device.js).
  // Live telemetry is Kafka-only (see foxEssPointMap.js).

  /**
   * The registered heat pumps. `sn` (the outdoor unit's serial) is optional in practice: the live
   * endpoint answers without it.
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
   * The data loggers (modules) of the account. A heat pump's gateway may be one of them.
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
