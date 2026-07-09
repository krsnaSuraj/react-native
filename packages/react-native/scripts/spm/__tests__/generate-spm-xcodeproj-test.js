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

  it('gates the swap block on BUILT_PRODUCTS_DIR (scheme pre-action no-op)', () => {
    expect(script).toContain('if [ -n "${BUILT_PRODUCTS_DIR:-}" ]; then');
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
});
