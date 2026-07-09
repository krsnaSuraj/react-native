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
  addPreActionToScheme,
  buildEmbeddedFixScript,
  buildSyncAutolinkingScript,
  generateXcscheme,
} = require('../generate-spm-xcodeproj');

// ---------------------------------------------------------------------------
// generateXcscheme — pre-action for SPM autolinking sync
//
// Without the pre-action, our sync ran as a build phase AFTER Xcode's
// "Resolve Package Dependencies" step. Adding a dep then required two
// builds to take effect — the first build re-resolved against the old
// graph, the second saw the just-regenerated Package.swift. Moving the
// sync to a scheme PreAction makes it run BEFORE resolution.
// ---------------------------------------------------------------------------

describe('generateXcscheme', () => {
  const SYNC_SENTINEL = 'SYNC_SCRIPT_SENTINEL_MARKER';

  it('emits a PreActions block containing the sync script', () => {
    const result = generateXcscheme(
      'MyApp',
      'TARGET_UUID',
      'MyApp',
      SYNC_SENTINEL,
    );
    expect(result).toContain('<PreActions>');
    expect(result).toContain('</PreActions>');
    expect(result).toContain('Sync SPM Autolinking');
    expect(result).toContain(SYNC_SENTINEL);
  });

  it('pre-action references the target via EnvironmentBuildable so env vars inherit', () => {
    const result = generateXcscheme(
      'MyApp',
      'TARGET_UUID',
      'MyApp',
      SYNC_SENTINEL,
    );
    expect(result).toContain('<EnvironmentBuildable>');
    // The buildable inside EnvironmentBuildable must point at the same target
    // as the main BuildableReference, so SRCROOT / PROJECT_DIR / etc. resolve.
    const envBlock = result.slice(
      result.indexOf('<EnvironmentBuildable>'),
      result.indexOf('</EnvironmentBuildable>'),
    );
    expect(envBlock).toContain('BlueprintIdentifier = "TARGET_UUID"');
    expect(envBlock).toContain('BuildableName = "MyApp.app"');
    expect(envBlock).toContain('BlueprintName = "MyApp"');
  });

  it('XML-escapes shell-meta characters inside scriptText', () => {
    // Shell scripts have `>` (redirection), `&` (bg/and), `<` (heredoc); all
    // are XML special chars. Without escaping, the scheme XML is malformed
    // and Xcode silently ignores the pre-action — which would mask the very
    // bug we're fixing.
    const script =
      'echo "x" > /tmp/foo 2>&1; while read L; do :; done < /tmp/in';
    const result = generateXcscheme('MyApp', 'TARGET_UUID', 'MyApp', script);
    expect(result).toContain('&gt;');
    expect(result).toContain('&amp;');
    expect(result).toContain('&lt;');
    // Raw `>` inside the scriptText attribute breaks the XML parser.
    // (Outside attributes, > is technically legal, so just assert the
    // problematic substring doesn't appear: the actual script text after
    // scriptText=" must not contain raw >, &, < before its closing quote.)
    const attrStart = result.indexOf('scriptText = "');
    const attrEnd = result.indexOf('"', attrStart + 'scriptText = "'.length);
    const attrValue = result.slice(
      attrStart + 'scriptText = "'.length,
      attrEnd,
    );
    expect(attrValue).not.toMatch(/[<>&](?!(amp|lt|gt|quot|apos);)/);
  });
});

// ---------------------------------------------------------------------------
// addPreActionToScheme — the marker-tracked pre-action must refresh its
// scriptText on re-injection instead of freezing it at whatever it was on
// first run (Expo hit this in production: the pre-action kept stale dispatch
// logic forever because the guard only checked for the title's presence).
// ---------------------------------------------------------------------------

describe('addPreActionToScheme', () => {
  it('refreshes a stale scriptText on re-injection', () => {
    const first = generateXcscheme(
      'MyApp',
      'TARGET_UUID',
      'MyApp',
      'OLD_SCRIPT',
    );
    const updated = addPreActionToScheme(first, 'TARGET_UUID', 'NEW_SCRIPT');
    expect(updated).toContain('NEW_SCRIPT');
    expect(updated).not.toContain('OLD_SCRIPT');
    // Only the scriptText attribute changed — everything else (title,
    // EnvironmentBuildable, structure) stays put.
    expect(updated).toContain('title = "Sync SPM Autolinking"');
    expect(updated).toContain('<EnvironmentBuildable>');
  });

  it('is byte-identical when the script is unchanged', () => {
    const first = generateXcscheme(
      'MyApp',
      'TARGET_UUID',
      'MyApp',
      'SAME_SCRIPT',
    );
    const second = addPreActionToScheme(first, 'TARGET_UUID', 'SAME_SCRIPT');
    expect(second).toBe(first);
  });

  it('safely refreshes a script containing $-sequences without misinterpreting them', () => {
    // A naive String.replace(regex, escaped) would treat `$1`/`$&` inside the
    // replacement string as backreferences and corrupt the output — the
    // refresh must splice by index instead.
    const first = generateXcscheme(
      'MyApp',
      'TARGET_UUID',
      'MyApp',
      'OLD_SCRIPT',
    );
    const trickyScript = 'echo "$1 $& $$HOME ${NODE_BINARY}"';
    const updated = addPreActionToScheme(first, 'TARGET_UUID', trickyScript);
    const attrStart = updated.indexOf('scriptText = "');
    const attrEnd = updated.indexOf('"', attrStart + 'scriptText = "'.length);
    const attrValue = updated.slice(
      attrStart + 'scriptText = "'.length,
      attrEnd,
    );
    expect(attrValue).toBe('echo &quot;$1 $&amp; $$HOME ${NODE_BINARY}&quot;');
  });

  it('adds a fresh pre-action when none exists yet (unchanged behavior)', () => {
    const xmlWithoutPreAction = generateXcscheme(
      'MyApp',
      'TARGET_UUID',
      'MyApp',
      'X',
    ).replace(/<PreActions>[\s\S]*?<\/PreActions>\n\s*/, '');
    expect(xmlWithoutPreAction).not.toContain('Sync SPM Autolinking');
    const updated = addPreActionToScheme(
      xmlWithoutPreAction,
      'TARGET_UUID',
      'FRESH_SCRIPT',
    );
    expect(updated).toContain('Sync SPM Autolinking');
    expect(updated).toContain('FRESH_SCRIPT');
  });
});

// ---------------------------------------------------------------------------
// buildSyncAutolinkingScript — the generated "Sync SPM Autolinking" build
// phase / pre-action shell. It must be dependency-free (no `npx react-native`,
// which needs @react-native-community/cli — absent in e.g. Expo apps) and
// resolve node + react-native at BUILD time.
// ---------------------------------------------------------------------------
describe('buildSyncAutolinkingScript', () => {
  const BAKED = '../node_modules/react-native';
  const script = buildSyncAutolinkingScript(BAKED);

  it('resolves node from NODE_BINARY / .xcode.env / command -v node', () => {
    expect(script).toContain('NODE_BINARY="${NODE_BINARY:-}"');
    expect(script).toContain('. "$SRCROOT/.xcode.env"');
    expect(script).toContain('. "$SRCROOT/.xcode.env.local"');
    expect(script).toContain('NODE_BINARY="$(command -v node 2>/dev/null');
  });

  it('resolves the react-native dir at build time via require.resolve', () => {
    expect(script).toContain(
      "require('path').dirname(require.resolve('react-native/package.json'))",
    );
    // Falls back to the baked generation-time path if resolution fails.
    expect(script).toContain(`RN_DIR="${BAKED}"`);
  });

  it('dispatches swap-flavor DIRECTLY into setup-apple-spm.js (no npx)', () => {
    expect(script).toContain(
      '"$NODE_BINARY" "$RN_DIR/scripts/setup-apple-spm.js" swap-flavor',
    );
    // The old npx-based swap DISPATCH must be gone (the string may still appear
    // inside the actionable error hint, so match the invocation form).
    expect(script).not.toContain('&& npx react-native spm swap-flavor )');
  });

  it('short-circuits the swap when BUILT_PRODUCTS_DIR is unset (inside run_swap_flavor)', () => {
    expect(script).toContain('if [ -z "${BUILT_PRODUCTS_DIR:-}" ]; then');
  });

  it('defines run_swap_flavor once and calls it TWICE, sandwiching the sync', () => {
    // Swap sandwich: leading call = race-winning pre-action repoint (before the
    // sync); trailing call = authoritative end-state after sync's linkOne re-pin.
    expect(script).toContain('run_swap_flavor() {');
    expect(script.match(/run_swap_flavor\(\) \{/g)).toHaveLength(1);
    // Two bare invocations (not the definition).
    const calls = [...script.matchAll(/\nrun_swap_flavor\n/g)];
    expect(calls).toHaveLength(2);
    const syncIdx = script.indexOf(
      '"$NODE_BINARY" "$RN_DIR/scripts/setup-apple-spm.js" sync',
    );
    expect(syncIdx).toBeGreaterThan(-1);
    expect(calls[0].index).toBeLessThan(syncIdx); // leading swap before sync
    expect(calls[1].index).toBeGreaterThan(syncIdx); // trailing swap after sync
  });

  it('ties the loud-error mismatch fallback to the FINAL (trailing) swap', () => {
    const lastCall = script.lastIndexOf('\nrun_swap_flavor\n');
    const fallbackIdx = script.indexOf('if [ "$SWAP_OK" -eq 0 ]; then');
    expect(lastCall).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(lastCall);
  });

  it('does not early-exit before the swap when sync inputs are unchanged', () => {
    // A config flip (Debug<->Release) changes no sync input, so the not-stale
    // path must still fall through to the swap rather than `exit 0`.
    expect(script).toContain('if [ "$STALE" -eq 1 ]; then');
    // The old unconditional "not stale -> exit 0" short-circuit is gone.
    expect(script).not.toContain('if [ "$STALE" -eq 0 ]; then\n  exit 0');
  });

  it('hard-fails (error + exit 1) when the pinned flavor mismatches config', () => {
    // The loud, build-breaking branch: a certain Debug<->release mix.
    expect(script).toContain(
      'readlink "$SRCROOT/build/xcframeworks/React.xcframework"',
    );
    expect(script).toContain('echo "error: SwiftPM flavor swap could not run');
    expect(script).toContain("Debug builds: 'No script URL provided'");
    // The mismatch branch exits 1; the match/indeterminate branch only warns.
    const errIdx = script.indexOf('echo "error: SwiftPM flavor swap');
    expect(script.indexOf('exit 1', errIdx)).toBeGreaterThan(errIdx);
    expect(script).toContain(
      'echo "warning: SwiftPM flavor swap could not run',
    );
  });

  it('mirrors swap-flavor.js flavor mapping (Release->release, else debug)', () => {
    expect(script).toContain('DESIRED_FLAVOR=debug');
    expect(script).toContain('if [ "${CONFIGURATION:-}" = "Release" ]; then');
    expect(script).toContain('DESIRED_FLAVOR=release');
    // Case-insensitive match of the pinned symlink's flavor path component.
    expect(script).toContain("tr '[:upper:]' '[:lower:]'");
    expect(script).toContain('debug) PINNED_FLAVOR=debug ;;');
    expect(script).toContain('release) PINNED_FLAVOR=release ;;');
  });

  it('dispatches sync directly, with an npx fallback retained', () => {
    expect(script).toContain(
      '"$NODE_BINARY" "$RN_DIR/scripts/setup-apple-spm.js" sync',
    );
    // npx fallback for environments without a resolved node/RN dir.
    expect(script).toContain('npx react-native spm sync');
  });

  it('sources with-environment.sh from the build-time RN dir', () => {
    expect(script).toContain(
      'WITH_ENVIRONMENT="$RN_DIR/scripts/xcode/with-environment.sh"',
    );
  });

  it('preserves the sync exit-code semantics (2 = fail, other = warn)', () => {
    expect(script).toContain('if [ "$RC" -eq 2 ]; then');
    expect(script).toContain('exit 1');
    expect(script).toContain('elif [ "$RC" -ne 0 ]; then');
    expect(script).toContain(
      'echo "warning: SPM sync failed — build may use stale codegen/autolinking"',
    );
  });

  it('is POSIX-sh clean: no bashisms ([[ ) in the generated script', () => {
    expect(script).not.toContain('[[');
  });

  it('is deterministic — the build phase and scheme pre-action get the same single script', () => {
    // injectSpmPackages builds the phase with buildSyncAutolinkingScript(rnPath)
    // and the scheme pre-action with the same call; a pure, deterministic result
    // guarantees both embed byte-identical text.
    expect(buildSyncAutolinkingScript(BAKED)).toBe(
      buildSyncAutolinkingScript(BAKED),
    );
  });
});

// ---------------------------------------------------------------------------
// buildEmbeddedFixScript — the appended in-target phase that runs AFTER Xcode's
// implicit SPM Embed to deterministically correct the embedded framework flavor.
// ---------------------------------------------------------------------------
describe('buildEmbeddedFixScript', () => {
  const BAKED = '../node_modules/react-native';
  const script = buildEmbeddedFixScript(BAKED);

  it('shares the node/RN_DIR resolution preamble with the sync script', () => {
    expect(script).toContain('NODE_BINARY="${NODE_BINARY:-}"');
    expect(script).toContain(
      "require('path').dirname(require.resolve('react-native/package.json'))",
    );
    expect(script).toContain(`RN_DIR="${BAKED}"`);
  });

  it('dispatches swap-flavor directly (no npx) and is a single dispatch (no sync, no sandwich)', () => {
    expect(script).toContain(
      '"$NODE_BINARY" "$RN_DIR/scripts/setup-apple-spm.js" swap-flavor',
    );
    // Exactly one swap dispatch; NOT the sync-phase machinery.
    expect(script.match(/setup-apple-spm\.js" swap-flavor/g)).toHaveLength(1);
    expect(script).not.toContain('swap-flavor" sync');
    expect(script).not.toContain('run_swap_flavor');
    expect(script).not.toContain('"$STALE"');
  });

  it('soft-fails (warns, no exit 1) so it never hard-breaks the build alone', () => {
    expect(script).toContain('warning: SPM embedded-flavor fix could not run');
    expect(script).not.toContain('exit 1');
  });

  it('is POSIX-sh clean (no bashisms)', () => {
    expect(script).not.toContain('[[');
  });
});
