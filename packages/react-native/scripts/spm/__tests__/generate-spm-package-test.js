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
  findSourcePath,
  generateXCFrameworksPackageSwift,
  main,
} = require('../generate-spm-package');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// generateXCFrameworksPackageSwift
// ---------------------------------------------------------------------------

describe('generateXCFrameworksPackageSwift', () => {
  it('renames React product to ReactNative', () => {
    const result = generateXCFrameworksPackageSwift([
      'React',
      'ReactNativeDependencies',
      'hermes-engine',
    ]);
    expect(result).toContain(
      '.library(name: "ReactNative", targets: ["React"])',
    );
    expect(result).toContain(
      '.library(name: "ReactNativeDependencies", targets: ["ReactNativeDependencies"])',
    );
    expect(result).toContain(
      '.library(name: "hermes-engine", targets: ["hermes-engine"])',
    );
  });

  it('lists binary targets', () => {
    const result = generateXCFrameworksPackageSwift([
      'React',
      'ReactNativeDependencies',
    ]);
    expect(result).toContain(
      '.binaryTarget(name: "React", path: "React.xcframework")',
    );
    expect(result).toContain(
      '.binaryTarget(name: "ReactNativeDependencies", path: "ReactNativeDependencies.xcframework")',
    );
  });

  it('includes auto-generated header comment', () => {
    const result = generateXCFrameworksPackageSwift(['React']);
    expect(result).toContain('AUTO-GENERATED');
    expect(result).toContain('swift-tools-version: 6.0');
    expect(result).toContain('name: "ReactNative"');
  });
});

// ---------------------------------------------------------------------------
// findSourcePath
// ---------------------------------------------------------------------------

describe('findSourcePath', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-find-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  it('finds directory matching derived name', () => {
    fs.mkdirSync(path.join(tempDir, 'MyApp'));
    expect(findSourcePath(tempDir, 'my-app')).toBe('MyApp');
  });

  it('falls back to ios directory', () => {
    fs.mkdirSync(path.join(tempDir, 'ios'));
    expect(findSourcePath(tempDir, 'unknown-pkg')).toBe('ios');
  });

  it('scans for directory with native sources', () => {
    fs.mkdirSync(path.join(tempDir, 'CustomDir'));
    fs.writeFileSync(path.join(tempDir, 'CustomDir', 'main.m'), '');
    expect(findSourcePath(tempDir, 'unrelated-name')).toBe('CustomDir');
  });

  it('returns derived name when nothing found', () => {
    expect(findSourcePath(tempDir, 'my-app')).toBe('MyApp');
  });
});

// ---------------------------------------------------------------------------
// main — end-to-end generation of build/xcframeworks/{Package.swift,symlinks}
// from a local artifacts.json. The headers composer is injected so the
// happy paths stay inside a tempdir with no cross-package side effects.
// ---------------------------------------------------------------------------

describe('main', () => {
  let appRoot;
  let rnRoot;
  let origExitCode;
  let logSpy;
  let errSpy;

  beforeEach(() => {
    appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-pkg-app-'));
    rnRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-pkg-rn-'));
    origExitCode = process.exitCode;
    process.exitCode = undefined;
    // main() is chatty via makeLogger/console.error — silence to keep output
    // readable; assertions target the filesystem, not the logs.
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = origExitCode;
    fs.rmSync(appRoot, {recursive: true, force: true});
    fs.rmSync(rnRoot, {recursive: true, force: true});
  });

  // Writes the app package.json so findProjectRoot/readPackageJson resolve.
  function writeAppPkg(name /*: string */ = 'my-app') {
    fs.writeFileSync(
      path.join(appRoot, 'package.json'),
      JSON.stringify({name, version: '1.0.0'}),
      'utf8',
    );
  }

  // Builds an artifacts dir with artifacts.json + a target dir per entry.
  // Each value's `present` flag controls whether the entry is written at all.
  function writeArtifacts(entries /*: Array<string> */) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-pkg-art-'));
    const json = {};
    for (const name of entries) {
      const xcfwPath = path.join(dir, `${name}.xcframework`);
      fs.mkdirSync(xcfwPath, {recursive: true});
      json[name] = {xcframeworkPath: xcfwPath, url: 'https://example'};
    }
    fs.writeFileSync(
      path.join(dir, 'artifacts.json'),
      JSON.stringify(json),
      'utf8',
    );
    return dir;
  }

  function run(artifactsDir /*:: ?: ?string */) {
    const argv = [
      '--app-root',
      appRoot,
      '--react-native-root',
      rnRoot,
      '--version',
      '0.85.0',
    ];
    if (artifactsDir != null) {
      argv.push('--artifacts-dir', artifactsDir);
    }
    main(argv);
  }

  it('generates Package.swift + symlinks when headers ship in the slot', () => {
    writeAppPkg();
    const artifactsDir = writeArtifacts([
      'React',
      'ReactNativeDependencies',
      'hermes-engine',
      'ReactNativeHeaders',
    ]);
    try {
      run(artifactsDir);

      expect(process.exitCode).toBeUndefined();

      const pkgSwift = path.join(
        appRoot,
        'build',
        'xcframeworks',
        'Package.swift',
      );
      expect(fs.existsSync(pkgSwift)).toBe(true);
      const contents = fs.readFileSync(pkgSwift, 'utf8');
      expect(contents).toContain('.binaryTarget(name: "React"');
      // The slot comment is derived from the artifacts dir's trailing path
      // segments (version/flavor), not the --version flag.
      expect(contents).toContain('Cache slot:');

      const reactLink = path.join(
        appRoot,
        'build',
        'xcframeworks',
        'React.xcframework',
      );
      expect(fs.lstatSync(reactLink).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(artifactsDir, {recursive: true, force: true});
    }
  });

  it('throws when ReactNativeHeaders is absent (no consumer-side compose)', () => {
    writeAppPkg();
    // Artifacts WITHOUT ReactNativeHeaders: the consumer does not compose the
    // layout locally, it fails with a clear error instead.
    const artifactsDir = writeArtifacts([
      'React',
      'ReactNativeDependencies',
      'hermes-engine',
    ]);
    try {
      expect(() => run(artifactsDir)).toThrow(/ReactNativeHeaders/);
      // No package is generated when the artifacts are incomplete.
      expect(
        fs.existsSync(
          path.join(appRoot, 'build', 'xcframeworks', 'Package.swift'),
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(artifactsDir, {recursive: true, force: true});
    }
  });

  it('throws when no package.json is found', () => {
    // No app package.json written.
    expect(() => run(null)).toThrow(/No package\.json/);
  });

  it('throws when --artifacts-dir has no artifacts.json', () => {
    writeAppPkg();
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-pkg-empty-'));
    try {
      expect(() => run(emptyDir)).toThrow(/artifacts\.json not found/);
    } finally {
      fs.rmSync(emptyDir, {recursive: true, force: true});
    }
  });

  it('throws when artifacts.json is missing a required entry', () => {
    writeAppPkg();
    // Missing hermes-engine.
    const artifactsDir = writeArtifacts(['React', 'ReactNativeDependencies']);
    try {
      expect(() => run(artifactsDir)).toThrow(/missing required entries/);
    } finally {
      fs.rmSync(artifactsDir, {recursive: true, force: true});
    }
  });

  it('auto-detects an existing build/xcframeworks without --artifacts-dir', () => {
    writeAppPkg();
    const xcfwDir = path.join(appRoot, 'build', 'xcframeworks');
    fs.mkdirSync(xcfwDir, {recursive: true});
    fs.writeFileSync(path.join(xcfwDir, 'Package.swift'), '// existing');
    run(null);
    // No artifacts-dir: it should leave the existing manifest untouched.
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(path.join(xcfwDir, 'Package.swift'), 'utf8')).toBe(
      '// existing',
    );
  });
});
