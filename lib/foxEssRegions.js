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
Two separate FoxESS backends; an API key belongs to one. EU: the document's "Request domain"; US:
the document's code sample (its changelog has US-only changes).
`legacyConfigId`: the OAuth2ConfigId in the store of a device paired with OAuth.
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
 * The region of a device from its store, else its OAuth2 configId, else EU.
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
