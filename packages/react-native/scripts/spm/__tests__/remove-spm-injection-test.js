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
  SPM_INJECTED_MARKER,
  injectSpmIntoExistingXcodeproj,
  removeSpmInjection,
} = require('../generate-spm-xcodeproj');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLAIN = fs.readFileSync(
  path.join(__dirname, '__fixtures__', 'plain-app.pbxproj'),
  'utf8',
);

// Build a throwaway app dir: <tmp>/MyApp.xcodeproj/project.pbxproj seeded with
// the plain (SPM-only) fixture, and a node_modules/react-native sibling so the
// relative reactNativePath resolves.
function scaffoldApp() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-deinit-'));
  const xcodeprojPath = path.join(appRoot, 'MyApp.xcodeproj');
  fs.mkdirSync(xcodeprojPath, {recursive: true});
  fs.writeFileSync(path.join(xcodeprojPath, 'project.pbxproj'), PLAIN, 'utf8');
  const rnRoot = path.join(appRoot, 'node_modules', 'react-native');
  fs.mkdirSync(rnRoot, {recursive: true});
  return {appRoot, xcodeprojPath, rnRoot};
}

function pbxprojOf(xcodeprojPath) {
  return fs.readFileSync(path.join(xcodeprojPath, 'project.pbxproj'), 'utf8');
}

describe('removeSpmInjection — the surgical inverse of add', () => {
  it('round-trips: add then deinit restores the pbxproj byte-for-byte', () => {
    const {appRoot, xcodeprojPath, rnRoot} = scaffoldApp();
    const before = pbxprojOf(xcodeprojPath);

    const injected = injectSpmIntoExistingXcodeproj({
      appRoot,
      reactNativeRoot: rnRoot,
      xcodeprojPath,
    });
    expect(injected.status).toBe('injected');
    // It actually changed something + wrote the marker.
    expect(pbxprojOf(xcodeprojPath)).not.toBe(before);
    expect(fs.existsSync(path.join(xcodeprojPath, SPM_INJECTED_MARKER))).toBe(
      true,
    );

    const removed = removeSpmInjection({appRoot, xcodeprojPath});
    expect(removed.status).toBe('removed');
    // Byte-identical to the pre-add pbxproj.
    expect(pbxprojOf(xcodeprojPath)).toBe(before);
    // Marker is gone.
    expect(fs.existsSync(path.join(xcodeprojPath, SPM_INJECTED_MARKER))).toBe(
      false,
    );
  });

  it('preserves an unrelated edit made to the pbxproj after add', () => {
    const {appRoot, xcodeprojPath, rnRoot} = scaffoldApp();

    injectSpmIntoExistingXcodeproj({
      appRoot,
      reactNativeRoot: rnRoot,
      xcodeprojPath,
    });

    // Simulate a user edit AFTER injection: flip the deployment target.
    const edited = pbxprojOf(xcodeprojPath).replace(
      /IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/g,
      'IPHONEOS_DEPLOYMENT_TARGET = 18.0;',
    );
    fs.writeFileSync(
      path.join(xcodeprojPath, 'project.pbxproj'),
      edited,
      'utf8',
    );

    removeSpmInjection({appRoot, xcodeprojPath});

    const after = pbxprojOf(xcodeprojPath);
    // The user's edit survives…
    expect(after).toContain('IPHONEOS_DEPLOYMENT_TARGET = 18.0;');
    // …and all SPM injection is gone.
    expect(after).not.toContain('Sync SPM Autolinking');
    expect(after).not.toContain('build/generated/autolinking/headers');
    expect(after).not.toContain('REACT_NATIVE_PATH');
    expect(after).not.toMatch(/relativePath = build\/xcframeworks/);
  });

  it('is a no-op (status: absent) when the project was never injected', () => {
    const {appRoot, xcodeprojPath} = scaffoldApp();
    const before = pbxprojOf(xcodeprojPath);
    const result = removeSpmInjection({appRoot, xcodeprojPath});
    expect(result.status).toBe('absent');
    expect(pbxprojOf(xcodeprojPath)).toBe(before);
  });
});
