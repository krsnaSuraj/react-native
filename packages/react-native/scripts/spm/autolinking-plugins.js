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
 *         // Sources compiled INTO THE APP TARGET (not the static Autolinked
 *         // aggregate) — the only place an @objc class reaches the ObjC
 *         // classlist, so emit files here when a class must be reachable by
 *         // name (e.g. via NSClassFromString), as Expo's ExpoModulesProvider
 *         // needs. Recorded to `.spm-plugin-generated-sources.json`; the
 *         // `spm add`/`update` xcodeproj injector wires each into the app
 *         // target (PBXFileReference + Sources-phase entry), marker-tracked
 *         // so deinit reverts and update reconciles.
 *         generatedSources: [{path}],
 *         // Precompiled xcframeworks that come in debug/release flavor pairs.
 *         // `link` is a plugin-owned stable symlink its binaryTarget references;
 *         // RN's build-time swap-flavor repoints it per $CONFIGURATION. Recorded
 *         // to `.spm-plugin-flavored-artifacts.json` and consumed there.
 *         flavoredArtifacts: [{name, link, flavors: {debug?, release?}}],
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
  logger /*: {warn: (msg: string) => void} */ = {
    warn: msg => console.warn(msg),
  },
) /*: PluginResult */ {
  const packageDependencies /*: Array<{name: string, path?: string, url?: string, version?: string}> */ =
    [];
  const productDependencies /*: Array<{name: string, package: string}> */ = [];
  const generatedSources /*: Array<{path: string}> */ = [];
  const flavoredArtifacts /*: Array<{name: string, link: string, flavors: {debug?: string, release?: string}}> */ =
    [];
  const seenPackages /*: Set<string> */ = new Set();
  const seenProducts /*: Set<string> */ = new Set();
  const seenArtifacts /*: Set<string> */ = new Set();

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
    // $FlowFixMe[incompatible-use]
    const rawArts = result.flavoredArtifacts ?? [];
    // Never let a malformed flavoredArtifacts break the build — a non-array
    // (e.g. an object) would make the drop-loop below throw. Warn and ignore.
    if (!Array.isArray(rawArts)) {
      logger.warn(
        `react-native spm: '${depName}' returned a non-array flavoredArtifacts ` +
          `— ignoring it.`,
      );
    }
    const arts = Array.isArray(rawArts) ? rawArts : [];
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
    // flavoredArtifacts are DROPPED (with a warning), not fatal: they're an
    // optional Preview capability the build shouldn't break over, and a
    // malformed entry only means one plugin framework won't flavor-swap.
    for (const a of arts) {
      const flavorsOk =
        a != null &&
        a.flavors != null &&
        typeof a.flavors === 'object' &&
        // $FlowFixMe[incompatible-use] dynamic shape, validated here
        Object.values(a.flavors).every(v => typeof v === 'string');
      if (
        a == null ||
        typeof a.name !== 'string' ||
        a.name.length === 0 ||
        typeof a.link !== 'string' ||
        a.link.length === 0 ||
        !flavorsOk
      ) {
        logger.warn(
          `react-native spm: '${depName}' returned an invalid flavoredArtifact ` +
            `(need {name, link} non-empty strings and flavors as an object of ` +
            `string paths) — dropping it.`,
        );
        continue;
      }
      // Dedupe by name so two plugins declaring the same artifact don't
      // double-swap (mirrors the package/product dedupe).
      if (seenArtifacts.has(a.name)) {
        continue;
      }
      seenArtifacts.add(a.name);
      flavoredArtifacts.push({name: a.name, link: a.link, flavors: a.flavors});
    }
  }

  return {
    packageDependencies,
    productDependencies,
    generatedSources,
    flavoredArtifacts,
  };
}

module.exports = {
  discoverPlugins,
  invokePlugins,
};
