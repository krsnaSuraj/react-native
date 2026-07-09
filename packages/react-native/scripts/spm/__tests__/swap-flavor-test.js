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

// swap-flavor.js shells out to `plutil` to read an xcframework's Info.plist as
// JSON — plutil is macOS-only, so on Linux CI the real spawn ENOENTs and
// jest-worker can't serialize the resulting error, killing the whole suite.
// Stand in with a portable plist-parse. Mocked at the `child_process` module
// level (not via jest.spyOn) because swap-flavor.js destructures `execFileSync`
// at require time, so a post-import spy would never be seen. `plutil` is stubbed
// (macOS-only); everything else (rsync) runs for real so file-content assertions
// hold.
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execFileSync: (cmd, args, opts) => {
      if (cmd === 'plutil') {
        const fs = require('fs');
        const plist = require('plist');
        const file = args[args.length - 1];
        return Buffer.from(
          JSON.stringify(plist.parse(fs.readFileSync(file, 'utf8'))),
        );
      }
      return actual.execFileSync(cmd, args, opts);
    },
  };
});

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
  // The app-local slot symlink the Embed step resolves (lazy: appRoot is set in
  // beforeEach).
  const slotLink = () =>
    path.join(appRoot, 'build', 'xcframeworks', 'React.xcframework');
  const pinnedSlot = () =>
    path.basename(path.dirname(fs.readlinkSync(slotLink())));

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

  // F2: swap-flavor.js now maps CONFIGURATION via the shared
  // flavorFromConfiguration name-match rule instead of an exact 'Release'
  // string match — a custom configuration name (e.g. a "Staging" scheme
  // config) resolves like Xcode's own SwiftPM configuration mapping does.
  it('maps a custom configuration name ("Staging") to release', () => {
    const result = swapFlavorFrameworks({
      appRoot,
      configuration: 'Staging',
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
    });
    expect(result.flavor).toBe('release');
    expect(embedded()).toBe('REACT-release');
  });

  it('maps a custom configuration name containing "development" to debug', () => {
    const result = swapFlavorFrameworks({
      appRoot,
      configuration: 'MyDevelopmentConfig',
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
    });
    expect(result.flavor).toBe('debug');
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

  it('repoints the symlink but skips the rsync when the products dir does not exist (pre-action)', () => {
    const logs = [];
    expect(() =>
      swapFlavorFrameworks({
        appRoot,
        configuration: 'Release',
        builtProductsDir: path.join(tmp, 'nope'),
        platformName: 'iphonesimulator',
        logger: {log: m => logs.push(m)},
      }),
    ).not.toThrow();
    // Embed-step fix (repoint) runs even with no products dir — this is the
    // clean-build / pre-action case that must be corrected before Xcode
    // captures the embed source.
    expect(pinnedSlot()).toBe('release');
    // rsync skipped → the pre-existing materialized copy is left untouched.
    expect(embedded()).toBe('REACT-debug');
    expect(logs.some(m => /no products dir yet — pre-action/.test(m))).toBe(
      true,
    );
  });

  it('repoints the symlink but skips the rsync when builtProductsDir is null (scheme pre-action)', () => {
    const logs = [];
    expect(() =>
      swapFlavorFrameworks({
        appRoot,
        configuration: 'Release',
        builtProductsDir: null,
        platformName: 'iphonesimulator',
        logger: {log: m => logs.push(m)},
      }),
    ).not.toThrow();
    expect(pinnedSlot()).toBe('release');
    expect(embedded()).toBe('REACT-debug'); // untouched — no rsync
    expect(logs.some(m => /no products dir yet — pre-action/.test(m))).toBe(
      true,
    );
  });

  it('repoints the app-local slot symlink to the release slot for a Release build (embed-step fix)', () => {
    expect(pinnedSlot()).toBe('debug'); // add-time pin
    swapFlavorFrameworks({
      appRoot,
      configuration: 'Release',
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
    });
    // Symlink now resolves into the release slot (embed source), and the
    // materialized copy was rsynced to release too (link source).
    expect(pinnedSlot()).toBe('release');
    expect(fs.existsSync(fs.readlinkSync(slotLink()))).toBe(true);
    expect(embedded()).toBe('REACT-release');
  });

  it('leaves the slot symlink untouched for a matched (Debug) build', () => {
    const before = fs.readlinkSync(slotLink());
    swapFlavorFrameworks({
      appRoot,
      configuration: 'Debug',
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
    });
    expect(fs.readlinkSync(slotLink())).toBe(before); // byte-identical target
    expect(pinnedSlot()).toBe('debug');
  });

  it('leaves the symlink alone and warns (no throw) when the desired slot is missing', () => {
    fs.rmSync(path.join(tmp, 'cache', '1.0', 'release'), {
      recursive: true,
      force: true,
    });
    const logs = [];
    expect(() =>
      swapFlavorFrameworks({
        appRoot,
        configuration: 'Release',
        builtProductsDir: builtProducts,
        platformName: 'iphonesimulator',
        logger: {log: m => logs.push(m)},
      }),
    ).not.toThrow();
    expect(pinnedSlot()).toBe('debug'); // still the add-time pin
    expect(logs.some(m => /release slot missing/.test(m))).toBe(true);
  });

  it('preserves a RELATIVE slot symlink target when repointing (form-preserving)', () => {
    // Re-point the app symlink at the debug slot using a RELATIVE target
    // (linkOne can emit either form; the repoint must not silently absolutize).
    const links = path.join(appRoot, 'build', 'xcframeworks');
    fs.unlinkSync(slotLink());
    const relDebug = path.relative(
      links,
      path.join(tmp, 'cache', '1.0', 'debug', 'React.xcframework'),
    );
    expect(path.isAbsolute(relDebug)).toBe(false); // sanity: fixture is relative
    fs.symlinkSync(relDebug, slotLink());

    swapFlavorFrameworks({
      appRoot,
      configuration: 'Release',
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
    });

    const after = fs.readlinkSync(slotLink());
    expect(path.isAbsolute(after)).toBe(false); // still relative
    expect(pinnedSlot()).toBe('release');
    // ...and it resolves to the real release slot.
    expect(fs.existsSync(path.resolve(links, after))).toBe(true);
    expect(
      read(
        path.join(
          links,
          after,
          'ios-arm64_x86_64-simulator',
          'React.framework',
          'React',
        ),
      ),
    ).toBe('REACT-release');
  });

  it('never creates a dangling pin when a framework symlink lives in a different cache dir', () => {
    // React resolves via the normal (populated) slot, but hermes-engine points
    // at a SEPARATE cache dir that only has a debug slot — its release slot is
    // absent. The React-derived gate would pass; the per-target existence check
    // must still refuse to repoint hermes-engine.
    mkXcframework(
      path.join(tmp, 'other', '1.0', 'debug', 'hermes-engine.xcframework'),
      'hermes-engine',
      [
        {
          id: 'ios-arm64_x86_64-simulator',
          platform: 'ios',
          variant: 'simulator',
        },
      ],
      'HERMES-debug',
    );
    // Also place hermes in React's release slot so the slot-existence gate (xcfw
    // check) passes and we reach the repoint for hermes-engine.
    mkXcframework(
      path.join(tmp, 'cache', '1.0', 'release', 'hermes-engine.xcframework'),
      'hermes-engine',
      [
        {
          id: 'ios-arm64_x86_64-simulator',
          platform: 'ios',
          variant: 'simulator',
        },
      ],
      'HERMES-release',
    );
    const hermesLink = path.join(
      appRoot,
      'build',
      'xcframeworks',
      'hermes-engine.xcframework',
    );
    fs.symlinkSync(
      path.join(tmp, 'other', '1.0', 'debug', 'hermes-engine.xcframework'),
      hermesLink,
    );

    const logs = [];
    expect(() =>
      swapFlavorFrameworks({
        appRoot,
        configuration: 'Release',
        builtProductsDir: builtProducts,
        platformName: 'iphonesimulator',
        logger: {log: m => logs.push(m)},
      }),
    ).not.toThrow();

    // React repointed to release; hermes left at its (real) debug pin, not a
    // dangling link into other/1.0/release.
    expect(pinnedSlot()).toBe('release');
    expect(path.basename(path.dirname(fs.readlinkSync(hermesLink)))).toBe(
      'debug',
    );
    expect(fs.existsSync(fs.readlinkSync(hermesLink))).toBe(true);
    expect(logs.some(m => /slot missing for hermes-engine/.test(m))).toBe(true);
  });

  it('is idempotent — repointing twice equals once', () => {
    const opts = {
      appRoot,
      configuration: 'Release',
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
    };
    swapFlavorFrameworks(opts);
    const afterFirst = fs.readlinkSync(slotLink());
    const inodeFirst = fs.lstatSync(slotLink()).ino;
    swapFlavorFrameworks(opts);
    expect(fs.readlinkSync(slotLink())).toBe(afterFirst);
    // Matched flavor on the second pass → no unlink/symlink, inode unchanged.
    expect(fs.lstatSync(slotLink()).ino).toBe(inodeFirst);
    expect(pinnedSlot()).toBe('release');
    expect(embedded()).toBe('REACT-release');
  });

  // --- Autolinking-plugin flavored artifacts (sidecar-driven) ---
  const autolinkingDir = () =>
    path.join(appRoot, 'build', 'generated', 'autolinking');
  const writeSidecar = entries => {
    fs.mkdirSync(autolinkingDir(), {recursive: true});
    fs.writeFileSync(
      path.join(autolinkingDir(), '.spm-plugin-flavored-artifacts.json'),
      JSON.stringify(entries),
    );
  };
  // A plugin-flavor xcframework under tmp/plugin/<flavor>/<name>.xcframework.
  const mkPluginXcfw = (flavor, name, content) => {
    const dir = path.join(tmp, 'plugin', flavor, `${name}.xcframework`);
    mkXcframework(
      dir,
      name,
      [
        {
          id: 'ios-arm64_x86_64-simulator',
          platform: 'ios',
          variant: 'simulator',
        },
      ],
      content,
    );
    return dir;
  };
  // The plugin-owned symlink at <autolinking>/<name>/artifacts/<name>.xcframework.
  const mkPluginLink = (name, targetXcfw) => {
    const dir = path.join(autolinkingDir(), name, 'artifacts');
    fs.mkdirSync(dir, {recursive: true});
    const link = path.join(dir, `${name}.xcframework`);
    fs.symlinkSync(targetXcfw, link);
    return link;
  };
  const linkFlavor = link => path.basename(path.dirname(fs.readlinkSync(link)));

  it('repoints a plugin artifact (and its products copy) to the release flavor', () => {
    const dbg = mkPluginXcfw('debug', 'ExpoModulesCore', 'EXPO-debug');
    const rel = mkPluginXcfw('release', 'ExpoModulesCore', 'EXPO-release');
    const link = mkPluginLink('ExpoModulesCore', dbg); // plugin pins debug
    writeSidecar([
      {name: 'ExpoModulesCore', link, flavors: {debug: dbg, release: rel}},
    ]);
    // A materialized copy the Link step consumes.
    const copy = path.join(builtProducts, 'ExpoModulesCore.framework');
    fs.mkdirSync(copy, {recursive: true});
    fs.writeFileSync(path.join(copy, 'ExpoModulesCore'), 'EXPO-debug');

    const logs = [];
    swapFlavorFrameworks({
      appRoot,
      configuration: 'Release',
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
      logger: {log: m => logs.push(m)},
    });

    expect(linkFlavor(link)).toBe('release'); // embed source repointed
    expect(read(path.join(copy, 'ExpoModulesCore'))).toBe('EXPO-release'); // copy
    // Summary reports the plugin repoint count (React + plugin repointed).
    expect(logs.some(m => /\(1 plugin\)/.test(m))).toBe(true);
  });

  it('warns and leaves a plugin link alone when the requested flavor is not built (no wrong-flavor pin)', () => {
    // Only `release` is declared (and not built); the link is parked on an
    // undeclared debug path, so there is no "pinned to the other flavor" mix.
    const parked = mkPluginXcfw('debug', 'PluginA', 'A-debug');
    const rel = path.join(tmp, 'plugin', 'release', 'PluginA.xcframework'); // absent
    const link = mkPluginLink('PluginA', parked);
    writeSidecar([{name: 'PluginA', link, flavors: {release: rel}}]);

    const logs = [];
    expect(() =>
      swapFlavorFrameworks({
        appRoot,
        configuration: 'Release',
        builtProductsDir: builtProducts,
        platformName: 'iphonesimulator',
        logger: {log: m => logs.push(m)},
      }),
    ).not.toThrow();

    expect(linkFlavor(link)).toBe('debug'); // untouched
    expect(logs.some(m => /PluginA: release flavor not built/.test(m))).toBe(
      true,
    );
    expect(logs.some(m => /^error:/.test(m))).toBe(false); // no certain-mix
  });

  it('emits an error: line when the requested flavor is not built and the link is pinned to the other flavor', () => {
    const dbg = mkPluginXcfw('debug', 'PluginB', 'B-debug');
    const rel = path.join(tmp, 'plugin', 'release', 'PluginB.xcframework'); // absent
    const link = mkPluginLink('PluginB', dbg); // pinned to debug (declared)
    writeSidecar([
      {name: 'PluginB', link, flavors: {debug: dbg, release: rel}},
    ]);

    const logs = [];
    expect(() =>
      swapFlavorFrameworks({
        appRoot,
        configuration: 'Release',
        builtProductsDir: builtProducts,
        platformName: 'iphonesimulator',
        logger: {log: m => logs.push(m)},
      }),
    ).not.toThrow();

    expect(linkFlavor(link)).toBe('debug'); // untouched
    expect(logs.some(m => /PluginB: release flavor not built/.test(m))).toBe(
      true,
    );
    expect(
      logs.some(m =>
        /^error: swap-flavor: PluginB is pinned to the debug/.test(m),
      ),
    ).toBe(true);
  });

  it('warns and skips a plugin entry whose link is not a symlink (plugin owns creation)', () => {
    const dbg = mkPluginXcfw('debug', 'PluginC', 'C-debug');
    const rel = mkPluginXcfw('release', 'PluginC', 'C-release');
    // A real directory where the symlink should be.
    const dir = path.join(autolinkingDir(), 'PluginC', 'artifacts');
    fs.mkdirSync(dir, {recursive: true});
    const link = path.join(dir, 'PluginC.xcframework');
    fs.mkdirSync(link, {recursive: true});
    writeSidecar([
      {name: 'PluginC', link, flavors: {debug: dbg, release: rel}},
    ]);

    const logs = [];
    expect(() =>
      swapFlavorFrameworks({
        appRoot,
        configuration: 'Release',
        builtProductsDir: builtProducts,
        platformName: 'iphonesimulator',
        logger: {log: m => logs.push(m)},
      }),
    ).not.toThrow();

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false); // untouched
    expect(logs.some(m => /PluginC: no plugin-owned symlink/.test(m))).toBe(
      true,
    );
  });

  it('is silent about plugins when the sidecar is absent', () => {
    const logs = [];
    swapFlavorFrameworks({
      appRoot,
      configuration: 'Release',
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
      logger: {log: m => logs.push(m)},
    });
    // Only the RN-builtin summary; no plugin-specific chatter, count is (0 plugin).
    expect(logs.some(m => /\(0 plugin\)/.test(m))).toBe(true);
    expect(logs.some(m => /flavor not built|no plugin-owned/.test(m))).toBe(
      false,
    );
  });

  // --- HARD-FAIL + CONVERGE: the return value drives the CLI's exit code. ---
  it('returns builtinsCorrected + flavor info when it repoints a mismatch in-target', () => {
    const result = swapFlavorFrameworks({
      appRoot,
      configuration: 'Release',
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
    });
    expect(result.builtinsCorrected).toBe(true);
    expect(result.hasProducts).toBe(true);
    expect(result.flavor).toBe('release');
    expect(result.previousFlavor).toBe('debug');
  });

  it('returns builtinsCorrected=false for a matched (Debug) build', () => {
    const result = swapFlavorFrameworks({
      appRoot,
      configuration: 'Debug',
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
    });
    expect(result.builtinsCorrected).toBe(false);
    expect(result.hasProducts).toBe(true);
  });

  it('reports hasProducts=false in the pre-action context but still repoints', () => {
    const result = swapFlavorFrameworks({
      appRoot,
      configuration: 'Release',
      builtProductsDir: null,
      platformName: 'iphonesimulator',
    });
    expect(result.hasProducts).toBe(false);
    expect(result.builtinsCorrected).toBe(true);
    expect(pinnedSlot()).toBe('release');
  });

  it('does NOT count a plugin-only repoint as builtinsCorrected', () => {
    // A DEBUG build: React is pinned debug → MATCHED (no builtin repoint). Only
    // the plugin (pinned release) mismatches and flips to debug.
    const autolinking = path.join(appRoot, 'build', 'generated', 'autolinking');
    fs.mkdirSync(autolinking, {recursive: true});
    const slice = [
      {id: 'ios-arm64_x86_64-simulator', platform: 'ios', variant: 'simulator'},
    ];
    const rel = path.join(tmp, 'plugin', 'release', 'P.xcframework');
    const dbg = path.join(tmp, 'plugin', 'debug', 'P.xcframework');
    mkXcframework(rel, 'P', slice, 'P-release');
    mkXcframework(dbg, 'P', slice, 'P-debug');
    const linkDir = path.join(autolinking, 'P', 'artifacts');
    fs.mkdirSync(linkDir, {recursive: true});
    const link = path.join(linkDir, 'P.xcframework');
    fs.symlinkSync(rel, link); // plugin pinned RELEASE (mismatches a Debug build)
    fs.writeFileSync(
      path.join(autolinking, '.spm-plugin-flavored-artifacts.json'),
      JSON.stringify([{name: 'P', link, flavors: {debug: dbg, release: rel}}]),
    );

    const result = swapFlavorFrameworks({
      appRoot,
      configuration: 'Debug', // React (debug) is matched; only the plugin flips.
      builtProductsDir: builtProducts,
      platformName: 'iphonesimulator',
    });
    // A plugin repoint happened, but no BUILTIN was corrected.
    expect(result.builtinsCorrected).toBe(false);
    // Confirm the plugin symlink actually flipped to debug.
    expect(path.basename(path.dirname(fs.readlinkSync(link)))).toBe('debug');
  });
});

// RN must have ZERO writers of the built .app bundle — Xcode is the single
// writer of `.app/Frameworks`. This is a structural guard (grep-verifiable): the
// swap-flavor + CLI sources must not reference the embedded-destination /
// codesign / stamp surface.
describe('no .app writers (structural)', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  it('swap-flavor.js has no embedded-dest / codesign code', () => {
    const src = read('swap-flavor.js');
    for (const needle of [
      'TARGET_BUILD_DIR',
      'FRAMEWORKS_FOLDER_PATH',
      'targetBuildDir',
      'frameworksFolderPath',
      'codesign',
      'CODE_SIGNING_ALLOWED',
      'EXPANDED_CODE_SIGN',
    ]) {
      expect(src).not.toContain(needle);
    }
  });
  it('setup-apple-spm.js does not wire embedded-dest / codesign env into swap-flavor', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'setup-apple-spm.js'),
      'utf8',
    );
    for (const needle of [
      'TARGET_BUILD_DIR',
      'FRAMEWORKS_FOLDER_PATH',
      'CODE_SIGNING_ALLOWED',
      'EXPANDED_CODE_SIGN_IDENTITY',
    ]) {
      expect(src).not.toContain(needle);
    }
  });
});
