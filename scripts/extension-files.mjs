/**
 * Canonical list of files that MUST be in any unpacked load or CWS zip.
 *
 * Pitfall: copying only manifest.json + background.js + content/ + panel/ +
 * icons/ omits ensure-content-script.js. panel/panel.js imports that root ES
 * module; omitting it breaks inject-then-message in the side panel.
 *
 * background.js is a classic service worker (no ES import, no background.type
 * module). Do not remove it — MV3 still requires a service worker.
 */

export const SHIP_ROOT_FILES = [
  'manifest.json',
  'background.js',
  'ensure-content-script.js'
];

export const SHIP_DIRS = [
  'content',
  'panel',
  'icons'
];

/** Folders a naive packager copies — not enough on its own. */
export const NAIVE_SHIP_DIRS = ['content', 'panel', 'icons'];
export const NAIVE_SHIP_ROOT_FILES = ['manifest.json', 'background.js'];

const RELATIVE_IMPORT_RE = /(?:from|import)\s+['"](\.\.?\/[^'"]+)['"]/g;
const EXECUTE_SCRIPT_FILES_RE = /files\s*:\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
const HTML_REF_RE = /(?:src|href)\s*=\s*['"]([^'"]+)['"]/gi;

function toPosix(p) {
  return p.split('\\').join('/');
}

function normalizeRel(fromFile, spec) {
  const fromDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const joined = toPosix(
    [fromDir, spec].filter(Boolean).join('/')
  );
  const parts = [];
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

export function collectRelativeImports(source, fromFile) {
  const out = new Set();
  const text = String(source || '');
  RELATIVE_IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = RELATIVE_IMPORT_RE.exec(text))) {
    out.add(normalizeRel(fromFile, m[1]));
  }
  EXECUTE_SCRIPT_FILES_RE.lastIndex = 0;
  while ((m = EXECUTE_SCRIPT_FILES_RE.exec(text))) {
    out.add(toPosix(m[1]).replace(/^\.\//, ''));
  }
  return [...out];
}

export function collectHtmlRefs(source, fromFile) {
  const out = new Set();
  const text = String(source || '');
  HTML_REF_RE.lastIndex = 0;
  let m;
  while ((m = HTML_REF_RE.exec(text))) {
    const spec = m[1];
    if (!spec || spec.startsWith('http') || spec.startsWith('mailto:') || spec.startsWith('#')) continue;
    out.add(normalizeRel(fromFile, spec));
  }
  return [...out];
}

/**
 * Expand SHIP_ROOT_FILES + SHIP_DIRS into a sorted list of posix relative paths.
 * @param {(rel: string) => string[]} readDir
 * @param {(rel: string) => boolean} isDir
 */
export function expandShipList(readDir, isDir) {
  const out = new Set(SHIP_ROOT_FILES);
  const stack = [...SHIP_DIRS];
  while (stack.length) {
    const rel = stack.pop();
    if (isDir(rel)) {
      for (const name of readDir(rel)) {
        if (name === '.' || name === '..') continue;
        stack.push(`${rel}/${name}`);
      }
    } else {
      out.add(rel);
    }
  }
  return [...out].sort();
}

/**
 * Files a naive content/+panel/+icons/+background copy would include.
 * Used by tests to lock the ensure-content-script.js pitfall.
 */
export function expandNaiveShipList(readDir, isDir) {
  const out = new Set(NAIVE_SHIP_ROOT_FILES);
  const stack = [...NAIVE_SHIP_DIRS];
  while (stack.length) {
    const rel = stack.pop();
    if (isDir(rel)) {
      for (const name of readDir(rel)) {
        if (name === '.' || name === '..') continue;
        stack.push(`${rel}/${name}`);
      }
    } else {
      out.add(rel);
    }
  }
  return [...out].sort();
}
