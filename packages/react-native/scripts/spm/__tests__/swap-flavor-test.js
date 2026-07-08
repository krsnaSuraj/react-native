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

const {matchSlice, swapFlavorFrameworks} = require('../swap-flavor');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plist = require('plist');

// Build a minimal <name>.xcframework with the given slices, each carrying a
// <name>.framework whose binary contains `content` (to assert what got copied).
function mkXcframework(dir, name, slices, content) {
  fs.mkdirSync(dir, {recursive: true});
  const available = slices.map(s => ({
    LibraryIdentifier: s.id,
    LibraryPath: `${name}.framework`,
    SupportedPlatform: s.platform,
    SupportedArchitectures: ['arm64'],
    ...(s.variant ? {SupportedPlatformVariant: s.variant} : {}),
  }));
  fs.writeFileSync(
    path.join(dir, 'Info.plist'),
    plist.build({
      AvailableLibraries: available,
      CFBundlePackageType: 'XFWK',
      XCFrameworkFormatVersion: '1.0',
    }),
  );
  for (const s of slices) {
    const fw = path.join(dir, s.id, `${name}.framework`);
    fs.mkdirSync(fw, {recursive: true});
    fs.writeFileSync(path.join(fw, name), content);
  }
}

describe('matchSlice', () => {
  let tmp, xcfw;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-match-'));
    xcfw = path.join(tmp, 'React.xcframework');
    mkXcframework(
      xcfw,
      'React',
      [
        {id: 'ios-arm64', platform: 'ios'},
        {
          id: 'ios-arm64_x86_64-simulator',
          platform: 'ios',
          variant: 'simulator',
        },
        {
          id: 'ios-arm64_x86_64-maccatalyst',
          platform: 'ios',
          variant: 'maccatalyst',
        },
        {id: 'tvos-arm64', platform: 'tvos'},
      ],
      'x',
    );
  });
  afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

  it('maps iphonesimulator to the ios+simulator slice', () => {
    expect(matchSlice(xcfw, 'iphonesimulator', false)).toBe(
      'ios-arm64_x86_64-simulator',
    );
  });
  it('maps iphoneos to the ios (no-variant) slice', () => {
    expect(matchSlice(xcfw, 'iphoneos', false)).toBe('ios-arm64');
  });
  it('maps Mac Catalyst explicitly (macosx PLATFORM_NAME + variant)', () => {
    expect(matchSlice(xcfw, 'macosx', true)).toBe(
      'ios-arm64_x86_64-maccatalyst',
    );
  });
  it('returns null for an unknown platform', () => {
    expect(matchSlice(xcfw, 'watchos', false)).toBeNull();
  });
});

describe('swapFlavorFrameworks', () => {
  let tmp, appRoot, builtProducts;
  const read = p => fs.readFileSync(p, 'utf8');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-fw-'));
    // Cache slots: debug + release, each with a React.framework binary tagged
    // by flavor so we can assert which one landed.
    for (const flavor of ['debug', 'release']) {
      mkXcframework(
        path.join(tmp, 'cache', '1.0', flavor, 'React.xcframework'),
        'React',
        [
          {
            id: 'ios-arm64_x86_64-simulator',
            platform: 'ios',
            variant: 'simulator',
          },
        ],
        `REACT-${flavor}`,
      );
    }
    // App: build/xcframeworks/React.xcframework -> the DEBUG slot (as `spm add`
    // --flavor debug would leave it).
    appRoot = path.join(tmp, 'app');
    const links = path.join(appRoot, 'build', 'xcframeworks');
    fs.mkdirSync(links, {recursive: true});
    fs.symlinkSync(
      path.join(tmp, 'cache', '1.0', 'debug', 'React.xcframework'),
      path.join(links, 'React.xcframework'),
    );
    // SPM-copied (debug) framework in PackageFrameworks.
    builtProducts = path.join(tmp, 'products');
    const pf = path.join(builtProducts, 'PackageFrameworks', 'React.framework');
    fs.mkdirSync(pf, {recursive: true});
    fs.writeFileSync(path.join(pf, 'React'), 'REACT-debug');
  });
  afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

  const embedded = () =>
    read(
      path.join(builtProducts, 'PackageFrameworks', 'React.framework', 'React'),
    );

  it('swaps the copied debug framework to release for a Release build', () => {
    swapFlavorFrameworks({
      appRoot,
      configuration: 'Release',
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
    });
    expect(embedded()).toBe('REACT-release');
  });

  it('leaves debug in place for a Debug build (idempotent)', () => {
    swapFlavorFrameworks({
      appRoot,
      configuration: 'Debug',
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
    });
    expect(embedded()).toBe('REACT-debug');
  });

  it('swaps a framework at the BUILT_PRODUCTS_DIR top level (real SPM binaryTarget layout)', () => {
    // SPM copies binaryTarget frameworks to <BUILT_PRODUCTS_DIR>/<F>.framework,
    // not PackageFrameworks/. Put it there and confirm the swap finds it.
    const topFw = path.join(builtProducts, 'React.framework');
    fs.mkdirSync(topFw, {recursive: true});
    fs.writeFileSync(path.join(topFw, 'React'), 'REACT-debug');
    swapFlavorFrameworks({
      appRoot,
      configuration: 'Release',
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
    });
    expect(read(path.join(topFw, 'React'))).toBe('REACT-release');
  });

  it('no-ops when the products dir does not exist (pre-action)', () => {
    expect(() =>
      swapFlavorFrameworks({
        appRoot,
        configuration: 'Release',
        builtProductsDir: path.join(tmp, 'nope'),
        platformName: 'iphonesimulator',
      }),
    ).not.toThrow();
    expect(embedded()).toBe('REACT-debug');
  });
});
