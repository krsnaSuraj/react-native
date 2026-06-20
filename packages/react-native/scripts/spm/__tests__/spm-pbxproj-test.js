/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @noflow
 */

'use strict';

const {
  addArrayMembers,
  addArrayStringValues,
  ensureScalarField,
  fileTypeForExtension,
  findApplicationTargets,
  findField,
  findObjectByUuid,
  findProjectObject,
  generateUUID,
  insertObjectsIntoSection,
  namespacedUUID,
  quoteIfNeeded,
  scanProjectFiles,
  scanToClose,
  serializeEntry,
  serializePbxproj,
  uuidsInArray,
} = require('../spm-pbxproj');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLAIN_PBXPROJ = fs.readFileSync(
  path.join(__dirname, '__fixtures__', 'plain-app.pbxproj'),
  'utf8',
);

// ---------------------------------------------------------------------------
// generateUUID
// ---------------------------------------------------------------------------

describe('generateUUID', () => {
  it('produces a 24-character uppercase hex string', () => {
    const result = generateUUID('test-seed');
    expect(result).toMatch(/^[0-9A-F]{24}$/);
  });

  it('is deterministic', () => {
    expect(generateUUID('same')).toBe(generateUUID('same'));
  });

  it('produces different results for different seeds', () => {
    expect(generateUUID('seed-a')).not.toBe(generateUUID('seed-b'));
  });
});

// ---------------------------------------------------------------------------
// fileTypeForExtension
// ---------------------------------------------------------------------------

describe('fileTypeForExtension', () => {
  it.each([
    ['.m', 'sourcecode.c.objc'],
    ['.swift', 'sourcecode.swift'],
    ['.xcassets', 'folder.assetcatalog'],
    ['.h', 'sourcecode.c.h'],
    ['.xyz', 'file'],
  ])('maps %s to %s', (ext, expected) => {
    expect(fileTypeForExtension(ext)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// quoteIfNeeded
// ---------------------------------------------------------------------------

describe('quoteIfNeeded', () => {
  it.each([
    ['foo.bar/baz', 'foo.bar/baz'],
    ['foo bar', '"foo bar"'],
    ['a\\b', '"a\\\\b"'],
    ['a"b', '"a\\"b"'],
    ['<group>', '"<group>"'],
  ])('quoteIfNeeded(%j) => %j', (input, expected) => {
    expect(quoteIfNeeded(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// scanProjectFiles
// ---------------------------------------------------------------------------

describe('scanProjectFiles', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbxproj-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  it('categorizes source files correctly', () => {
    fs.writeFileSync(path.join(tempDir, 'main.m'), '');
    fs.writeFileSync(path.join(tempDir, 'App.swift'), '');
    fs.writeFileSync(path.join(tempDir, 'Header.h'), '');
    fs.mkdirSync(path.join(tempDir, 'Assets.xcassets'));
    fs.writeFileSync(path.join(tempDir, 'Info.plist'), '');

    const result = scanProjectFiles(tempDir);
    expect(result.sources.sort()).toEqual(['App.swift', 'main.m']);
    expect(result.headers).toEqual(['Header.h']);
    expect(result.resources).toEqual(['Assets.xcassets']);
    expect(result.plists).toEqual(['Info.plist']);
  });

  it('skips dot-prefixed entries', () => {
    fs.writeFileSync(path.join(tempDir, '.hidden.m'), '');
    fs.writeFileSync(path.join(tempDir, 'visible.m'), '');

    const result = scanProjectFiles(tempDir);
    expect(result.sources).toEqual(['visible.m']);
  });

  it('walks subdirectories', () => {
    fs.mkdirSync(path.join(tempDir, 'sub'));
    fs.writeFileSync(path.join(tempDir, 'sub', 'file.cpp'), '');

    const result = scanProjectFiles(tempDir);
    expect(result.sources).toEqual(['sub/file.cpp']);
  });

  it('returns empty for non-existent directory', () => {
    const result = scanProjectFiles(path.join(tempDir, 'nonexistent'));
    expect(result).toEqual({
      sources: [],
      headers: [],
      resources: [],
      plists: [],
    });
  });

  // -------------------------------------------------------------------------
  // SPM-collision guards — files named Package.swift are SPM manifests, never
  // app target sources. swiftc refuses to compile two files with the same
  // basename in one target, so the legacy bug here was: scanning an appRoot
  // like ios/ recursively pulled in Package.swift from build/xcframeworks/,
  // build/generated/ios/, and the app's own Package.swift sibling — breaking
  // every build with "Filename Package.swift used twice".
  // -------------------------------------------------------------------------

  it('excludes files named Package.swift even at the source root', () => {
    fs.writeFileSync(path.join(tempDir, 'AppDelegate.swift'), '');
    fs.writeFileSync(path.join(tempDir, 'Package.swift'), '');
    const result = scanProjectFiles(tempDir);
    expect(result.sources).toEqual(['AppDelegate.swift']);
  });

  it('skips the build/ directory so nested Package.swift / generated artifacts never enter the source list', () => {
    fs.writeFileSync(path.join(tempDir, 'AppDelegate.swift'), '');
    fs.mkdirSync(path.join(tempDir, 'build', 'xcframeworks'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tempDir, 'build', 'xcframeworks', 'Package.swift'),
      '',
    );
    fs.writeFileSync(
      path.join(tempDir, 'build', 'xcframeworks', 'Generated.swift'),
      '',
    );
    const result = scanProjectFiles(tempDir);
    expect(result.sources).toEqual(['AppDelegate.swift']);
  });

  it('skips node_modules/, Pods/, and *.xcodeproj subdirectories', () => {
    fs.writeFileSync(path.join(tempDir, 'Real.m'), '');
    for (const skip of ['node_modules', 'Pods']) {
      fs.mkdirSync(path.join(tempDir, skip));
      fs.writeFileSync(path.join(tempDir, skip, 'Hidden.m'), '');
    }
    fs.mkdirSync(path.join(tempDir, 'Helloworld.xcodeproj'));
    fs.writeFileSync(
      path.join(tempDir, 'Helloworld.xcodeproj', 'embedded.swift'),
      '',
    );
    const result = scanProjectFiles(tempDir);
    expect(result.sources).toEqual(['Real.m']);
  });

  it('skips Xcode test target dirs (*Tests, *UITests) so XCTest-only files do not enter the app target', () => {
    fs.writeFileSync(path.join(tempDir, 'AppDelegate.swift'), '');
    for (const dir of ['HelloWorldTests', 'HelloWorldUITests', 'AppTest']) {
      fs.mkdirSync(path.join(tempDir, dir));
      fs.writeFileSync(path.join(tempDir, dir, 'Suite.m'), '');
    }
    // Directories whose names CONTAIN "test" but don't end with Test(s)/UITests
    // are legitimate sources — don't over-exclude.
    fs.mkdirSync(path.join(tempDir, 'TestUtils'));
    fs.writeFileSync(path.join(tempDir, 'TestUtils', 'Helper.m'), '');
    const result = scanProjectFiles(tempDir);
    expect(result.sources.sort()).toEqual([
      'AppDelegate.swift',
      'TestUtils/Helper.m',
    ]);
  });
});

// ---------------------------------------------------------------------------
// serializePbxproj
// ---------------------------------------------------------------------------

describe('serializePbxproj', () => {
  it('produces valid pbxproj header', () => {
    const result = serializePbxproj('1', '77', 'ROOT_UUID', {});
    expect(result).toMatch(/^\/\/ !\$\*UTF8\*\$!/);
    expect(result).toContain('archiveVersion = 1;');
    expect(result).toContain('objectVersion = 77;');
    expect(result).toContain('rootObject = ROOT_UUID;');
  });

  it('serializes a section with entries', () => {
    const sections = {
      PBXBuildFile: [
        {
          uuid: 'ABC123',
          comment: 'test file',
          fields: {
            isa: 'PBXBuildFile',
            fileRef: 'DEF456',
          },
        },
      ],
    };
    const result = serializePbxproj('1', '77', 'ROOT', sections);
    expect(result).toContain('/* Begin PBXBuildFile section */');
    expect(result).toContain('/* End PBXBuildFile section */');
    expect(result).toContain('ABC123 /* test file */');
    expect(result).toContain('isa = PBXBuildFile;');
  });
});

// ---------------------------------------------------------------------------
// Surgical-edit toolkit (in-place injection primitives)
// ---------------------------------------------------------------------------

describe('namespacedUUID', () => {
  it('is deterministic and 24-hex', () => {
    const a = namespacedUUID('ROOT', 'sec', 'id');
    expect(a).toMatch(/^[0-9A-F]{24}$/);
    expect(namespacedUUID('ROOT', 'sec', 'id')).toBe(a);
  });

  it('differs by root, section, id, and salt', () => {
    const base = namespacedUUID('ROOT', 'sec', 'id');
    expect(namespacedUUID('OTHER', 'sec', 'id')).not.toBe(base);
    expect(namespacedUUID('ROOT', 'other', 'id')).not.toBe(base);
    expect(namespacedUUID('ROOT', 'sec', 'other')).not.toBe(base);
    expect(namespacedUUID('ROOT', 'sec', 'id', '2')).not.toBe(base);
  });
});

describe('scanToClose', () => {
  it('matches braces and parens, skipping quoted delimiters', () => {
    const t = 'x = { a = ("a)b"); };';
    const open = t.indexOf('{');
    expect(t[scanToClose(t, open)]).toBe('}');
    const paren = t.indexOf('(');
    // The ")" inside the quoted string must not close the paren early.
    expect(scanToClose(t, paren)).toBe(t.indexOf(');') + 0);
  });
});

describe('findObjectByUuid / findField', () => {
  it('locates an object body and reads scalar + array fields', () => {
    const target = findApplicationTargets(PLAIN_PBXPROJ)[0];
    expect(target.name).toBe('MyApp');
    const obj = findObjectByUuid(PLAIN_PBXPROJ, target.uuid);
    expect(obj).not.toBeNull();
    const productType = findField(PLAIN_PBXPROJ, obj, 'productType');
    expect(productType.value).toContain('application');
    const buildPhases = findField(PLAIN_PBXPROJ, obj, 'buildPhases');
    expect(uuidsInArray(buildPhases.value).size).toBe(3);
  });

  it('returns null for an absent field', () => {
    const project = findProjectObject(PLAIN_PBXPROJ);
    expect(findField(PLAIN_PBXPROJ, project, 'packageReferences')).toBeNull();
  });
});

describe('addArrayMembers', () => {
  it('creates an absent array field after the body open', () => {
    const project = findProjectObject(PLAIN_PBXPROJ);
    const out = addArrayMembers(PLAIN_PBXPROJ, project, 'packageReferences', [
      {uuid: 'CAFE0000000000000000CAFE', comment: 'ref'},
    ]);
    expect(out).toMatch(/packageReferences = \(/);
    expect(out).toContain('CAFE0000000000000000CAFE /* ref */');
  });

  it('appends to and dedupes an existing array', () => {
    const target = findApplicationTargets(PLAIN_PBXPROJ)[0];
    const member = [{uuid: 'AA0000000000000000000301'}]; // already in buildPhases
    const out = addArrayMembers(PLAIN_PBXPROJ, target, 'buildPhases', member);
    // Dedup: no second occurrence added.
    expect(out.match(/AA0000000000000000000301/g)).toHaveLength(
      PLAIN_PBXPROJ.match(/AA0000000000000000000301/g).length,
    );
  });

  it('prepends when requested', () => {
    const target = findApplicationTargets(PLAIN_PBXPROJ)[0];
    const out = addArrayMembers(
      PLAIN_PBXPROJ,
      target,
      'buildPhases',
      [{uuid: 'BEEF0000000000000000BEEF', comment: 'First'}],
      {prepend: true},
    );
    const firstIdx = out.indexOf('BEEF0000000000000000BEEF');
    const sourcesIdx = out.indexOf('AA0000000000000000000301 /* Sources */');
    expect(firstIdx).toBeLessThan(sourcesIdx);
  });
});

describe('addArrayStringValues', () => {
  function targetDebugDict(text) {
    const cfg = findObjectByUuid(text, 'AA0000000000000000000901');
    const bs = findField(text, cfg, 'buildSettings');
    return {uuid: 'x', bodyOpen: bs.valueStart, bodyClose: bs.tokenEnd - 1};
  }

  it('creates an array seeded with $(inherited)', () => {
    const out = addArrayStringValues(
      PLAIN_PBXPROJ,
      targetDebugDict(PLAIN_PBXPROJ),
      'OTHER_LDFLAGS',
      ['"-ObjC"'],
    );
    expect(out).toMatch(/OTHER_LDFLAGS = \(/);
    expect(out).toContain('"$(inherited)"');
    expect(out).toContain('"-ObjC"');
  });

  it('promotes an existing scalar to an array, preserving the old value', () => {
    const scalar = PLAIN_PBXPROJ.replace(
      'PRODUCT_NAME = "$(TARGET_NAME)";',
      'OTHER_LDFLAGS = "-lz"; PRODUCT_NAME = "$(TARGET_NAME)";',
    );
    const out = addArrayStringValues(
      scalar,
      targetDebugDict(scalar),
      'OTHER_LDFLAGS',
      ['"-ObjC"'],
    );
    expect(out).toMatch(/OTHER_LDFLAGS = \(/);
    expect(out).toContain('"-lz"');
    expect(out).toContain('"-ObjC"');
  });
});

describe('ensureScalarField', () => {
  it('adds a scalar only when absent', () => {
    const project = findProjectObject(PLAIN_PBXPROJ);
    const out = ensureScalarField(
      PLAIN_PBXPROJ,
      project,
      'ORGANIZATIONNAME',
      'Acme',
    );
    expect(out).toContain('ORGANIZATIONNAME = Acme;');
    // Re-running is a no-op.
    const project2 = findProjectObject(out);
    expect(ensureScalarField(out, project2, 'ORGANIZATIONNAME', 'Other')).toBe(
      out,
    );
  });
});

describe('insertObjectsIntoSection', () => {
  it('creates a new section before the objects dict closes', () => {
    const entry = serializeEntry({
      uuid: 'DEAD0000000000000000DEAD',
      comment: 'XCLocalSwiftPackageReference "x"',
      fields: {isa: 'XCLocalSwiftPackageReference', relativePath: 'x'},
    });
    const out = insertObjectsIntoSection(
      PLAIN_PBXPROJ,
      'XCLocalSwiftPackageReference',
      entry,
    );
    expect(out).toContain('/* Begin XCLocalSwiftPackageReference section */');
    expect(out).toContain('DEAD0000000000000000DEAD');
    // Still inside the objects dict (before rootObject).
    expect(out.indexOf('DEAD0000000000000000DEAD')).toBeLessThan(
      out.indexOf('rootObject ='),
    );
  });
});
