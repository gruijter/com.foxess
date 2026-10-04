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

// Active faults, as the installation itself reports them.
//
// The real-time query carries `currentFault` ("Current fault code") and `currentFaultCount`.
// /op/v0/device/fault/get translates codes into FoxESS's own text - 2759 codes live (2026-09-19),
// account-independent, 162 KB raw. The text decides which alarm a fault raises; the rules below
// were reviewed code by code against that live table (zzz_docs/fault_classification.md):
//
//   heat    over temp / overheat / temperature (too|super) high / high temp / too hot -
//           but not when the text is about a sensor, an invalid reading, or LOW/UNDER temperature
//   battery batt / bms / bdc (the battery DC converter)
//
// Every active fault raises alarm_problem regardless; a low state of charge is normal operation
// and deliberately raises nothing.

// `temp\w*?\s*` so camel-cased codes match too: 1122 'cEnvTempHighFault' is the ambient over-temperature.
const HEAT = /over.?temp|overheat|temp\w*?\s*(is\s+)?(too\s+|super\s+)?high|high.?temp|too hot/i;
const NOT_HEAT = /sensor|sen(open|short)|invalid|low\b|under/i;
const BATTERY = /batt|bms|bdc/i;

const isHeat = (text) => HEAT.test(text) && !NOT_HEAT.test(text);
const isBattery = (text) => BATTERY.test(text);

// The table only changes with FoxESS releases, so it is fetched once per app run, and only once a
// fault is actually active - on a healthy installation it is never fetched at all. A failed fetch
// is retried at the earliest an hour later; until then codes are reported without their text.
const RETRY_MS = 60 * 60 * 1000;
let table = null;
let pending = null;
let failedAt = 0;

/** code -> English text, from the raw /op/v0/device/fault/get answer. */
const compactTable = (response) => {
  const result = response?.result;
  const rows = Array.isArray(result) ? result : [result];
  const compact = {};
  rows.forEach((row) => Object.entries(row || {}).forEach(([code, text]) => {
    compact[code] = typeof text === 'string' ? text : text?.en;
  }));
  return compact;
};

const loadTable = async (client) => {
  if (table) return table;
  if (pending) return pending;
  if (Date.now() - failedAt < RETRY_MS) return null;
  pending = client.getFaultCodes()
    .then((response) => {
      const compact = compactTable(response);
      if (!Object.keys(compact).length) throw Error('empty fault table');
      table = compact;
      return table;
    })
    .catch((error) => {
      failedAt = Date.now();
      client.error?.('fault table fetch failed:', error.message || error);
      return null;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
};

/**
 * The texts of the faults in `currentFault`.
 *
 * The document only says "Current fault code". Live it was "" with no fault active, so the shape of
 * an active one has not been seen yet: it is accepted as one code, several codes separated by
 * , ; or |, or text. A numeric code is looked up; a code the table lacks is kept as "Fault <code>",
 * and anything non-numeric is taken as the text itself - either way it still raises alarm_problem.
 * @param {*} currentFault the raw variable value
 * @param {object} client the API client, to fetch the table on first need
 * @returns {Promise<string[]>} one text per active fault, [] when none
 */
const faultTexts = async (currentFault, client) => {
  if (currentFault === undefined || currentFault === null) return [];
  const tokens = String(currentFault).split(/[,;|]/).map((t) => t.trim()).filter((t) => t && t !== '0');
  if (!tokens.length) return [];
  const lookup = tokens.some((t) => /^\d+$/.test(t)) ? await loadTable(client) : null;
  return tokens.map((t) => {
    if (!/^\d+$/.test(t)) return t;
    return lookup?.[t] || `Fault ${t}`;
  });
};

/** Test hook: preload or reset the cached table. */
const setTable = (value) => {
  table = value;
  pending = null;
  failedAt = 0;
};

module.exports = {
  faultTexts,
  isHeat,
  isBattery,
  compactTable,
  setTable,
};
