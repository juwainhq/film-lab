# Building Film Lab as a Desktop App and Android APK

## Downloads

Prebuilt installers for all four platforms are attached to the
[latest GitHub release](https://github.com/juwainhq/film-lab/releases/latest):

- **Windows:** `.exe` installer
- **Mac:** `.dmg` disk image
- **Linux:** `.AppImage`
- **Android:** `.apk` package

See [DOWNLOADS.md](DOWNLOADS.md) for the short version.

Film Lab is a static site: `index.html` plus the worker and vendor scripts next to it.
The same files are packaged twice — as a native desktop app with [Electron](https://www.electronjs.org/)
and as an Android APK with [Capacitor](https://capacitorjs.com/).

---

## Desktop (Electron)

### Install dependencies

```sh
npm install
```

`npm install` downloads the Electron runtime for your platform (roughly 100 MB).

### Run in dev mode

```sh
npm run electron
```

### Build for your platform

```sh
npm run build:win    → dist-electron/Film Lab Setup <version>.exe
npm run build:mac    → dist-electron/Film Lab-<version>-<arch>.dmg
npm run build:linux  → dist-electron/Film Lab-<version>.AppImage
```

`electron-builder` stamps the `version` from `package.json` into those names, so the current
build is `Film Lab Setup 2.0.0.exe`. The rolling `latest-build` release republishes the same
files under fixed names (see below) so download links do not change between versions.

Each `build:*` script runs `electron-builder`, which writes its output to `dist-electron/`.
Windows builds need to run on Windows (or Wine), macOS builds on macOS — use the
tag-driven workflow below to get all three at once.

### Ship a release from GitHub Actions

`.github/workflows/build.yml` runs on every push to `main` and to `arena/01a102e1-film-lab`, when
you push a version tag, and on demand through **Actions → Build Desktop Apps → Run workflow**
(`workflow_dispatch`):

```sh
git tag v2.0.0
git push origin v2.0.0
```

The workflow runs `windows-latest`, `macos-latest` and `ubuntu-latest` desktop builds in
parallel alongside an `android` job that stages the web app, syncs Capacitor and runs
`./android/gradlew assembleDebug -p android` to produce `film-lab-android` (`app-debug.apk`).
Once all four builds finish, a final `release` job publishes a GitHub Release named
`Film Lab <tag>` (for example `Film Lab v2.0.0`) on tag pushes — or replaces the rolling
`latest-build` release on pushes to `main` or the arena branch, and via `workflow_dispatch` —
with the Windows `.exe`, macOS `.dmg`, Linux `.AppImage` and Android `.apk` attached as
downloadable assets. Those rolling assets keep fixed names (`FilmLab-Setup.exe`, `FilmLab.dmg`,
`FilmLab.AppImage`, `FilmLab.apk`), so the download links stay valid even though the app version
changes; tagged releases keep electron-builder's version-stamped names. The builds are unsigned,
so Windows SmartScreen, macOS Gatekeeper and Android Play Protect will show an "unidentified
developer" warning on first install.

### Notes on how the packaged app loads the site

- `electron/main.js` starts a **loopback-only static server** inside the app process
  (bound to `127.0.0.1` on a random free port) and points the window at it. Film Lab
  spawns Web Workers, streams WASM with `fetch()` (MediaPipe portrait masks, FFmpeg
  encoding) and registers a service worker — Chromium blocks all of those on `file://`,
  so the local origin is what keeps every feature working in the packaged app. Nothing
  external is required: the server is part of the app and shuts down with it.
- Prefer the plain `loadFile()` behaviour? Start the app with `--file-protocol`
  (`FILM_LAB_FILE_PROTOCOL=1 npm run electron`). The editor opens, but blur/mask/portrait
  and video encoding stay disabled because of the `file://` restrictions above.
- All asset paths in `index.html` and `manifest.json` are relative (`./…`), which is what
  lets the same files load from `file://`, from the loopback server, and from Capacitor.
- On Ubuntu 24.04+ the AppImage may refuse to start because of the AppArmor restriction
  on unprivileged user namespaces; run it with `--no-sandbox` or install an AppArmor
  profile. This is a distro policy, not a Film Lab bug.

---

## Android (Capacitor)

### Prerequisites

Android Studio installed, Java 17+.

### Install dependencies

```sh
npm install
```

### Stage the web app

Capacitor copies its `webDir` into the native project, and Capacitor refuses a `webDir`
of `.` — so the app shell is staged into `www/` first:

```sh
npm run web:stage
```

This mirrors `index.html`, the workers, `vendor/`, `icons/` and the other runtime files
into `www/` (about 14 MB) and leaves `node_modules`, `tests/`, `electron/` and the
Android project itself out. `www/` is generated and git-ignored; re-run the command after
editing any app file.

### Initialize the Android project (first time only)

```sh
npx cap add android        # or: npm run android:add  (stages, then adds)
```

### Sync web code to Android

```sh
npx cap sync android       # or: npm run android:sync (stages, then syncs)
```

### Open in Android Studio

```sh
npx cap open android       # or: npm run android:open
```

### Generate the APK

Then in Android Studio: **Build → Generate Signed Bundle/APK → APK**.
The APK will be at `android/app/build/outputs/apk/release/app-release.apk`.

For a debug APK (no signing needed):

```sh
cd android && ./gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`.

The Android project is generated locally and git-ignored, so each machine runs
`npx cap add android` once. Delete the `android/` entry in `.gitignore` if you would
rather commit native customizations (icons, splash screen, manifest tweaks).

### Notes on the Capacitor configuration

- `capacitor.config.json` uses `"webDir": "www"` (staged app shell) instead of `"."`;
  Capacitor 5+ rejects `''`, `'.'`, `'..'`, `'../'` and `'./'` as `webDir` values with
  `"." is not a valid value for webDir`, which aborts `cap add`/`cap sync`. Everything
  else in the config matches the desktop app: same `appId`, same dark background.
- `"androidScheme": "https"` serves the app from `https://localhost`, a secure context,
  so the service worker and workers behave exactly as they do on the web.
- The `SplashScreen` block only takes effect if you add the optional plugin:
  `npm install @capacitor/splash-screen`.

---

## Verification

```sh
npm test
```

`tests/packaging.test.cjs` checks these configurations: it boots `electron/main.js`
against a stubbed Electron runtime (window options, `file://` fallback, the app file
server, external-link handling), runs the staging script into a temporary directory, and
validates `capacitor.config.json`, `package.json` and the GitHub Actions workflow.
