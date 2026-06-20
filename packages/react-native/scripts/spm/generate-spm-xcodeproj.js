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

/*:: import type {GenerateXcodeprojArgs} from './spm-types'; */

/**
 * generate-spm-xcodeproj.js – Generates a <AppName>.xcodeproj that uses the
 * SPM Package.swift as its dependency source. This provides proper code
 * signing, asset handling, and device deployment that a bare SPM executable
 * target cannot provide.
 *
 * The generated xcodeproj uses the same filename as the legacy CocoaPods
 * xcodeproj (<AppName>.xcodeproj) so `npm run ios` / xcodebuild resolve
 * unambiguously. The legacy is renamed to <AppName>.xcodeproj.legacy on
 * `spm init` before this generator runs (see
 * maybeMigrateLegacyXcodeproj in setup-apple-spm.js). The SPM-managed
 * xcodeproj is tagged with a sidecar `.spm-managed` marker file so it
 * can be distinguished from a non-migrated legacy with the same filename.
 *
 * Usage:
 *   node generate-spm-xcodeproj.js [options]
 *
 * Options:
 *   --app-root <path>            Path to the app directory (default: cwd)
 *   --react-native-root <path>   Path to react-native package root
 *   --app-name <name>            App name (default: from package.json)
 *   --source-path <path>         Path to app source relative to app-root
 *   --ios-version <ver>          Minimum iOS version (default: 15)
 *   --bundle-identifier <id>     Bundle identifier (default: com.facebook.<AppName>)
 *   --entry-file <path>          JS entry file relative to app root (default: package.json "main" or index.js)
 */

const {findSourcePath} = require('./generate-spm-package');
const {
  addArrayMembers,
  addArrayStringValues,
  ensureScalarField,
  fileTypeForExtension,
  findApplicationTargets,
  findField,
  findObjectByUuid,
  findProjectObject,
  generateUUID,
  insertObjectsIntoSection,
  namespacedUUID,
  quoteIfNeeded,
  scanProjectFiles,
  serializeEntry,
  serializePbxproj,
} = require('./spm-pbxproj');
const {
  deriveAppName,
  findProjectRoot,
  makeLogger,
  resolveReactNativeRoot,
  remotePackageConfig,
  RemoteVersionError,
} = require('./spm-utils');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs');

const {log} = makeLogger('generate-spm-xcodeproj');

// Sidecar inside the SPM-managed xcodeproj. Distinguishes the SPM-generated
// `<App>.xcodeproj` from a legacy CocoaPods one with the same filename.
const SPM_MANAGED_MARKER = '.spm-managed';
const SPM_MANAGED_MARKER_HEADER = '# Managed by `npx react-native spm`.';

// Sidecar inside a USER-OWNED xcodeproj that SPM packages were injected into
// in place (as opposed to a from-scratch SPM-managed project). Records the
// host project's root UUID + every UUID we added so `clean` can revert and
// re-runs stay idempotent.
const SPM_INJECTED_MARKER = '.spm-injected.json';

function parseArgs(argv /*: Array<string> */) /*: GenerateXcodeprojArgs */ {
  const parsed = yargs(argv)
    .version(false)
    .option('app-root', {
      type: 'string',
      default: process.cwd(),
      describe: 'Path to the app directory',
    })
    .option('react-native-root', {
      type: 'string',
      describe: 'Path to react-native package root',
    })
    .option('app-name', {
      type: 'string',
      describe: 'App name (default: from package.json)',
    })
    .option('source-path', {
      type: 'string',
      describe: 'Path to app source relative to app-root',
    })
    .option('ios-version', {
      type: 'string',
      default: '15',
      describe: 'Minimum iOS version',
    })
    .option('bundle-identifier', {
      type: 'string',
      describe: 'Bundle identifier (default: com.facebook.<AppName>)',
    })
    .option('entry-file', {
      type: 'string',
      describe: 'JS entry file relative to app root (default: index.js)',
    })
    .usage(
      'Usage: $0 [options]\n\nGenerates a <AppName>.xcodeproj for a React Native app using SPM.',
    )
    .help()
    .parseSync();

  return {
    appRoot: parsed['app-root'],
    reactNativeRoot: parsed['react-native-root'] ?? null,
    appName: parsed['app-name'] ?? null,
    sourcePath: parsed['source-path'] ?? null,
    iosVersion: parsed['ios-version'],
    bundleIdentifier: parsed['bundle-identifier'] ?? null,
    entryFile: parsed['entry-file'] ?? null,
  };
}

function uuid(
  projectName /*: string */,
  section /*: string */,
  id /*: string */,
) /*: string */ {
  return generateUUID(`${projectName}:${section}:${id}`);
}

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
 * `mkUuid(section, id)` supplies UUIDs — the from-scratch generator seeds it
 * with the app name, the in-place injector seeds it with the host project's
 * root UUID. Sharing this builder keeps both paths' SPM wiring identical.
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
 * Render the SPM graph into pbxproj section entry objects (the same shapes the
 * from-scratch generator emits). Used by the in-place injector to splice these
 * objects into an existing project.
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

function generatePbxproj(
  opts /*: {
  appName: string,
  sourcePath: string,
  iosVersion: string,
  bundleIdentifier: string,
  reactNativePath: string,
  files: {sources: Array<string>, headers: Array<string>, resources: Array<string>, plists: Array<string>},
  hasPrivacyInfo: boolean,
  entryFile?: string,
  appRoot?: string,
} */,
) /*: string */ {
  const {
    appName,
    sourcePath,
    iosVersion,
    bundleIdentifier,
    reactNativePath,
    files,
    hasPrivacyInfo,
  } = opts;
  const entryFile = opts.entryFile ?? 'index.js';
  const appRoot = opts.appRoot;

  const projectUUID = uuid(appName, 'PBXProject', 'root');
  const mainGroupUUID = uuid(appName, 'PBXGroup', 'mainGroup');
  const sourcesGroupUUID = uuid(appName, 'PBXGroup', 'sourcesGroup');
  const productsGroupUUID = uuid(appName, 'PBXGroup', 'Products');
  const targetUUID = uuid(appName, 'PBXNativeTarget', appName);
  const productRefUUID = uuid(appName, 'PBXFileReference', `${appName}.app`);
  const sourcesBuildPhaseUUID = uuid(
    appName,
    'PBXSourcesBuildPhase',
    'Sources',
  );
  const resourcesBuildPhaseUUID = uuid(
    appName,
    'PBXResourcesBuildPhase',
    'Resources',
  );
  const frameworksBuildPhaseUUID = uuid(
    appName,
    'PBXFrameworksBuildPhase',
    'Frameworks',
  );
  const bundleScriptUUID = uuid(
    appName,
    'PBXShellScriptBuildPhase',
    'BundleJS',
  );

  const projectConfigListUUID = uuid(appName, 'XCConfigurationList', 'project');
  const targetConfigListUUID = uuid(appName, 'XCConfigurationList', 'target');
  const projectDebugConfigUUID = uuid(
    appName,
    'XCBuildConfiguration',
    'project:Debug',
  );
  const projectReleaseConfigUUID = uuid(
    appName,
    'XCBuildConfiguration',
    'project:Release',
  );
  const targetDebugConfigUUID = uuid(
    appName,
    'XCBuildConfiguration',
    'target:Debug',
  );
  const targetReleaseConfigUUID = uuid(
    appName,
    'XCBuildConfiguration',
    'target:Release',
  );
  // Remote SPM package mode: the ReactNative-family products reference the
  // remote package (XCRemoteSwiftPackageReference) instead of the local
  // artifacts package. The SPM graph (package refs + product deps + their
  // frameworks build files) is resolved by the shared builder so the
  // from-scratch and in-place-injection paths stay identical.
  const remote = appRoot != null ? remotePackageConfig(appRoot) : null;
  const spmGraph = buildSpmDependencyGraph(
    (section, id) => uuid(appName, section, id),
    remote,
  );
  const uniquePackages = spmGraph.uniquePackages;
  const localPkgRefUUIDs = spmGraph.localPkgRefs.map(r => r.uuid);
  const remotePkgRefUUID =
    spmGraph.remotePkgRef != null ? spmGraph.remotePkgRef.uuid : null;

  /*:: type PbxEntry = {uuid: string, comment: string, fields: {[string]: string}}; */

  const buildFileEntries /*: Array<PbxEntry> */ = [];
  const fileRefEntries /*: Array<PbxEntry> */ = [];
  const sourcesBuildFileUUIDs /*: Array<{uuid: string, comment: string}> */ =
    [];
  const resourcesBuildFileUUIDs /*: Array<{uuid: string, comment: string}> */ =
    [];
  const sourcesGroupChildren /*: Array<{uuid: string, comment: string}> */ = [];

  // Helper: create a PBXFileReference entry and add to group children.
  // Returns the fileRef UUID for optional build-phase tracking.
  function addFileRef(file /*: string */) /*: string */ {
    const fileName = path.basename(file);
    const ext = path.extname(file);
    const fileRefId = uuid(appName, 'PBXFileReference', file);
    fileRefEntries.push({
      uuid: fileRefId,
      comment: fileName,
      fields: {
        isa: 'PBXFileReference',
        lastKnownFileType: quoteIfNeeded(fileTypeForExtension(ext)),
        path: quoteIfNeeded(file),
        sourceTree: quoteIfNeeded('<group>'),
      },
    });
    sourcesGroupChildren.push({uuid: fileRefId, comment: fileName});
    return fileRefId;
  }

  // Helper: create a PBXBuildFile entry linking to a file reference.
  function addBuildFile(
    prefix /*: string */,
    file /*: string */,
    fileRefId /*: string */,
    phase /*: string */,
  ) /*: string */ {
    const fileName = path.basename(file);
    const buildFileId = uuid(appName, 'PBXBuildFile', `${prefix}:${file}`);
    buildFileEntries.push({
      uuid: buildFileId,
      comment: `${fileName} in ${phase}`,
      fields: {
        isa: 'PBXBuildFile',
        fileRef: `${fileRefId} /* ${fileName} */`,
      },
    });
    return buildFileId;
  }

  for (const file of files.sources) {
    const fileRefId = addFileRef(file);
    const buildFileId = addBuildFile('src', file, fileRefId, 'Sources');
    sourcesBuildFileUUIDs.push({
      uuid: buildFileId,
      comment: `${path.basename(file)} in Sources`,
    });
  }

  for (const file of files.headers) {
    addFileRef(file);
  }

  for (const file of files.resources) {
    const fileRefId = addFileRef(file);
    const buildFileId = addBuildFile('res', file, fileRefId, 'Resources');
    resourcesBuildFileUUIDs.push({
      uuid: buildFileId,
      comment: `${path.basename(file)} in Resources`,
    });
  }

  for (const file of files.plists) {
    addFileRef(file);
  }

  // PrivacyInfo.xcprivacy (lives at app root, outside source dir)
  const privacyInfoFileRefUUID = uuid(
    appName,
    'PBXFileReference',
    'PrivacyInfo.xcprivacy',
  );
  const privacyInfoBuildFileUUID = uuid(
    appName,
    'PBXBuildFile',
    'res:PrivacyInfo.xcprivacy',
  );
  if (hasPrivacyInfo) {
    fileRefEntries.push({
      uuid: privacyInfoFileRefUUID,
      comment: 'PrivacyInfo.xcprivacy',
      fields: {
        isa: 'PBXFileReference',
        lastKnownFileType: quoteIfNeeded(fileTypeForExtension('.xcprivacy')),
        path: 'PrivacyInfo.xcprivacy',
        sourceTree: quoteIfNeeded('<group>'),
      },
    });
    buildFileEntries.push({
      uuid: privacyInfoBuildFileUUID,
      comment: 'PrivacyInfo.xcprivacy in Resources',
      fields: {
        isa: 'PBXBuildFile',
        fileRef: `${privacyInfoFileRefUUID} /* PrivacyInfo.xcprivacy */`,
      },
    });
    resourcesBuildFileUUIDs.push({
      uuid: privacyInfoBuildFileUUID,
      comment: 'PrivacyInfo.xcprivacy in Resources',
    });
  }

  fileRefEntries.push({
    uuid: productRefUUID,
    comment: `${appName}.app`,
    fields: {
      isa: 'PBXFileReference',
      explicitFileType: quoteIfNeeded('wrapper.application'),
      includeInIndex: '0',
      path: quoteIfNeeded(`${appName}.app`),
      sourceTree: 'BUILT_PRODUCTS_DIR',
    },
  });

  // SPM package product dependencies + their frameworks build files, rendered
  // from the shared graph so the entry shapes match the injector exactly.
  const spmEntries = spmGraphToEntries(spmGraph);
  const spmDepEntries /*: Array<PbxEntry> */ = spmEntries.productDeps;
  const spmDepUUIDs /*: Array<string> */ = spmGraph.products.map(
    p => p.depUuid,
  );
  for (const bf of spmEntries.buildFiles) {
    buildFileEntries.push(bf);
  }

  const bundleJSScript = `set -e

export PROJECT_ROOT="$SRCROOT"
export ENTRY_FILE="$SRCROOT/${entryFile}"

WITH_ENVIRONMENT="${reactNativePath}/scripts/xcode/with-environment.sh"
REACT_NATIVE_XCODE="${reactNativePath}/scripts/react-native-xcode.sh"

/bin/sh -c "$WITH_ENVIRONMENT $REACT_NATIVE_XCODE"
`;

  /*:: type SectionMap = {[string]: Array<PbxEntry>}; */
  const sections /*: SectionMap */ = {};

  sections.PBXBuildFile = buildFileEntries;

  sections.PBXFileReference = fileRefEntries;

  const frameworkBuildFileUUIDs = spmGraph.products.map(p => p.buildFileUuid);
  sections.PBXFrameworksBuildPhase = [
    {
      uuid: frameworksBuildPhaseUUID,
      comment: 'Frameworks',
      fields: {
        isa: 'PBXFrameworksBuildPhase',
        buildActionMask: '2147483647',
        files: `(\n${frameworkBuildFileUUIDs.map(id => `\t\t\t\t${id},\n`).join('')}\t\t\t)`,
        runOnlyForDeploymentPostprocessing: '0',
      },
    },
  ];

  const mainGroupChildren = [`${sourcesGroupUUID} /* ${sourcePath} */`];
  if (hasPrivacyInfo) {
    mainGroupChildren.push(
      `${privacyInfoFileRefUUID} /* PrivacyInfo.xcprivacy */`,
    );
  }
  mainGroupChildren.push(`${productsGroupUUID} /* Products */`);

  sections.PBXGroup = [
    {
      uuid: mainGroupUUID,
      comment: '',
      fields: {
        isa: 'PBXGroup',
        children: `(\n${mainGroupChildren.map(c => `\t\t\t\t${c},\n`).join('')}\t\t\t)`,
        sourceTree: quoteIfNeeded('<group>'),
      },
    },
    {
      uuid: sourcesGroupUUID,
      comment: sourcePath,
      fields: {
        isa: 'PBXGroup',
        children: `(\n${sourcesGroupChildren.map(c => `\t\t\t\t${c.uuid} /* ${c.comment} */,\n`).join('')}\t\t\t)`,
        path: quoteIfNeeded(sourcePath),
        sourceTree: quoteIfNeeded('<group>'),
      },
    },
    {
      uuid: productsGroupUUID,
      comment: 'Products',
      fields: {
        isa: 'PBXGroup',
        children: `(\n\t\t\t\t${productRefUUID} /* ${appName}.app */,\n\t\t\t)`,
        name: 'Products',
        sourceTree: quoteIfNeeded('<group>'),
      },
    },
  ];

  const syncAutolinkingScriptUUID = uuid(
    appName,
    'PBXShellScriptBuildPhase',
    'SyncAutolinking',
  );
  const buildPhasesList = [
    `${syncAutolinkingScriptUUID} /* Sync SPM Autolinking */`,
    `${sourcesBuildPhaseUUID} /* Sources */`,
    `${frameworksBuildPhaseUUID} /* Frameworks */`,
    `${resourcesBuildPhaseUUID} /* Resources */`,
    `${bundleScriptUUID} /* Build JS Bundle */`,
  ];
  sections.PBXNativeTarget = [
    {
      uuid: targetUUID,
      comment: appName,
      fields: {
        isa: 'PBXNativeTarget',
        buildConfigurationList: `${targetConfigListUUID} /* Build configuration list for PBXNativeTarget "${appName}" */`,
        buildPhases: `(\n${buildPhasesList.map(p => `\t\t\t\t${p},\n`).join('')}\t\t\t)`,
        buildRules: '(\n\t\t\t)',
        dependencies: '(\n\t\t\t)',
        name: quoteIfNeeded(appName),
        packageProductDependencies: `(\n${spmDepUUIDs.map(id => `\t\t\t\t${id},\n`).join('')}\t\t\t)`,
        productName: quoteIfNeeded(appName),
        productReference: `${productRefUUID} /* ${appName}.app */`,
        productType: quoteIfNeeded('com.apple.product-type.application'),
      },
    },
  ];

  sections.PBXProject = [
    {
      uuid: projectUUID,
      comment: 'Project object',
      fields: {
        isa: 'PBXProject',
        attributes: `{\n\t\t\t\tBuildIndependentTargetsInParallel = 1;\n\t\t\t\tLastUpgradeCheck = 1600;\n\t\t\t}`,
        buildConfigurationList: `${projectConfigListUUID} /* Build configuration list for PBXProject "${appName}" */`,
        mainGroup: mainGroupUUID,
        packageReferences: `(\n${remotePkgRefUUID != null ? `\t\t\t\t${remotePkgRefUUID} /* XCRemoteSwiftPackageReference "${remote?.identity ?? ''}" */,\n` : ''}${localPkgRefUUIDs.map((id, i) => `\t\t\t\t${id} /* XCLocalSwiftPackageReference "${uniquePackages[i].packagePath}" */,\n`).join('')}\t\t\t)`,
        productRefGroup: `${productsGroupUUID} /* Products */`,
        projectDirPath: quoteIfNeeded(''),
        projectRoot: quoteIfNeeded(''),
        targets: `(\n\t\t\t\t${targetUUID} /* ${appName} */,\n\t\t\t)`,
      },
    },
  ];

  sections.PBXResourcesBuildPhase = [
    {
      uuid: resourcesBuildPhaseUUID,
      comment: 'Resources',
      fields: {
        isa: 'PBXResourcesBuildPhase',
        buildActionMask: '2147483647',
        files: `(\n${resourcesBuildFileUUIDs.map(r => `\t\t\t\t${r.uuid} /* ${r.comment} */,\n`).join('')}\t\t\t)`,
        runOnlyForDeploymentPostprocessing: '0',
      },
    },
  ];

  // Sync SPM Autolinking: timestamp check + conditional node re-run.
  // Built once at top-level so the same string flows into both the build
  // phase (safety net) and the scheme pre-action (the one that actually
  // runs before SPM resolution).
  const syncAutolinkingScript = buildSyncAutolinkingScript(reactNativePath);

  sections.PBXShellScriptBuildPhase = [
    shellScriptPhase(
      syncAutolinkingScriptUUID,
      'Sync SPM Autolinking',
      syncAutolinkingScript,
    ),
    shellScriptPhase(bundleScriptUUID, 'Build JS Bundle', bundleJSScript),
  ];

  sections.PBXSourcesBuildPhase = [
    {
      uuid: sourcesBuildPhaseUUID,
      comment: 'Sources',
      fields: {
        isa: 'PBXSourcesBuildPhase',
        buildActionMask: '2147483647',
        files: `(\n${sourcesBuildFileUUIDs.map(s => `\t\t\t\t${s.uuid} /* ${s.comment} */,\n`).join('')}\t\t\t)`,
        runOnlyForDeploymentPostprocessing: '0',
      },
    },
  ];

  const debugProjectSettings = `{\n\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;\n\t\t\t\tCLANG_CXX_LANGUAGE_STANDARD = "c++20";\n\t\t\t\tCLANG_ENABLE_MODULES = YES;\n\t\t\t\tCLANG_ENABLE_OBJC_ARC = YES;\n\t\t\t\tCOPY_PHASE_STRIP = NO;\n\t\t\t\tDEBUG_INFORMATION_FORMAT = dwarf;\n\t\t\t\tENABLE_STRICT_OBJC_MSGSEND = YES;\n\t\t\t\tENABLE_TESTABILITY = YES;\n\t\t\t\tGCC_DYNAMIC_NO_PIC = NO;\n\t\t\t\tGCC_NO_COMMON_BLOCKS = YES;\n\t\t\t\tGCC_OPTIMIZATION_LEVEL = 0;\n\t\t\t\tGCC_PREPROCESSOR_DEFINITIONS = (\n\t\t\t\t\t"DEBUG=1",\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t);\n\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = ${iosVersion};\n\t\t\t\tMTL_ENABLE_DEBUG_INFO = INCLUDE_SOURCE;\n\t\t\t\tONLY_ACTIVE_ARCH = YES;\n\t\t\t\tSDKROOT = iphoneos;\n\t\t\t\tSUPPORTED_PLATFORMS = "iphoneos iphonesimulator";\n\t\t\t\tSUPPORTS_MACCATALYST = NO;\n\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;\n\t\t\t\t\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-Onone";\n\t\t\t\tSWIFT_VERSION = 5.0;\n\t\t\t}`;

  const releaseProjectSettings = `{\n\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;\n\t\t\t\tCLANG_CXX_LANGUAGE_STANDARD = "c++20";\n\t\t\t\tCLANG_ENABLE_MODULES = YES;\n\t\t\t\tCLANG_ENABLE_OBJC_ARC = YES;\n\t\t\t\tCOPY_PHASE_STRIP = YES;\n\t\t\t\tDEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";\n\t\t\t\tENABLE_NS_ASSERTIONS = NO;\n\t\t\t\tENABLE_STRICT_OBJC_MSGSEND = YES;\n\t\t\t\tGCC_NO_COMMON_BLOCKS = YES;\n\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = ${iosVersion};\n\t\t\t\tSDKROOT = iphoneos;\n\t\t\t\tSUPPORTED_PLATFORMS = "iphoneos iphonesimulator";\n\t\t\t\tSUPPORTS_MACCATALYST = NO;\n\t\t\t\tSWIFT_COMPILATION_MODE = wholemodule;\n\t\t\t\t\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-O";\n\t\t\t\tSWIFT_VERSION = 5.0;\n\t\t\t\tVALIDATE_PRODUCT = YES;\n\t\t\t}`;

  // Find Info.plist path
  const infoPlistFile = files.plists.find(
    p => path.basename(p) === 'Info.plist',
  );
  const infoPlistSetting =
    infoPlistFile != null
      ? `"$(SRCROOT)/${sourcePath}/${infoPlistFile}"`
      : `"$(SRCROOT)/${sourcePath}/Info.plist"`;

  const targetBuildSettings = (isDebug /*: boolean */) => {
    // The app shim compiles against the SPM products: React headers come from
    // the copied React.framework (BUILT_PRODUCTS_DIR) + the ReactNativeHeaders
    // / ReactAppHeaders binaryTarget+target header serving — no search paths.
    // Only the autolinking headers farm remains for cross-package includes.
    const lines = [
      `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon`,
      `CLANG_CXX_LANGUAGE_STANDARD = "c++20"`,
      `DEVELOPMENT_TEAM = ""`,
      `HEADER_SEARCH_PATHS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"$(SRCROOT)/build/generated/autolinking/headers",\n\t\t\t\t)`,
      `INFOPLIST_FILE = ${infoPlistSetting}`,
      `IPHONEOS_DEPLOYMENT_TARGET = ${iosVersion}`,
      `LD_RUNPATH_SEARCH_PATHS = (\n\t\t\t\t\t/usr/lib/swift,\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"@executable_path/Frameworks",\n\t\t\t\t)`,
      `OTHER_CFLAGS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t)`,
      `OTHER_LDFLAGS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"-ObjC",\n\t\t\t\t)`,
      // The React framework module map (headers live inside the copied
      // framework) for Swift's clang importer.
      `OTHER_SWIFT_FLAGS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"-Xcc",\n\t\t\t\t\t"-fmodule-map-file=$(BUILT_PRODUCTS_DIR)/React.framework/Modules/module.modulemap",\n\t\t\t\t)`,
      `PRODUCT_BUNDLE_IDENTIFIER = ${quoteIfNeeded(bundleIdentifier)}`,
      `PRODUCT_NAME = ${quoteIfNeeded(appName)}`,
      `REACT_NATIVE_PATH = ${quoteIfNeeded(reactNativePath)}`,
      `SWIFT_VERSION = 5.0`,
      `TARGETED_DEVICE_FAMILY = "1,2"`,
    ];
    if (isDebug) {
      lines.push(`SWIFT_OPTIMIZATION_LEVEL = "-Onone"`);
    }
    return `{\n${lines.map(l => `\t\t\t\t${l};`).join('\n')}\n\t\t\t}`;
  };

  sections.XCBuildConfiguration = [
    {
      uuid: projectDebugConfigUUID,
      comment: 'Debug',
      fields: {
        isa: 'XCBuildConfiguration',
        buildSettings: debugProjectSettings,
        name: 'Debug',
      },
    },
    {
      uuid: projectReleaseConfigUUID,
      comment: 'Release',
      fields: {
        isa: 'XCBuildConfiguration',
        buildSettings: releaseProjectSettings,
        name: 'Release',
      },
    },
    {
      uuid: targetDebugConfigUUID,
      comment: 'Debug',
      fields: {
        isa: 'XCBuildConfiguration',
        buildSettings: targetBuildSettings(true),
        name: 'Debug',
      },
    },
    {
      uuid: targetReleaseConfigUUID,
      comment: 'Release',
      fields: {
        isa: 'XCBuildConfiguration',
        buildSettings: targetBuildSettings(false),
        name: 'Release',
      },
    },
  ];

  sections.XCConfigurationList = [
    {
      uuid: projectConfigListUUID,
      comment: `Build configuration list for PBXProject "${appName}"`,
      fields: {
        isa: 'XCConfigurationList',
        buildConfigurations: `(\n\t\t\t\t${projectDebugConfigUUID} /* Debug */,\n\t\t\t\t${projectReleaseConfigUUID} /* Release */,\n\t\t\t)`,
        defaultConfigurationIsVisible: '0',
        defaultConfigurationName: 'Release',
      },
    },
    {
      uuid: targetConfigListUUID,
      comment: `Build configuration list for PBXNativeTarget "${appName}"`,
      fields: {
        isa: 'XCConfigurationList',
        buildConfigurations: `(\n\t\t\t\t${targetDebugConfigUUID} /* Debug */,\n\t\t\t\t${targetReleaseConfigUUID} /* Release */,\n\t\t\t)`,
        defaultConfigurationIsVisible: '0',
        defaultConfigurationName: 'Release',
      },
    },
  ];

  sections.XCLocalSwiftPackageReference = spmEntries.localRefs;

  if (spmEntries.remoteRef != null) {
    sections.XCRemoteSwiftPackageReference = [spmEntries.remoteRef];
  }

  sections.XCSwiftPackageProductDependency = spmDepEntries;

  return serializePbxproj('1', '77', projectUUID, sections);
}

// Sync SPM Autolinking: timestamp check + conditional node re-run. Shared by
// the build phase (safety net) and the scheme pre-action (the one that
// actually fires before SPM resolution, so a single build picks up
// dep-graph changes from `npm install`).
// Build a PBXShellScriptBuildPhase entry. Module-scoped so both the
// from-scratch generator and the in-place injector emit identical phases.
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

function generateXcworkspaceData(projName /*: string */) /*: string */ {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Workspace
   version = "1.0">
   <FileRef
      location = "self:${projName}.xcodeproj">
   </FileRef>
</Workspace>
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
// Unlike the from-scratch generator above, this never creates a target or
// scans sources — it splices the SPM dependency graph, the React build
// settings, and the sync build phase / scheme pre-action into the project the
// user already owns, leaving everything else byte-identical. Used as the
// default `spm init` path so hand-tuned signing / capabilities / extra targets
// survive. Refuses (so the caller can fall back to from-scratch) when the
// project is CocoaPods-integrated or its shape can't be safely anchored.
// ---------------------------------------------------------------------------

// The React build settings the app target needs to compile against the SPM
// products. Mirrors targetBuildSettings() in the from-scratch generator.
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
 * the caller turns into a from-scratch fallback.
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
) /*: {text: string, injectedUuids: Array<string>} */ {
  let text = input;
  const mkUuid = (section /*: string */, id /*: string */) =>
    namespacedUUID(plan.rootUuid, section, id);
  const graph = buildSpmDependencyGraph(mkUuid, remote);
  const entries = spmGraphToEntries(graph);
  const injectedUuids /*: Array<string> */ = [];

  // 1. Insert the new objects (skip any UUID already present — idempotency).
  const insertObjects = (
    sectionName /*: string */,
    objs /*: $ReadOnlyArray<{+uuid: string, +comment?: ?string, +fields: {+[string]: string}, ...}> */,
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

  // 2. packageReferences on the PBXProject.
  const pkgRefMembers = [
    ...(graph.remotePkgRef != null
      ? [{uuid: graph.remotePkgRef.uuid, comment: graph.remotePkgRef.comment}]
      : []),
    ...graph.localPkgRefs.map(r => ({uuid: r.uuid, comment: r.comment})),
  ];
  const project = findProjectObject(text);
  if (project != null) {
    text = addArrayMembers(text, project, 'packageReferences', pkgRefMembers);
  }

  // 3. packageProductDependencies on the app target.
  const productMembers = graph.products.map(p => ({
    uuid: p.depUuid,
    comment: p.product,
  }));
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
  for (const configUuid of plan.configUuids) {
    text = mergeReactBuildSettings(text, configUuid, reactNativePath);
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

  return {text, injectedUuids};
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

/** Merge the React build settings into one XCBuildConfiguration's dict. */
function mergeReactBuildSettings(
  input /*: string */,
  configUuid /*: string */,
  reactNativePath /*: string */,
) /*: string */ {
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
  for (const {key, values} of INJECTED_ARRAY_SETTINGS) {
    const d = dict();
    if (d != null) {
      text = addArrayStringValues(text, d, key, values);
    }
  }
  for (const {key, value} of scalars) {
    const d = dict();
    if (d != null) {
      text = ensureScalarField(text, d, key, value);
    }
  }
  return text;
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
) /*: string */ {
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
      return writeIfChanged(p, updated) ? 'updated' : 'unchanged';
    }
  }
  const xml = generateXcscheme(
    opts.appName,
    opts.targetUuid,
    opts.projName,
    opts.syncScript,
  );
  writeIfChanged(path.join(schemesDir, `${opts.appName}.xcscheme`), xml);
  return 'created';
}

/**
 * Add SPM packages to a user's EXISTING xcodeproj in place. Returns
 * {status: 'injected', target} on success, or {status: 'refused', reason}
 * when the project can't be safely edited (caller falls back to
 * generate-from-scratch).
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
  const {text, injectedUuids} = injectSpmIntoPbxproj(
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
  log(`Scheme sync pre-action: ${schemeResult}`);

  // Marker for idempotency + `clean` revert.
  writeIfChanged(
    path.join(xcodeprojPath, SPM_INJECTED_MARKER),
    JSON.stringify(
      {
        rootUuid: plan.rootUuid,
        target: plan.target.name,
        injectedUuids: Array.from(new Set(injectedUuids)).sort(),
      },
      null,
      2,
    ) + '\n',
  );

  ensureStubPackages(appRoot);
  return {status: 'injected', target: plan.target.name};
}

function main(argv /*:: ?: Array<string> */) /*: void */ {
  const args = parseArgs(argv ?? process.argv.slice(2));
  const appRoot = path.resolve(args.appRoot);

  // Read app package.json for name derivation and entry file.
  // package.json may be in a parent directory (e.g. when appRoot is ios/).
  const projectRoot = findProjectRoot(appRoot);
  const pkgPath = path.join(projectRoot, 'package.json');
  // $FlowFixMe[incompatible-type]
  const pkgJson /*: {name?: string, main?: string} | null */ = fs.existsSync(
    pkgPath,
  )
    ? JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    : null;
  const rawName = pkgJson?.name ?? path.basename(projectRoot);

  let rnRoot =
    args.reactNativeRoot != null
      ? path.resolve(args.reactNativeRoot)
      : resolveReactNativeRoot(appRoot, projectRoot);
  if (rnRoot == null) {
    console.error(
      '[generate-spm-xcodeproj] Could not find react-native. Pass --react-native-root.',
    );
    process.exitCode = 1;
    return;
  }
  const reactNativePath = path.relative(appRoot, rnRoot);

  // Determine source path
  let sourcePath = args.sourcePath;
  if (sourcePath == null) {
    sourcePath = findSourcePath(appRoot, rawName);
  }

  const appName = args.appName ?? deriveAppName(rawName, sourcePath);

  const iosVersion = args.iosVersion;
  const bundleIdentifier =
    args.bundleIdentifier ?? `com.meta.${appName}.localDevelopment`;

  log(`App name:          ${appName}`);
  log(`Source path:       ${sourcePath}`);
  log(`Bundle identifier: ${bundleIdentifier}`);
  log(`iOS version:       ${iosVersion}`);

  const sourceDir = path.join(appRoot, sourcePath);
  const files = scanProjectFiles(sourceDir);

  // Check for PrivacyInfo.xcprivacy at app root (outside source dir)
  const privacyInfoPath = path.join(appRoot, 'PrivacyInfo.xcprivacy');
  const hasPrivacyInfo = fs.existsSync(privacyInfoPath);

  log(
    `Sources: ${files.sources.length}, Headers: ${files.headers.length}, Resources: ${files.resources.length}${hasPrivacyInfo ? ' + PrivacyInfo.xcprivacy' : ''}`,
  );

  // The SPM xcodeproj uses the same name as the legacy CocoaPods xcodeproj
  // (`<appName>.xcodeproj`). On `init`, the legacy is renamed to
  // `<appName>.xcodeproj.legacy` first (see maybeMigrateLegacyXcodeproj in
  // setup-apple-spm.js), then this generator writes the new one in the now-
  // free slot. The result: `npm run ios` resolves to the SPM xcodeproj with
  // no scheme/path tricks. The SPM-managed xcodeproj is tagged via a
  // sidecar marker file (.spm-managed) so it's distinguishable from a bare
  // CocoaPods project carrying the same filename.
  const projName = appName;
  const projDir = path.join(appRoot, `${projName}.xcodeproj`);
  const targetUUID = uuid(appName, 'PBXNativeTarget', appName);

  // Determine JS entry file: CLI arg > package.json "main" > "index.js"
  const entryFile = args.entryFile ?? pkgJson?.main ?? undefined;

  const pbxproj = generatePbxproj({
    appName,
    sourcePath,
    iosVersion,
    bundleIdentifier,
    reactNativePath,
    files,
    hasPrivacyInfo,
    entryFile,
    appRoot,
  });

  const pbxprojPath = path.join(projDir, 'project.pbxproj');
  const xcworkspacePath = path.join(
    projDir,
    'project.xcworkspace',
    'contents.xcworkspacedata',
  );
  const xcschemePath = path.join(
    projDir,
    'xcshareddata',
    'xcschemes',
    `${projName}.xcscheme`,
  );
  // Sidecar marker proving this xcodeproj was generated by spm-init. Used by
  // findExistingSpmXcodeproj / findLegacyXcodeproj to disambiguate the
  // shared `<App>.xcodeproj` filename without inspecting pbxproj contents.
  const markerPath = path.join(projDir, SPM_MANAGED_MARKER);

  const xcworkspaceData = generateXcworkspaceData(projName);
  const xcscheme = generateXcscheme(
    appName,
    targetUUID,
    projName,
    buildSyncAutolinkingScript(reactNativePath),
  );
  const markerContent = `${SPM_MANAGED_MARKER_HEADER}\n`;

  const wrote = [
    [pbxprojPath, writeIfChanged(pbxprojPath, pbxproj)],
    [xcworkspacePath, writeIfChanged(xcworkspacePath, xcworkspaceData)],
    [xcschemePath, writeIfChanged(xcschemePath, xcscheme)],
    [markerPath, writeIfChanged(markerPath, markerContent)],
  ];

  for (const [filePath, changed] of wrote) {
    const rel = path.relative(appRoot, filePath);
    log(changed ? `Generated: ${rel}` : `Unchanged: ${rel}`);
  }

  // Stub Package.swift files for each sub-package so Xcode resolves before
  // the first build phase runs.
  ensureStubPackages(appRoot);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    if (e instanceof RemoteVersionError) {
      log(e.message);
      process.exitCode = 2;
    } else {
      throw e;
    }
  }
}

module.exports = {
  main,
  generatePbxproj,
  generateXcscheme,
  ensureStubPackages,
  buildSpmDependencyGraph,
  spmGraphToEntries,
  planInjection,
  injectSpmIntoPbxproj,
  injectSpmIntoExistingXcodeproj,
  addPreActionToScheme,
  SPM_MANAGED_MARKER,
  SPM_INJECTED_MARKER,
};
