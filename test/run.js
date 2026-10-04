'use strict';

/* A runner with no dependencies: every case file exports async (t) => {} and uses t.ok/t.eq.
   Run everything with `node test/run.js`, or one file with `node test/run.js mapping`.
   Same shape as com.growatt/test/run.js, plus a banner naming the fixture source. */

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'cases');
const filter = process.argv[2];

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function makeT(file) {
  return {
    ok(cond, msg) {
      if (cond) {
        passed += 1; return;
      }
      failed += 1;
      failures.push(`${file}: ${msg}`);
      console.log(`    FAIL  ${msg}`);
    },
    eq(actual, expected, msg) {
      this.ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    },
    skip(msg) {
      skipped += 1; console.log(`    SKIP  ${msg}`);
    },
    log(msg) {
      console.log(`    ${msg}`);
    },
  };
}

(async () => {
  // eslint-disable-next-line global-require
  const fixtures = require('./fixtures');
  console.log(fixtures.banner());

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && (!filter || f.includes(filter))).sort();

  const runOnce = async (label) => {
    for (const file of files) {
      console.log(`\n${label ? `[${label}] ` : ''}${file}`);
      const t = makeT(label ? `${label}/${file}` : file);
      try {
        // Each case pulls its data through require('../fixtures'), so re-requiring the file per
        // site re-runs it against whichever site is active now.
        // eslint-disable-next-line import/no-dynamic-require, global-require
        await require(path.join(DIR, file))(t);
      } catch (e) {
        failed += 1;
        failures.push(`${label ? `${label}/` : ''}${file}: threw ${e.stack || e.message}`);
        console.log(`    FAIL  threw: ${e.message}`);
      }
    }
  };

  // Run every case against each site's captures in turn (more sites = more real-world coverage);
  // with no captures at all, run once against the doc stubs.
  if (fixtures.sites.length) {
    for (const site of fixtures.sites) {
      fixtures.useSite(site);
      console.log(`\n──────── site: ${site} ────────`);
      await runOnce(site);
    }
  } else {
    await runOnce('');
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failures.length) console.log(`\n${failures.join('\n')}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
