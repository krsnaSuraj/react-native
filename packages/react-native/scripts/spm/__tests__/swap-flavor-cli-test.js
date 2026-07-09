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

// HARD-FAIL + CONVERGE exit-code contract of the `swap-flavor` CLI action
// (setup-apple-spm.js), exercised as a real subprocess so the actual process
// exit path is covered. A build that STARTS on the wrong pinned flavor must, in
// an in-target context (BUILT_PRODUCTS_DIR set), correct the pin AND exit 1 so
// the generated build phase fails the build; the rebuild is then green. A
// matched build, or the pre-action context (no BUILT_PRODUCTS_DIR), exits 0.

const {execFileSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plist = require('plist');

const SCRIPT = path.join(__dirname, '..', '..', 'setup-apple-spm.js');

function mkXcframework(dir, name, content) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(
    path.join(dir, 'Info.plist'),
    plist.build({
      AvailableLibraries: [
        {
          LibraryIdentifier: 'ios-arm64_x86_64-simulator',
          LibraryPath: `${name}.framework`,
          SupportedPlatform: 'ios',
          SupportedArchitectures: ['arm64'],
          SupportedPlatformVariant: 'simulator',
        },
      ],
      CFBundlePackageType: 'XFWK',
      XCFrameworkFormatVersion: '1.0',
    }),
  );
  const fw = path.join(dir, 'ios-arm64_x86_64-simulator', `${name}.framework`);
  fs.mkdirSync(fw, {recursive: true});
  fs.writeFileSync(path.join(fw, name), content);
}

describe('swap-flavor CLI action — HARD-FAIL + CONVERGE exit codes', () => {
  let tmp, appRoot, versionDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-cli-'));
    appRoot = path.join(tmp, 'app');
    fs.mkdirSync(appRoot, {recursive: true});
    fs.writeFileSync(
      path.join(appRoot, 'package.json'),
      JSON.stringify({name: 'my-app', version: '1.0.0'}),
    );
    versionDir = path.join(tmp, 'cache', '1.0');
    for (const flavor of ['debug', 'release']) {
      mkXcframework(
        path.join(versionDir, flavor, 'React.xcframework'),
        'React',
        `REACT-${flavor}`,
      );
    }
    // App slot symlink -> the DEBUG slot (as `spm add --flavor debug` leaves it).
    const links = path.join(appRoot, 'build', 'xcframeworks');
    fs.mkdirSync(links, {recursive: true});
    fs.symlinkSync(
      path.join(versionDir, 'debug', 'React.xcframework'),
      path.join(links, 'React.xcframework'),
    );
  });
  afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

  function runSwap(env) {
    try {
      const out = execFileSync('node', [SCRIPT, 'swap-flavor'], {
        cwd: appRoot,
        env: {...process.env, ...env},
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return {code: 0, out};
    } catch (e) {
      return {code: e.status, out: (e.stdout || '') + (e.stderr || '')};
    }
  }

  const pinnedFlavor = () =>
    path.basename(
      path.dirname(
        fs.readlinkSync(
          path.join(appRoot, 'build', 'xcframeworks', 'React.xcframework'),
        ),
      ),
    );

  it('exits 1 with the error line when a Release build starts on the debug pin (in-target)', () => {
    const products = path.join(tmp, 'products');
    fs.mkdirSync(products, {recursive: true});
    const {code, out} = runSwap({
      CONFIGURATION: 'Release',
      BUILT_PRODUCTS_DIR: products,
      PLATFORM_NAME: 'iphonesimulator',
    });
    expect(code).toBe(1);
    expect(out).toMatch(/error:/);
    expect(out).toMatch(/switched to release/i);
    expect(out).toMatch(/build again/i);
    // CONVERGE: the pin is now release, so the REBUILD is green.
    expect(pinnedFlavor()).toBe('release');
  });

  it('exits 0 for a matched (Debug) build in-target', () => {
    const products = path.join(tmp, 'products');
    fs.mkdirSync(products, {recursive: true});
    const {code} = runSwap({
      CONFIGURATION: 'Debug',
      BUILT_PRODUCTS_DIR: products,
      PLATFORM_NAME: 'iphonesimulator',
    });
    expect(code).toBe(0);
    expect(pinnedFlavor()).toBe('debug');
  });

  it('exits 1 when a custom configuration ("Staging") starts on the debug pin (name-match -> release)', () => {
    const products = path.join(tmp, 'products');
    fs.mkdirSync(products, {recursive: true});
    const {code, out} = runSwap({
      CONFIGURATION: 'Staging',
      BUILT_PRODUCTS_DIR: products,
      PLATFORM_NAME: 'iphonesimulator',
    });
    expect(code).toBe(1);
    expect(out).toMatch(/switched to release/i);
    expect(pinnedFlavor()).toBe('release');
  });

  it('exits 0 (no hard-fail) in the pre-action context — no BUILT_PRODUCTS_DIR — but still repoints', () => {
    const {code, out} = runSwap({
      CONFIGURATION: 'Release',
      PLATFORM_NAME: 'iphonesimulator',
      BUILT_PRODUCTS_DIR: '',
    });
    expect(code).toBe(0);
    expect(out).not.toMatch(/error:/);
    // The repoint still happens (pre-action fixes the embed source), it just
    // does not fail the build.
    expect(pinnedFlavor()).toBe('release');
  });
});
