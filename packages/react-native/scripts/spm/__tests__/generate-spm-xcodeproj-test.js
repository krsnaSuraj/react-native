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

const {generateXcscheme} = require('../generate-spm-xcodeproj');

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
