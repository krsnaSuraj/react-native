/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

'use strict';

/*:: import type {ProjectFiles, PbxprojSections} from './spm-types'; */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Generate a deterministic 24-hex-character UUID from a seed string.
 * Uses MD5 hash truncated to 24 chars (standard Xcode pbxproj UUID length).
 */
function generateUUID(seed /*: string */) /*: string */ {
  return crypto
    .createHash('md5')
    .update(seed)
    .digest('hex')
    .substring(0, 24)
    .toUpperCase();
}

const FILE_TYPE_MAP /*: {[string]: string} */ = {
  '.m': 'sourcecode.c.objc',
  '.mm': 'sourcecode.cpp.objcpp',
  '.c': 'sourcecode.c.c',
  '.cpp': 'sourcecode.cpp.cpp',
  '.swift': 'sourcecode.swift',
  '.h': 'sourcecode.c.h',
  '.hpp': 'sourcecode.cpp.h',
  '.plist': 'text.plist.xml',
  '.storyboard': 'file.storyboard',
  '.xib': 'file.xib',
  '.xcassets': 'folder.assetcatalog',
  '.bundle': '"wrapper.plug-in"',
  '.xcprivacy': 'text.plist.xml',
  '.png': 'image.png',
  '.jpg': 'image.jpeg',
  '.json': 'text.json',
  '.js': 'sourcecode.javascript',
  '.entitlements': 'text.plist.entitlements',
};

/**
 * Map a file extension to its Xcode file type identifier.
 */
function fileTypeForExtension(ext /*: string */) /*: string */ {
  return FILE_TYPE_MAP[ext] ?? 'file';
}

/**
 * Scans a source directory and categorizes files for xcodeproj generation.
 * Returns sources (.m, .mm, .swift, .cpp, .c), headers (.h),
 * resources (.xcassets, .storyboard, .bundle, .xcprivacy, .png), and plists (.plist).
 *
 * Paths returned are relative to sourceDir.
 */
function scanProjectFiles(sourceDir /*: string */) /*: ProjectFiles */ {
  const sources /*: Array<string> */ = [];
  const headers /*: Array<string> */ = [];
  const resources /*: Array<string> */ = [];
  const plists /*: Array<string> */ = [];

  const sourceExts = new Set(['.m', '.mm', '.swift', '.cpp', '.c']);
  const headerExts = new Set(['.h', '.hpp']);
  const resourceExts = new Set([
    '.xcassets',
    '.storyboard',
    '.xib',
    '.bundle',
    '.xcprivacy',
    '.png',
    '.jpg',
  ]);

  // Directories that should never be walked into for app target sources:
  // generated SPM output (build/), npm install state (node_modules/), and any
  // sibling Xcode project bundles (*.xcodeproj). Without this, scanning an
  // appRoot like `ios/` recursively picks up auto-generated `Package.swift`
  // files under build/xcframeworks/, build/generated/ios/, etc. and shoves
  // them into the xcodeproj's PBXSourcesBuildPhase — swiftc then refuses to
  // compile multiple files named `Package.swift` in the same target.
  const skipDirNames /*: Set<string> */ = new Set([
    'build',
    'node_modules',
    'Pods',
  ]);

  // Test target dirs follow the Xcode convention `<AppName>Tests` and
  // `<AppName>UITests`. Their .m / .swift files include <XCTest/XCTest.h>,
  // which is only available to XCTest test targets — pulling them into the
  // app target's source list breaks the build with "file not found".
  // Skip-rule: case-insensitive ends-with "Tests" / "Test" / "UITests".
  const isTestDir = (name /*: string */) /*: boolean */ =>
    /(?:UI)?Tests?$/i.test(name);

  function walk(dir /*: string */, relBase /*: string */) /*: void */ {
    if (!fs.existsSync(dir)) {
      return;
    }
    const entries /*: Array<{name: string, isDirectory(): boolean}> */ =
      // $FlowFixMe[incompatible-type] Dirent typing
      fs.readdirSync(dir, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      // SPM manifest, never a target source — would collide with itself when
      // multiple sibling sub-packages define their own Package.swift.
      if (entry.name === 'Package.swift') {
        continue;
      }
      const full = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const ext = path.extname(entry.name);

      if (entry.isDirectory()) {
        // .xcassets and .bundle are treated as single resources, not walked into
        if (ext === '.xcassets' || ext === '.bundle') {
          resources.push(rel);
        } else if (
          skipDirNames.has(entry.name) ||
          ext === '.xcodeproj' ||
          ext === '.xcworkspace' ||
          isTestDir(entry.name)
        ) {
          continue;
        } else {
          walk(full, rel);
        }
      } else {
        if (sourceExts.has(ext)) {
          sources.push(rel);
        } else if (headerExts.has(ext)) {
          headers.push(rel);
        } else if (resourceExts.has(ext)) {
          resources.push(rel);
        } else if (ext === '.plist') {
          plists.push(rel);
        }
      }
    }
  }

  walk(sourceDir, '');
  return {sources, headers, resources, plists};
}

/**
 * Escapes a string for OpenStep plist format if needed.
 */
function quoteIfNeeded(s /*: string */) /*: string */ {
  if (/^[a-zA-Z0-9._/]+$/.test(s)) {
    return s;
  }
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * Serialize a single pbxproj object entry to its OpenStep text form,
 * including the leading `\t\t<uuid>` and trailing `};` but NO trailing
 * newline. Short entries (≤3 scalar fields) collapse to one line, matching
 * Xcode's own formatting. Shared by serializePbxproj (whole-file generation)
 * and the in-place injector (single-entry splicing) so both paths produce
 * byte-identical entry text.
 */
function serializeEntry(
  entry /*: {+uuid: string, +comment?: ?string, +fields: {+[string]: string}, ...} */,
) /*: string */ {
  const comment =
    entry.comment != null && entry.comment !== ''
      ? ` /* ${entry.comment} */`
      : '';
  let out = `\t\t${entry.uuid}${comment} = {`;
  const fieldKeys = Object.keys(entry.fields);
  if (
    fieldKeys.length <= 3 &&
    !fieldKeys.some(k => entry.fields[k].includes('\n'))
  ) {
    // Single-line format for short entries
    out += fieldKeys.map(k => `${k} = ${entry.fields[k]};`).join(' ');
    out += '};';
  } else {
    out += '\n';
    for (const key of fieldKeys) {
      out += `\t\t\t${key} = ${entry.fields[key]};\n`;
    }
    out += '\t\t};';
  }
  return out;
}

/**
 * Serialize a sections object into Xcode's OpenStep ASCII plist format.
 *
 * sections is an object mapping section names (e.g. "PBXBuildFile") to
 * arrays of {uuid, comment, fields} entries. fields is an object mapping
 * field names to string values (already formatted for plist output).
 */
function serializePbxproj(
  archiveVersion /*: string */,
  objectVersion /*: string */,
  rootObjectUUID /*: string */,
  sections /*: PbxprojSections */,
) /*: string */ {
  let out = `// !$*UTF8*$!\n{\n`;
  out += `\tarchiveVersion = ${archiveVersion};\n`;
  out += `\tclasses = {\n\t};\n`;
  out += `\tobjectVersion = ${objectVersion};\n`;
  out += `\tobjects = {\n\n`;

  const sectionOrder = [
    'PBXBuildFile',
    'PBXFileReference',
    'PBXFrameworksBuildPhase',
    'PBXGroup',
    'PBXNativeTarget',
    'PBXProject',
    'PBXResourcesBuildPhase',
    'PBXShellScriptBuildPhase',
    'PBXSourcesBuildPhase',
    'XCBuildConfiguration',
    'XCConfigurationList',
    'XCLocalSwiftPackageReference',
    'XCRemoteSwiftPackageReference',
    'XCSwiftPackageProductDependency',
  ];

  for (const sectionName of sectionOrder) {
    const entries = sections[sectionName];
    if (!entries || entries.length === 0) {
      continue;
    }

    out += `/* Begin ${sectionName} section */\n`;
    for (const entry of entries) {
      out += `${serializeEntry(entry)}\n`;
    }
    out += `/* End ${sectionName} section */\n\n`;
  }

  out += `\t};\n`;
  out += `\trootObject = ${rootObjectUUID};\n`;
  out += `}\n`;

  return out;
}

// ---------------------------------------------------------------------------
// Surgical in-place pbxproj editing.
//
// The whole-file generator above writes a brand-new project. To ADD SPM
// packages to a user's EXISTING project.pbxproj we instead splice new objects
// and array members into the existing text by string anchors, leaving every
// untouched byte identical (so the git diff is just the added lines). These
// helpers operate on the raw OpenStep text — there is no AST. Quote-aware
// delimiter matching lets them skip over field values (e.g. a shellScript
// containing braces/parens) without miscounting.
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic UUID for an injected object, namespaced by the host
 * project's root-object UUID so it is (a) stable across re-runs (idempotency)
 * and (b) astronomically unlikely to collide with the user's existing
 * randomly-assigned 24-hex IDs. `salt` lets the caller re-derive on the
 * ~1-in-2^96 collision.
 */
function namespacedUUID(
  rootUUID /*: string */,
  section /*: string */,
  id /*: string */,
  salt /*: string */ = '',
) /*: string */ {
  return generateUUID(`${rootUUID}:spm${salt}:${section}:${id}`);
}

function escapeRegExp(s /*: string */) /*: string */ {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Given an index pointing at an opening `"`, return the index of the matching
 * closing `"` (honoring backslash escapes).
 */
function scanString(text /*: string */, openIdx /*: number */) /*: number */ {
  for (let i = openIdx + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '"') {
      return i;
    }
  }
  throw new Error('pbxproj: unterminated string literal');
}

/**
 * Given an index pointing at an opening `{` or `(`, return the index of the
 * matching close delimiter. Nesting counts both brace and paren forms; quoted
 * strings are skipped. Well-formed OpenStep never mismatches the two forms.
 */
function scanToClose(text /*: string */, openIdx /*: number */) /*: number */ {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i = scanString(text, i);
      continue;
    }
    if (c === '{' || c === '(') {
      depth++;
    } else if (c === '}' || c === ')') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  throw new Error('pbxproj: unbalanced delimiters');
}

/*::
type ObjectRange = {uuid: string, bodyOpen: number, bodyClose: number};
// Any object whose body range is known — field accessors only need the body
// bounds, so they accept the richer shapes callers carry (e.g. app targets
// with a name, or buildSettings dicts) inexactly.
type BodyRange = {bodyOpen: number, bodyClose: number, ...};
type FieldRange = {matchStart: number, valueStart: number, value: string, tokenEnd: number};
*/

/**
 * Locate the object with the given 24-hex UUID. Returns the index of the body
 * `{` and its matching `}`. Matches both single-line and multi-line entries.
 */
function findObjectByUuid(
  text /*: string */,
  uuid /*: string */,
) /*: ObjectRange | null */ {
  const m = new RegExp(`\\n\\t*${uuid}\\b[^\\n]*?= \\{`).exec(text);
  if (m == null) {
    return null;
  }
  const bodyOpen = text.indexOf('{', m.index);
  const bodyClose = scanToClose(text, bodyOpen);
  return {uuid, bodyOpen, bodyClose};
}

/**
 * Find a field within a multi-line object body (`\n\t+key = value;`). Returns
 * the value token range (value excludes the trailing `;`; `tokenEnd` points AT
 * the `;`). Containers (`( … )` / `{ … }`) and quoted strings are matched as a
 * whole. Returns null when the key is absent.
 */
function findField(
  text /*: string */,
  obj /*: BodyRange */,
  key /*: string */,
) /*: FieldRange | null */ {
  const body = text.slice(obj.bodyOpen, obj.bodyClose);
  const m = new RegExp(`\\n\\t+${escapeRegExp(key)} = `).exec(body);
  if (m == null) {
    return null;
  }
  const matchStart = obj.bodyOpen + m.index;
  const valueStart = matchStart + m[0].length;
  const fc = text[valueStart];
  let tokenEnd;
  if (fc === '(' || fc === '{') {
    tokenEnd = scanToClose(text, valueStart) + 1;
  } else if (fc === '"') {
    tokenEnd = scanString(text, valueStart) + 1;
  } else {
    tokenEnd = text.indexOf(';', valueStart);
  }
  return {
    matchStart,
    valueStart,
    value: text.slice(valueStart, tokenEnd),
    tokenEnd,
  };
}

/** Locate the `/* Begin X section *​/ … /* End X section *​/` byte range. */
function findSection(
  text /*: string */,
  name /*: string */,
) /*: {begin: number, contentStart: number, end: number} | null */ {
  const beginTag = `/* Begin ${name} section */`;
  const endTag = `/* End ${name} section */`;
  const begin = text.indexOf(beginTag);
  const end = text.indexOf(endTag);
  if (begin < 0 || end < 0) {
    return null;
  }
  return {begin, contentStart: begin + beginTag.length, end};
}

/** The PBXProject root object (via the trailing `rootObject = <uuid>;`). */
function findProjectObject(text /*: string */) /*: ObjectRange | null */ {
  const m = /\n\trootObject = ([0-9A-Fa-f]{24})/.exec(text);
  if (m == null) {
    return null;
  }
  return findObjectByUuid(text, m[1]);
}

/** The `objectVersion = NN;` value, or null. */
function readObjectVersion(text /*: string */) /*: string | null */ {
  const m = /\n\tobjectVersion = (\d+);/.exec(text);
  return m != null ? m[1] : null;
}

/**
 * Every PBXNativeTarget whose productType is an application. Returns uuid +
 * name + body range for each. Used to pick the app target to inject into
 * (and to refuse on ambiguity).
 */
function findApplicationTargets(
  text /*: string */,
) /*: Array<{uuid: string, name: string, bodyOpen: number, bodyClose: number}> */ {
  const section = findSection(text, 'PBXNativeTarget');
  if (section == null) {
    return [];
  }
  const out = [];
  const re = /\n\t\t([0-9A-Fa-f]{24})(?: \/\* (.*?) \*\/)? = \{/g;
  re.lastIndex = section.contentStart;
  for (;;) {
    const m = re.exec(text);
    if (m == null || m.index >= section.end) {
      break;
    }
    const uuid = m[1];
    const comment = m[2];
    const bodyOpen = text.indexOf('{', m.index);
    const bodyClose = scanToClose(text, bodyOpen);
    const obj = {uuid, bodyOpen, bodyClose};
    const productType = findField(text, obj, 'productType');
    if (
      productType != null &&
      /com\.apple\.product-type\.application/.test(productType.value)
    ) {
      const nameField = findField(text, obj, 'name');
      const name =
        nameField != null
          ? nameField.value.replace(/^"|"$/g, '')
          : (comment ?? uuid);
      out.push({uuid, name, bodyOpen, bodyClose});
    }
    re.lastIndex = bodyClose;
  }
  return out;
}

/** UUIDs already referenced inside a `( … )` array field value. */
function uuidsInArray(value /*: string */) /*: Set<string> */ {
  const found = new Set /*:: <string> */();
  const re = /\b([0-9A-Fa-f]{24})\b/g;
  for (;;) {
    const m = re.exec(value);
    if (m == null) {
      break;
    }
    found.add(m[1]);
  }
  return found;
}

/**
 * The leading-tab indent of fields inside an object body (e.g. `\t\t\t` for a
 * top-level object, `\t\t\t\t` for a nested dict like buildSettings). Used so
 * inserted fields/members match the surrounding depth at any nesting level.
 */
function detectFieldIndent(
  text /*: string */,
  obj /*: BodyRange */,
) /*: string */ {
  const m = /\n(\t+)\S/.exec(text.slice(obj.bodyOpen, obj.bodyClose));
  return m != null ? m[1] : '\t\t\t';
}

/**
 * Insert one or more already-serialized object entries (text produced by
 * serializeEntry, no surrounding newlines) into the named section — created
 * just before the close of the `objects` dict if the section is absent.
 */
function insertObjectsIntoSection(
  text /*: string */,
  sectionName /*: string */,
  entriesText /*: string */,
) /*: string */ {
  const section = findSection(text, sectionName);
  if (section != null) {
    return (
      text.slice(0, section.end) + entriesText + '\n' + text.slice(section.end)
    );
  }
  // No such section yet — create it just before the `objects` dict closes.
  const anchor = '\n\t};\n\trootObject = ';
  const at = text.indexOf(anchor);
  if (at < 0) {
    throw new Error('pbxproj: could not find end of objects dict');
  }
  const block =
    `/* Begin ${sectionName} section */\n${entriesText}\n` +
    `/* End ${sectionName} section */\n\n`;
  return text.slice(0, at + 1) + block + text.slice(at + 1);
}

/**
 * Append members to a `( … )` array field, deduping by UUID. Creates the field
 * (with a `$(inherited)`-free literal list) after the object's opening `{` when
 * absent. `members` are `{uuid, comment}`. Indentation is derived from the
 * object so it works for top-level fields and nested dicts alike.
 */
function addArrayMembers(
  text /*: string */,
  obj /*: BodyRange */,
  key /*: string */,
  members /*: $ReadOnlyArray<{+uuid: string, +comment?: ?string, ...}> */,
  options /*: {prepend?: boolean} */ = {},
) /*: string */ {
  const fieldIndent = detectFieldIndent(text, obj);
  const memberIndent = fieldIndent + '\t';
  const line = (m /*: {+uuid: string, +comment?: ?string, ...} */) =>
    `${memberIndent}${m.uuid}${m.comment != null && m.comment !== '' ? ` /* ${m.comment} */` : ''},\n`;

  const field = findField(text, obj, key);
  if (field != null) {
    const existing = uuidsInArray(field.value);
    const fresh = members.filter(m => !existing.has(m.uuid));
    if (fresh.length === 0) {
      return text;
    }
    // Prepend: insert right after the array's opening `(\n` so the new members
    // run first (used for the sync phase, which must precede Sources).
    const insertAt =
      options.prepend === true
        ? text.indexOf('\n', field.valueStart) + 1
        : text.lastIndexOf('\n', field.tokenEnd - 1) + 1;
    return (
      text.slice(0, insertAt) + fresh.map(line).join('') + text.slice(insertAt)
    );
  }
  const block = `\n${fieldIndent}${key} = (\n${members.map(line).join('')}${fieldIndent});`;
  return text.slice(0, obj.bodyOpen + 1) + block + text.slice(obj.bodyOpen + 1);
}

/**
 * Append raw string values to a `( … )` array build-setting (e.g.
 * OTHER_LDFLAGS), deduping by exact token. Creates the setting seeded with
 * `"$(inherited)"` when absent. Values must already be plist-quoted by caller.
 */
function addArrayStringValues(
  text /*: string */,
  obj /*: BodyRange */,
  key /*: string */,
  values /*: Array<string> */,
) /*: string */ {
  const fieldIndent = detectFieldIndent(text, obj);
  const memberIndent = fieldIndent + '\t';
  const arrayBlock = (members /*: Array<string> */) =>
    `(\n${members.map(v => `${memberIndent}${v},\n`).join('')}${fieldIndent})`;

  const field = findField(text, obj, key);
  if (field != null) {
    const fresh = values.filter(v => !field.value.includes(v));
    if (fresh.length === 0) {
      return text;
    }
    if (field.value.trimStart().startsWith('(')) {
      // Existing array — splice fresh members before the closing `)`.
      const lineStart = text.lastIndexOf('\n', field.tokenEnd - 1) + 1;
      const lines = fresh.map(v => `${memberIndent}${v},\n`).join('');
      return text.slice(0, lineStart) + lines + text.slice(lineStart);
    }
    // Existing scalar — promote to an array preserving the prior value.
    const replacement = arrayBlock([
      '"$(inherited)"',
      field.value.trim(),
      ...fresh,
    ]);
    return (
      text.slice(0, field.valueStart) + replacement + text.slice(field.tokenEnd)
    );
  }
  const block = `\n${fieldIndent}${key} = ${arrayBlock(['"$(inherited)"', ...values])};`;
  return text.slice(0, obj.bodyOpen + 1) + block + text.slice(obj.bodyOpen + 1);
}

/**
 * Add a scalar field after the object's `{` only when ABSENT (never clobbers a
 * value the user already set). Returns text unchanged if the key exists.
 */
function ensureScalarField(
  text /*: string */,
  obj /*: BodyRange */,
  key /*: string */,
  value /*: string */,
) /*: string */ {
  if (findField(text, obj, key) != null) {
    return text;
  }
  const fieldIndent = detectFieldIndent(text, obj);
  const block = `\n${fieldIndent}${key} = ${value};`;
  return text.slice(0, obj.bodyOpen + 1) + block + text.slice(obj.bodyOpen + 1);
}

module.exports = {
  generateUUID,
  namespacedUUID,
  fileTypeForExtension,
  scanProjectFiles,
  serializeEntry,
  serializePbxproj,
  quoteIfNeeded,
  // Surgical-edit toolkit (in-place injection):
  scanString,
  scanToClose,
  findObjectByUuid,
  findField,
  findSection,
  findProjectObject,
  readObjectVersion,
  findApplicationTargets,
  uuidsInArray,
  detectFieldIndent,
  insertObjectsIntoSection,
  addArrayMembers,
  addArrayStringValues,
  ensureScalarField,
  escapeRegExp,
};
