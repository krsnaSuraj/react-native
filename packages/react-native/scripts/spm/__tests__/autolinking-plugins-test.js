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

const {discoverPlugins, invokePlugins} = require('../autolinking-plugins');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('discoverPlugins', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-plugins-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  // Writes a dep dir with a plugin module and returns its {name, root}.
  function makeDep(name, pluginBody /*: ?string */) {
    const root = path.join(tmp, name);
    fs.mkdirSync(root, {recursive: true});
    if (pluginBody != null) {
      fs.writeFileSync(path.join(root, 'plugin.js'), pluginBody, 'utf8');
    }
    return {name, root};
  }

  // readConfig fake: a dep opts in when opted[name] is truthy.
  const readConfigFor = opted => root => {
    const name = path.basename(root);
    return opted[name] ? {spm: {autolinkingPlugin: './plugin.js'}} : null;
  };

  it('discovers a plugin declared via react-native.config.js', () => {
    const dep = makeDep('expo', 'module.exports = () => ({});');
    const found = discoverPlugins([dep], readConfigFor({expo: true}));
    expect(found).toHaveLength(1);
    expect(found[0].depName).toBe('expo');
    expect(typeof found[0].plugin).toBe('function');
  });

  it('skips deps that do not declare a plugin', () => {
    const dep = makeDep('react-native-svg', null);
    expect(discoverPlugins([dep], readConfigFor({}))).toHaveLength(0);
  });

  it('honors the app deny-list (opt-out, no allowlist needed)', () => {
    const dep = makeDep('expo', 'module.exports = () => ({});');
    const found = discoverPlugins([dep], readConfigFor({expo: true}), ['expo']);
    expect(found).toHaveLength(0);
  });

  it('accepts default/plugin export interop', () => {
    const a = makeDep('a', 'module.exports.default = () => ({});');
    const b = makeDep('b', 'module.exports.plugin = () => ({});');
    const found = discoverPlugins([a, b], readConfigFor({a: true, b: true}));
    expect(found.map(f => f.depName).sort()).toEqual(['a', 'b']);
  });

  it('fails closed when the plugin module is missing', () => {
    const dep = makeDep('expo', null); // opted in below but no plugin.js
    expect(() => discoverPlugins([dep], readConfigFor({expo: true}))).toThrow(
      /failed to load the autolinking plugin for 'expo'/,
    );
  });

  it('fails closed when the module does not export a function', () => {
    const dep = makeDep('expo', 'module.exports = {nope: 1};');
    expect(() => discoverPlugins([dep], readConfigFor({expo: true}))).toThrow(
      /does not export a function/,
    );
  });
});

describe('invokePlugins', () => {
  const ctx = {
    appRoot: '/app/ios',
    projectRoot: '/app',
    reactNativeRoot: '/app/node_modules/react-native',
    autolinking: {},
    outputDir: '/app/ios/build/generated/autolinking',
    flavor: 'debug',
    react: {
      packageRef: {name: 'ReactNative', path: '../build/xcframeworks'},
      products: [{name: 'ReactNative', package: 'ReactNative'}],
    },
  };
  const mk = (depName, fn) => ({
    depName,
    pluginPath: `/x/${depName}.js`,
    plugin: fn,
  });

  it('merges package/product/generated contributions', () => {
    const res = invokePlugins(
      [
        mk('expo', () => ({
          packageDependencies: [{name: 'ExpoModulesCore', path: '../expo'}],
          productDependencies: [
            {name: 'ExpoModulesCore', package: 'ExpoModulesCore'},
          ],
          generatedSources: [{path: 'ExpoModulesProvider.swift'}],
        })),
      ],
      ctx,
    );
    expect(res.packageDependencies).toEqual([
      {name: 'ExpoModulesCore', path: '../expo'},
    ]);
    expect(res.productDependencies).toEqual([
      {name: 'ExpoModulesCore', package: 'ExpoModulesCore'},
    ]);
    expect(res.generatedSources).toEqual([{path: 'ExpoModulesProvider.swift'}]);
  });

  it('passes the full context (incl. flavor) to the plugin', () => {
    let seen;
    invokePlugins(
      [
        mk('expo', c => {
          seen = c;
          return {};
        }),
      ],
      ctx,
    );
    expect(seen.flavor).toBe('debug');
    expect(seen.projectRoot).toBe('/app');
    expect(seen.autolinking).toBe(ctx.autolinking);
    // react descriptor is forwarded so plugins depend on React via one source.
    expect(seen.react.packageRef).toEqual({
      name: 'ReactNative',
      path: '../build/xcframeworks',
    });
  });

  it('dedupes packages and products by name across plugins', () => {
    const res = invokePlugins(
      [
        mk('a', () => ({
          packageDependencies: [{name: 'Dup', path: './a'}],
          productDependencies: [{name: 'P', package: 'Dup'}],
        })),
        mk('b', () => ({
          packageDependencies: [{name: 'Dup', path: './b'}],
          productDependencies: [{name: 'P', package: 'Dup'}],
        })),
      ],
      ctx,
    );
    expect(res.packageDependencies).toHaveLength(1);
    expect(res.productDependencies).toHaveLength(1);
  });

  it('tolerates a plugin returning null/undefined', () => {
    const res = invokePlugins([mk('a', () => undefined)], ctx);
    expect(res.packageDependencies).toEqual([]);
  });

  it('fails closed and names the plugin when it throws', () => {
    expect(() =>
      invokePlugins(
        [
          mk('expo', () => {
            throw new Error('boom');
          }),
        ],
        ctx,
      ),
    ).toThrow(/plugin for 'expo'.*threw: boom/);
  });

  it('rejects a package dep without a path or url+version', () => {
    expect(() =>
      invokePlugins(
        [mk('expo', () => ({packageDependencies: [{name: 'X'}]}))],
        ctx,
      ),
    ).toThrow(/needs either a path or a url\+version/);
  });

  it('rejects a product dep missing name or package', () => {
    expect(() =>
      invokePlugins(
        [mk('expo', () => ({productDependencies: [{name: 'X'}]}))],
        ctx,
      ),
    ).toThrow(/productDependency needing name \+ package/);
  });

  it('merges valid flavoredArtifacts', () => {
    const res = invokePlugins(
      [
        mk('expo', () => ({
          flavoredArtifacts: [
            {
              name: 'ExpoModulesCore',
              link: '/o/ExpoModulesCore/artifacts/ExpoModulesCore.xcframework',
              flavors: {
                debug: '/o/debug/ExpoModulesCore.xcframework',
                release: '/o/release/ExpoModulesCore.xcframework',
              },
            },
          ],
        })),
      ],
      ctx,
    );
    expect(res.flavoredArtifacts).toEqual([
      {
        name: 'ExpoModulesCore',
        link: '/o/ExpoModulesCore/artifacts/ExpoModulesCore.xcframework',
        flavors: {
          debug: '/o/debug/ExpoModulesCore.xcframework',
          release: '/o/release/ExpoModulesCore.xcframework',
        },
      },
    ]);
  });

  it('accepts a flavoredArtifact with only one flavor present', () => {
    const res = invokePlugins(
      [
        mk('expo', () => ({
          flavoredArtifacts: [
            {name: 'A', link: '/o/A.xcframework', flavors: {debug: '/d/A'}},
          ],
        })),
      ],
      ctx,
    );
    expect(res.flavoredArtifacts).toEqual([
      {name: 'A', link: '/o/A.xcframework', flavors: {debug: '/d/A'}},
    ]);
  });

  it('drops invalid flavoredArtifacts with a per-entry warning (not fatal)', () => {
    const warnings = [];
    const res = invokePlugins(
      [
        mk('expo', () => ({
          flavoredArtifacts: [
            {name: '', link: '/o/x', flavors: {debug: '/d'}}, // empty name
            {name: 'B', link: '', flavors: {debug: '/d'}}, // empty link
            {name: 'C', link: '/o/c', flavors: {debug: 5}}, // non-string flavor
            {name: 'D', link: '/o/d'}, // missing flavors
            {name: 'OK', link: '/o/ok', flavors: {release: '/r/ok'}}, // valid
          ],
        })),
      ],
      ctx,
      {warn: m => warnings.push(m)},
    );
    expect(res.flavoredArtifacts).toEqual([
      {name: 'OK', link: '/o/ok', flavors: {release: '/r/ok'}},
    ]);
    expect(warnings).toHaveLength(4);
    expect(warnings.every(w => /invalid flavoredArtifact/.test(w))).toBe(true);
  });

  it('dedupes flavoredArtifacts by name across plugins', () => {
    const res = invokePlugins(
      [
        mk('a', () => ({
          flavoredArtifacts: [
            {name: 'Dup', link: '/a/Dup', flavors: {debug: '/a/d'}},
          ],
        })),
        mk('b', () => ({
          flavoredArtifacts: [
            {name: 'Dup', link: '/b/Dup', flavors: {debug: '/b/d'}},
          ],
        })),
      ],
      ctx,
    );
    expect(res.flavoredArtifacts).toHaveLength(1);
    expect(res.flavoredArtifacts[0].link).toBe('/a/Dup');
  });

  it('defaults flavoredArtifacts to [] when no plugin declares any', () => {
    const res = invokePlugins([mk('a', () => ({}))], ctx);
    expect(res.flavoredArtifacts).toEqual([]);
  });

  it('ignores a non-array flavoredArtifacts with a warning (never throws)', () => {
    const warnings = [];
    let res;
    expect(() => {
      res = invokePlugins(
        [mk('expo', () => ({flavoredArtifacts: {name: 'X'}}))], // object, not array
        ctx,
        {warn: m => warnings.push(m)},
      );
    }).not.toThrow();
    expect(res.flavoredArtifacts).toEqual([]);
    expect(warnings.some(w => /non-array flavoredArtifacts/.test(w))).toBe(
      true,
    );
  });

  it('keeps valid absolute watchPaths (dirs or files) across plugins', () => {
    const res = invokePlugins(
      [
        mk('expo', () => ({
          watchPaths: [
            '/app/node_modules/expo/Package.swift',
            '/app/node_modules/expo/expo-module.config.json',
          ],
        })),
        mk('b', () => ({watchPaths: ['/app/node_modules/b']})),
      ],
      ctx,
    );
    expect(res.watchPaths).toEqual([
      '/app/node_modules/expo/Package.swift',
      '/app/node_modules/expo/expo-module.config.json',
      '/app/node_modules/b',
    ]);
  });

  it('defaults watchPaths to [] when no plugin declares any', () => {
    const res = invokePlugins([mk('a', () => ({}))], ctx);
    expect(res.watchPaths).toEqual([]);
  });

  it('drops relative / empty / non-string watchPaths with a per-entry warning', () => {
    const warnings = [];
    const res = invokePlugins(
      [
        mk('expo', () => ({
          watchPaths: [
            '/app/node_modules/expo/Package.swift', // kept
            'relative/Package.swift', // relative → dropped
            '', // empty → dropped
            42, // non-string → dropped
          ],
        })),
      ],
      ctx,
      {warn: m => warnings.push(m)},
    );
    expect(res.watchPaths).toEqual(['/app/node_modules/expo/Package.swift']);
    expect(warnings).toHaveLength(3);
    expect(warnings.every(w => /invalid watchPath/.test(w))).toBe(true);
  });

  it('ignores a non-array watchPaths with a warning (never throws)', () => {
    const warnings = [];
    let res;
    expect(() => {
      res = invokePlugins(
        [mk('expo', () => ({watchPaths: '/app/x'}))], // string, not array
        ctx,
        {warn: m => warnings.push(m)},
      );
    }).not.toThrow();
    expect(res.watchPaths).toEqual([]);
    expect(warnings.some(w => /non-array watchPaths/.test(w))).toBe(true);
  });
});
