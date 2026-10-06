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

// Fault codes (currentFault) to FoxESS's texts (/op/v0/device/fault/get); the text decides which
// alarm a fault raises. Rules checked against the live table: zzz_docs/fault_classification.md.

// `temp\w*?` also matches camel case ('cEnvTempHighFault')
const HEAT = /over.?temp|overheat|temp\w*?\s*(is\s+)?(too\s+|super\s+)?high|high.?temp|too hot/i;
const NOT_HEAT = /sensor|sen(open|short)|invalid|low\b|under/i;
const BATTERY = /batt|bms|bdc/i; // bdc: battery DC converter

const isHeat = (text) => HEAT.test(text) && !NOT_HEAT.test(text);
const isBattery = (text) => BATTERY.test(text);

// The table (~160 KB) is fetched once per app run, only when a fault is active; retry after an hour.
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
 * The texts of the faults in `currentFault`. The format of an active fault has not been seen live
 * (only ""), so one code, codes separated by , ; or |, and plain text are all accepted.
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
