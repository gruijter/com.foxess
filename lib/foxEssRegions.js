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

/*
FoxESS runs two separate cloud backends, and an API key belongs to one of them - so the region is
chosen at pairing, next to the key. The EU host is the "Request domain" in the FoxESS OpenAPI
document; the US host appears in that same document's code sample, and the changelog carries
US-only endpoint changes ("Add battery information to plant details endpoint (US only)"),
confirming they are distinct backends.

`legacyConfigId` is the OAuth2 configId a device paired before the API-key switch still carries in
its store (OAuth2ConfigId); regionIdOf() maps it, so such a device keeps its region on repair.
*/
const REGIONS = [
  {
    id: 'eu',
    legacyConfigId: 'default',
    fallbackName: 'Europe / Global',
    host: 'www.foxesscloud.com',
  },
  {
    id: 'us',
    legacyConfigId: 'us',
    fallbackName: 'North America',
    host: 'portal.foxesscloud.us',
  },
];

const DEFAULT_REGION = REGIONS[0].id;

const regionById = (id) => REGIONS.find((r) => r.id === id) || null;

const hostOf = (id) => regionById(id)?.host || REGIONS[0].host;

/**
 * The region of a device, from its store. Falls back to the OAuth2 configId of a device paired
 * before the API-key switch, and to EU when neither is known.
 * @param {object} store the device store
 * @returns {string} a region id
 */
const regionIdOf = (store = {}) => {
  if (regionById(store.region)) return store.region;
  const legacy = REGIONS.find((r) => r.legacyConfigId === store.OAuth2ConfigId);
  return legacy ? legacy.id : DEFAULT_REGION;
};

module.exports = {
  REGIONS,
  DEFAULT_REGION,
  regionById,
  hostOf,
  regionIdOf,
};
