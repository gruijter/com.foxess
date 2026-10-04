'use strict';

/*
Poll timing: tick right after FoxESS publishes a snapshot, not on the period boundary.

Measured on De Brik (2026-09-19): one snapshot per 5 minutes, always at the same second (12:05:24,
12:10:24, ...), readable within seconds, with every variable replaced at once. The real-time answer
carries that moment in its `time`; the app learns it and ticks MARGIN_MS later. Inverters of one
account too far apart to share a tick fall back to the plain boundary.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const timing = fixtures.app('lib/foxEssTiming.js');
  const { PERIOD_MS, MARGIN_MS } = timing;

  // --- reading the snapshot time ---
  const at = timing.parseSnapshotTime('2026-09-19 12:05:24 CEST+0200');
  t.eq(new Date(at).toISOString(), '2026-09-19T10:05:24.000Z', 'the zone name is ignored, the offset is used');
  t.eq(timing.parseSnapshotTime('not a time'), null, 'an unreadable time is null, not a guess');

  // --- the learned position ---
  t.eq(timing.tickPhase([]), 0, 'nothing learned: the period boundary');
  t.eq(timing.tickPhase([at]), 24000 + MARGIN_MS, 'one inverter: its snapshot second plus the margin');
  t.eq(timing.tickPhase([at, at + 30000]), 54000 + MARGIN_MS, 'close inverters: after the last of them');
  t.eq(timing.tickPhase([at, at + 150000]), 0, 'inverters too far apart: the plain boundary');
  const beforeMark = Date.UTC(2026, 8, 19, 10, 4, 50);
  const afterMark = Date.UTC(2026, 8, 19, 10, 5, 10);
  t.eq(timing.tickPhase([beforeMark, afterMark]), 10000 + MARGIN_MS, 'a pair on both sides of the mark is one group');

  // --- the self-correcting margin ---
  t.eq(timing.adaptMargin(MARGIN_MS, false), MARGIN_MS + 15000, 'no new snapshot: aim later');
  t.eq(timing.adaptMargin(timing.MAX_MARGIN_MS, false), timing.MAX_MARGIN_MS, 'but never past the cap');
  t.eq(timing.adaptMargin(MARGIN_MS + 15000, true), MARGIN_MS + 10000, 'a new snapshot eases it back');
  t.eq(timing.adaptMargin(MARGIN_MS, true), MARGIN_MS, 'down to the base margin, not below');
  t.eq(timing.tickPhase([at], 50000), 24000 + 50000, 'the tick sits the current margin after the snapshot');

  // --- the next tick ---
  const phase = timing.tickPhase([at]);
  const now = Date.UTC(2026, 8, 19, 10, 11, 0);
  t.eq(timing.delayToNextTick(now, phase), (4 * 60 + 44) * 1000, 'from 10:11:00 the next tick is 10:15:44');
  const onTick = Date.UTC(2026, 8, 19, 10, 15, 44);
  t.eq(timing.delayToNextTick(onTick, phase), PERIOD_MS, 'on a tick, the next one is a full period later');

  // --- the client reports every snapshot it sees ---
  const seen = [];
  const client = fixtures.makeClient({
    post: async () => ({ errno: 0, result: [{ deviceSN: 'SN-1', time: '2026-09-19 12:05:24 CEST+0200', datas: [] }] }),
  });
  client.onSnapshot = (sn, ms) => seen.push([sn, ms]);
  await client.getDeviceRealTimeData({ sn: 'SN-1' });
  t.eq(JSON.stringify(seen), JSON.stringify([['SN-1', at]]), 'the client passes each snapshot moment to the app');
};
