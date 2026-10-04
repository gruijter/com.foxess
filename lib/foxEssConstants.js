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

// The app-wide poll tick. Shared rather than written out in both places: app.js used to emit
// 'poll' while common_device.js listened for 'everyXminutes', so the periodic poll never fired -
// devices updated once at init and then silently froze, because the staleness check that would
// have marked them unavailable lives inside that same listener.
const POLL_EVENT = 'everyXminutes';

// How long the client waits for sibling devices to queue their real-time request before firing
// one combined call. Every device is woken by the same tick, so they all arrive within a few ms.
const REAL_QUERY_BATCH_MS = 50;

// Heat pumps expose no telemetry over REST - only settings (work mode, DHW enable, DHW target).
// Those change when somebody changes them, not on their own, and each poll costs two calls, so
// reading them every tick was the most expensive thing the app did for the least new information.
// Polled every third tick instead; a write refreshes the local state immediately anyway, and the
// 'Get status update' flow card forces a poll regardless of this.
const HEATPUMP_POLL_EVERY_N_TICKS = 3;

// The inverter's energy report (/op/v0/device/report/query, today's and this month's yield) costs
// one call per inverter, on top of the one batched real-time call for all devices. 'Energy today'
// moving in 15-minute steps is plenty, and keeps a multi-inverter account well inside the daily
// call budget. The 'Get status update' flow card forces it anyway.
const GENERATION_POLL_EVERY_N_TICKS = 3;

// /op/v0/device/list carries each device's status (1 online, 2 breakdown, 3 offline), which feeds
// alarm_problem and alarm_connectivity. One call answers for the whole account, and the client
// shares it between every device on that account for this long.
const DEVICE_STATUS_CACHE_MS = 10 * 60 * 1000;

// Battery control state (scheduler switch, WorkMode, scheduler slots) costs two or three calls, and
// only changes when somebody changes it - in Homey (which re-reads right after its own write) or in
// FoxCloud. Every third tick shows a FoxCloud change within 15 minutes.
const CONTROL_POLL_EVERY_N_TICKS = 3;

// The installation's own limits - battery SoC limits (two calls) and the export limit (one call) -
// are changed by hand, rarely. Hourly keeps them inside a key's daily call budget next to
// everything above; Homey re-reads them on the next tick after its own write anyway.
const SETTINGS_POLL_EVERY_N_TICKS = 12;

// A write is only compared with what the device reports once it is this old, so a read that
// was already under way, or a cloud value that has not caught up yet, is not taken for an override.
// Measured on De Brik (2026-10-04): setting/get and battery/soc/get show a write after 4 s to ~50 s.
const OVERRIDE_GRACE_MS = 3 * 60 * 1000;

// The 'control overridden' timeline notification, at most this often for the whole app: an
// energy provider that keeps taking control back would otherwise repeat it on every read.
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
