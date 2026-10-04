'use strict';

/*
Every user-facing text in all 13 languages: each translation object in the compose files
(.homeycompose, driver.compose.json, driver.settings.compose.json), and every key of
locales/en.json in each other locale file. Ported from com.solarwatt/test/check-manifests.js.
*/

const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', '..');
const LOCALES = ['nl', 'de', 'fr', 'es', 'it', 'da', 'sv', 'no', 'pl', 'ru', 'ar', 'ko'];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const collect = (dir, into) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, into);
    else if (entry.name.endsWith('.compose.json') || (dir.includes('.homeycompose') && entry.name.endsWith('.json'))) into.push(full);
  }
  return into;
};

// the dotted paths of every string in a locale file
const keys = (node, trail = '') => Object.entries(node).flatMap(([key, value]) => (
  value && typeof value === 'object' ? keys(value, `${trail}${key}.`) : [`${trail}${key}`]));

module.exports = async (t) => {
  const missing = [];
  const walk = (node, file, trail) => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, file, `${trail}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    // a translation object: strings per locale, or arrays per locale for the app's tags
    const kind = typeof node.en === 'string' ? 'string' : Array.isArray(node.en) && 'array';
    if (kind) {
      const gaps = LOCALES.filter((l) => (kind === 'array' ? !Array.isArray(node[l]) : typeof node[l] !== 'string'));
      if (gaps.length) missing.push(`${file} ${trail} missing: ${gaps.join(', ')}`);
    }
    for (const key of Object.keys(node)) walk(node[key], file, `${trail}.${key}`);
  };

  const files = [...collect(path.join(APP, '.homeycompose'), []), ...collect(path.join(APP, 'drivers'), [])];
  for (const file of files) walk(readJson(file), path.relative(APP, file), '');
  t.ok(files.length > 10, `${files.length} compose files checked`);
  t.eq(missing.join('\n'), '', 'every compose text has all 13 languages');

  const en = keys(readJson(path.join(APP, 'locales', 'en.json')));
  for (const locale of LOCALES) {
    const have = new Set(keys(readJson(path.join(APP, 'locales', `${locale}.json`))));
    t.eq(en.filter((key) => !have.has(key)).join(', '), '', `locales/${locale}.json has every key of en.json`);
  }
};
