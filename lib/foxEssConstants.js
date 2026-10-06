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

// app-wide poll tick event (app.js emits, devices listen)
const POLL_EVENT = 'everyXminutes';

// wait for the other devices of the same tick before one combined real-time call
const REAL_QUERY_BATCH_MS = 50;

// Calls that change rarely are polled every N ticks of 5 min; 'Get status update' forces them.
const HEATPUMP_POLL_EVERY_N_TICKS = 3; // settings only, two calls
const GENERATION_POLL_EVERY_N_TICKS = 3; // energy report, one call per inverter
const CONTROL_POLL_EVERY_N_TICKS = 3; // scheduler + WorkMode
const SETTINGS_POLL_EVERY_N_TICKS = 12; // SoC and export limits

// device/list status, cached per account
const DEVICE_STATUS_CACHE_MS = 10 * 60 * 1000;

// A Homey write is only compared with reads once this old; writes showed after 4-50 s (2026-10-04).
const OVERRIDE_GRACE_MS = 3 * 60 * 1000;

const OVERRIDE_NOTIFICATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

module.exports = {
  CONTROL_POLL_EVERY_N_TICKS,
  SETTINGS_POLL_EVERY_N_TICKS,
  OVERRIDE_GRACE_MS,
  OVERRIDE_NOTIFICATION_INTERVAL_MS,
  POLL_EVENT,
  DEVICE_STATUS_CACHE_MS,
  GENERATION_POLL_EVERY_N_TICKS,
  REAL_QUERY_BATCH_MS,
  HEATPUMP_POLL_EVERY_N_TICKS,
};
