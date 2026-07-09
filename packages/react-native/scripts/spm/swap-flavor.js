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
 * Aligns the SPM binaryTargets' flavor with `configuration`. SwiftPM
 * binaryTargets can't branch on the build configuration, so a Debug build must
 * not embed the release React (and vice-versa) — RN's debug artifacts carry the
 * dev experience (dev menu, assertions, RN_DEBUG_STRING_CONVERTIBLE), release
 * strips it. Both flavor slots are downloaded at `spm add`, so this never
 * touches the network.
 *
 * The swap has TWO parts, run from two places, because Xcode captures the
 * binaryTarget's EMBED source when it constructs the build graph — BEFORE any
 * in-target build phase runs:
 *
 *   1. SYMLINK REPOINT (primary) — repoints the app-local slot symlink
 *      `build/xcframeworks/<F>.xcframework` (created by generate-spm-package.js
 *      `linkOne`) at the desired-flavor slot. Xcode's implicit "Embed" copies
 *      with `builtin-copy -resolve-src-symlinks` straight from that symlink and
 *      locks in the resolved path at build-graph-construction time, so the
 *      repoint MUST run in the scheme PRE-ACTION (which fires before graph
 *      construction, with $CONFIGURATION set but BUILT_PRODUCTS_DIR not yet
 *      populated) — an in-target-phase repoint is too late; the embed already
 *      copied the graph-time flavor. This half needs only appRoot +
 *      configuration + the slot symlinks, so it runs even with no products dir.
 *   2. MATERIALIZED-COPY rsync (in-target correction) — once SPM has copied the
 *      framework into `<builtProductsDir>/<F>.framework` and
 *      `.../PackageFrameworks/<F>.framework`, overwrite those copies (which the
 *      LINK step consumes) with the desired-flavor slices. Gated on
 *      BUILT_PRODUCTS_DIR existing; skipped in the pre-action / clean build.
 *
 * The desired flavor is derived purely from $CONFIGURATION (Release → release,
 * everything else → debug); the currently-pinned flavor is read from the slot
 * symlink's parent-dir segment (`.../<version>/<flavor>/<F>.xcframework`). There
 * is no persisted marker (unlike the CocoaPods React-Core-prebuilt swap's
 * `.last_build_configuration`): this runs on every build and the symlink target
 * is itself the source of truth for the pinned flavor.
 *
 * Both parts run in ONE loop over normalized `{name, link, flavors}` entries:
 *   - RN builtins (React / ReactNativeDependencies / hermes-engine): the flavor
 *     paths are derived from the app-local slot symlink (`build/xcframeworks/`).
 *   - Autolinking-plugin artifacts (Expo & co.): read from the sync-written
 *     sidecar `build/generated/autolinking/.spm-plugin-flavored-artifacts.json`.
 *     The plugin OWNS its link (creates it at sync time); RN only ever repoints
 *     it, never creates or deletes it. Because the repoint runs in the scheme
 *     pre-action, plugin artifacts inherit the same graph-time embed correctness
 *     as RN's own — no separate plugin-side swap script needed.
 *
 * Idempotent (matched flavor → symlink untouched, rsync -a --delete → no-op) and
 * best-effort: a missing framework/slot/dest is skipped, never fatal.
 */
function swapFlavorFrameworks(
  opts /*: {
    appRoot: string,
    configuration: ?string,
    builtProductsDir: ?string,
    platformName: ?string,
    isMacCatalyst?: boolean,
    // The embedded copy inside the built .app bundle
    // (<targetBuildDir>/<frameworksFolderPath>/<F>.framework) — the ONLY copy
    // the running app loads. Xcode's implicit SPM Embed runs before our appended
    // in-target phase, so correcting this post-embed copy is the deterministic
    // same-build fix (the symlink repoint is best-effort defense-in-depth that
    // races graph construction). codeSigningAllowed / expandedCodeSignIdentity
    // drive the re-sign, mirroring CocoaPods' `[CP] Embed Pods Frameworks`.
    targetBuildDir?: ?string,
    frameworksFolderPath?: ?string,
    codeSigningAllowed?: ?string,
    expandedCodeSignIdentity?: ?string,
    logger?: {log: (msg: string) => void},
  } */,
) /*: void */ {
  const {
    appRoot,
    configuration,
    builtProductsDir,
    platformName,
    isMacCatalyst = false,
    targetBuildDir,
    frameworksFolderPath,
    codeSigningAllowed,
    expandedCodeSignIdentity,
    logger = {log() {}},
  } = opts;
  // Discover the desired flavor + cache slot from the app-local symlinks. This
  // needs only appRoot + configuration, so it runs BEFORE the products-dir gate:
  // the scheme pre-action (which fires before Xcode builds the graph and locks
  // in the embed source) has no BUILT_PRODUCTS_DIR yet but MUST still repoint.
  const flavor = configuration === 'Release' ? 'release' : 'debug';
  const reactLink = path.join(
    appRoot,
    'build',
    'xcframeworks',
    'React.xcframework',
  );
  let linkTarget /*: string */;
  try {
    // ONE level only (readlink, not realpath): the app symlink points at
    // <cache>/<version>/<resolved-flavor>/React.xcframework — the cache slot,
    // which holds all five artifacts. Fully canonicalizing would follow the
    // artifact's own internal symlinks out of the slot (e.g. a locally-built
    // React.xcframework symlinked into the slot), landing somewhere that only
    // has a subset (core, not deps/hermes) and silently under-swapping.
    linkTarget = path.resolve(
      path.dirname(reactLink),
      fs.readlinkSync(reactLink),
    );
  } catch {
    return; // Not an SPM-set-up app (no symlink).
  }
  const versionDir = path.dirname(path.dirname(linkTarget));
  const slot = path.join(versionDir, flavor);
  // The rsync (LINK-step correction) only applies once SPM has materialized the
  // frameworks into BUILT_PRODUCTS_DIR. On a clean build / in the pre-action that
  // dir does not exist yet — the repoint still runs, the rsync is skipped.
  const hasProducts =
    builtProductsDir != null && fs.existsSync(builtProductsDir);
  const pkgFrameworks =
    builtProductsDir != null
      ? path.join(builtProductsDir, 'PackageFrameworks')
      : null;
  // The frameworks folder INSIDE the built .app bundle. Present only in the
  // in-target build phase (the appended "Fix SPM Embedded Flavor" phase, which
  // runs AFTER Xcode's implicit SPM Embed), never in the scheme pre-action.
  const embeddedFrameworksDir =
    targetBuildDir != null && frameworksFolderPath != null
      ? path.join(targetBuildDir, frameworksFolderPath)
      : null;
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
    logger.log(
      `swap-flavor[debug]: BUILT_PRODUCTS_DIR=${builtProductsDir ?? '(unset — pre-action)'}`,
    );
    if (hasProducts && builtProductsDir != null && pkgFrameworks != null) {
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
  }

  // Normalize every flavored artifact into one shape: {name, link, flavors,
  // isBuiltin}. RN builtins derive their flavor paths from the cache slot (skip
  // entirely when the whole desired slot is missing — the pre-existing warning);
  // plugin artifacts come from the sync-written sidecar (absent → none).
  const entries /*: Array<{
    name: string,
    link: string,
    flavors: {debug?: string, release?: string},
    isBuiltin: boolean,
  }> */ = [];
  if (fs.existsSync(slot)) {
    for (const name of FLAVORED_XCFRAMEWORKS) {
      entries.push({
        name,
        link: path.join(
          appRoot,
          'build',
          'xcframeworks',
          `${name}.xcframework`,
        ),
        flavors: {
          debug: path.join(versionDir, 'debug', `${name}.xcframework`),
          release: path.join(versionDir, 'release', `${name}.xcframework`),
        },
        isBuiltin: true,
      });
    }
  } else {
    logger.log(
      `swap-flavor: ${flavor} slot missing (${slot}). Re-run \`npx react-native spm add\` — it downloads both flavors.`,
    );
  }
  for (const a of readPluginFlavoredArtifacts(appRoot)) {
    entries.push({
      name: a.name,
      link: a.link,
      flavors: a.flavors,
      isBuiltin: false,
    });
  }

  let repointed = 0;
  let pluginRepointed = 0;
  let swapped = 0;
  let pluginSwapped = 0;
  const otherFlavor = flavor === 'release' ? 'debug' : 'release';
  for (const {name, link, flavors, isBuiltin} of entries) {
    const desired = flavors[flavor];

    // Read the current link state once.
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(link).isSymbolicLink();
    } catch {
      /* link absent */
    }
    let rawTarget /*: ?string */ = null;
    let resolvedCurrent /*: ?string */ = null;
    if (isSymlink) {
      try {
        rawTarget = fs.readlinkSync(link);
        resolvedCurrent = path.resolve(path.dirname(link), rawTarget);
      } catch {
        /* unreadable — treat as no current target */
      }
    }

    // (a) REPOINT — the embed-step fix. Xcode's implicit Embed resolves the
    // link at build-graph-construction time, so this is the part the pre-action
    // must win the race on.
    if (!isSymlink) {
      // A builtin with no symlink is static-linked / not SPM-managed (nothing to
      // repoint — keep the pre-existing silent behavior; the products copy below
      // still runs and is a safe no-op via its per-dest existsSync guard); a
      // plugin's link is missing even though it declared it (the plugin owns
      // creation — warn, don't try to create it).
      if (!isBuiltin) {
        logger.log(
          `swap-flavor: ${name}: no plugin-owned symlink at ${link} — skipping (the plugin creates it at sync time).`,
        );
      }
    } else if (desired == null || !fs.existsSync(desired)) {
      // Requested flavor unavailable. Builtins stay silent (a slot may
      // legitimately not carry every artifact — unchanged behavior); a plugin
      // explicitly declared it, so warn — and if the link is pinned to the OTHER
      // flavor it's a certain wrong-flavor embed, so mirror the shell-side
      // pinned-flavor `error:` line for Xcode to surface.
      if (!isBuiltin) {
        logger.log(
          `swap-flavor: ${name}: ${flavor} flavor not built — expected ${desired ?? '(not declared)'}`,
        );
        const resolvedOther =
          flavors[otherFlavor] != null
            ? path.resolve(flavors[otherFlavor])
            : null;
        if (
          resolvedCurrent != null &&
          resolvedOther != null &&
          resolvedCurrent === resolvedOther
        ) {
          logger.log(
            `error: swap-flavor: ${name} is pinned to the ${otherFlavor} flavor but this build needs ${flavor}, and the ${flavor} artifact is not built — the app would embed the wrong flavor. Build the ${flavor} artifact and rebuild.`,
          );
        }
      }
    } else {
      // desired exists on disk. Builtins: swap only the <flavor> path segment of
      // the link's OWN target, preserving relative-vs-absolute form and staying
      // in that link's cache dir. Plugins: the declared absolute path.
      const desiredTarget =
        isBuiltin && rawTarget != null
          ? path.join(
              path.dirname(path.dirname(rawTarget)),
              flavor,
              path.basename(rawTarget),
            )
          : desired;
      const resolvedDesired = path.resolve(path.dirname(link), desiredTarget);
      if (resolvedCurrent !== resolvedDesired) {
        // Never replace a valid pin with a dangling one — the builtin swap may
        // point at a different cache dir that lacks this flavor.
        if (!fs.existsSync(resolvedDesired)) {
          logger.log(
            `swap-flavor: ${flavor} slot missing for ${name} (${resolvedDesired}) — leaving its pin unchanged.`,
          );
        } else {
          fs.unlinkSync(link);
          fs.symlinkSync(desiredTarget, link);
          repointed++;
          if (!isBuiltin) {
            pluginRepointed++;
          }
        }
      }
    }

    // (b) COPY the desired-flavor slice over every already-materialized copy:
    //   - BUILT_PRODUCTS_DIR / PackageFrameworks — the Link-step copies.
    //   - <targetBuildDir>/<frameworksFolderPath> — the EMBEDDED copy inside the
    //     .app bundle, the one the running app actually loads. Correcting it
    //     post-embed (in the appended phase) is the deterministic same-build fix;
    //     a changed embedded framework is re-codesigned like CocoaPods does.
    // Each copy is only touched when it already exists. rsync -a --delete is
    // idempotent (no-op when already the right flavor).
    if (desired != null && fs.existsSync(desired)) {
      const sliceId = matchSlice(desired, platformName, isMacCatalyst);
      if (sliceId != null) {
        const sliceDir = path.join(desired, sliceId);
        const fwName = fs
          .readdirSync(sliceDir)
          .find(e => e.endsWith('.framework'));
        if (fwName != null) {
          const src = path.join(sliceDir, fwName);
          const dests /*: Array<{dir: string, embedded: boolean}> */ = [];
          if (
            hasProducts &&
            builtProductsDir != null &&
            pkgFrameworks != null
          ) {
            dests.push({dir: builtProductsDir, embedded: false});
            dests.push({dir: pkgFrameworks, embedded: false});
          }
          if (embeddedFrameworksDir != null) {
            dests.push({dir: embeddedFrameworksDir, embedded: true});
          }
          let copiedAny = false;
          for (const {dir, embedded} of dests) {
            const dest = path.join(dir, fwName);
            if (!fs.existsSync(dest)) {
              continue;
            }
            execFileSync('rsync', [
              '-a',
              '--delete',
              src + path.sep,
              dest + path.sep,
            ]);
            copiedAny = true;
            if (embedded) {
              // Re-sign unconditionally after any rsync to the embedded copy —
              // re-signing an unchanged framework is harmless, and it avoids a
              // fragile before/after content diff.
              codesignFramework(dest, {
                codeSigningAllowed,
                expandedCodeSignIdentity,
                logger,
              });
            }
          }
          // Count once per artifact that had at least one copy corrected (not
          // once per destination dir).
          if (copiedAny) {
            swapped++;
            if (!isBuiltin) {
              pluginSwapped++;
            }
          }
        }
      }
    }
  }
  logger.log(
    hasProducts
      ? `swap-flavor: ${flavor} — repointed ${repointed} slot symlink(s) (${pluginRepointed} plugin), swapped ${swapped} framework copy/copies (${pluginSwapped} plugin)`
      : `swap-flavor: ${flavor} — repointed ${repointed} slot symlink(s) (${pluginRepointed} plugin) (no products dir yet — pre-action)`,
  );
}

/**
 * Re-codesign an embedded framework after its binary was swapped, mirroring
 * CocoaPods' `[CP] Embed Pods Frameworks` phase. Skipped entirely when Xcode
 * disabled signing for this build (CODE_SIGNING_ALLOWED=NO). The identity
 * defaults to '-' (ad-hoc) — correct for the simulator, where
 * EXPANDED_CODE_SIGN_IDENTITY is unset. Best-effort: a codesign failure is
 * logged and swallowed (the caller contract is never-throw).
 */
function codesignFramework(
  frameworkPath /*: string */,
  opts /*: {
    codeSigningAllowed: ?string,
    expandedCodeSignIdentity: ?string,
    logger: {log: (msg: string) => void},
  } */,
) /*: void */ {
  const {codeSigningAllowed, expandedCodeSignIdentity, logger} = opts;
  if (codeSigningAllowed === 'NO') {
    return;
  }
  const identity =
    expandedCodeSignIdentity != null && expandedCodeSignIdentity.length > 0
      ? expandedCodeSignIdentity
      : '-';
  try {
    execFileSync('codesign', [
      '--force',
      '--preserve-metadata=identifier,entitlements,flags',
      '--sign',
      identity,
      frameworkPath,
    ]);
  } catch (e) {
    logger.log(
      `swap-flavor: codesign failed for ${frameworkPath} (${e.message}) — continuing.`,
    );
  }
}

/**
 * Plugin-declared flavored artifacts recorded by generate-spm-autolinking at
 * sync time (`<appRoot>/build/generated/autolinking/.spm-plugin-flavored-artifacts.json`).
 * Absent / unparseable / not-an-array → [] (sync may never have run — never
 * fatal). Each entry is shape-checked defensively even though the writer
 * validates, so a hand-edited or partial file can't throw here.
 */
function readPluginFlavoredArtifacts(
  appRoot /*: string */,
) /*: Array<{name: string, link: string, flavors: {debug?: string, release?: string}}> */ {
  const sidecar = path.join(
    appRoot,
    'build',
    'generated',
    'autolinking',
    '.spm-plugin-flavored-artifacts.json',
  );
  let parsed /*: $FlowFixMe */;
  try {
    parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out = [];
  for (const e of parsed) {
    if (
      e == null ||
      typeof e !== 'object' ||
      typeof e.name !== 'string' ||
      typeof e.link !== 'string' ||
      e.flavors == null ||
      typeof e.flavors !== 'object'
    ) {
      continue;
    }
    const flavors /*: {debug?: string, release?: string} */ = {};
    if (typeof e.flavors.debug === 'string') {
      flavors.debug = e.flavors.debug;
    }
    if (typeof e.flavors.release === 'string') {
      flavors.release = e.flavors.release;
    }
    out.push({name: e.name, link: e.link, flavors});
  }
  return out;
}

module.exports = {
  swapFlavorFrameworks,
  matchSlice,
  FLAVORED_XCFRAMEWORKS,
};
