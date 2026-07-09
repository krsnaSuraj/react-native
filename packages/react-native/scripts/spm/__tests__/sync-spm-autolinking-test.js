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
  decideSyncPlan,
  deriveFlavorFromPin,
  main,
} = require('../sync-spm-autolinking');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// decideSyncPlan — the pure decision core extracted from main(). Encodes the
// remote-vs-local / cached-vs-uncached matrix that drives the side effects.
// ---------------------------------------------------------------------------

describe('decideSyncPlan', () => {
  it('local mode without a cache: download + generate the sub-package', () => {
    expect(decideSyncPlan(null, false)).toEqual({
      isRemote: false,
      shouldDownload: true,
      shouldGeneratePackage: true,
    });
  });

  it('local mode with a populated cache: generate but do not download', () => {
    expect(decideSyncPlan(null, true)).toEqual({
      isRemote: false,
      shouldDownload: false,
      shouldGeneratePackage: true,
    });
  });

  it('remote mode: never download, never generate the local sub-package', () => {
    const remote = {url: 'https://example/rn.git', version: '0.85.0'};
    expect(decideSyncPlan(remote, false)).toEqual({
      isRemote: true,
      shouldDownload: false,
      shouldGeneratePackage: false,
    });
    // A stray cache must not change the remote-mode decision.
    expect(decideSyncPlan(remote, true).shouldGeneratePackage).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveFlavorFromPin — reads the flavor a prior add/sync pinned, from the
// React.xcframework slot symlink. Preserves a Release pin instead of stomping
// it back to debug on every sync.
// ---------------------------------------------------------------------------

describe('deriveFlavorFromPin', () => {
  let appRoot;
  beforeEach(() => {
    appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-pin-'));
  });
  afterEach(() => fs.rmSync(appRoot, {recursive: true, force: true}));

  const pin = target => {
    const dir = path.join(appRoot, 'build', 'xcframeworks');
    fs.mkdirSync(dir, {recursive: true});
    fs.symlinkSync(target, path.join(dir, 'React.xcframework'));
  };

  it('reads "release" from a release-pinned slot symlink', () => {
    pin(path.join(appRoot, 'cache', '1.0', 'release', 'React.xcframework'));
    expect(deriveFlavorFromPin(appRoot)).toBe('release');
  });

  it('reads "debug" from a debug-pinned slot symlink', () => {
    pin(path.join(appRoot, 'cache', '1.0', 'debug', 'React.xcframework'));
    expect(deriveFlavorFromPin(appRoot)).toBe('debug');
  });

  // DELIBERATE CONTRACT CHANGE (F2): deriveFlavorFromPin is now a null-returning
  // pin-read (a thin re-export of spm-utils' readFlavorPin) — an absent symlink
  // means "no pin yet", not "debug". main() below composes the fallback chain
  // (pin -> $CONFIGURATION -> 'debug') on top of this. Was previously asserted
  // to return 'debug' directly.
  it('returns null (not "debug") when the slot symlink is absent', () => {
    expect(deriveFlavorFromPin(appRoot)).toBeNull();
  });

  it('returns null for an unrecognized flavor segment', () => {
    pin(path.join(appRoot, 'cache', '1.0', 'weird', 'React.xcframework'));
    expect(deriveFlavorFromPin(appRoot)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// main — orchestration. Collaborators are injected as recording fakes; the
// fs-backed steps (cache probe, stamp write) run for real against tempdirs.
// ---------------------------------------------------------------------------

describe('main', () => {
  let appRoot;
  let rnRoot;
  let cacheDir;
  let logSpy;
  let errSpy;

  // Builds a full set of injectable fakes with sensible local-mode defaults.
  function makeDeps(over /*: Object */ = {}) {
    return {
      runCodegenAndInstallTemplate: jest.fn(),
      readPackageJson: jest.fn(() => ({version: '0.85.0'})),
      resolveCacheSlotVersion: jest.fn(async () => '0.85.0'),
      defaultCacheDir: jest.fn(() => cacheDir),
      remotePackageConfig: jest.fn(() => null),
      downloadArtifacts: jest.fn(async () => {}),
      generateAutolinking: jest.fn(),
      generatePackage: jest.fn(),
      installSpmCodegenTemplate: jest.fn(),
      buildPerAppHeaderTree: jest.fn(),
      findProjectRoot: jest.fn(p => p),
      readArtifactsVersionOverride: jest.fn(() => null),
      ...over,
    };
  }

  function run(deps) {
    return main(['--app-root', appRoot, '--react-native-root', rnRoot], deps);
  }

  function stampPath() {
    return path.join(
      appRoot,
      'build',
      'generated',
      'autolinking',
      '.spm-sync-stamp',
    );
  }

  beforeEach(() => {
    appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-sync-app-'));
    rnRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-sync-rn-'));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-sync-cache-'));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(appRoot, {recursive: true, force: true});
    fs.rmSync(rnRoot, {recursive: true, force: true});
    fs.rmSync(cacheDir, {recursive: true, force: true});
  });

  it('local mode, empty cache: downloads, generates, and writes the stamp', async () => {
    const deps = makeDeps();
    await run(deps);

    expect(deps.downloadArtifacts).toHaveBeenCalledWith([
      '--version',
      '0.85.0',
      '--flavor',
      'debug',
      '--output',
      cacheDir,
    ]);
    expect(deps.generateAutolinking).toHaveBeenCalledTimes(1);
    expect(deps.generatePackage).toHaveBeenCalledTimes(1);
    expect(deps.installSpmCodegenTemplate).toHaveBeenCalledTimes(1);
    expect(deps.buildPerAppHeaderTree).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(stampPath())).toBe(true);
  });

  it('preserves a release pin — flavor flows into cache-slot, download, and autolinking args', async () => {
    const dir = path.join(appRoot, 'build', 'xcframeworks');
    fs.mkdirSync(dir, {recursive: true});
    fs.symlinkSync(
      path.join(appRoot, 'cache', '1.0', 'release', 'React.xcframework'),
      path.join(dir, 'React.xcframework'),
    );
    const deps = makeDeps();
    await run(deps);

    expect(deps.defaultCacheDir).toHaveBeenCalledWith('0.85.0', 'release');
    expect(deps.downloadArtifacts).toHaveBeenCalledWith(
      expect.arrayContaining(['--flavor', 'release']),
    );
    expect(deps.generateAutolinking).toHaveBeenCalledWith(
      expect.arrayContaining(['--flavor', 'release']),
    );
  });

  it('prefers a pinned artifactsVersionOverride over the package.json version, and logs it', async () => {
    const deps = makeDeps({
      readArtifactsVersionOverride: jest.fn(() => '0.79.0'),
      // Echo the requested version back so the assertions below can verify
      // it (rather than the package.json-derived '0.85.0') flowed through.
      resolveCacheSlotVersion: jest.fn(async v => v),
    });
    await run(deps);

    expect(deps.readArtifactsVersionOverride).toHaveBeenCalledWith(appRoot);
    expect(deps.resolveCacheSlotVersion).toHaveBeenCalledWith('0.79.0');
    expect(deps.defaultCacheDir).toHaveBeenCalledWith('0.79.0', 'debug');
    expect(deps.downloadArtifacts).toHaveBeenCalledWith(
      expect.arrayContaining(['--version', '0.79.0']),
    );
    expect(
      logSpy.mock.calls.some(call =>
        call.some(
          arg =>
            typeof arg === 'string' &&
            arg.includes(
              'Using pinned artifacts version 0.79.0 (from .spm-injected.json)',
            ),
        ),
      ),
    ).toBe(true);
  });

  it('falls back to the package.json version when no override is pinned (no log line)', async () => {
    const deps = makeDeps(); // readArtifactsVersionOverride defaults to null
    await run(deps);

    expect(deps.resolveCacheSlotVersion).toHaveBeenCalledWith('0.85.0');
    expect(
      logSpy.mock.calls.some(call =>
        call.some(
          arg => typeof arg === 'string' && arg.includes('pinned artifacts'),
        ),
      ),
    ).toBe(false);
  });

  it('a malformed/absent marker falls back to the package.json version, no throw', async () => {
    // readArtifactsVersionOverride itself never throws (see
    // generate-spm-xcodeproj-test / remove-spm-injection-test); this
    // exercises sync's consumption of a null result end-to-end.
    const deps = makeDeps({
      readArtifactsVersionOverride: jest.fn(() => null),
    });
    await expect(run(deps)).resolves.toBeUndefined();
    expect(deps.resolveCacheSlotVersion).toHaveBeenCalledWith('0.85.0');
  });

  it('local mode, populated cache: skips download but still generates', async () => {
    fs.writeFileSync(path.join(cacheDir, 'artifacts.json'), '{}');
    const deps = makeDeps();
    await run(deps);

    expect(deps.downloadArtifacts).not.toHaveBeenCalled();
    expect(deps.generatePackage).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(stampPath())).toBe(true);
  });

  it('remote mode: skips both download and sub-package generation', async () => {
    const deps = makeDeps({
      remotePackageConfig: jest.fn(() => ({
        url: 'https://example/rn.git',
        version: '0.85.0',
      })),
    });
    await run(deps);

    expect(deps.downloadArtifacts).not.toHaveBeenCalled();
    expect(deps.generatePackage).not.toHaveBeenCalled();
    // Autolinking + stamp still happen in remote mode.
    expect(deps.generateAutolinking).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(stampPath())).toBe(true);
  });

  it('continues when codegen throws, completing the rest of the sync', async () => {
    const deps = makeDeps({
      runCodegenAndInstallTemplate: jest.fn(() => {
        throw new Error('codegen blew up');
      }),
    });
    await expect(run(deps)).resolves.toBeUndefined();

    expect(deps.generateAutolinking).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(stampPath())).toBe(true);
  });

  it('propagates a slot-resolution failure to the caller', async () => {
    const deps = makeDeps({
      resolveCacheSlotVersion: jest.fn(async () => {
        throw new Error('npm offline');
      }),
    });
    await expect(run(deps)).rejects.toThrow(/npm offline/);
    // The stamp is only written on a successful run.
    expect(fs.existsSync(stampPath())).toBe(false);
  });

  // Regression test for the failure-atomicity bug: generateAutolinking runs
  // fail-closed autolinking plugins that can throw. If installSpmCodegenTemplate
  // hasn't already run by then, codegen's mis-rooted default
  // build/generated/ios/Package.swift is left in place and every subsequent
  // Xcode "Resolve Package Graph" fails. installSpmCodegenTemplate must be
  // called before generateAutolinking regardless of whether it throws.
  it('installs the codegen template before generateAutolinking runs, even if generateAutolinking throws', async () => {
    const deps = makeDeps({
      generateAutolinking: jest.fn(() => {
        throw new Error('autolinking plugin blew up');
      }),
    });
    await expect(run(deps)).rejects.toThrow(/autolinking plugin blew up/);

    expect(deps.installSpmCodegenTemplate).toHaveBeenCalledTimes(1);
    expect(
      deps.installSpmCodegenTemplate.mock.invocationCallOrder[0],
    ).toBeLessThan(deps.generateAutolinking.mock.invocationCallOrder[0]);
  });

  // -------------------------------------------------------------------------
  // F2: a FRESH app (no pin yet) derives its first flavor from $CONFIGURATION
  // instead of hardcoding debug, via flavorFromConfiguration. An existing pin
  // still wins over $CONFIGURATION (sync must not stomp a Release pin).
  // -------------------------------------------------------------------------
  describe('flavor resolution (F2: fresh state derives from $CONFIGURATION)', () => {
    const ORIGINAL_CONFIGURATION = process.env.CONFIGURATION;
    afterEach(() => {
      if (ORIGINAL_CONFIGURATION === undefined) {
        delete process.env.CONFIGURATION;
      } else {
        process.env.CONFIGURATION = ORIGINAL_CONFIGURATION;
      }
    });

    it('no pin + CONFIGURATION=Release -> release', async () => {
      process.env.CONFIGURATION = 'Release';
      const deps = makeDeps();
      await run(deps);
      expect(deps.defaultCacheDir).toHaveBeenCalledWith('0.85.0', 'release');
      expect(deps.generateAutolinking).toHaveBeenCalledWith(
        expect.arrayContaining(['--flavor', 'release']),
      );
    });

    it('no pin + CONFIGURATION=Debug -> debug', async () => {
      process.env.CONFIGURATION = 'Debug';
      const deps = makeDeps();
      await run(deps);
      expect(deps.defaultCacheDir).toHaveBeenCalledWith('0.85.0', 'debug');
    });

    it('no pin + CONFIGURATION=Staging -> release (name-match rule)', async () => {
      process.env.CONFIGURATION = 'Staging';
      const deps = makeDeps();
      await run(deps);
      expect(deps.defaultCacheDir).toHaveBeenCalledWith('0.85.0', 'release');
    });

    it('no pin + CONFIGURATION containing "development" -> debug', async () => {
      process.env.CONFIGURATION = 'MyDevelopmentBuild';
      const deps = makeDeps();
      await run(deps);
      expect(deps.defaultCacheDir).toHaveBeenCalledWith('0.85.0', 'debug');
    });

    it('an existing pin WINS over $CONFIGURATION', async () => {
      process.env.CONFIGURATION = 'Debug';
      const dir = path.join(appRoot, 'build', 'xcframeworks');
      fs.mkdirSync(dir, {recursive: true});
      fs.symlinkSync(
        path.join(appRoot, 'cache', '1.0', 'release', 'React.xcframework'),
        path.join(dir, 'React.xcframework'),
      );
      const deps = makeDeps();
      await run(deps);
      expect(deps.defaultCacheDir).toHaveBeenCalledWith('0.85.0', 'release');
    });

    it('no pin + no $CONFIGURATION -> debug', async () => {
      delete process.env.CONFIGURATION;
      const deps = makeDeps();
      await run(deps);
      expect(deps.defaultCacheDir).toHaveBeenCalledWith('0.85.0', 'debug');
    });
  });
});
