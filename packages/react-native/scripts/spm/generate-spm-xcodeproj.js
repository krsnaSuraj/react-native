/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

'use strict';

/**
 * generate-spm-xcodeproj.js – Surgical, in-place Swift Package Manager
 * integration toolkit for an existing `<App>.xcodeproj`.
 *
 * `injectSpmIntoExistingXcodeproj` adds the SPM package references, React build
 * settings, the "Sync SPM Autolinking" build phase, and a scheme pre-action to
 * a user's existing project — purely additively, recording every edit in a
 * `.spm-injected.json` marker. `removeSpmInjection` is the exact inverse (used
 * by `spm deinit`). Consumed as a library by setup-apple-spm.js; not a CLI.
 */

const {
  addArrayMembers,
  addArrayStringValues,
  ensureScalarField,
  findApplicationTargets,
  findField,
  findObjectByUuid,
  findProjectObject,
  insertObjectsIntoSection,
  namespacedUUID,
  quoteIfNeeded,
  removeArrayMembersByUuid,
  removeArrayStringValues,
  removeEmptyPodsGroup,
  removeField,
  removeObjectByUuid,
  serializeEntry,
} = require('./spm-pbxproj');
const {makeLogger, remotePackageConfig} = require('./spm-utils');
const fs = require('fs');
const path = require('path');

const {log} = makeLogger('generate-spm-xcodeproj');

// Sidecar inside a USER-OWNED xcodeproj that SPM packages were injected into in
// place. Records the host project's root UUID + every edit so `spm deinit`
// (removeSpmInjection) can surgically revert and re-runs stay idempotent.
const SPM_INJECTED_MARKER = '.spm-injected.json';

// Maps each SPM product to its sub-package path (relative to app root).
// The xcodeproj must reference each sub-package directly so Xcode can
// resolve the product dependencies — SPM doesn't expose transitive products.
const SPM_PRODUCT_PACKAGES /*: Array<{product: string, packagePath: string, packageName: string}> */ =
  [
    {
      product: 'ReactNative',
      packagePath: 'build/xcframeworks',
      packageName: 'ReactNative',
    },
    {
      product: 'ReactNativeDependencies',
      packagePath: 'build/xcframeworks',
      packageName: 'ReactNative',
    },
    {
      product: 'hermes-engine',
      packagePath: 'build/xcframeworks',
      packageName: 'ReactNative',
    },
    {
      product: 'Autolinked',
      packagePath: 'build/generated/autolinking',
      packageName: 'Autolinked',
    },
    {
      product: 'ReactCodegen',
      packagePath: 'build/generated/ios',
      packageName: 'React-GeneratedCode',
    },
    {
      product: 'ReactAppDependencyProvider',
      packagePath: 'build/generated/ios',
      packageName: 'React-GeneratedCode',
    },
  ];

/*::
type RemoteCfg = {url: string, version: string, identity: string};
// Precise record of the build-setting edits injection made to ONE build config,
// so deinit can reverse exactly those (and nothing the user already had).
type BuildSettingChange = {
  configUuid: string,
  createdArrayKeys: Array<string>,
  appendedArrayValues: {[string]: Array<string>},
  createdScalars: Array<string>,
};
type SpmGraph = {
  uniquePackages: Array<{packagePath: string, packageName: string}>,
  localPkgRefs: Array<{uuid: string, packagePath: string, comment: string}>,
  remotePkgRef: ?{uuid: string, url: string, version: string, identity: string, comment: string},
  products: Array<{product: string, depUuid: string, buildFileUuid: string, pkgRefUuid: string, refComment: string}>,
};
*/

/**
 * Resolve the SPM dependency graph (package references + product
 * dependencies + their frameworks build files) from SPM_PRODUCT_PACKAGES.
 * `mkUuid(section, id)` supplies UUIDs, seeded with the host project's root
 * UUID so injected IDs are stable across re-runs and collision-safe.
 */
function buildSpmDependencyGraph(
  mkUuid /*: (section: string, id: string) => string */,
  remote /*: ?RemoteCfg */,
) /*: SpmGraph */ {
  // Remote mode: ReactNative-family products move to the remote package.
  const productPackages = SPM_PRODUCT_PACKAGES.map(e =>
    remote != null && e.packagePath === 'build/xcframeworks'
      ? {...e, packagePath: 'REMOTE', packageName: remote.identity}
      : e,
  );
  const uniquePackages = Array.from(
    new Map(
      productPackages
        .filter(e => e.packagePath !== 'REMOTE')
        .map(e => [
          e.packagePath,
          {packagePath: e.packagePath, packageName: e.packageName},
        ]),
    ).values(),
  );
  const localPkgRefs = uniquePackages.map(pkg => ({
    uuid: mkUuid('XCLocalSwiftPackageReference', pkg.packagePath),
    packagePath: pkg.packagePath,
    comment: `XCLocalSwiftPackageReference "${pkg.packagePath}"`,
  }));
  const remotePkgRef =
    remote != null
      ? {
          uuid: mkUuid('XCRemoteSwiftPackageReference', remote.url),
          url: remote.url,
          version: remote.version,
          identity: remote.identity,
          comment: `XCRemoteSwiftPackageReference "${remote.identity}"`,
        }
      : null;
  const localByPath = new Map(localPkgRefs.map(r => [r.packagePath, r]));
  const products = productPackages.map(entry => {
    const {product, packagePath} = entry;
    const isRemote = packagePath === 'REMOTE' && remotePkgRef != null;
    const pkgRefUuid = isRemote
      ? // $FlowFixMe[incompatible-use] guarded by isRemote
        remotePkgRef.uuid
      : // $FlowFixMe[incompatible-use] every non-REMOTE path is in localByPath
        localByPath.get(packagePath).uuid;
    const refComment = isRemote
      ? // $FlowFixMe[incompatible-use] guarded by isRemote
        `XCRemoteSwiftPackageReference "${remotePkgRef.identity}"`
      : `XCLocalSwiftPackageReference "${packagePath}"`;
    return {
      product,
      depUuid: mkUuid('XCSwiftPackageProductDependency', product),
      buildFileUuid: mkUuid('PBXBuildFile', `spm:${product}`),
      pkgRefUuid,
      refComment,
    };
  });
  return {uniquePackages, localPkgRefs, remotePkgRef, products};
}

/**
 * Render the SPM graph into pbxproj section entry objects the in-place injector
 * splices into an existing project.
 */
/*:: type PbxEntryT = {uuid: string, comment: string, fields: {[string]: string}}; */

function spmGraphToEntries(
  graph /*: SpmGraph */,
) /*: {localRefs: Array<PbxEntryT>, remoteRef: ?PbxEntryT, productDeps: Array<PbxEntryT>, buildFiles: Array<PbxEntryT>} */ {
  const localRefs /*: Array<PbxEntryT> */ = graph.localPkgRefs.map(ref => ({
    uuid: ref.uuid,
    comment: ref.comment,
    fields: {
      isa: 'XCLocalSwiftPackageReference',
      relativePath: quoteIfNeeded(ref.packagePath),
    },
  }));
  const remote = graph.remotePkgRef;
  const remoteRef /*: ?PbxEntryT */ =
    remote != null
      ? {
          uuid: remote.uuid,
          comment: remote.comment,
          fields: {
            isa: 'XCRemoteSwiftPackageReference',
            repositoryURL: quoteIfNeeded(remote.url),
            requirement: `{\n\t\t\t\tkind = exactVersion;\n\t\t\t\tversion = "${remote.version}";\n\t\t\t}`,
          },
        }
      : null;
  const productDeps /*: Array<PbxEntryT> */ = graph.products.map(p => ({
    uuid: p.depUuid,
    comment: p.product,
    fields: {
      isa: 'XCSwiftPackageProductDependency',
      package: `${p.pkgRefUuid} /* ${p.refComment} */`,
      productName: quoteIfNeeded(p.product),
    },
  }));
  const buildFiles /*: Array<PbxEntryT> */ = graph.products.map(p => ({
    uuid: p.buildFileUuid,
    comment: `${p.product} in Frameworks`,
    fields: {
      isa: 'PBXBuildFile',
      productRef: `${p.depUuid} /* ${p.product} */`,
    },
  }));
  return {localRefs, remoteRef, productDeps, buildFiles};
}

// Sync SPM Autolinking: timestamp check + conditional node re-run. Shared by
// the build phase (safety net) and the scheme pre-action (the one that
// actually fires before SPM resolution, so a single build picks up
// dep-graph changes from `npm install`).
// Build a PBXShellScriptBuildPhase entry (the "Sync SPM Autolinking" phase).
function shellScriptPhase(
  phaseUUID /*: string */,
  name /*: string */,
  script /*: string */,
  options /*: {inputPaths?: string, outputPaths?: string} */ = {},
) /*: {uuid: string, comment: string, fields: {[string]: string}} */ {
  const empty = '(\n\t\t\t)';
  return {
    uuid: phaseUUID,
    comment: name,
    fields: {
      isa: 'PBXShellScriptBuildPhase',
      buildActionMask: '2147483647',
      files: empty,
      inputFileListPaths: empty,
      inputPaths: options.inputPaths ?? empty,
      name: quoteIfNeeded(name),
      outputFileListPaths: empty,
      outputPaths: options.outputPaths ?? empty,
      runOnlyForDeploymentPostprocessing: '0',
      shellPath: '/bin/sh',
      shellScript: quoteIfNeeded(script),
    },
  };
}

function buildSyncAutolinkingScript(
  reactNativePath /*: string */,
) /*: string */ {
  return `set -euo pipefail

STAMP="$SRCROOT/build/generated/autolinking/.spm-sync-stamp"
STALE=0

# Check 0: xcframework artifacts missing (fresh clone)
if [ ! -f "$SRCROOT/build/xcframeworks/artifacts.json" ] || \\
   [ ! -d "$SRCROOT/build/xcframeworks/React.xcframework" ]; then
  STALE=1
fi

# Find project root (where package.json lives — may be an ancestor of SRCROOT)
PROJECT_ROOT="$SRCROOT"
while [ "$PROJECT_ROOT" != "/" ] && [ ! -f "$PROJECT_ROOT/package.json" ]; do
  PROJECT_ROOT="$(dirname "$PROJECT_ROOT")"
done
if [ ! -f "$PROJECT_ROOT/package.json" ]; then
  PROJECT_ROOT="$SRCROOT"
fi

# Check 1: dependency inputs (covers app projects after any package manager install)
for INPUT in \\
  "$PROJECT_ROOT/package.json" \\
  "$PROJECT_ROOT/react-native.config.js"; do
  if [ -f "$INPUT" ] && [ "$INPUT" -nt "$STAMP" ]; then
    STALE=1
    break
  fi
done

# Check workspace lockfiles and package-manager metadata. These cover package
# managers that do not reliably bump node_modules mtimes, and Yarn PnP projects
# that do not have node_modules at all.
if [ "$STALE" -eq 0 ]; then
  DIR="$PROJECT_ROOT"
  while [ "$DIR" != "/" ]; do
    for INPUT in \\
      "$DIR/package-lock.json" \\
      "$DIR/npm-shrinkwrap.json" \\
      "$DIR/yarn.lock" \\
      "$DIR/pnpm-lock.yaml" \\
      "$DIR/bun.lock" \\
      "$DIR/bun.lockb" \\
      "$DIR/.pnp.cjs" \\
      "$DIR/.pnp.loader.mjs"; do
      if [ -f "$INPUT" ] && [ "$INPUT" -nt "$STAMP" ]; then
        STALE=1
        break
      fi
    done
    if [ "$STALE" -eq 1 ]; then
      break
    fi
    DIR="$(dirname "$DIR")"
  done
fi

# Check node_modules mtime. In monorepos, node_modules may be hoisted to any
# ancestor between the app package and the workspace root.
if [ "$STALE" -eq 0 ]; then
  DIR="$PROJECT_ROOT"
  while [ "$DIR" != "/" ]; do
    NM_DIR="$DIR/node_modules"
    if [ -d "$NM_DIR" ] && [ "$NM_DIR" -nt "$STAMP" ]; then
      STALE=1
      break
    fi
    DIR="$(dirname "$DIR")"
  done
fi

# Also check the app root directly when SRCROOT is not the package root.
if [ "$STALE" -eq 0 ] && [ "$SRCROOT" != "$PROJECT_ROOT" ]; then
  if [ -d "$SRCROOT/node_modules" ] && [ "$SRCROOT/node_modules" -nt "$STAMP" ]; then
    STALE=1
  fi
fi

# Check 1.5: watched module source dirs (catches add/remove of source files
# in spm.modules and autolinked deps). Directory mtime updates on both add
# and remove of children, so a single -newer check covers both cases.
WATCH_FILE="$SRCROOT/build/generated/autolinking/.spm-sync-watch-paths"
if [ "$STALE" -eq 0 ] && [ -f "$WATCH_FILE" ]; then
  while IFS= read -r DIR; do
    [ -z "$DIR" ] && continue
    if [ -d "$DIR" ] && [ -n "$(find "$DIR" -newer "$STAMP" -print -quit 2>/dev/null)" ]; then
      STALE=1
      break
    fi
  done < "$WATCH_FILE"
fi

# Check 2: codegen spec files changed via git (covers monorepo after git pull)
if [ "$STALE" -eq 0 ] && [ -f "$STAMP" ]; then
  STAMP_TIME=$(stat -f %m "$STAMP" 2>/dev/null || stat -c %Y "$STAMP" 2>/dev/null || echo 0)
  LATEST_SPEC_COMMIT=$(git -C "$SRCROOT" log -1 --format=%ct -- '*.js' '*.ts' 2>/dev/null || echo 0)
  if [ "$LATEST_SPEC_COMMIT" -gt "$STAMP_TIME" ]; then
    STALE=1
  fi
fi

if [ ! -f "$STAMP" ]; then
  STALE=1
fi

if [ "$STALE" -eq 0 ]; then
  exit 0
fi

echo "SPM sync inputs changed — re-syncing (codegen + autolinking)..."

WITH_ENVIRONMENT="${reactNativePath}/scripts/xcode/with-environment.sh"

if [ -f "$WITH_ENVIRONMENT" ]; then
  # with-environment.sh references PODS_ROOT and $1, which may be unset.
  # Temporarily disable nounset to avoid failures when sourcing.
  export PODS_ROOT="\${PODS_ROOT:-$SRCROOT}"
  set +u
  . "$WITH_ENVIRONMENT"
  set -u
fi

cd "$SRCROOT"
if command -v npx >/dev/null 2>&1; then
  npx react-native spm sync
  RC=$?
  if [ "$RC" -eq 2 ]; then
    # Exit 2 = an autolinked community dependency has no Package.swift. The
    # autolinker already printed an \`error:\` line per dep (so Xcode shows them
    # and the fix). Fail the build — the developer must run
    # \`npx react-native spm scaffold\` from a terminal to generate the manifest.
    exit 1
  elif [ "$RC" -ne 0 ]; then
    echo "warning: SPM sync failed — build may use stale codegen/autolinking"
    exit 0
  fi
else
  echo "warning: npx not found — skipping SPM sync"
  exit 0
fi
`;
}

// XML-attribute escape (the five named entities). The sync script uses `>`
// and `&` for redirection and bg/and chains, plus `<` for heredocs and
// comparisons — all of which break Xcode's scheme parser if left raw.
function escapeXmlAttribute(s /*: string */) /*: string */ {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function generateXcscheme(
  appName /*: string */,
  targetUUID /*: string */,
  projName /*: string */,
  syncScript /*: string */,
) /*: string */ {
  const escapedSync = escapeXmlAttribute(syncScript);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1600"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <PreActions>
         <ExecutionAction
            ActionType = "Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction">
            <ActionContent
               title = "Sync SPM Autolinking"
               scriptText = "${escapedSync}">
               <EnvironmentBuildable>
                  <BuildableReference
                     BuildableIdentifier = "primary"
                     BlueprintIdentifier = "${targetUUID}"
                     BuildableName = "${appName}.app"
                     BlueprintName = "${appName}"
                     ReferencedContainer = "container:${projName}.xcodeproj">
                  </BuildableReference>
               </EnvironmentBuildable>
            </ActionContent>
         </ExecutionAction>
      </PreActions>
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "${targetUUID}"
               BuildableName = "${appName}.app"
               BlueprintName = "${appName}"
               ReferencedContainer = "container:${projName}.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      shouldUseLaunchSchemeArgsEnv = "YES"
      shouldAutocreateTestPlan = "YES">
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "${targetUUID}"
            BuildableName = "${appName}.app"
            BlueprintName = "${appName}"
            ReferencedContainer = "container:${projName}.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction
      buildConfiguration = "Release"
      shouldUseLaunchSchemeArgsEnv = "YES"
      savedToolIdentifier = ""
      useCustomWorkingDirectory = "NO"
      debugDocumentVersioning = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "${targetUUID}"
            BuildableName = "${appName}.app"
            BlueprintName = "${appName}"
            ReferencedContainer = "container:${projName}.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;
}

// When the xcodeproj is generated, the referenced SPM package directories
// (build/xcframeworks, autolinked, build/generated/ios) may not exist yet.
// Xcode resolves packages before any build phase runs, so we write minimal
// stub Package.swift files to let resolution succeed. The real generators
// (sync-spm-autolinking.js) overwrite these during the first build.

/*::
type StubPackageDef = {
  packageName: string,
  products: Array<string>,
};
*/

function generateStubPackageSwift(def /*: StubPackageDef */) /*: string */ {
  const {packageName, products} = def;
  const stubTarget = `${packageName.replace(/[^a-zA-Z0-9]/g, '')}Stub`;
  const productLines = products
    .map(p => `        .library(name: "${p}", targets: ["${stubTarget}"]),`)
    .join('\n');
  return `// swift-tools-version: 5.9
// GENERATED STUB — will be overwritten by sync-spm-autolinking.js during build.
import PackageDescription

let package = Package(
    name: "${packageName}",
    products: [
${productLines}
    ],
    targets: [
        .target(name: "${stubTarget}", path: "_stub", sources: ["Stub.swift"]),
    ]
)
`;
}

/**
 * Ensures each referenced SPM sub-package directory has a valid Package.swift
 * so Xcode can resolve packages before any build phase runs.
 * Skips directories that already contain a Package.swift (from a previous build).
 */
function ensureStubPackages(appRoot /*: string */) /*: void */ {
  // Derive stub definitions from SPM_PRODUCT_PACKAGES
  const byPath = new Map /*:: <string, StubPackageDef> */();
  for (const entry of SPM_PRODUCT_PACKAGES) {
    const existing = byPath.get(entry.packagePath);
    if (existing != null) {
      existing.products.push(entry.product);
    } else {
      byPath.set(entry.packagePath, {
        packageName: entry.packageName,
        products: [entry.product],
      });
    }
  }

  for (const [relPath, def] of byPath) {
    const pkgDir = path.join(appRoot, relPath);
    const pkgSwiftPath = path.join(pkgDir, 'Package.swift');

    if (fs.existsSync(pkgSwiftPath)) {
      continue;
    }

    fs.mkdirSync(pkgDir, {recursive: true});
    fs.writeFileSync(pkgSwiftPath, generateStubPackageSwift(def), 'utf8');

    // Create minimal stub source file required by SPM
    const stubDir = path.join(pkgDir, '_stub');
    fs.mkdirSync(stubDir, {recursive: true});
    const stubSwift = path.join(stubDir, 'Stub.swift');
    if (!fs.existsSync(stubSwift)) {
      fs.writeFileSync(
        stubSwift,
        '// Placeholder — replaced during first build.\n',
        'utf8',
      );
    }

    log(`Wrote stub Package.swift: ${relPath}/Package.swift`);
  }
}

// ---------------------------------------------------------------------------
// In-place injection: add SPM packages to a user's EXISTING xcodeproj.
//
// This never creates a target or scans sources — it splices the SPM dependency
// graph, the React build settings, and the sync build phase / scheme pre-action
// into the project the user already owns, leaving everything else
// byte-identical. The whole `spm add` / `spm update` xcodeproj strategy, so
// hand-tuned signing / capabilities / extra targets survive. Fails loud (the
// caller surfaces the error) when the project is CocoaPods-integrated or its
// shape can't be safely anchored.
// ---------------------------------------------------------------------------

// The React build settings the app target needs to compile against the SPM
// products.
const INJECTED_ARRAY_SETTINGS = [
  {
    key: 'HEADER_SEARCH_PATHS',
    values: ['"$(SRCROOT)/build/generated/autolinking/headers"'],
  },
  {key: 'OTHER_LDFLAGS', values: ['"-ObjC"']},
  {
    key: 'OTHER_SWIFT_FLAGS',
    values: [
      '"-Xcc"',
      '"-fmodule-map-file=$(BUILT_PRODUCTS_DIR)/React.framework/Modules/module.modulemap"',
    ],
  },
];

/** The XCBuildConfiguration UUIDs of a target (via its buildConfigurationList). */
function targetBuildConfigUuids(
  text /*: string */,
  targetObj /*: {bodyOpen: number, bodyClose: number, ...} */,
) /*: Array<string> */ {
  const listField = findField(text, targetObj, 'buildConfigurationList');
  if (listField == null) {
    return [];
  }
  const listMatch = listField.value.match(/[0-9A-Fa-f]{24}/);
  if (listMatch == null) {
    return [];
  }
  const listObj = findObjectByUuid(text, listMatch[0]);
  if (listObj == null) {
    return [];
  }
  const configs = findField(text, listObj, 'buildConfigurations');
  if (configs == null) {
    return [];
  }
  const matches = configs.value.match(/[0-9A-Fa-f]{24}/g);
  return matches != null ? Array.from(matches) : [];
}

/** True when a build config layers a CocoaPods `Pods-*.xcconfig`. */
function configUsesPods(
  text /*: string */,
  configUuid /*: string */,
) /*: boolean */ {
  const obj = findObjectByUuid(text, configUuid);
  if (obj == null) {
    return false;
  }
  const base = findField(text, obj, 'baseConfigurationReference');
  return base != null && /Pods[-/]/.test(base.value);
}

/**
 * Inspect an existing pbxproj and decide whether it can be injected. Returns
 * the chosen app target + its config/frameworks anchors, or a refusal reason
 * the caller surfaces (fail-loud).
 */
function planInjection(text /*: string */, opts /*: {appName?: ?string} */) /*:
  | {ok: true, rootUuid: string, target: {uuid: string, name: string, bodyOpen: number, bodyClose: number}, configUuids: Array<string>, frameworksPhaseUuid: string}
  | {ok: false, reason: string} */ {
  const project = findProjectObject(text);
  if (project == null) {
    return {ok: false, reason: 'no PBXProject object found'};
  }
  const apps = findApplicationTargets(text);
  if (apps.length === 0) {
    return {ok: false, reason: 'no application target found'};
  }
  let target;
  if (apps.length === 1) {
    target = apps[0];
  } else {
    const appName = opts.appName;
    if (appName == null) {
      return {
        ok: false,
        reason: `multiple application targets (${apps
          .map(a => a.name)
          .join(', ')}); pass --app-name to disambiguate`,
      };
    }
    target = apps.find(a => a.name === appName);
    if (target == null) {
      return {
        ok: false,
        reason: `no application target named "${appName}"`,
      };
    }
  }
  const configUuids = targetBuildConfigUuids(text, target);
  if (configUuids.length === 0) {
    return {ok: false, reason: 'could not resolve target build configurations'};
  }
  if (configUuids.some(c => configUsesPods(text, c))) {
    return {
      ok: false,
      reason:
        'target uses CocoaPods (Pods-*.xcconfig) — in-place injection only ' +
        'supports SPM-only targets',
    };
  }
  // The target's own Frameworks build phase (where product build files link).
  const buildPhases = findField(text, target, 'buildPhases');
  const phaseUuids =
    buildPhases != null
      ? (buildPhases.value.match(/[0-9A-Fa-f]{24}/g) ?? [])
      : [];
  let frameworksPhaseUuid = null;
  for (const pu of phaseUuids) {
    const po = findObjectByUuid(text, pu);
    if (po != null) {
      const isa = findField(text, po, 'isa');
      if (isa != null && /PBXFrameworksBuildPhase/.test(isa.value)) {
        frameworksPhaseUuid = pu;
        break;
      }
    }
  }
  if (frameworksPhaseUuid == null) {
    return {ok: false, reason: 'target has no Frameworks build phase'};
  }
  return {
    ok: true,
    rootUuid: project.uuid,
    target,
    configUuids,
    frameworksPhaseUuid,
  };
}

/**
 * Splice the SPM dependency graph + React build settings + sync build phase
 * into `text` and return the modified pbxproj. Pure string transform (no I/O),
 * idempotent: objects already present (by UUID) and array members / settings
 * already applied are skipped, so a second run is a no-op.
 */
function injectSpmIntoPbxproj(
  input /*: string */,
  plan /*: {rootUuid: string, targetUuid: string, configUuids: Array<string>, frameworksPhaseUuid: string} */,
  reactNativePath /*: string */,
  remote /*: ?RemoteCfg */,
) /*: {text: string, injectedUuids: Array<string>, createdArrayFields: Array<{container: 'project' | 'target', key: string}>, buildSettingChanges: Array<BuildSettingChange>} */ {
  let text = input;
  const mkUuid = (section /*: string */, id /*: string */) =>
    namespacedUUID(plan.rootUuid, section, id);
  const graph = buildSpmDependencyGraph(mkUuid, remote);
  const entries = spmGraphToEntries(graph);
  const injectedUuids /*: Array<string> */ = [];

  // 1. Insert the new objects (skip any UUID already present — idempotency).
  const insertObjects = (
    sectionName /*: string */,
    objs /*: ReadonlyArray<{readonly uuid: string, readonly comment?: ?string, readonly fields: {readonly [string]: string}, ...}> */,
  ) => {
    const fresh = objs.filter(o => !text.includes(o.uuid));
    for (const o of objs) {
      injectedUuids.push(o.uuid);
    }
    if (fresh.length === 0) {
      return;
    }
    text = insertObjectsIntoSection(
      text,
      sectionName,
      fresh.map(serializeEntry).join('\n'),
    );
  };
  insertObjects('XCLocalSwiftPackageReference', entries.localRefs);
  if (entries.remoteRef != null) {
    insertObjects('XCRemoteSwiftPackageReference', [entries.remoteRef]);
  }
  insertObjects('XCSwiftPackageProductDependency', entries.productDeps);
  insertObjects('PBXBuildFile', entries.buildFiles);

  // Track array fields we CREATE (vs. append to a pre-existing one) so deinit
  // can remove the whole field and land byte-identical to the original.
  const createdArrayFields /*: Array<{container: 'project' | 'target', key: string}> */ =
    [];

  // 2. packageReferences on the PBXProject.
  const pkgRefMembers = [
    ...(graph.remotePkgRef != null
      ? [{uuid: graph.remotePkgRef.uuid, comment: graph.remotePkgRef.comment}]
      : []),
    ...graph.localPkgRefs.map(r => ({uuid: r.uuid, comment: r.comment})),
  ];
  const project = findProjectObject(text);
  if (project != null) {
    if (findField(text, project, 'packageReferences') == null) {
      createdArrayFields.push({container: 'project', key: 'packageReferences'});
    }
    text = addArrayMembers(text, project, 'packageReferences', pkgRefMembers);
  }

  // 3. packageProductDependencies on the app target.
  const productMembers = graph.products.map(p => ({
    uuid: p.depUuid,
    comment: p.product,
  }));
  if (
    findField(
      text,
      findApplicationTargetByUuid(text, plan.targetUuid),
      'packageProductDependencies',
    ) == null
  ) {
    createdArrayFields.push({
      container: 'target',
      key: 'packageProductDependencies',
    });
  }
  text = addArrayMembers(
    text,
    findApplicationTargetByUuid(text, plan.targetUuid),
    'packageProductDependencies',
    productMembers,
  );

  // 4. product build files into the target's Frameworks phase.
  const phase = findObjectByUuid(text, plan.frameworksPhaseUuid);
  if (phase != null) {
    text = addArrayMembers(
      text,
      phase,
      'files',
      graph.products.map(p => ({
        uuid: p.buildFileUuid,
        comment: `${p.product} in Frameworks`,
      })),
    );
  }

  // 5. React build settings into every build config (Debug + Release).
  const buildSettingChanges /*: Array<BuildSettingChange> */ = [];
  for (const configUuid of plan.configUuids) {
    const merged = mergeReactBuildSettings(text, configUuid, reactNativePath);
    text = merged.text;
    buildSettingChanges.push(merged.change);
  }

  // 6. The Sync SPM Autolinking build phase (safety net; the scheme pre-action
  //    is what fires before SPM resolution). Prepended so it runs before
  //    Sources. We do NOT add a JS-bundle phase — an existing app already
  //    bundles JS via its own phase.
  const syncScript = buildSyncAutolinkingScript(reactNativePath);
  const syncPhaseUuid = mkUuid('PBXShellScriptBuildPhase', 'SyncAutolinking');
  if (!text.includes(syncPhaseUuid)) {
    text = insertObjectsIntoSection(
      text,
      'PBXShellScriptBuildPhase',
      serializeEntry(
        shellScriptPhase(syncPhaseUuid, 'Sync SPM Autolinking', syncScript),
      ),
    );
  }
  injectedUuids.push(syncPhaseUuid);
  text = addArrayMembers(
    text,
    findApplicationTargetByUuid(text, plan.targetUuid),
    'buildPhases',
    [{uuid: syncPhaseUuid, comment: 'Sync SPM Autolinking'}],
    {prepend: true},
  );

  return {text, injectedUuids, createdArrayFields, buildSettingChanges};
}

/** Re-locate an application target by UUID against the current text. */
function findApplicationTargetByUuid(
  text /*: string */,
  targetUuid /*: string */,
) /*: {uuid: string, bodyOpen: number, bodyClose: number} */ {
  const obj = findObjectByUuid(text, targetUuid);
  if (obj == null) {
    throw new Error(`pbxproj: app target ${targetUuid} disappeared mid-edit`);
  }
  return obj;
}

/**
 * Merge the React build settings into one XCBuildConfiguration's dict. Returns
 * the modified text plus a precise record of what was actually added — so
 * `deinit` (removeSpmInjection) can reverse exactly these edits, never touching
 * a value the user already had (key insight: ensureScalarField/
 * addArrayStringValues are no-ops / dedupe when a value is already present).
 */
function mergeReactBuildSettings(
  input /*: string */,
  configUuid /*: string */,
  reactNativePath /*: string */,
) /*: {text: string, change: BuildSettingChange} */ {
  let text = input;
  const scalars = [
    {key: 'CLANG_CXX_LANGUAGE_STANDARD', value: '"c++20"'},
    {key: 'REACT_NATIVE_PATH', value: quoteIfNeeded(reactNativePath)},
  ];
  // Re-locate the buildSettings dict before each edit (offsets shift).
  const dict = () => {
    const cfg = findObjectByUuid(text, configUuid);
    if (cfg == null) {
      return null;
    }
    const bs = findField(text, cfg, 'buildSettings');
    if (bs == null) {
      return null;
    }
    return {
      uuid: configUuid,
      bodyOpen: bs.valueStart,
      bodyClose: bs.tokenEnd - 1,
    };
  };
  const createdArrayKeys /*: Array<string> */ = [];
  const appendedArrayValues /*: {[string]: Array<string>} */ = {};
  const createdScalars /*: Array<string> */ = [];
  for (const {key, values} of INJECTED_ARRAY_SETTINGS) {
    const d = dict();
    if (d == null) {
      continue;
    }
    const existing = findField(text, d, key);
    if (existing == null) {
      createdArrayKeys.push(key);
    } else {
      const fresh = values.filter(v => !existing.value.includes(v));
      if (fresh.length > 0) {
        appendedArrayValues[key] = fresh;
      }
    }
    text = addArrayStringValues(text, d, key, values);
  }
  for (const {key, value} of scalars) {
    const d = dict();
    if (d == null) {
      continue;
    }
    if (findField(text, d, key) == null) {
      createdScalars.push(key);
    }
    text = ensureScalarField(text, d, key, value);
  }
  return {
    text,
    change: {configUuid, createdArrayKeys, appendedArrayValues, createdScalars},
  };
}

// Write only when content changed (avoids spurious Xcode reloads / git churn).
function writeIfChanged(
  filePath /*: string */,
  content /*: string */,
) /*: boolean */ {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  try {
    if (fs.readFileSync(filePath, 'utf8') === content) {
      return false;
    }
  } catch {
    /* file doesn't exist yet */
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

/**
 * Add the "Sync SPM Autolinking" pre-action to an existing scheme's
 * BuildAction, reusing the scheme's own primary BuildableReference. Returns
 * the XML unchanged when the pre-action is already present.
 */
function addPreActionToScheme(
  xml /*: string */,
  targetUuid /*: string */,
  syncScript /*: string */,
) /*: string */ {
  if (xml.includes('title = "Sync SPM Autolinking"')) {
    return xml;
  }
  const refMatch = xml.match(
    new RegExp(
      `<BuildableReference\\b[^>]*BlueprintIdentifier = "${targetUuid}"[^>]*>`,
    ),
  );
  const attr = (name /*: string */) => {
    const m =
      refMatch != null
        ? refMatch[0].match(new RegExp(`${name} = "([^"]*)"`))
        : null;
    return m != null ? m[1] : '';
  };
  const cleanRef =
    `<BuildableReference\n` +
    `                     BuildableIdentifier = "primary"\n` +
    `                     BlueprintIdentifier = "${targetUuid}"\n` +
    `                     BuildableName = "${attr('BuildableName')}"\n` +
    `                     BlueprintName = "${attr('BlueprintName')}"\n` +
    `                     ReferencedContainer = "${attr('ReferencedContainer')}">\n` +
    `                  </BuildableReference>`;
  const executionAction =
    `         <ExecutionAction\n` +
    `            ActionType = "Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction">\n` +
    `            <ActionContent\n` +
    `               title = "Sync SPM Autolinking"\n` +
    `               scriptText = "${escapeXmlAttribute(syncScript)}">\n` +
    `               <EnvironmentBuildable>\n` +
    `                  ${cleanRef}\n` +
    `               </EnvironmentBuildable>\n` +
    `            </ActionContent>\n` +
    `         </ExecutionAction>`;

  if (/<PreActions>/.test(xml)) {
    return xml.replace(
      '</PreActions>',
      `${executionAction}\n      </PreActions>`,
    );
  }
  const openEnd = xml.indexOf('>', xml.indexOf('<BuildAction'));
  if (openEnd < 0) {
    return xml; // no BuildAction — leave the scheme untouched
  }
  const block = `\n      <PreActions>\n${executionAction}\n      </PreActions>`;
  return xml.slice(0, openEnd + 1) + block + xml.slice(openEnd + 1);
}

/**
 * Ensure the app target's shared scheme runs the sync pre-action before SPM
 * resolution. Updates the scheme that builds the target if one exists,
 * otherwise creates a fresh shared scheme. Returns 'updated' | 'created' |
 * 'unchanged'.
 */
function injectOrCreateScheme(
  xcodeprojDir /*: string */,
  opts /*: {appName: string, targetUuid: string, projName: string, syncScript: string} */,
) /*: {status: 'updated' | 'unchanged' | 'created', file: string} */ {
  const schemesDir = path.join(xcodeprojDir, 'xcshareddata', 'xcschemes');
  let schemeFiles /*: Array<string> */ = [];
  try {
    schemeFiles = fs
      .readdirSync(schemesDir)
      .filter(f => f.endsWith('.xcscheme'));
  } catch {
    /* no shared schemes dir yet */
  }
  for (const f of schemeFiles) {
    const p = path.join(schemesDir, f);
    const xml = fs.readFileSync(p, 'utf8');
    if (xml.includes(`BlueprintIdentifier = "${opts.targetUuid}"`)) {
      const updated = addPreActionToScheme(
        xml,
        opts.targetUuid,
        opts.syncScript,
      );
      return {
        status: writeIfChanged(p, updated) ? 'updated' : 'unchanged',
        file: f,
      };
    }
  }
  const file = `${opts.appName}.xcscheme`;
  const xml = generateXcscheme(
    opts.appName,
    opts.targetUuid,
    opts.projName,
    opts.syncScript,
  );
  writeIfChanged(path.join(schemesDir, file), xml);
  return {status: 'created', file};
}

/**
 * Strip the empty `Pods` group `pod deintegrate` leaves in the navigator.
 * Called by `add --deintegrate` after deintegration so the converted project is
 * visually clean. No-op when absent or when the group still has children.
 */
function cleanupLeftoverPodsGroup(xcodeprojPath /*: string */) /*: boolean */ {
  const pbxprojPath = path.join(xcodeprojPath, 'project.pbxproj');
  if (!fs.existsSync(pbxprojPath)) {
    return false;
  }
  const original = fs.readFileSync(pbxprojPath, 'utf8');
  const cleaned = removeEmptyPodsGroup(original);
  return cleaned !== original ? writeIfChanged(pbxprojPath, cleaned) : false;
}

/**
 * Add SPM packages to a user's EXISTING xcodeproj in place. Returns
 * {status: 'injected', target} on success, or {status: 'refused', reason}
 * when the project can't be safely edited (caller surfaces it; fail-loud).
 */
function injectSpmIntoExistingXcodeproj(
  opts /*: {appRoot: string, reactNativeRoot: string, xcodeprojPath: string, appName?: ?string} */,
) /*: {status: 'injected', target: string} | {status: 'refused', reason: string} */ {
  const {appRoot, reactNativeRoot, xcodeprojPath} = opts;
  const pbxprojPath = path.join(xcodeprojPath, 'project.pbxproj');
  if (!fs.existsSync(pbxprojPath)) {
    return {
      status: 'refused',
      reason: `no project.pbxproj at ${xcodeprojPath}`,
    };
  }
  const original = fs.readFileSync(pbxprojPath, 'utf8');
  const plan = planInjection(original, {appName: opts.appName});
  if (!plan.ok) {
    return {status: 'refused', reason: plan.reason};
  }
  const reactNativePath = path.relative(appRoot, reactNativeRoot);
  const remote = remotePackageConfig(appRoot);
  const {text, injectedUuids, createdArrayFields, buildSettingChanges} =
    injectSpmIntoPbxproj(
      original,
      {
        rootUuid: plan.rootUuid,
        targetUuid: plan.target.uuid,
        configUuids: plan.configUuids,
        frameworksPhaseUuid: plan.frameworksPhaseUuid,
      },
      reactNativePath,
      remote,
    );

  const changed = writeIfChanged(pbxprojPath, text);
  log(
    changed
      ? `Injected SPM packages into ${path.relative(appRoot, pbxprojPath)}`
      : `${path.relative(appRoot, pbxprojPath)} already up to date`,
  );

  const projName = path.basename(xcodeprojPath, '.xcodeproj');
  const schemeResult = injectOrCreateScheme(xcodeprojPath, {
    appName: plan.target.name,
    targetUuid: plan.target.uuid,
    projName,
    syncScript: buildSyncAutolinkingScript(reactNativePath),
  });
  log(`Scheme sync pre-action: ${schemeResult.status}`);

  // Marker: idempotency signal + the exact, reversible record of every edit so
  // `deinit` (removeSpmInjection) can undo precisely what was added.
  writeIfChanged(
    path.join(xcodeprojPath, SPM_INJECTED_MARKER),
    JSON.stringify(
      {
        rootUuid: plan.rootUuid,
        target: plan.target.name,
        targetUuid: plan.target.uuid,
        injectedUuids: Array.from(new Set(injectedUuids)).sort(),
        createdArrayFields,
        buildSettingChanges,
        scheme: {
          file: schemeResult.file,
          created: schemeResult.status === 'created',
        },
      },
      null,
      2,
    ) + '\n',
  );

  ensureStubPackages(appRoot);
  return {status: 'injected', target: plan.target.name};
}

/**
 * Remove the "Sync SPM Autolinking" pre-action that addPreActionToScheme added
 * to a scheme, and drop the `<PreActions>` wrapper if it is left empty (the
 * byte-identical inverse for the common case where injection created it).
 */
function removePreActionFromScheme(xml /*: string */) /*: string */ {
  const withoutAction = xml.replace(
    /[ \t]*<ExecutionAction\b(?:(?!<\/ExecutionAction>)[\s\S])*?title = "Sync SPM Autolinking"(?:(?!<\/ExecutionAction>)[\s\S])*?<\/ExecutionAction>\n?/,
    '',
  );
  return withoutAction.replace(/\n[ \t]*<PreActions>\s*<\/PreActions>/, '');
}

/**
 * The exact inverse of `add` (injectSpmIntoExistingXcodeproj): using the
 * `.spm-injected.json` marker's precise record of every edit, remove only what
 * injection added — leaving any other (user) edits made afterwards intact. No
 * `git checkout`, no prompt. Returns {status:'absent'} when the project was
 * never injected.
 */
function removeSpmInjection(
  opts /*: {appRoot: string, xcodeprojPath: string} */,
) /*: {status: 'removed', target: string} | {status: 'absent'} */ {
  const {appRoot, xcodeprojPath} = opts;
  const markerPath = path.join(xcodeprojPath, SPM_INJECTED_MARKER);
  if (!fs.existsSync(markerPath)) {
    return {status: 'absent'};
  }
  // $FlowFixMe[incompatible-type] JSON.parse returns any
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const pbxprojPath = path.join(xcodeprojPath, 'project.pbxproj');
  let text = fs.readFileSync(pbxprojPath, 'utf8');

  const injectedUuids /*: Array<string> */ = marker.injectedUuids ?? [];

  // 1. Drop our array members, then the array fields we created (now empty),
  //    then the injected object definitions.
  text = removeArrayMembersByUuid(text, injectedUuids);
  for (const f of marker.createdArrayFields ?? []) {
    const obj =
      f.container === 'project'
        ? findProjectObject(text)
        : findObjectByUuid(text, marker.targetUuid);
    if (obj != null) {
      text = removeField(text, obj, f.key);
    }
  }
  for (const uuid of injectedUuids) {
    text = removeObjectByUuid(text, uuid);
  }
  // Drop any section that injection created and we just emptied (e.g.
  // XCLocalSwiftPackageReference) — a well-formed pbxproj never carries an
  // empty `/* Begin X *​/ /* End X *​/` section, so this lands byte-identical.
  text = text.replace(
    /\/\* Begin (\w+) section \*\/\n\/\* End \1 section \*\/\n\n/g,
    '',
  );

  // 2. Reverse the per-config build-setting edits (only what we added).
  for (const change of marker.buildSettingChanges ?? []) {
    const dict = () => {
      const cfg = findObjectByUuid(text, change.configUuid);
      if (cfg == null) {
        return null;
      }
      const bs = findField(text, cfg, 'buildSettings');
      if (bs == null) {
        return null;
      }
      return {
        uuid: change.configUuid,
        bodyOpen: bs.valueStart,
        bodyClose: bs.tokenEnd - 1,
      };
    };
    for (const key of Object.keys(change.appendedArrayValues ?? {})) {
      const d = dict();
      if (d != null) {
        text = removeArrayStringValues(
          text,
          d,
          key,
          change.appendedArrayValues[key],
        );
      }
    }
    for (const key of change.createdArrayKeys ?? []) {
      const d = dict();
      if (d != null) {
        text = removeField(text, d, key);
      }
    }
    for (const key of change.createdScalars ?? []) {
      const d = dict();
      if (d != null) {
        text = removeField(text, d, key);
      }
    }
  }

  writeIfChanged(pbxprojPath, text);
  log(`Removed SPM injection from ${path.relative(appRoot, pbxprojPath)}`);

  // 3. Scheme: delete it if injection created it, else strip the pre-action.
  const scheme = marker.scheme;
  if (scheme != null && scheme.file != null) {
    const schemePath = path.join(
      xcodeprojPath,
      'xcshareddata',
      'xcschemes',
      scheme.file,
    );
    if (scheme.created === true) {
      fs.rmSync(schemePath, {force: true});
    } else if (fs.existsSync(schemePath)) {
      const xml = fs.readFileSync(schemePath, 'utf8');
      writeIfChanged(schemePath, removePreActionFromScheme(xml));
    }
  }

  // 4. Drop the marker — the project is no longer SPM-injected.
  fs.rmSync(markerPath, {force: true});
  return {status: 'removed', target: marker.target};
}

module.exports = {
  generateXcscheme,
  ensureStubPackages,
  buildSpmDependencyGraph,
  spmGraphToEntries,
  planInjection,
  injectSpmIntoPbxproj,
  injectSpmIntoExistingXcodeproj,
  removeSpmInjection,
  cleanupLeftoverPodsGroup,
  addPreActionToScheme,
  removePreActionFromScheme,
  SPM_INJECTED_MARKER,
};
