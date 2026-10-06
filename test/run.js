'use strict';

/* Dependency-free runner: each case file exports async (t) => {} using t.ok/t.eq.
   `node test/run.js` runs all, `node test/run.js mapping` one file. */

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
        // re-required per site, so the case reads the active site's fixtures
        // eslint-disable-next-line import/no-dynamic-require, global-require
        await require(path.join(DIR, file))(t);
      } catch (e) {
        failed += 1;
        failures.push(`${label ? `${label}/` : ''}${file}: threw ${e.stack || e.message}`);
        console.log(`    FAIL  threw: ${e.message}`);
      }
    }
  };

  // every case runs per captured site, or once against the doc stubs
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
