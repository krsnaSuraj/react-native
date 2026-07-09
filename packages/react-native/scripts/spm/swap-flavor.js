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

const {execFileSync} = require('child_process');
const fs = require('fs');
const path = require('path');

// Framework-type artifacts whose compiled binary differs by flavor. The
// headers-only companions (ReactNativeHeaders / ReactNativeDependenciesHeaders)
// are library-type and flavor-agnostic, so they never need swapping.
const FLAVORED_XCFRAMEWORKS /*: Array<string> */ = [
  'React',
  'ReactNativeDependencies',
  'hermes-engine',
];

// Xcode PLATFORM_NAME → xcframework SupportedPlatform (+ optional Variant).
const PLATFORM_MAP /*: {[string]: {platform: string, variant?: string}} */ = {
  iphoneos: {platform: 'ios'},
  iphonesimulator: {platform: 'ios', variant: 'simulator'},
  appletvos: {platform: 'tvos'},
  appletvsimulator: {platform: 'tvos', variant: 'simulator'},
  xros: {platform: 'xros'},
  xrsimulator: {platform: 'xros', variant: 'simulator'},
  macosx: {platform: 'macos'},
};

function plistJson(p /*: string */) /*: $FlowFixMe */ {
  return JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', p]).toString(),
  );
}

/**
 * The LibraryIdentifier (slice dir) of `xcfwDir` matching the build platform,
 * or null. Mac Catalyst is PLATFORM_NAME=macosx with a distinct variant, so it
 * is matched explicitly.
 */
function matchSlice(
  xcfwDir /*: string */,
  platformName /*: ?string */,
  isMacCatalyst /*: boolean */,
) /*: ?string */ {
  const libs = plistJson(path.join(xcfwDir, 'Info.plist')).AvailableLibraries;
  if (!Array.isArray(libs)) {
    return null;
  }
  if (isMacCatalyst) {
    const m = libs.find(l => l.SupportedPlatformVariant === 'maccatalyst');
    return m ? m.LibraryIdentifier : null;
  }
  const want = platformName != null ? PLATFORM_MAP[platformName] : null;
  if (want == null) {
    return null;
  }
  const m = libs.find(
    l =>
      l.SupportedPlatform === want.platform &&
      (l.SupportedPlatformVariant ?? undefined) === (want.variant ?? undefined),
  );
  return m ? m.LibraryIdentifier : null;
}

/**
 * Overwrites the SPM-copied flavored frameworks in
 * `<builtProductsDir>/PackageFrameworks/` with the slices from the cache slot
 * matching `configuration`'s flavor. Mirrors the CocoaPods React-Core-prebuilt
 * swap: SwiftPM binaryTargets can't branch on the build configuration, so a
 * Debug build must not embed the release React (and vice-versa) — RN's debug
 * artifacts carry the dev experience (dev menu, assertions,
 * RN_DEBUG_STRING_CONVERTIBLE), release strips it. Both flavor slots are
 * downloaded at `spm add`, so this never touches the network.
 *
 * Idempotent (rsync -a --delete → no-op when identical) and best-effort:
 * missing framework/slot/dest is skipped, never fatal.
 */
function swapFlavorFrameworks(
  opts /*: {
    appRoot: string,
    configuration: ?string,
    builtProductsDir: ?string,
    platformName: ?string,
    isMacCatalyst?: boolean,
    logger?: {log: (msg: string) => void},
  } */,
) /*: void */ {
  const {
    appRoot,
    configuration,
    builtProductsDir,
    platformName,
    isMacCatalyst = false,
    logger = {log() {}},
  } = opts;
  if (builtProductsDir == null || !fs.existsSync(builtProductsDir)) {
    return; // Pre-action / no products dir yet — nothing copied to swap.
  }
  const flavor = configuration === 'Release' ? 'release' : 'debug';
  const link = path.join(appRoot, 'build', 'xcframeworks', 'React.xcframework');
  let linkTarget /*: string */;
  try {
    // ONE level only (readlink, not realpath): the app symlink points at
    // <cache>/<version>/<resolved-flavor>/React.xcframework — the cache slot,
    // which holds all five artifacts. Fully canonicalizing would follow the
    // artifact's own internal symlinks out of the slot (e.g. a locally-built
    // React.xcframework symlinked into the slot), landing somewhere that only
    // has a subset (core, not deps/hermes) and silently under-swapping.
    linkTarget = path.resolve(path.dirname(link), fs.readlinkSync(link));
  } catch {
    return; // Not an SPM-set-up app (no symlink).
  }
  const slot = path.join(path.dirname(path.dirname(linkTarget)), flavor);
  if (!fs.existsSync(slot)) {
    logger.log(
      `swap-flavor: ${flavor} slot missing (${slot}). Re-run \`npx react-native spm add\` — it downloads both flavors.`,
    );
    return;
  }
  const pkgFrameworks = path.join(builtProductsDir, 'PackageFrameworks');
  if (process.env.RN_SPM_SWAP_DEBUG === '1') {
    logger.log(`swap-flavor[debug]: linkTarget=${linkTarget}`);
    logger.log(
      `swap-flavor[debug]: slot=${slot} exists=${String(fs.existsSync(slot))}`,
    );
    for (const n of FLAVORED_XCFRAMEWORKS) {
      const x = path.join(slot, `${n}.xcframework`);
      const sid = fs.existsSync(x)
        ? matchSlice(x, platformName, isMacCatalyst)
        : '(no-xcfw)';
      logger.log(
        `swap-flavor[debug]:   ${n}: xcfw=${String(fs.existsSync(x))} slice=${sid ?? '(none)'}`,
      );
    }
    logger.log(`swap-flavor[debug]: BUILT_PRODUCTS_DIR=${builtProductsDir}`);
    logger.log(
      `swap-flavor[debug]: PackageFrameworks exists=${String(fs.existsSync(pkgFrameworks))}`,
    );
    try {
      const found = execFileSync('/usr/bin/find', [
        builtProductsDir,
        '-maxdepth',
        '4',
        '-name',
        '*.framework',
      ])
        .toString()
        .trim();
      logger.log(`swap-flavor[debug]: frameworks under products:\n${found}`);
    } catch (e) {
      logger.log(`swap-flavor[debug]: find failed: ${e.message}`);
    }
  }
  let swapped = 0;
  for (const name of FLAVORED_XCFRAMEWORKS) {
    const xcfw = path.join(slot, `${name}.xcframework`);
    if (!fs.existsSync(xcfw)) {
      continue;
    }
    const sliceId = matchSlice(xcfw, platformName, isMacCatalyst);
    if (sliceId == null) {
      continue;
    }
    const sliceDir = path.join(xcfw, sliceId);
    const fwName = fs.readdirSync(sliceDir).find(e => e.endsWith('.framework'));
    if (fwName == null) {
      continue;
    }
    // SPM copies a binaryTarget's framework to BUILT_PRODUCTS_DIR/<F>.framework
    // (top level); source-built package products land in PackageFrameworks/.
    // Overwrite it wherever it exists (both, to be safe) — this is the copy the
    // Link and Embed steps consume. Skip when absent (static linkage / other
    // slice). rsync -a --delete is idempotent (no-op when already this flavor).
    const src = path.join(sliceDir, fwName);
    for (const destDir of [builtProductsDir, pkgFrameworks]) {
      const dest = path.join(destDir, fwName);
      if (!fs.existsSync(dest)) {
        continue;
      }
      execFileSync('rsync', [
        '-a',
        '--delete',
        src + path.sep,
        dest + path.sep,
      ]);
      swapped++;
    }
  }
  logger.log(
    `swap-flavor: ${flavor} — swapped ${swapped} framework(s) in PackageFrameworks`,
  );
}

module.exports = {
  swapFlavorFrameworks,
  matchSlice,
  FLAVORED_XCFRAMEWORKS,
};
