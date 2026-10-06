'use strict';

/*
Poll cadence: per-device pollEveryNTicks, and 'Get status update' always polls.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const { POLL_EVENT, HEATPUMP_POLL_EVERY_N_TICKS } = fixtures.app('lib/foxEssConstants.js');
  const CommonDevice = fixtures.app('lib/common_device.js');
  const HeatPump = fixtures.app('drivers/heatpump/device.js');

  t.ok(typeof POLL_EVENT === 'string' && POLL_EVENT.length > 0, 'the poll event has a shared name');

  const ticks = (Cls, count) => {
    const device = Object.create(Cls.prototype);
    return Array.from({ length: count }, () => device.isPollDue());
  };

  const normal = ticks(CommonDevice, 12);
  t.ok(normal.every(Boolean), 'an ordinary device polls on every tick');

  const n = HEATPUMP_POLL_EVERY_N_TICKS;
  const hp = ticks(HeatPump, 12);
  t.eq(hp.filter(Boolean).length, Math.ceil(12 / n), `the heat pump polls ${Math.ceil(12 / n)} times in 12 ticks`);
  t.ok(hp[0], 'the heat pump polls on the first tick, so a fresh device is not blank');
  t.ok(!hp[1], 'the heat pump skips the tick after that');

  // force_poll must override the cadence
  const forced = Object.create(HeatPump.prototype);
  forced.isPollDue();
  t.ok(!forced.isPollDue(), 'second tick is skipped normally');
  t.ok(forced.isPollDue({ force: true }), 'force_poll polls anyway');

  // the cadence must not drift: with n=3 the pattern repeats exactly
  const long = ticks(HeatPump, 30).map((v) => (v ? 'P' : '.')).join('');
  const expected = Array.from({ length: 30 }, (_, i) => (i % n === 0 ? 'P' : '.')).join('');
  t.eq(long, expected, 'the skip pattern stays in phase over 30 ticks');
};
