'use strict';

/*
SoC limits, the export limit and 'control overridden' (lib/foxEssSettings.js): which SoC targets
are accepted, and when a read counts as someone else's change.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const s = fixtures.app('lib/foxEssSettings.js');

  // --- SoC limits: 10-100, min <= on grid ---
  t.ok(s.socLimitsValid({ minSoc: 10, minSocOnGrid: 20 }), 'a normal pair is valid');
  t.ok(s.socLimitsValid({ minSoc: 20, minSocOnGrid: 20 }), 'equal floors are valid');
  t.ok(!s.socLimitsValid({ minSoc: 15, minSocOnGrid: 12 }), 'off-grid floor above the on-grid one is refused (De Brik half-applied it)');
  t.ok(!s.socLimitsValid({ minSoc: 5, minSocOnGrid: 20 }), 'below 10% is refused (battery/soc/set minimum)');
  t.ok(!s.socLimitsValid({ minSoc: 10, minSocOnGrid: 20.5 }), 'whole percents only');
  t.ok(!s.socLimitsValid({ minSoc: 10, minSocOnGrid: null }), 'an unknown value is refused');

  // --- overridden: only Homey's own, settled writes count ---
  const written = s.noteWrites({}, { mode: 'homey', exportLimit: 3000 }, 1000);
  const grace = 60000;
  t.eq(s.overriddenKeys(written, { mode: 'self_use' }, 1000 + grace + 1, grace).join(), 'mode', 'another mode after the grace is an override');
  t.eq(s.overriddenKeys(written, { mode: 'self_use' }, 1000 + 10, grace).join(), '', 'a read right after the write is not');
  t.eq(s.overriddenKeys(written, { mode: 'homey', exportLimit: 3000 }, 1e9, grace).join(), '', 'the same values are not');
  t.eq(s.overriddenKeys(written, { mode: undefined, minSoc: 20 }, 1e9, grace).join(), '', 'unread and never-written keys are not');
  t.eq(s.noteWrites(written, { exportLimit: 0 }, 5).exportLimit.value, 0, 'a written 0 is remembered');
};
