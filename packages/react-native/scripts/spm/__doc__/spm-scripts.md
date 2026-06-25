# SPM Scripts – React Native iOS via Swift Package Manager

Build React Native iOS apps using **Swift Package Manager** with prebuilt
XCFrameworks, as an alternative to CocoaPods.

## Quick Start

```bash
cd ios

# First-time setup: injects SPM packages into your existing MyApp.xcodeproj,
# in place. `npx react-native spm` with no action auto-resolves to `add` (or
# `update` once injected); on a fresh CocoaPods app it converts in one command
# (implies --deintegrate). To do it explicitly:
npx react-native spm add --deintegrate

# Open in Xcode (or `npm run ios`). Autolinking syncs automatically on build.
open MyApp.xcodeproj
```

After the initial run, the `.xcodeproj` includes an **auto-sync build phase**
that detects dependency changes and re-runs autolinking before compilation
(see [Auto-Sync](#auto-sync-build-phase) below) — you typically don't need to
re-invoke `react-native spm` manually.

> **Note:** `react-native spm` is a thin wrapper over
> `node node_modules/react-native/scripts/setup-apple-spm.js`. If the CLI
> alias is unavailable in your environment, invoke the script directly with
> the same actions and the kebab-case flag equivalents (e.g.
> `--skip-codegen`).

## CocoaPods → SwiftPM migration

`spm add` injects into a project that is **not** CocoaPods-integrated. On a
CocoaPods app it fails loud and points you at `--deintegrate`, which runs
`pod deintegrate` and strips React Native from the Podfile before injecting.
Non-RN pods can stay side-by-side (rebuild a Podfile without
`use_react_native!` and `pod install`). The migration is fully reversible:
`spm deinit` removes the injection, then `pod install` restores CocoaPods.
Expo-managed apps are not supported yet.

To roll back the SPM injection:

```bash
npx react-native spm deinit   # surgically removes everything `add` injected
# then, to restore CocoaPods:
pod install
```

## Pipeline

`react-native spm add` and `react-native spm update` orchestrate these steps:

| Step | Script | Output |
|------|--------|--------|
| 1. CLI config | `spm/generate-spm-autolinking-config.js` | `build/generated/autolinking/autolinking.json` |
| 2. Codegen | `generate-codegen-artifacts.js` | `build/generated/ios/` |
| 3. Autolinking | `spm/generate-spm-autolinking.js` | `build/generated/autolinking/Package.swift` |
| 4. Download | `spm/download-spm-artifacts.js` | Cached xcframeworks |
| 5. Package | `spm/generate-spm-package.js` | `build/xcframeworks/Package.swift` + symlinks |
| 6. Inject | `spm/generate-spm-xcodeproj.js` | SPM packages injected into the existing `<AppName>.xcodeproj` + `.spm-injected.json` marker |
| Auto-sync | `spm/sync-spm-autolinking.js` | Re-runs codegen/autolinking/package generation at Xcode build time |

## Directory Layout

```
my-app/ios/
  MyApp.xcodeproj/                 <-- committed (your project; SPM injected in place, carries .spm-injected.json)
  Podfile                          <-- present until `pod deintegrate` (CocoaPods coexistence is best-effort)
  build/
    generated/
      autolinking/                 <-- gitignored (regenerated at build time)
        Package.swift
        autolinking.json
        packages/                  <-- synth wrappers for autolinker-managed deps
        libs/                      <-- symlinks to self-managed deps' Package.swift
                                       dirs, named by Swift module so SPM
                                       package identity stays unique
        headers/                   <-- generated header symlinks
      ios/                         <-- gitignored, codegen output
    xcframeworks/                  <-- gitignored, symlinks to cached artifacts
      React.xcframework -> ~/Library/Caches/.../React.xcframework
      ReactNativeDependencies.xcframework -> ...
      hermes-engine.xcframework -> ...
```

### What to commit

| Path | Commit? | Why |
|------|---------|-----|
| `MyApp.xcodeproj/` | Yes | Your project, with SPM injected in place. Holds your signing, capabilities, Build Phases — `add` only adds SPM refs/settings, additively. |
| `MyApp.xcodeproj/.spm-injected.json` | Yes | Marker recording every edit `add` made, so `deinit` can surgically reverse it and re-runs stay idempotent. |
| `build/generated/` | No | Codegen/autolinking output; regenerated |
| `build/xcframeworks/` | No | Symlinks to local cache; machine-specific |
| `Package.resolved` | No | SPM resolution file; machine-specific |

Injection is **purely additive** and **idempotent**: `add`/`update` insert only
SPM package refs, the React build settings, the Sync build phase, and a scheme
pre-action — every other byte (your signing / capabilities / Build Phases)
stays untouched, and a re-run is a no-op. The injected refs point at three
stable sub-package paths under `build/`; adding or removing community deps
changes the sub-package contents (gitignored) and never re-injects. `deinit`
removes exactly what was injected (using the marker), leaving the project
byte-identical to its pre-`add` state.

## CLI Actions

```bash
react-native spm [action] [options]
```

With no action, the command **auto-resolves**: if SPM has been injected
(`.spm-injected.json` marker present) it routes to `update`; otherwise `add`.
On a freshly-scaffolded CocoaPods project (clean git tree, stock Podfile) the
zero-arg path additionally implies `--deintegrate` (the safe-gate), so
`npx react-native spm` converts a brand-new app to SwiftPM in one command.

When invoked from the JS root of a standard RN app (sibling `ios/` subdir),
the command auto-redirects into `ios/` with a banner.

| Action | Description |
|---|---|
| `add` | Inject SPM packages (package refs, build settings, the Sync build phase) into the existing `.xcodeproj`, in place. Idempotent. Default on first run. `--deintegrate` first runs `pod deintegrate` + strips React Native from the Podfile. |
| `update` | Re-run the pipeline and refresh the existing injection. Default once a project is injected. |
| `deinit` | The exact inverse of `add`: surgically remove only what `add` injected (recorded in `.spm-injected.json`) and drop the marker. Git-recoverable; no prompt. |
| `scaffold` | Generate `Package.swift` into `node_modules/<dep>/` for community RN libraries that ship only a podspec. |
| `sync` (advanced) | Lightweight resync invoked by the Xcode auto-sync build phase. Regenerates autolinking + xcframeworks sub-packages. Not for humans. |
| `codegen` (advanced) | Run codegen and install the SPM codegen template only. |
| `download` (advanced) | Download/check xcframework artifacts only. |

## CLI Options

Flags below use the `react-native spm` (camelCase) form. The raw script
accepts kebab-case equivalents (e.g. `--skip-codegen`).

| Option | Description |
|---|---|
| `--version <ver>` | RN version (default: from package.json) |
| `--flavor <debug\|release>` | Artifact flavor (default: debug) |
| `--yes` | Skip the dirty-pbxproj confirmation prompt |
| `--xcodeproj <path>` | [add] Which `.xcodeproj` to inject into (when several exist) |
| `--productName <name>` | [add] Which app target to inject into (when several exist) |
| `--deintegrate` | [add] Run `pod deintegrate` + strip React Native from the Podfile before injecting |
| `--artifacts <path>` | [advanced] Local artifact source: a `.xcframework` (used directly) or a directory (cache dir to read/download into) |
| `--download <auto\|skip\|force>` | [advanced] Artifact download policy (default: auto) |
| `--skipCodegen` | [advanced] Skip the codegen step |

## Local Native Modules

Modules not discovered via autolinking can be declared in `react-native.config.js`:

```js
module.exports = {
  spm: {
    modules: [
      {
        name: 'MyNativeModule',
        path: 'ios/MyNativeModule',       // relative to app root
        exclude: ['*.podspec'],            // optional
        publicHeadersPath: '.',            // optional
      },
    ],
  },
};
```

Each entry becomes a target in `build/generated/autolinking/Package.swift`.
Sources outside `build/generated/autolinking/` are automatically mirrored with
file-level symlinks.

## Self-managed community packages

A community library that ships its own `Package.swift` is referenced
directly by the autolinker instead of being wrapped. To keep SPM's
package identity (which it derives from the path basename) unique across
deps — even when several libs put their manifest inside an `ios/` subdir
— each self-managed dep is exposed through a uniquely-named symlink at
`build/generated/autolinking/libs/<SwiftName>/`. The aggregator
`Package.swift` references that path, so two libs both shipping
`<dep>/ios/Package.swift` never collide on identity `"ios"`.

The `libs/` directory is wiped and recreated on every autolinker run,
so deleting a dep via `npm uninstall` cleans up the alias automatically
on the next build.

## Header Resolution

React Native uses CocoaPods-style imports (`#import <React/RCTBridge.h>`) that
SPM doesn't natively support. Two mechanisms solve this:

1. **XCFramework Headers/**: prebuild copies headers organized by import path,
   so `-I Headers` resolves `#import <React/...>` directly.

2. **VFS overlay** (`React-VFS.yaml`): maps remaining non-standard paths — headers
   that appear in multiple locations or have platform variants. Generated as a
   template at prebuild time, resolved with local paths at setup time.

## Auto-Sync Build Phase

The generated `.xcodeproj` includes a **Sync SPM Autolinking** shell script
build phase that runs before all other phases. It keeps
`build/generated/autolinking/Package.swift` up to date without requiring manual
re-runs of `react-native spm`.

**How it works:**

1. Compares timestamps of staleness inputs against `build/generated/autolinking/.spm-sync-stamp`:
   - `package.json` — dependency declarations
   - `react-native.config.js` — `spm.modules` config
   - `node_modules/` directory mtime — updated by any package manager (npm, yarn, pnpm, bun); also checks parent `node_modules` for monorepo setups
2. If any input is newer (or stamp is missing): runs `npx react-native spm sync`,
   which re-executes autolinking + package generation + VFS overlay resolution
   and writes the stamp file.
3. If all inputs are fresh: exits immediately (~1ms).

**Build phase ordering:**

| # | Phase |
|---|-------|
| 1 | Sync SPM Autolinking (new) |
| 2 | Prepare VFS Overlay |
| 3 | Sources (compile) |
| 4 | Frameworks (link) |
| 5 | Resources (copy) |
| 6 | Build JS Bundle |

Failures are non-fatal — the phase emits `warning:` and exits 0, so the
existing autolinking may still produce a successful build.

## Removing / resetting

To remove SPM entirely, use `deinit` (the inverse of `add`):

```bash
react-native spm deinit   # surgically removes everything `add` injected
pod install               # then, to restore CocoaPods
```

To reset the regenerable build state (without un-injecting), just delete the
gitignored dirs and re-run:

```bash
rm -rf build/xcframeworks build/generated .build
react-native spm update
```

Xcode's "Clean Build Folder" (Cmd+Shift+K) only removes DerivedData — it does
not touch SPM-generated directories. The cached xcframework slot is shared
across apps; refresh it with `react-native spm update --download force`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `spm add` fails: "CocoaPods-integrated project" | Re-run `spm add --deintegrate` (runs `pod deintegrate` + strips RN from the Podfile), or `pod deintegrate` yourself first. |
| `spm add` fails: "no .xcodeproj found" | Create an app first (`npx @react-native-community/cli init`) or make a project in Xcode, then `spm add`. |
| `spm add` fails: "multiple .xcodeproj found" | Pass `--xcodeproj <path>` (and `--product-name <target>` if multiple app targets). |
| Missing headers | Re-run `react-native spm` |
| "not contained in target" | Re-run setup (regenerates file-level symlinks) |
| Codegen fails | Use `--skipCodegen` to iterate on other parts |
| "SPM autolinking sync failed" warning | Check Xcode build log for details; node may not be in PATH — ensure `with-environment.sh` is present |
| Autolinking not updating on build | Touch `package.json` to force a sync, or delete `build/generated/autolinking/.spm-sync-stamp` |
| Stale SPM state or corrupted build | `rm -rf build/ .build/`, then `react-native spm update`, then reopen Xcode |
| Want to revert to CocoaPods | `react-native spm deinit`, then `pod install` |
