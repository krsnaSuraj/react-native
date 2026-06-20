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

const {decideSyncPlan, main} = require('../sync-spm-autolinking');
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
});
