'use strict';

/*
Turn a user's diagnostics report into test fixtures.

    node test/from-logs.js <report.txt>              write test/captures/<site>/*.json
    node test/from-logs.js <report.txt> --dry        show what it found, write nothing
    node test/from-logs.js <report.txt> --force      overwrite captures that already exist
    node test/from-logs.js <report.txt> --site name  put them under test/captures/name/

Captures are stored one subfolder per site, so the suite can hold real data from several
installations at once. The site folder is derived from the plant name in the report (fall back to
its stationID); pass --site to name it yourself.

The app writes each API response into its log as a ===FOXESS-CAPTURE-START ...=== block whenever
it is armed (app start, device restart, pair, repair - see lib/foxEssCapture.js). A diagnostics
report carries that log, so this reads the blocks back out and writes them under the exact names
test/fixtures.js looks for. After that, `npm test` runs against the user's real account data.

Paste the report to a file first; it does not matter what wraps the lines - timestamps, log
prefixes - the parser anchors on the markers.
*/

const fs = require('node:fs');
const path = require('node:path');
const capture = require('../lib/foxEssCapture');

const CAPTURES = path.join(__dirname, 'captures');
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry');
const force = args.includes('--force');
const siteArgIndex = args.indexOf('--site');
const siteArg = siteArgIndex !== -1 ? args[siteArgIndex + 1] : undefined;

if (!file) {
  console.error('usage: node test/from-logs.js <report.txt> [--dry] [--force] [--site name]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

// A filesystem-safe folder name for a site. Prefers the plant name from the captured plantList,
// falls back to its stationID, then to 'site'.
const slug = (s) => String(s)
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
const siteFromCaptures = (caps) => {
  // A report may hold only some endpoints (an app-start report has device detail + real-time but
  // no plant/device list, which come from pairing), so try them all before giving up.
  const fromList = caps.plantList?.result?.data?.[0] || caps.deviceList?.result?.data?.[0] || {};
  const detail = caps.deviceDetail?.result || {};
  const rt = caps.deviceRealQuery?.result?.[0] || {};
  const candidate = fromList.name
    || fromList.stationName || detail.stationName
    || fromList.stationID || detail.stationID
    || fromList.deviceSN || detail.deviceSN || rt.deviceSN;
  return slug(candidate || 'site') || 'site';
};

const { captures, errors } = capture.parseLog(fs.readFileSync(file, 'utf8'));
const names = Object.keys(captures).sort();
const site = siteArg ? slug(siteArg) : siteFromCaptures(captures);
const OUT = path.join(CAPTURES, site);

if (!names.length) {
  console.error('No capture blocks found.');
  console.error('The report must come from an app version that logs them, and the user must have');
  console.error('restarted the app (or re-paired) while that version was running.');
  if (errors.length) console.error(`\n${errors.join('\n')}`);
  process.exit(1);
}

console.log(`Found ${names.length} capture(s) in ${path.basename(file)} -> site '${site}' (test/captures/${site}/)\n`);
let written = 0;
let skipped = 0;

for (const name of names) {
  const target = path.join(OUT, `${name}.json`);
  const exists = fs.existsSync(target);
  const payload = captures[name];
  const errno = Number(payload.errno ?? payload.code ?? 0);
  const size = JSON.stringify(payload).length;

  // A capture of a failed call is worse than no capture: the suite would treat the error body as
  // the response shape and quietly assert nothing.
  if (errno !== 0) {
    console.log(`  skip   ${name}  (errno ${errno}: ${payload.msg || 'failed call'})`);
    skipped += 1;
    continue;
  }
  if (exists && !force && !dryRun) {
    console.log(`  keep   ${name}  (already present - pass --force to overwrite)`);
    skipped += 1;
    continue;
  }
  if (dryRun) {
    console.log(`  would  ${name}  ${size} bytes${exists ? ' (overwrites existing)' : ''}`);
    continue;
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`  write  ${name}  ${size} bytes`);
  written += 1;
}

if (errors.length) console.log(`\nProblems:\n  ${errors.join('\n  ')}`);

if (dryRun) {
  console.log('\nDry run, nothing written.');
} else {
  console.log(`\n${written} written, ${skipped} skipped. Run \`npm test\` - the banner should now name the captures.`);
}
