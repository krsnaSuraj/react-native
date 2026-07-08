/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

/**
 * SwiftPM autolinking plugins — the extension seam for frameworks (Expo first)
 * that need to contribute their own SwiftPM package refs / product deps /
 * generated sources into the autolinked package graph.
 *
 * PREVIEW / UNSTABLE CONTRACT. The discovery mechanism and the plugin
 * function's context/return shape may change while the first real consumers
 * (Expo) validate it.
 *
 * Why a plugin and not a post-process: the Xcode auto-sync build phase
 * re-runs autolinking on every dependency change, so a one-shot rewrite of the
 * generated Package.swift is clobbered on the next sync. Plugins are invoked
 * from generate-spm-autolinking.js:main() — the single function both `add`/
 * `update` and the build-time `sync` call — so a contribution runs on EVERY
 * regeneration.
 *
 * Discovery (transitive, mirrors CocoaPods' `use_expo_modules!`): any
 * autolinked dependency can register a plugin from its own
 * react-native.config.js —
 *
 *     // node_modules/expo/react-native.config.js
 *     module.exports = { spm: { autolinkingPlugin: './spm/plugin.js' } };
 *
 * Installing the framework is enough; no app-level config is required. An app
 * MAY still exclude a plugin via `spm.denyPlugins` (npm-name list) in its own
 * react-native.config.js — an escape hatch, not a required allowlist.
 *
 * Contract:
 *
 *     module.exports = function plugin(context) {
 *       // context: {appRoot, projectRoot, reactNativeRoot, autolinking,
 *       //           outputDir, flavor, react}
 *       // context.react (?ReactDescriptor): how to depend on React —
 *       //   {packageRef, products}. packageRef is local ({name, path (absolute),
 *       //   relPath}) or remote ({name, url, version}); products is the set RN
 *       //   gives its own autolinked targets (incl. ReactAppHeaders from the
 *       //   separate React-GeneratedCode package), filtered to what resolves
 *       //   this run. Use it instead of re-deriving RN's path/identity/products.
 *       return {
 *         packageDependencies: [{name, path}] | [{name, url, version}],
 *         productDependencies: [{name, package}],
 *         generatedSources: [{path}],
 *       };
 *     };
 *
 * The plugin returns DATA; it never writes into RN's generated tree. RN owns
 * the merge, so regeneration stays deterministic and idempotent.
 */

const path = require('path');

/*:: import type {
  AutolinkedDep,
  PluginContext,
  PluginResult,
  DiscoveredPlugin,
} from './spm-types';
*/

/**
 * Discover plugins declared by autolinked deps. `readConfig(root)` returns the
 * dep's parsed react-native.config.js (or null). `denyList` is the app's
 * `spm.denyPlugins` (npm names to skip). Fail-closed: a declared-but-missing
 * or unloadable plugin throws, naming the dep — a framework silently dropping
 * its modules is worse than a loud stop.
 */
function discoverPlugins(
  deps /*: ReadonlyArray<AutolinkedDep> */,
  readConfig /*: (root: string) => ?{readonly [string]: unknown} */,
  denyList /*: ReadonlyArray<string> */ = [],
) /*: Array<DiscoveredPlugin> */ {
  const denied = new Set(denyList);
  const found /*: Array<DiscoveredPlugin> */ = [];
  for (const dep of deps) {
    if (denied.has(dep.name)) {
      continue;
    }
    const config = readConfig(dep.root);
    // $FlowFixMe[incompatible-use] config has a dynamic shape
    const rel = config?.spm?.autolinkingPlugin;
    if (rel == null) {
      continue;
    }
    if (typeof rel !== 'string' || rel.length === 0) {
      throw new Error(
        `react-native spm: '${dep.name}' declares an invalid spm.autolinkingPlugin ` +
          `(expected a module path string).`,
      );
    }
    const pluginPath = path.resolve(dep.root, rel);
    let fn /*: unknown */;
    try {
      // $FlowFixMe[unsupported-syntax] dynamic require by computed path
      fn = require(pluginPath);
    } catch (e) {
      throw new Error(
        `react-native spm: failed to load the autolinking plugin for '${dep.name}' ` +
          `at ${pluginPath}: ${e.message}`,
      );
    }
    // Support `module.exports = fn` and `{default: fn}` / `{plugin: fn}`.
    const resolved =
      typeof fn === 'function'
        ? fn
        : // $FlowFixMe[incompatible-use] interop shapes
          typeof fn?.default === 'function'
          ? fn.default
          : // $FlowFixMe[incompatible-use]
            typeof fn?.plugin === 'function'
            ? fn.plugin
            : null;
    if (resolved == null) {
      throw new Error(
        `react-native spm: the autolinking plugin for '${dep.name}' at ${pluginPath} ` +
          `does not export a function.`,
      );
    }
    found.push({depName: dep.name, pluginPath, plugin: resolved});
  }
  return found;
}

/**
 * Invoke discovered plugins and merge their results. Each plugin gets the same
 * context. Fail-closed: a throwing plugin aborts (named), and a malformed
 * return is rejected. Dedupe package + product deps by name so a plugin and an
 * npm dep that both reference the same package don't double-declare.
 */
function invokePlugins(
  plugins /*: ReadonlyArray<DiscoveredPlugin> */,
  context /*: PluginContext */,
) /*: PluginResult */ {
  const packageDependencies /*: Array<{name: string, path?: string, url?: string, version?: string}> */ =
    [];
  const productDependencies /*: Array<{name: string, package: string}> */ = [];
  const generatedSources /*: Array<{path: string}> */ = [];
  const seenPackages /*: Set<string> */ = new Set();
  const seenProducts /*: Set<string> */ = new Set();

  for (const {depName, pluginPath, plugin} of plugins) {
    let result /*: unknown */;
    try {
      result = plugin(context);
    } catch (e) {
      throw new Error(
        `react-native spm: the autolinking plugin for '${depName}' (${pluginPath}) ` +
          `threw: ${e.message}`,
      );
    }
    if (result == null) {
      continue;
    }
    if (typeof result !== 'object') {
      throw new Error(
        `react-native spm: the autolinking plugin for '${depName}' returned a ` +
          `${typeof result}; expected an object or undefined.`,
      );
    }
    // $FlowFixMe[incompatible-use] validated field-by-field below
    const pkgs = result.packageDependencies ?? [];
    // $FlowFixMe[incompatible-use]
    const prods = result.productDependencies ?? [];
    // $FlowFixMe[incompatible-use]
    const srcs = result.generatedSources ?? [];
    for (const p of pkgs) {
      if (p == null || typeof p.name !== 'string') {
        throw new Error(
          `react-native spm: '${depName}' returned a packageDependency without a name.`,
        );
      }
      if (p.path == null && (p.url == null || p.version == null)) {
        throw new Error(
          `react-native spm: '${depName}' packageDependency '${p.name}' needs either ` +
            `a path or a url+version.`,
        );
      }
      if (!seenPackages.has(p.name)) {
        seenPackages.add(p.name);
        packageDependencies.push(p);
      }
    }
    for (const p of prods) {
      if (
        p == null ||
        typeof p.name !== 'string' ||
        typeof p.package !== 'string'
      ) {
        throw new Error(
          `react-native spm: '${depName}' returned a productDependency needing name + package.`,
        );
      }
      const key = `${p.package}/${p.name}`;
      if (!seenProducts.has(key)) {
        seenProducts.add(key);
        productDependencies.push(p);
      }
    }
    for (const s of srcs) {
      if (s == null || typeof s.path !== 'string') {
        throw new Error(
          `react-native spm: '${depName}' returned a generatedSource without a path.`,
        );
      }
      generatedSources.push(s);
    }
  }

  return {packageDependencies, productDependencies, generatedSources};
}

module.exports = {
  discoverPlugins,
  invokePlugins,
};
