# Offline test suite

Runs the app's real code — the client's request coalescing and rate-limit cooldown, the capability
mapping, the poll cadence, the pairing matcher — with no network and no credentials.

```bash
node test/run.js            # everything
node test/run.js mapping    # one case file, matched by substring
npm test                    # same as the first
```

Exit code is non-zero if anything fails, so it drops straight into CI or a pre-commit hook.

## Two fixture sources, one set of cases

The suite prefers **real captures** and falls back to **stubs derived from the OpenAPI document**.
The runner says which it used on the first line of output.

| source | where it comes from |
| --- | --- |
| `capture` | `test/captures/<site>/*.json`, one folder per installation, written by `capture.js` or `from-logs.js` |
| `doc` | response schemas in the [FoxESS OpenAPI document](https://www.foxesscloud.com/public/i18n/en/OpenApiDocument.html), hard-coded in `fixtures.js` |

Captures are grouped **one subfolder per site**, so several real installations can live side by
side. `node test/run.js` loops over every site it finds, running each case against that site's data
(and printing a `──── site: <name> ────` header), then falls back to the doc stubs for any endpoint
a site did not capture. More sites means more real-world coverage.

No case knows which one it got. Cases derive their expectations **from** the fixture — the mapping
case reads the variables out of the payload and checks the capability maps against them, rather than
asserting hard-coded numbers — so the day real captures land, every case keeps working and starts
protecting against the thing stubs cannot catch: the API not matching its own documentation.

That matters here more than usual. Several bugs found while building this app were exactly that
kind: `/op/v0/plant/list` calls the plant id `stationID` while the code read `plantID`, and
`/op/v0/device/list` documents no `plantID` parameter at all and returns the whole account. Stubs
built from the document cannot catch a document that is itself wrong.

## Getting real captures

**From a user's diagnostics report** — the route that needs no credentials and no account of your
own. The app writes every API response into its log whenever it is armed: app start, a device
(re)start, and every completed pair or repair (`lib/foxEssCapture.js`). A Homey diagnostics report
carries that log.

Ask the user to restart the app, then create a report from the Homey app
(Settings → Apps → FoxESS → ⋯ → Create diagnostics report). Save it to a file and:

```bash
node test/from-logs.js report.txt --dry            # list what it contains and which site, write nothing
node test/from-logs.js report.txt                  # write test/captures/<site>/*.json
node test/from-logs.js report.txt --force          # overwrite captures already there
node test/from-logs.js report.txt --site my-house  # choose the site folder name
```

The site folder is derived from the plant name in the report (falling back to its stationID) unless
`--site` overrides it.

Owner and installer contact details are redacted at capture time; serial numbers and plant names
are not, because a capture without them reproduces nothing. A payload whose `errno` is non-zero is
refused — the suite would otherwise assert against an error body.

**From your own account:**

```bash
node test/capture.js <api_key> [host] [--site name]
```

The API key is the personal key from the FoxESS portal (User Profile → API Management), the same
one the app pairs with. `host` defaults to
`www.foxesscloud.com` — use `portal.foxesscloud.us` for a US account. The site folder is named
after the plant unless `--site` overrides it.

It writes files named exactly what `fixtures.js` looks for, into a per-site subfolder, so the suite
switches over on the next run with nothing else to change. Requests are spaced 1.5s apart: FoxESS
throttles with errno 40400 and advertises no recovery time.

**Captures hold real serial numbers and plant names**, so every site folder under `test/captures/`
is gitignored (only this suite and the README are tracked). `test/` is in `.homeyignore`, so none
of it reaches the published app bundle.

## The cases

| File | What it protects |
| --- | --- |
| `mapping.js` | Every driver's capability map over the real-time payload. Catches the silent failure: a renamed FoxESS variable turns a capability into `NaN`, which Homey renders as an empty tile rather than an error. Also pins the honesty rule — an absent field stays `undefined` so the tile is empty, while a genuine `0` is still reported. |
| `pairing.js` | The two ways a device silently lands in the wrong place: OEM rebadging (the vendor model sits in `deviceType`, the FoxESS series in `productType`), and plant ownership (`device/list` is account-wide, so `stationID` decides). Also pins that only physical devices are offered — no virtual plant aggregate. Includes the negatives — a meter must not match the inverter driver. |
| `migration.js` | `lib/DeviceMigrator.js` and the lists that drive it: base capabilities equal each `driver.compose.json` in order (otherwise every existing device is migrated on the next start), every optional capability has a title, appending one never removes an existing capability, a wrong order is repaired from the first mismatch with values restored, and concurrent migrations run one after the other. Also pins the evidence rule — a zero or absent variable adds no capability — and that every `runningState` code in the document's appendix has a value in the `running_state` enum, with an unlisted code kept as `unknown`. |
| `today.js` | Recovering a reading when the aggregate variable is unusable: per-pack copies (`batVolt_1`, `SoC_2`, ...) are only a fallback for an absent or 0 aggregate, averaged over several packs; and 'Energy today' is derived from the lifetime total when the API sends no `todayYield`, with the baseline reset at local midnight and on a counter that goes down. |
| `signature.js` | That a request is signed again each time it is built, so the retry after a 401 token refresh carries a signature over the new token. The stale call-site signature made FoxESS answer errno 40256 "illegal signature" on every first poll after a token expiry (seen live). |
| `alarms.js` | Alarms from what the installation reports itself: the fault-text classification (heat vs sensor/low/under, battery vs the rest, checked on texts from the live FoxESS table), `currentFault` parsing (empty, one or several codes, unknown code, plain text; the table fetched lazily and once), `alarm_problem` as catch-all on every driver, heat split between inverter and battery, `alarm_battery` never from a low SoC, and `alarm_connectivity` from the device list. |
| `batching.js` | That one poll tick produces one request: serials unioned into the v1 `sns` array, variable sets unioned, every caller resolved with the same response, a late caller still joining, and a failed batch rejecting all of its waiters rather than hanging one. |
| `scheduler.js` | The poll cadence, including the heat pump's reduced rate and that `force_poll` overrides it. Also asserts the poll event is a shared constant — app.js emitting `'poll'` while `lib/common_device` listened for `'everyXminutes'` is how periodic polling came to never fire at all. |
| `partial.js` | Incomplete payloads. A `datas` entry can arrive with no `value` at all (a shipping third-party client guards for it), and the old `Number(x \|\| 0)` published that as a real-looking `0 W` or `0% SoC`. The same `\|\|` chains also mis-read a genuine zero by falling through to the next field. Pins both, plus the rule that one side of a pair is still a usable reading. |
| `capture.js` | The diagnostics-report chain: that arming is required (a poll every five minutes must not fill the log), that capture is generic (any endpoint the app calls is recorded, not a fixed allowlist, so a future feature needs no edit), that a payload round-trips byte-identically through a timestamped report, that a truncated report is reported rather than silently half-accepted, and that contact details are redacted while serials and plant names survive. |
| `limiter.js` | That a 200 carrying errno 40400 is raised rather than returned as data, that it arms a bounded cooldown, that nothing is even built while cooling down, and that every request carries an `AbortSignal` inside Homey's 30s pair budget. |

## Adding a case

Drop a file in `cases/` exporting `async (t) => {}`. Use `t.ok(cond, msg)`, `t.eq(a, b, msg)`,
`t.skip(msg)`, `t.log(msg)`. Take data through `require('../fixtures')`:

```js
fixtures.get('deviceList')      // capture if present, else doc stub
fixtures.isReal('deviceList')   // true when it came from a capture
fixtures.makeRoutedClient()     // a real client, every endpoint answered from fixtures
fixtures.makeDriver('inverter') // a real driver with logging stubbed
fixtures.app('lib/foo.js')      // require app code with the Homey runtime stubbed
```

Derive expectations from the fixture rather than hard-coding them, and skip rather than fail when
a fixture genuinely cannot support the case (`if (!plants.length) return t.skip(...)`).

## Worth adding next

- **Repair** — that the region picker rebuilds the client against the chosen config and that the
  new `configId` is persisted to both the store and the `region` setting.
- **Heat pump writes** — that `writeControls()` merges into freshly-read settings rather than
  replacing them, which is what keeps a `workMode` change from wiping the timers in the same
  object. Needs a capture of a real controls payload to be worth much.
- **Paging** — `plant/list` and `device/list` return `total`; nothing in the app follows a second
  page, so an account with more than 100 devices is silently truncated.
