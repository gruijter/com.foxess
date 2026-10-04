# Captures

Real API responses, used by the suite instead of the doc-derived stubs in `fixtures.js`.
The runner names its source on the first line of `npm test`.

## One subfolder per site

Captures are stored **one folder per site** so the suite can hold real data from several
installations at once and run every case against each of them:

```
test/captures/
  de-brik/
    plantList.json
    deviceList.json
    deviceRealQuery.json
  <another-site>/
    ...
```

The folder name is derived from the plant name (falling back to its stationID); both tools below
take `--site <name>` to set it yourself. `npm test` loops over every site it finds and prints a
`──── site: <name> ────` header before each run, so more sites means more real-world coverage.
(Loose `*.json` left directly in `test/captures/` still work - they are read as a site called
`default`.)

Two ways to fill a site folder:

**From a user's diagnostics report** — the normal route, no credentials needed.
The app logs each API response whenever it is armed (app start, device restart, pair, repair;
see `lib/foxEssCapture.js`). Ask the user to restart the app and create a diagnostics report
(Homey app → Settings → Apps → FoxESS → ⋯ → Create diagnostics report), save it to a file, then:

```bash
node test/from-logs.js report.txt --dry            # see what is in it and which site it lands in
node test/from-logs.js report.txt                  # write test/captures/<site>/*.json
node test/from-logs.js report.txt --site my-house  # choose the folder name
```

**From your own account:**

```bash
node test/capture.js <access_token> [host] [--apikey] [--site name]
```

## These files stay local

They hold real serial numbers and plant names, so everything here except this README is
gitignored (the whole `test/` folder is also in `.homeyignore`, so none of it ships). Owner and
installer contact details are already stripped at capture time, but the files are still somebody's
installation — treat them as such.

A capture of a failed call is worse than none: `from-logs.js` refuses any payload whose `errno`
is non-zero, because the suite would otherwise assert against an error body.
