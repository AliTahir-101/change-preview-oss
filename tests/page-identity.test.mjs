/**
 * Unit tests for ChangePreview's canonical page-identity keying.
 *
 * Product rule: storage / baseline / Keep-Reapply identity is the FULL page URL,
 * canonicalized as origin + pathname + meaningful query — with the hash and
 * common tracking params (utm_*, gclid, fbclid, …) stripped. This keeps the same
 * form together across campaign/share links while keeping different forms/paths
 * separate. Header display may still use a short host (not tested here).
 *
 * The helpers are pure; we load panel.js in jsdom only to import them (auto-boot
 * is skipped under window.__CHANGEPREVIEW_TEST__).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PANEL_HTML = fs.readFileSync(path.join(ROOT, 'panel', 'panel.html'), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Minimal chrome stub: panel.js registers listeners at import time.
const chromeStub = {
  runtime: { lastError: null, onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); } },
  tabs: {
    query() { return Promise.resolve([]); },
    sendMessage() { return Promise.resolve(); },
    onActivated: { addListener() {} },
    onUpdated: { addListener() {} }
  },
  storage: {
    local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } },
    session: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } },
    onChanged: { addListener() {} }
  }
};

const dom = new JSDOM(PANEL_HTML, { url: 'https://panel.invalid/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.chrome = chromeStub;
dom.window.chrome = chromeStub;
dom.window.__CHANGEPREVIEW_TEST__ = true;

await import(pathToFileURL(path.join(ROOT, 'panel', 'panel.js')).href);

const { canonicalizePageUrl, getPageKey, createFingerprint, isTrackingParam } =
  dom.window.__changePreviewPanelInternals;

/* ------------------------------------------------------------------ */
console.log('\ncanonicalizePageUrl: path, query, hash, tracking params');

check('two different paths on the same domain are different identities',
  canonicalizePageUrl('https://tally.so/r/zxlaAM') !== canonicalizePageUrl('https://tally.so/r/ABC123'),
  `${canonicalizePageUrl('https://tally.so/r/zxlaAM')} vs ${canonicalizePageUrl('https://tally.so/r/ABC123')}`);

check('hash is stripped from the identity',
  canonicalizePageUrl('https://tally.so/r/zxlaAM#section-2') === canonicalizePageUrl('https://tally.so/r/zxlaAM'),
  canonicalizePageUrl('https://tally.so/r/zxlaAM#section-2'));

check('utm_* params are stripped',
  canonicalizePageUrl('https://ex.com/form?utm_source=x&utm_medium=y') === canonicalizePageUrl('https://ex.com/form'),
  canonicalizePageUrl('https://ex.com/form?utm_source=x&utm_medium=y'));

check('gclid / fbclid are stripped',
  canonicalizePageUrl('https://ex.com/form?gclid=abc&fbclid=def') === canonicalizePageUrl('https://ex.com/form'),
  canonicalizePageUrl('https://ex.com/form?gclid=abc&fbclid=def'));

check('same path + only utm/hash differences collapse to one identity',
  canonicalizePageUrl('https://ex.com/survey?utm_campaign=spring#top') ===
  canonicalizePageUrl('https://ex.com/survey'),
  canonicalizePageUrl('https://ex.com/survey?utm_campaign=spring#top'));

check('meaningful query params are KEPT (different forms stay separate)',
  canonicalizePageUrl('https://ex.com/form?formId=123') !== canonicalizePageUrl('https://ex.com/form?formId=456'),
  `${canonicalizePageUrl('https://ex.com/form?formId=123')} vs ${canonicalizePageUrl('https://ex.com/form?formId=456')}`);

check('meaningful query is preserved alongside stripped tracking params',
  canonicalizePageUrl('https://ex.com/form?formId=123&utm_source=x') ===
  canonicalizePageUrl('https://ex.com/form?formId=123'),
  canonicalizePageUrl('https://ex.com/form?formId=123&utm_source=x'));

check('query param order does not split one form',
  canonicalizePageUrl('https://ex.com/form?a=1&b=2') === canonicalizePageUrl('https://ex.com/form?b=2&a=1'),
  `${canonicalizePageUrl('https://ex.com/form?a=1&b=2')} vs ${canonicalizePageUrl('https://ex.com/form?b=2&a=1')}`);

check('trailing slash is normalized',
  canonicalizePageUrl('https://ex.com/form/') === canonicalizePageUrl('https://ex.com/form'),
  canonicalizePageUrl('https://ex.com/form/'));

check('different origins (scheme/host) are different identities',
  canonicalizePageUrl('https://ex.com/form') !== canonicalizePageUrl('http://ex.com/form'));

check('origin + path shape is as expected',
  canonicalizePageUrl('https://ex.com/a/b?x=1#h') === 'https://ex.com/a/b?x=1',
  canonicalizePageUrl('https://ex.com/a/b?x=1#h'));

check('unparseable input returns null', canonicalizePageUrl('not a url') === null);

/* ------------------------------------------------------------------ */
console.log('\nisTrackingParam');
check('utm_* is tracking', isTrackingParam('utm_source') && isTrackingParam('UTM_Campaign'));
check('gclid/fbclid are tracking', isTrackingParam('gclid') && isTrackingParam('fbclid'));
check('formId / id are NOT tracking', !isTrackingParam('formId') && !isTrackingParam('id'));

/* ------------------------------------------------------------------ */
console.log('\ngetPageKey: prefers full url, falls back to host/path');

check('prefers canonicalized full url when present',
  getPageKey({ url: 'https://ex.com/form?utm_source=x#h', host: 'ex.com', path: '/other' }) ===
  'https://ex.com/form',
  getPageKey({ url: 'https://ex.com/form?utm_source=x#h', host: 'ex.com', path: '/other' }));

check('falls back to host+path pseudo-url when no url',
  getPageKey({ host: 'ex.com', path: '/form/' }) === 'https://ex.com/form',
  getPageKey({ host: 'ex.com', path: '/form/' }));

check('returns null when nothing usable is present', getPageKey({}) === null);

// A sub-frame / CDN url is never the identity because only the top frame reports
// `url`; if a payload somehow lacks url, host (the top-level host) is the fallback.
check('host fallback uses the top-level host, not a sub-frame url',
  getPageKey({ host: 'dashboard.example.com', path: '/settings' }) === 'https://dashboard.example.com/settings');

/* ------------------------------------------------------------------ */
console.log('\ncreateFingerprint: keyed by pageKey + field set');

check('same pageKey + same fields (any order) → same fingerprint',
  createFingerprint('https://ex.com/form', ['b', 'a', 'c']) ===
  createFingerprint('https://ex.com/form', ['a', 'b', 'c']));

check('different pageKey → different fingerprint',
  createFingerprint('https://ex.com/form?formId=1', ['a']) !==
  createFingerprint('https://ex.com/form?formId=2', ['a']));

check('fingerprint embeds the pageKey',
  createFingerprint('https://ex.com/form', ['a']).startsWith('https://ex.com/form#'),
  createFingerprint('https://ex.com/form', ['a']));

/* ------------------------------------------------------------------ */
console.log('');
if (failed === 0) {
  console.log(`All ${passed} checks passed.`);
  process.exit(0);
} else {
  console.log(`${failed} FAILED, ${passed} passed.`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
