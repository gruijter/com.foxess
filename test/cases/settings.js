'use strict';

/*
SoC limits, the export limit and 'control overridden' (lib/foxEssSettings.js): which SoC targets
are accepted, the order the writes go out in, and when a read counts as someone else's change.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const s = fixtures.app('lib/foxEssSettings.js');

  // --- SoC limits: 10-100, min <= on grid <= max ---
  t.ok(s.socLimitsValid({ minSoc: 10, minSocOnGrid: 20, maxSoc: 100 }), 'a normal set is valid');
  t.ok(s.socLimitsValid({ minSoc: 10, minSocOnGrid: 20 }), 'without MaxSoc only the floor pair counts');
  t.ok(!s.socLimitsValid({ minSoc: 30, minSocOnGrid: 20, maxSoc: 100 }), 'off-grid floor above the on-grid one is refused');
  t.ok(!s.socLimitsValid({ minSoc: 10, minSocOnGrid: 60, maxSoc: 50 }), 'on-grid floor above the ceiling is refused');
  t.ok(!s.socLimitsValid({ minSoc: 5, minSocOnGrid: 20, maxSoc: 100 }), 'below 10% is refused (battery/soc/set minimum)');
  t.ok(!s.socLimitsValid({ minSoc: 10, minSocOnGrid: 20.5, maxSoc: 100 }), 'whole percents only');

  // --- write order keeps every step valid ---
  const from = { minSoc: 10, minSocOnGrid: 50, maxSoc: 60 };
  t.eq(s.socWriteOrder(from, { minSoc: 10, minSocOnGrid: 70, maxSoc: 90 }).join(','), 'maxSoc,minSoc', 'a higher ceiling goes first');
  t.eq(s.socWriteOrder(from, { minSoc: 10, minSocOnGrid: 20, maxSoc: 40 }).join(','), 'minSoc,maxSoc', 'a lower ceiling goes last');
  t.eq(s.socWriteOrder(from, { minSoc: 15, minSocOnGrid: 50, maxSoc: 60 }).join(','), 'minSoc', 'only what changed is written');
  t.eq(s.socWriteOrder(from, { ...from }).join(','), '', 'nothing changed, nothing written');
  t.eq(s.socWriteOrder({ minSoc: 10, minSocOnGrid: 20 }, { minSoc: 10, minSocOnGrid: 30 }).join(','), 'minSoc', 'no MaxSoc setting, no MaxSoc write');
  // every intermediate state of every order is valid
  const sets = [];
  for (const minSoc of [10, 30]) for (const minSocOnGrid of [30, 60]) for (const maxSoc of [60, 90]) sets.push({ minSoc, minSocOnGrid, maxSoc });
  const valid = sets.filter(s.socLimitsValid);
  let allValid = true;
  for (const a of valid) {
    for (const b of valid) {
      const state = { ...a };
      for (const step of s.socWriteOrder(a, b)) {
        if (step === 'maxSoc') state.maxSoc = b.maxSoc;
        else Object.assign(state, { minSoc: b.minSoc, minSocOnGrid: b.minSocOnGrid });
        if (!s.socLimitsValid(state)) allValid = false;
      }
      if (JSON.stringify(state) !== JSON.stringify(b)) allValid = false;
    }
  }
  t.ok(allValid, 'between any two valid sets, every step is valid and the target is reached');

  // --- overridden: only Homey's own, settled writes count ---
  const written = s.noteWrites({}, { mode: 'homey', exportLimit: 3000 }, 1000);
  const grace = 60000;
  t.eq(s.overriddenKeys(written, { mode: 'self_use' }, 1000 + grace + 1, grace).join(), 'mode', 'another mode after the grace is an override');
  t.eq(s.overriddenKeys(written, { mode: 'self_use' }, 1000 + 10, grace).join(), '', 'a read right after the write is not');
  t.eq(s.overriddenKeys(written, { mode: 'homey', exportLimit: 3000 }, 1e9, grace).join(), '', 'the same values are not');
  t.eq(s.overriddenKeys(written, { mode: undefined, minSoc: 20 }, 1e9, grace).join(), '', 'unread and never-written keys are not');
  t.eq(s.noteWrites(written, { exportLimit: 0 }, 5).exportLimit.value, 0, 'a written 0 is remembered');
};
