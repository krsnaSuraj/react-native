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
  buildSchemePreActionScript,
  buildSyncAutolinkingScript,
  generateXcscheme,
} = require('../generate-spm-xcodeproj');
const {execFileSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

  it('watches mixed dirs and files, treating a vanished path as stale', () => {
    // Dir branch: -newer catches add/remove of source children.
    expect(script).toContain('if [ -d "$P" ]; then');
    expect(script).toContain(
      'if [ -n "$(find "$P" -newer "$STAMP" -print -quit 2>/dev/null)" ]; then',
    );
    // File branch: a dep manifest / plugin file edit does not bump any dir mtime.
    expect(script).toContain('elif [ -f "$P" ]; then');
    expect(script).toContain('if [ "$P" -nt "$STAMP" ]; then');
    // Vanish branch: neither dir nor file → forced re-sync (real error surfaces).
    expect(script).toContain('else\n      STALE=1\n      break\n    fi');
    // Reads the same mixed watch file the autolinker emits.
    expect(script).toContain(
      'WATCH_FILE="$SRCROOT/build/generated/autolinking/.spm-sync-watch-paths"',
    );
  });

  it('is POSIX-sh clean: no bashisms ([[ ) in the generated script', () => {
    expect(script).not.toContain('[[');
  });

  it('is deterministic (pure) — repeated calls are byte-identical', () => {
    expect(buildSyncAutolinkingScript(BAKED)).toBe(
      buildSyncAutolinkingScript(BAKED),
    );
  });

  it('the in-target phase and the scheme pre-action are now DIFFERENT scripts', () => {
    // The phase carries the swap sandwich; the pre-action is sync-only. A
    // pre-action swap could win its race and mask a mismatch from the in-target
    // detector (a false green), so they intentionally diverge.
    expect(buildSyncAutolinkingScript(BAKED)).not.toBe(
      buildSchemePreActionScript(BAKED),
    );
  });
});

// ---------------------------------------------------------------------------
// Behavioral: drive the EXACT generated watch-paths stale loop under /bin/sh
// against fabricated STAMP + watch file fixtures. Uses fs.utimesSync for
// deterministic mtimes (no sleeps). `find`, `[ -d ]`, `[ -nt ]` are real — no
// mocking needed for this pure-shell region.
// ---------------------------------------------------------------------------
describe('buildSyncAutolinkingScript watch-paths stale loop (behavioral)', () => {
  const script = buildSyncAutolinkingScript('../node_modules/react-native');

  // Extract the real generated loop so the test can never drift from the source.
  const loopStart = script.indexOf('while IFS= read -r P; do');
  const endMarker = 'done < "$WATCH_FILE"';
  const loopEnd = script.indexOf(endMarker, loopStart) + endMarker.length;
  const staleLoop = script.slice(loopStart, loopEnd);

  const STAMP_T = 1600000000; // seconds
  const NEWER = STAMP_T + 100;
  const OLDER = STAMP_T - 100;

  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-watch-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  // Runs the extracted loop with a STAMP at STAMP_T and the given watch lines.
  function runStale(watchLines) {
    const stamp = path.join(tmp, '.spm-sync-stamp');
    fs.writeFileSync(stamp, '');
    fs.utimesSync(stamp, STAMP_T, STAMP_T);
    const watch = path.join(tmp, 'watch');
    fs.writeFileSync(watch, watchLines.join('\n') + '\n');
    const harness = [
      'set -eu',
      `STAMP="${stamp}"`,
      `WATCH_FILE="${watch}"`,
      'STALE=0',
      staleLoop,
      'echo "$STALE"',
    ].join('\n');
    return execFileSync('/bin/sh', ['-c', harness], {encoding: 'utf8'}).trim();
  }

  it('is stale when a watched FILE is newer than the stamp', () => {
    const f = path.join(tmp, 'Package.swift');
    fs.writeFileSync(f, '');
    fs.utimesSync(f, NEWER, NEWER);
    expect(runStale([f])).toBe('1');
  });

  it('is NOT stale when a watched file is older than the stamp', () => {
    const f = path.join(tmp, 'Package.swift');
    fs.writeFileSync(f, '');
    fs.utimesSync(f, OLDER, OLDER);
    expect(runStale([f])).toBe('0');
  });

  it('is stale when a watched DIR has a child newer than the stamp', () => {
    const d = path.join(tmp, 'src');
    fs.mkdirSync(d);
    const child = path.join(d, 'New.swift');
    fs.writeFileSync(child, '');
    fs.utimesSync(child, NEWER, NEWER);
    fs.utimesSync(d, NEWER, NEWER);
    expect(runStale([d])).toBe('1');
  });

  it('is NOT stale when a watched dir and all its children are older', () => {
    const d = path.join(tmp, 'src');
    fs.mkdirSync(d);
    const child = path.join(d, 'Old.swift');
    fs.writeFileSync(child, '');
    fs.utimesSync(child, OLDER, OLDER);
    fs.utimesSync(d, OLDER, OLDER);
    expect(runStale([d])).toBe('0');
  });

  it('is stale when a watched path has VANISHED (rename/move)', () => {
    expect(runStale([path.join(tmp, 'gone', 'Package.swift')])).toBe('1');
  });

  it('short-circuits on the first stale entry (mixed lines, blank tolerated)', () => {
    const fresh = path.join(tmp, 'fresh.txt');
    fs.writeFileSync(fresh, '');
    fs.utimesSync(fresh, OLDER, OLDER);
    const gone = path.join(tmp, 'gone', 'x');
    expect(runStale([fresh, '', gone])).toBe('1');
  });

  it('parses under `sh -n` (whole generated script is valid POSIX sh)', () => {
    const file = path.join(tmp, 'phase.sh');
    fs.writeFileSync(file, script);
    expect(() => execFileSync('/bin/sh', ['-n', file])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The obsolete appended "Fix SPM Embedded Flavor" phase is gone entirely — RN
// never writes the .app bundle (Xcode is its single writer).
// ---------------------------------------------------------------------------
describe('embedded-fix phase removal', () => {
  it('no longer exports buildEmbeddedFixScript', () => {
    expect(require('../generate-spm-xcodeproj').buildEmbeddedFixScript).toBe(
      undefined,
    );
  });

  it('no script references the embedded-fix phase', () => {
    const BAKED = '../node_modules/react-native';
    for (const s of [
      buildSyncAutolinkingScript(BAKED),
      buildSchemePreActionScript(BAKED),
    ]) {
      expect(s).not.toContain('Fix SPM Embedded Flavor');
      expect(s).not.toContain('SPM embedded-flavor fix could not run');
    }
  });
});

// ---------------------------------------------------------------------------
// HARD-FAIL + CONVERGE — the in-target phase runs the swap sandwich and fails
// the build ONCE at the end after correcting a mismatched start; the scheme
// PRE-ACTION is sync-only (no swap → cannot mask a mismatch = false green).
// ---------------------------------------------------------------------------
describe('buildSchemePreActionScript (sync-only)', () => {
  const script = buildSchemePreActionScript('../node_modules/react-native');

  it('does NOT dispatch or define a flavor swap', () => {
    expect(script).not.toContain('swap-flavor');
    expect(script).not.toContain('run_swap_flavor');
    expect(script).not.toContain('MISMATCH');
  });

  it('still runs the sync dispatch (its auto-heal purpose)', () => {
    expect(script).toContain(
      '"$NODE_BINARY" "$RN_DIR/scripts/setup-apple-spm.js" sync',
    );
    expect(script).toContain('if [ "$STALE" -eq 1 ]; then');
  });

  it('parses under `sh -n`', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preaction-'));
    const file = path.join(dir, 'pre.sh');
    fs.writeFileSync(file, script);
    try {
      expect(() => execFileSync('/bin/sh', ['-n', file])).not.toThrow();
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

describe('buildSyncAutolinkingScript — swap sandwich + hard-fail', () => {
  const script = buildSyncAutolinkingScript('../node_modules/react-native');

  it('runs the swap sandwich (def + leading + trailing = ≥3 run_swap_flavor uses)', () => {
    expect(
      (script.match(/run_swap_flavor/g) || []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('the LEADING swap runs BEFORE the sync dispatch (state corrected up front)', () => {
    const leading = script.indexOf('run_swap_flavor\n');
    const sync = script.indexOf('setup-apple-spm.js" sync');
    expect(leading).toBeGreaterThan(-1);
    expect(leading).toBeLessThan(sync);
  });

  it('captures the corrected-mismatch signal and defers the failure to the END', () => {
    expect(script).toContain('MISMATCH_PENDING');
    const gate = script.indexOf('if [ "$MISMATCH_PENDING" -eq 1 ]');
    expect(gate).toBeGreaterThan(-1);
    // The failure gate is AFTER the last swap (trailing) and after sync.
    expect(gate).toBeGreaterThan(script.lastIndexOf('run_swap_flavor'));
    expect(script.indexOf('setup-apple-spm.js" sync')).toBeLessThan(gate);
    expect(script.indexOf('exit 1', gate)).toBeGreaterThan(gate);
  });

  it('parses under `sh -n`', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-'));
    const file = path.join(dir, 'phase.sh');
    fs.writeFileSync(file, script);
    try {
      expect(() => execFileSync('/bin/sh', ['-n', file])).not.toThrow();
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

// A real-shell behavioral check of HARD-FAIL + CONVERGE. The stub setup-apple-spm
// is STATEFUL: swap-flavor reads a fake pin file, and only repoints + exits 1 on
// a genuine pin-vs-CONFIGURATION mismatch; sync re-pins the fake pin to debug
// (modelling generate-spm-package's default-debug links). This exercises the
// leading-vs-trailing distinction the constant-exit-code stub could not.
describe('sync script — shell behavior of HARD-FAIL + CONVERGE', () => {
  let dir, rnDir, srcroot, pinFile;

  function setup(startFlavor) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-hardfail-'));
    srcroot = path.join(dir, 'app');
    fs.mkdirSync(srcroot, {recursive: true});
    fs.writeFileSync(
      path.join(srcroot, 'package.json'),
      JSON.stringify({name: 'x'}),
    );
    pinFile = path.join(dir, 'pin');
    fs.writeFileSync(pinFile, startFlavor); // the flavor the build STARTS on
    rnDir = path.join(dir, 'rn');
    fs.mkdirSync(path.join(rnDir, 'scripts'), {recursive: true});
    fs.writeFileSync(
      path.join(rnDir, 'scripts', 'setup-apple-spm.js'),
      [
        "const fs = require('fs');",
        'const pinFile = process.env.FAKE_PIN_FILE;',
        'const a = process.argv[2];',
        // sync re-pins to the add-time (debug) flavor, like linkOne does.
        "if (a === 'sync') { fs.writeFileSync(pinFile, 'debug'); process.exit(0); }",
        "if (a === 'swap-flavor') {",
        "  const desired = process.env.CONFIGURATION === 'Release' ? 'release' : 'debug';",
        "  const pin = fs.existsSync(pinFile) ? fs.readFileSync(pinFile, 'utf8').trim() : 'debug';",
        '  if (pin !== desired) {',
        '    fs.writeFileSync(pinFile, desired);',
        "    console.log('error: corrected ' + pin + ' -> ' + desired);",
        '    process.exit(1);',
        '  }',
        '  process.exit(0);',
        '}',
        'process.exit(0);',
      ].join('\n'),
    );
    const scriptFile = path.join(dir, 'phase.sh');
    fs.writeFileSync(scriptFile, buildSyncAutolinkingScript(rnDir));
    return scriptFile;
  }

  afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

  function run(scriptFile, configuration) {
    try {
      execFileSync('/bin/sh', [scriptFile], {
        env: {
          ...process.env,
          SRCROOT: srcroot,
          BUILT_PRODUCTS_DIR: path.join(dir, 'products'),
          NODE_BINARY: process.execPath,
          CONFIGURATION: configuration,
          FAKE_PIN_FILE: pinFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      return {code: 0};
    } catch (e) {
      return {code: e.status, out: (e.stdout || '') + (e.stderr || '')};
    }
  }

  it('SUCCEEDS (exit 0) when only the TRAILING swap repoints (sync re-pinned mid-build) — not a mismatched start', () => {
    // Start on release, build Release: the LEADING swap is matched (no
    // correction). The (stale) sync re-pins to debug, so the TRAILING swap
    // repoints back to release. Only the leading swap may flag a mismatch, so
    // this must NOT fail the build.
    const {code} = run(setup('release'), 'Release');
    expect(code).toBe(0);
  });

  it('FAILS the build (exit 1) when the build STARTED on the wrong flavor (leading swap corrects)', () => {
    // Start on debug, build Release: the LEADING swap corrects debug->release and
    // flags it → fail once, converge, rebuild green.
    const {code, out} = run(setup('debug'), 'Release');
    expect(code).toBe(1);
    expect(out).toMatch(/error:/);
  });

  it('SUCCEEDS (exit 0) when the build started matched (Debug on debug)', () => {
    const {code} = run(setup('debug'), 'Debug');
    expect(code).toBe(0);
  });
});
