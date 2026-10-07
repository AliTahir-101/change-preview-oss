/**
 * Automated harness for ChangePreview's field label / value resolution.
 *
 * Runs content.js inside jsdom against the committed fixtures and asserts the
 * behaviour Ali must see on real Microsoft Forms:
 *   - Apartment Yes/No: Field = full question heading; value = Yes / No
 *   - House type cards:  Field = "House type";          value = option labels
 *   - Reapply restores the correct checks after a Keep -> reload
 *   - Previously-working MS Forms text/choice fixtures still resolve correctly
 *
 * No network, no extension APIs: chrome is stubbed and offsetParent is shimmed
 * because jsdom does not lay out elements.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT_JS = fs.readFileSync(path.join(ROOT, 'content', 'content.js'), 'utf8');

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

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * Load a fixture file, run content.js in it, and return the test internals.
 */
function loadFixture(relPath) {
  const html = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  window.__CHANGEPREVIEW_TEST__ = true;

  // jsdom does not implement CSS.escape; provide a minimal spec-compliant shim.
  if (!window.CSS || typeof window.CSS.escape !== 'function') {
    window.CSS = window.CSS || {};
    window.CSS.escape = (value) => String(value).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => `\\${ch}`);
  }

  window.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage() { return { catch() {} }; }
    }
  };

  // jsdom never lays out, so offsetParent is always null; treat any attached
  // element as visible so collectFields does not skip everything.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return this.isConnected ? (this.parentNode || window.document.body) : null; }
  });

  window.eval(CONTENT_JS);

  const internals = window.__changePreviewInternals;
  if (!internals) throw new Error('content.js did not expose test internals');
  internals.snapshotBaseline();
  return { window, document: window.document, internals };
}

function fieldByKey(fields, key) {
  return fields.find(f => f.key === key);
}
function fieldByTypeLabel(fields, type, label) {
  return fields.find(f => f.type === type && f.label === label);
}

/* ------------------------------------------------------------------ */
/* ms-forms-like.html                                                  */
/* ------------------------------------------------------------------ */
console.log('\nms-forms-like.html');
{
  const { document, internals } = loadFixture('fixtures/ms-forms-like.html');
  const fields = internals.collectFields();

  // --- Ali bug #1: Apartment Yes/No (real MS Forms Choice) -----------
  const apartment = fieldByKey(fields, 'name:rApartment');
  check('apartment: field is tracked', !!apartment, 'name:rApartment not found');
  if (apartment) {
    eq('apartment: Field = full question heading',
      apartment.label, 'Are any of the applicants currently living in an apartment?');
    eq('apartment: value is the option text (No)', apartment.value, 'No');
    eq('apartment: type is radio', apartment.type, 'radio');
    check('apartment: Field is NOT an option/type string',
      !['yes', 'no', 'choice'].includes(String(apartment.label).toLowerCase()),
      `label was ${JSON.stringify(apartment.label)}`);
  }

  // --- Ali bug #2: House type card checkboxes ------------------------
  const house = fieldByTypeLabel(fields, 'checkbox-group', 'House type');
  check('house type: grouped under "House type"', !!house,
    `got labels: ${fields.filter(f => f.type === 'checkbox-group').map(f => f.label).join(' | ')}`);
  if (house) {
    eq('house type: value is option label (Nursing home)', house.value, 'Nursing home');
    check('house type: value is NOT checked/unchecked',
      !/checked/i.test(house.value), `value was ${JSON.stringify(house.value)}`);
    eq('house type: key is group key', house.key, 'checkbox-group:House type');
  }
  // The card options must NOT appear as their own individual fields.
  check('house type: no option reported as its own Field',
    !fields.some(f => ['Block of flats', 'Nursing home', 'Detached house'].includes(f.label) && f.type !== 'checkbox-group'),
    'an option leaked as an individual field');

  // --- Regression: previously-working MS Forms fixtures --------------
  eq('text: email label', fieldByKey(fields, 'name:email')?.label, 'What is your email address?');
  eq('textarea: name label', fieldByKey(fields, 'name:full_name')?.label, 'What is your name ?');

  const fill = fieldByKey(fields, 'name:fill_in_blank');
  eq('radio: fill-in-blank strips type+points', fill?.label, 'He goes ....................every month.');
  eq('radio: fill-in-blank value', fill?.value, 'shopping');

  // --- Ali retest: MCQ item number glued to the question text -------
  // "3He goes ..." must drop the leading index and show the clean stem only.
  const numbered = fieldByKey(fields, 'name:fill_in_blank_numbered');
  eq('radio: glued ordinal stripped from title',
    numbered?.label, 'He goes ....................every month.');
  check('radio: glued ordinal title has no leading digit',
    !/^\d/.test(String(numbered?.label)), `label was ${JSON.stringify(numbered?.label)}`);
  eq('radio: glued-ordinal field value is option text', numbered?.value, 'shopping');

  // Leading-ordinal stripping must NOT eat real content that starts with a
  // number (digits + space + word, or a decimal).
  eq('ordinal: keeps "3 days a week ..."',
    internals.cleanLabel('3 days a week is enough'), '3 days a week is enough');
  eq('ordinal: keeps decimals like "3.5 miles ..."',
    internals.cleanLabel('3.5 miles to the station'), '3.5 miles to the station');
  eq('ordinal: keeps ordinal words like "3rd floor"',
    internals.cleanLabel('3rd floor meeting room'), '3rd floor meeting room');
  eq('ordinal: strips "3. " prefix',
    internals.cleanLabel('3. He goes to school'), 'He goes to school');
  eq('ordinal: strips "3) " prefix',
    internals.cleanLabel('3) He goes to school'), 'He goes to school');
  eq('ordinal: strips "Q3 " prefix',
    internals.cleanLabel('Q3 He goes to school'), 'He goes to school');
  eq('ordinal: strips "Question 3 " prefix',
    internals.cleanLabel('Question 3 He goes to school'), 'He goes to school');

  const klass = fieldByKey(fields, 'name:class_selection');
  eq('radio: class label', klass?.label, 'Which class are you in?');
  eq('radio: class value is option text', klass?.value, 'Three by one');

  const interests = fieldByTypeLabel(fields, 'checkbox-group', 'Select your interests');
  check('checkbox-group: interests resolved', !!interests);
  if (interests) {
    check('checkbox-group: interests value lists selected options',
      interests.value.includes('Sports') && interests.value.includes('Art'),
      `value was ${JSON.stringify(interests.value)}`);
  }

  // --- Reapply (Keep -> reload) restores the correct checks ----------
  // House type: was "Nursing home", now "Block of flats".
  internals.applyChangesWithBaseline([{
    key: 'checkbox-group:House type',
    label: 'House type',
    type: 'checkbox-group',
    was: 'Nursing home',
    now: 'Block of flats'
  }]);
  const blockCb = document.querySelector('input[value="block_of_flats"]');
  const nursingCb = document.querySelector('input[value="nursing_home"]');
  check('reapply house type: Block of flats checked', blockCb?.checked === true);
  check('reapply house type: Nursing home unchecked', nursingCb?.checked === false);

  // Apartment: was "No", now "Yes".
  internals.applyChangesWithBaseline([{
    key: 'name:rApartment',
    label: 'Are any of the applicants currently living in an apartment?',
    type: 'radio',
    was: 'No',
    now: 'Yes'
  }]);
  const yesRadio = document.querySelector('input[name="rApartment"][value="yes"]');
  const noRadio = document.querySelector('input[name="rApartment"][value="no"]');
  check('reapply apartment: Yes selected', yesRadio?.checked === true);
  check('reapply apartment: No deselected', noRadio?.checked === false);
}

/* ------------------------------------------------------------------ */
/* plain-admin.html                                                    */
/* ------------------------------------------------------------------ */
console.log('\nplain-admin.html');
{
  const { internals } = loadFixture('fixtures/plain-admin.html');
  const fields = internals.collectFields();

  eq('text: organization name label',
    fieldByKey(fields, 'name:organization_name')?.label, 'Organization name');

  const security = fieldByTypeLabel(fields, 'checkbox-group', 'Security options');
  check('checkbox-group: Security options grouped', !!security,
    `got: ${fields.filter(f => f.type === 'checkbox-group').map(f => f.label).join(' | ')}`);
  if (security) {
    check('checkbox-group: Security options value lists selected',
      security.value.includes('Enable IP whitelist') && security.value.includes('Enable audit logging'),
      `value was ${JSON.stringify(security.value)}`);
  }

  const houseAdmin = fieldByTypeLabel(fields, 'checkbox-group', 'House type');
  check('checkbox-group: admin House type grouped', !!houseAdmin);
  if (houseAdmin) {
    eq('checkbox-group: admin House type value', houseAdmin.value, 'Detached house');
  }

  const dateFormat = fieldByKey(fields, 'name:date_format');
  eq('radio: date format label', dateFormat?.label, 'Date format');
  eq('radio: date format value', dateFormat?.value, 'DD/MM/YYYY');
}

/* ------------------------------------------------------------------ */
/* submit-validation.html (smoke: no groups, must still resolve)       */
/* ------------------------------------------------------------------ */
console.log('\nsubmit-validation.html');
{
  const { internals } = loadFixture('fixtures/submit-validation.html');
  const fields = internals.collectFields();
  eq('text: display name label', fieldByKey(fields, 'name:display_name')?.label, 'Display name');
  eq('textarea: bio label', fieldByKey(fields, 'name:bio')?.label, 'Bio');
  check('no spurious checkbox/radio groups', !fields.some(f => f.type === 'checkbox-group' || f.type === 'radio-group'));
}

/* ------------------------------------------------------------------ */
/* aspnet-checkboxlist.html (ASP.NET WebForms CheckBoxList/RadioButtonList) */
/* ------------------------------------------------------------------ */
console.log('\naspnet-checkboxlist.html');
{
  const { document, internals } = loadFixture('fixtures/aspnet-checkboxlist.html');
  let fields = internals.collectFields();

  // --- RadioButtonList: Field = full section question, value = option -------
  const rentKey = 'name:ctl00$ContentPlaceHolder1$rblCurrentlyRenting';
  const rent = fieldByKey(fields, rentKey);
  check('aspnet radio: tracked as one row', !!rent, `${rentKey} not found`);
  if (rent) {
    eq('aspnet radio: type is radio', rent.type, 'radio');
    check('aspnet radio: Field is the full section question',
      /are any of the applicants currently living in an apartment/i.test(rent.label),
      `label was ${JSON.stringify(rent.label)}`);
    check('aspnet radio: Field is NOT the option (No/Yes)',
      !['no', 'yes'].includes(String(rent.label).toLowerCase()),
      `label was ${JSON.stringify(rent.label)}`);
    check('aspnet radio: Field has no leftover <br> glue',
      rent.label.includes('currently living'),
      `label was ${JSON.stringify(rent.label)}`);
  }

  // --- CheckBoxList: INDEPENDENT per-box rows, Field = "Section · Option" ---
  const blockKey = 'name:ctl00$ContentPlaceHolder1$cblHouseType$0';
  const block = fieldByKey(fields, blockKey);
  check('aspnet checkbox: Block of flats tracked as its own row', !!block,
    `${blockKey} not found`);
  if (block) {
    eq('aspnet checkbox: type stays single checkbox', block.type, 'checkbox');
    check('aspnet checkbox: Field contains the section heading "House type"',
      block.label.includes('House type'), `label was ${JSON.stringify(block.label)}`);
    check('aspnet checkbox: Field contains the option "Block of flats"',
      block.label.includes('Block of flats'), `label was ${JSON.stringify(block.label)}`);
    check('aspnet checkbox: Field joins section and option (not option-only)',
      block.label !== 'Block of flats', `label was ${JSON.stringify(block.label)}`);
    eq('aspnet checkbox: Was/Now stays Unchecked (independent box)',
      block.value, 'Unchecked');
  }

  // Each option is its OWN row — not folded into one comma-joined group.
  check('aspnet checkbox: no checkbox-group row created for the list',
    !fields.some(f => f.type === 'checkbox-group' &&
      /house type|apartment type/i.test(String(f.label))),
    `groups: ${fields.filter(f => f.type === 'checkbox-group').map(f => f.label).join(' | ')}`);
  check('aspnet checkbox: House type list yields multiple independent rows',
    fields.filter(f => f.type === 'checkbox' &&
      f.key.includes('cblHouseType')).length >= 5,
    'expected one row per House type option');

  // --- Second list: section label has `for` but no id -----------------------
  const roomKey = 'name:ctl00$ContentPlaceHolder1$cblApartmentType$0';
  const room = fieldByKey(fields, roomKey);
  check('aspnet checkbox: Apartment type option tracked', !!room, `${roomKey} not found`);
  if (room) {
    check('aspnet checkbox: Apartment type section resolved',
      room.label.includes('Apartment type') && room.label.includes('1 room'),
      `label was ${JSON.stringify(room.label)}`);
  }

  // --- Values flow: checking a radio surfaces the option text, not question --
  const noRadio = document.getElementById('ContentPlaceHolder1_rblCurrentlyRenting_0');
  noRadio.checked = true;
  fields = internals.collectFields();
  eq('aspnet radio: value is the option label (No)',
    fieldByKey(fields, rentKey)?.value, 'No');

  // --- Reapply toggles the correct independent checkbox ---------------------
  internals.snapshotBaseline();
  internals.applyChangesWithBaseline([{
    key: blockKey,
    label: 'House type \u00B7 Block of flats',
    type: 'checkbox',
    was: 'Unchecked',
    now: 'Checked'
  }]);
  const blockCb = document.getElementById('ContentPlaceHolder1_cblHouseType_0');
  check('aspnet reapply: Block of flats checkbox toggled on', blockCb?.checked === true);

  // --- Reapply toggles the correct radio -----------------------------------
  internals.applyChangesWithBaseline([{
    key: rentKey,
    label: 'Are any of the applicants currently living in an apartment at the property?',
    type: 'radio',
    was: 'No',
    now: 'Yes'
  }]);
  const yesRadio = document.getElementById('ContentPlaceHolder1_rblCurrentlyRenting_1');
  const noRadio2 = document.getElementById('ContentPlaceHolder1_rblCurrentlyRenting_0');
  check('aspnet reapply: Yes radio selected', yesRadio?.checked === true);
  check('aspnet reapply: No radio deselected', noRadio2?.checked === false);
}

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
