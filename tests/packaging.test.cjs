'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const pkg = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const capacitorConfig = JSON.parse(read('capacitor.config.json'));
const electronMain = read('electron', 'main.js');
const workflow = read('.github', 'workflows', 'build.yml');
const appHtml = read('index.html');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `film-lab-${name}-`));
}

/* --- Electron desktop packaging ------------------------------------------------- */

test('package.json drives Electron and electron-builder for Windows, macOS and Linux', () => {
  assert.equal(pkg.name, 'film-lab');
  assert.equal(pkg.version, '1.0.5');
  assert.equal(packageLock.version, pkg.version);
  assert.equal(packageLock.packages[''].version, pkg.version);
  assert.equal(pkg.description, 'Cinematic photo and video editor');
  assert.equal(pkg.main, 'electron/main.js');
  assert.ok(fs.existsSync(path.join(root, pkg.main)), 'the Electron entry point must exist');

  assert.equal(pkg.scripts.electron, 'electron .');
  assert.equal(pkg.scripts['build:win'], 'electron-builder --win');
  assert.equal(pkg.scripts['build:mac'], 'electron-builder --mac');
  assert.equal(pkg.scripts['build:linux'], 'electron-builder --linux');

  assert.equal(pkg.build.appId, 'com.filmlab.app');
  assert.equal(pkg.build.productName, 'Film Lab');
  assert.equal(pkg.build.directories.output, 'dist-electron');
  assert.equal(pkg.build.win.target, 'nsis');
  assert.equal(pkg.build.mac.target, 'dmg');
  assert.equal(pkg.build.linux.target, 'AppImage');

  // The sidecar files stay in the bundle; dependencies and build output do not.
  assert.ok(pkg.build.files.includes('**/*'));
  assert.ok(pkg.build.files.some(pattern => pattern.startsWith('!node_modules')));
  assert.ok(pkg.build.files.some(pattern => pattern.startsWith('!dist-electron')));
  assert.ok(pkg.build.files.some(pattern => pattern.startsWith('!www')));
  assert.ok(pkg.build.files.every(pattern => pattern === '**/*' || pattern.startsWith('!')), 'negated patterns must use !path/** globs');

  assert.ok(pkg.devDependencies.electron, 'electron must be a devDependency');
  assert.ok(pkg.devDependencies['electron-builder'], 'electron-builder must be a devDependency');

  for (const target of ['win', 'mac', 'linux']) {
    const iconPath = path.join(root, pkg.build[target].icon);
    assert.ok(fs.existsSync(iconPath), `${target} icon missing: ${pkg.build[target].icon}`);
    const icon = fs.readFileSync(iconPath);
    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${target} icon must be a PNG`);
    assert.equal(icon.readUInt32BE(16), 512);
    assert.equal(icon.readUInt32BE(20), 512);
  }
});

test('electron/main.js keeps renderer isolation, bridges external links and loads the local entry point', () => {
  assert.doesNotThrow(() => new vm.Script(electronMain, { filename: 'electron/main.js' }), 'main.js must be valid JavaScript');

  assert.match(electronMain, /require\('electron'\)/);
  assert.match(electronMain, /nodeIntegration:\s*false/);
  assert.match(electronMain, /contextIsolation:\s*true/);
  assert.match(electronMain, /webSecurity:\s*true/);
  assert.match(electronMain, /titleBarStyle:\s*process\.platform === 'darwin' \? 'hiddenInset' : 'default'/);
  assert.match(electronMain, /win\.loadFile\('index\.html'\)/);
  assert.match(electronMain, /setWindowOpenHandler/);
  assert.match(electronMain, /shell\.openExternal/);
  assert.match(electronMain, /app\.whenReady\(\)\.then\(createWindow\)/);
  assert.match(electronMain, /window-all-closed[\s\S]*?process\.platform !== 'darwin'[\s\S]*?app\.quit\(\)/);
  assert.match(electronMain, /app\.on\('activate', \(\) => \{ if \(BrowserWindow\.getAllWindows\(\)\.length === 0\) createWindow\(\) \}\)/);

  // Every asset the desktop window needs is addressed relatively so file:// and
  // the app's own loopback origin behave identically.
  assert.match(appHtml, /<script src="\.\/social-tools\.js"><\/script>/);
  assert.match(appHtml, /<script src="\.\/timeline-module\.js"><\/script>/);
  assert.match(appHtml, /<script src="\.\/multi-timeline\.js"><\/script>/);
  assert.match(appHtml, /<link rel="manifest" href="\.\/manifest\.json">/);
  assert.doesNotMatch(appHtml, /(?:src|href)="\/(?!\/)/, 'no root-absolute asset paths may remain in index.html');
});

test('the Electron window boots with the packaged app, serves it locally and blocks escapes', () => {
  const workspace = tempDir('electron');
  const outputFile = path.join(workspace, 'window.json');

  // A stubbed Electron runtime: it records the BrowserWindow options, performs the
  // real HTTP requests the window would make, then exits.
  const stub = `
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

const record = { windows: [], loads: [], probes: [], opened: [], windowOpenResults: [], navigationGuards: [] };

function finish() {
  fs.writeFileSync(process.env.FILM_LAB_TEST_OUT, JSON.stringify(record));
  process.exit(0);
}

function probe(url) {
  return new Promise(resolve => {
    http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        record.probes.push({
          url,
          status: response.statusCode,
          contentType: response.headers['content-type'],
          bytes: body.length,
          sha256: crypto.createHash('sha256').update(body).digest('hex'),
          text: body.toString('utf8').slice(0, 400)
        });
        resolve();
      });
    }).on('error', error => {
      record.probes.push({ url, error: error.message });
      resolve();
    });
  });
}

class BrowserWindow {
  constructor(options) {
    record.windows.push(options);
    BrowserWindow.instances.push(this);
    this.webContents = {
      setWindowOpenHandler(handler) {
        for (const url of ['https://example.com/link', 'javascript:alert(1)', 'file:///etc/passwd']) {
          record.windowOpenResults.push({ url, result: handler({ url }) });
        }
      },
      on(event, handler) {
        if (event !== 'will-navigate') return;
        const local = { prevented: false, preventDefault() { this.prevented = true; } };
        const external = { prevented: false, preventDefault() { this.prevented = true; } };
        handler(local, record.loads[0].url);
        handler(external, 'https://example.com/elsewhere');
        record.navigationGuards.push({ localPrevented: local.prevented, externalPrevented: external.prevented });
      }
    };
  }
  loadFile(file) {
    record.loads.push({ type: 'file', file });
    setTimeout(finish, 20);
  }
  async loadURL(url) {
    record.loads.push({ type: 'url', url });
    const origin = new URL(url).origin;
    await probe(url);
    await probe(origin + '/');
    await probe(origin + '/%2e%2e%2fpackage.json');
    await probe(origin + '/missing-file.js');
    setTimeout(finish, 20);
  }
  static getAllWindows() { return BrowserWindow.instances; }
}
BrowserWindow.instances = [];

const app = { whenReady: () => Promise.resolve(), on: () => app, quit: () => {} };
const shell = { openExternal: url => record.opened.push(url) };

module.exports = { app, BrowserWindow, shell };
`;
  fs.mkdirSync(path.join(workspace, 'node_modules', 'electron'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'node_modules', 'electron', 'index.js'), stub);
  fs.writeFileSync(
    path.join(workspace, 'node_modules', 'electron', 'package.json'),
    JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.js' })
  );
  fs.mkdirSync(path.join(workspace, 'electron'), { recursive: true });
  fs.copyFileSync(path.join(root, 'electron', 'main.js'), path.join(workspace, 'electron', 'main.js'));
  fs.copyFileSync(path.join(root, 'index.html'), path.join(workspace, 'index.html'));

  const run = spawnSync(process.execPath, [path.join('electron', 'main.js')], {
    cwd: workspace,
    env: { ...process.env, FILM_LAB_TEST_OUT: outputFile },
    encoding: 'utf8',
    timeout: 60000
  });
  assert.equal(run.status, 0, `stubbed Electron run failed:\n${run.stderr || run.stdout}`);

  const record = JSON.parse(fs.readFileSync(outputFile, 'utf8'));

  // Window options.
  const window = record.windows[0];
  assert.ok(window, 'a BrowserWindow must be created');
  assert.deepEqual(
    { width: window.width, height: window.height, minWidth: window.minWidth, minHeight: window.minHeight },
    { width: 1280, height: 800, minWidth: 900, minHeight: 600 }
  );
  assert.equal(window.backgroundColor, '#0a0a0a');
  assert.equal(window.titleBarStyle, process.platform === 'darwin' ? 'hiddenInset' : 'default');
  assert.equal(window.icon, path.join(workspace, 'icons', 'icon-512.png'), 'the window icon must resolve to <app root>/icons/icon-512.png');
  assert.deepEqual(window.webPreferences, { nodeIntegration: false, contextIsolation: true, webSecurity: true });

  // The app is served from a loopback origin with the real index.html bytes.
  assert.equal(record.loads.length, 1);
  assert.equal(record.loads[0].type, 'url');
  assert.match(record.loads[0].url, /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);

  const [entry, rootPath, traversal, missing] = record.probes;
  assert.equal(entry.status, 200);
  assert.equal(entry.contentType, 'text/html; charset=utf-8');
  assert.equal(entry.sha256, require('node:crypto').createHash('sha256').update(appHtml).digest('hex'), 'the served page must be the packaged index.html');
  assert.equal(entry.text.startsWith('<!DOCTYPE html>'), true);
  assert.equal(rootPath.status, 200, 'the bare origin must serve index.html');
  assert.equal(rootPath.sha256, entry.sha256);
  assert.ok(traversal.status >= 400, `encoded path traversal must be refused, got ${traversal.status}`);
  assert.equal(missing.status, 404);

  // External links open in the default browser; the window never navigates itself.
  assert.equal(record.windowOpenResults[0].result.action, 'deny');
  assert.ok(record.windowOpenResults.every(entry => entry.result.action === 'deny'));
  // popup links and off-app navigation both leave through the OS browser, and the
  // javascript:/file: URLs the stub also tries never reach shell.openExternal.
  assert.deepEqual(record.opened, ['https://example.com/link', 'https://example.com/elsewhere']);
  assert.ok(record.opened.every(url => /^(https?|mailto):/i.test(url)), 'only http(s)/mailto URLs may be handed to the OS');
  assert.deepEqual(record.navigationGuards, [{ localPrevented: false, externalPrevented: true }]);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test('--file-protocol keeps the plain loadFile() path available for desktop builds', () => {
  const workspace = tempDir('electron-file');
  const outputFile = path.join(workspace, 'window.json');

  const stub = `
'use strict';
const fs = require('node:fs');
const record = { windows: [], loads: [] };
class BrowserWindow {
  constructor(options) {
    record.windows.push(options);
    this.webContents = { setWindowOpenHandler() {}, on() {} };
    BrowserWindow.instances.push(this);
  }
  loadFile(file) {
    record.loads.push({ type: 'file', file });
    fs.writeFileSync(process.env.FILM_LAB_TEST_OUT, JSON.stringify(record));
    process.exit(0);
  }
  loadURL(url) {
    record.loads.push({ type: 'url', url });
    fs.writeFileSync(process.env.FILM_LAB_TEST_OUT, JSON.stringify(record));
    process.exit(0);
  }
  static getAllWindows() { return BrowserWindow.instances; }
}
BrowserWindow.instances = [];
module.exports = {
  app: { whenReady: () => Promise.resolve(), on: () => {}, quit: () => {} },
  BrowserWindow,
  shell: { openExternal: () => {} }
};
`;
  fs.mkdirSync(path.join(workspace, 'node_modules', 'electron'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'node_modules', 'electron', 'index.js'), stub);
  fs.writeFileSync(
    path.join(workspace, 'node_modules', 'electron', 'package.json'),
    JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.js' })
  );
  fs.mkdirSync(path.join(workspace, 'electron'), { recursive: true });
  fs.copyFileSync(path.join(root, 'electron', 'main.js'), path.join(workspace, 'electron', 'main.js'));
  fs.copyFileSync(path.join(root, 'index.html'), path.join(workspace, 'index.html'));

  const run = spawnSync(process.execPath, [path.join('electron', 'main.js'), '--file-protocol'], {
    cwd: workspace,
    env: { ...process.env, FILM_LAB_TEST_OUT: outputFile },
    encoding: 'utf8',
    timeout: 60000
  });
  assert.equal(run.status, 0, `stubbed Electron run failed:\n${run.stderr || run.stdout}`);

  const record = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  assert.deepEqual(record.loads, [{ type: 'file', file: 'index.html' }]);
  assert.ok(fs.existsSync(path.join(workspace, record.loads[0].file)), 'loadFile("index.html") must resolve inside the app package');

  fs.rmSync(workspace, { recursive: true, force: true });
});

/* --- Capacitor Android packaging ------------------------------------------------ */

test('capacitor.config.json targets com.filmlab.app with a valid web directory', () => {
  assert.equal(capacitorConfig.appId, 'com.filmlab.app');
  assert.equal(capacitorConfig.appName, 'Film Lab');
  assert.equal(capacitorConfig.server.androidScheme, 'https');
  assert.equal(capacitorConfig.android.backgroundColor, '#0a0a0a');
  assert.equal(capacitorConfig.plugins.SplashScreen.backgroundColor, '#0a0a0a');
  assert.equal(capacitorConfig.plugins.SplashScreen.launchShowDuration, 0);

  // Capacitor rejects '', '.', '..', '../' and './' for webDir, so the app shell
  // is staged into a generated directory instead of pointing at the repo root.
  assert.ok(!['', '.', '..', '../', './'].includes(capacitorConfig.webDir), 'webDir must not be the repository root');
  assert.equal(capacitorConfig.webDir, 'www');
  assert.equal(pkg.scripts['web:stage'], 'node scripts/stage-web.cjs');
  assert.equal(capacitorConfig.appId, pkg.build.appId, 'desktop and Android builds must share one app id');

  for (const dependency of ['@capacitor/core', '@capacitor/cli', '@capacitor/android']) {
    assert.ok(pkg.dependencies[dependency], `${dependency} must be listed in dependencies`);
  }
});

test('the staging script produces a self-contained web bundle for Capacitor', () => {
  const target = tempDir('www');
  const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'stage-web.cjs')], {
    cwd: root,
    env: { ...process.env, FILM_LAB_STAGE_DIR: target },
    encoding: 'utf8',
    timeout: 120000
  });
  assert.equal(run.status, 0, `staging failed:\n${run.stderr || run.stdout}`);

  for (const file of [
    'index.html',
    'manifest.json',
    'sw.js',
    'social-tools.js',
    'color-grading.js',
    'video-tools.js',
    'audio-tools.js',
    'timeline-module.js',
    'multi-timeline.js',
    'background-blur-worker.js',
    'mask-segmentation-worker.js',
    'favicon.svg',
    'icons/icon-512.png',
    'vendor/heic2any.min.js',
    'vendor/mediapipe-selfie/selfie_segmentation.js',
    'vendor/mediapipe-tasks/vision_bundle.js',
    'vendor/mediapipe-tasks/wasm/vision_wasm_internal.wasm',
    'vendor/ffmpeg/ffmpeg.js'
  ]) {
    assert.ok(fs.existsSync(path.join(target, file)), `staged bundle is missing ${file}`);
  }
  assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), appHtml);

  for (const excluded of ['package.json', 'capacitor.config.json', 'node_modules', 'tests', 'scripts', 'electron', 'README-BUILD.md']) {
    assert.equal(fs.existsSync(path.join(target, excluded)), false, `${excluded} must not ship inside the APK`);
  }

  // Relative paths keep working when Capacitor serves the bundle from https://localhost.
  const stagedManifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
  assert.equal(stagedManifest.start_url, './');
  assert.equal(stagedManifest.scope, './');

  fs.rmSync(target, { recursive: true, force: true });
});

/* --- CI ------------------------------------------------------------------------- */

test('the workflow triggers on main and version tags, builds desktop + Android, and uploads artifacts', () => {
  assert.match(workflow, /^name: Build Desktop Apps$/m);
  assert.match(workflow, /push:\s*\n\s*branches: \['main'\]\s*\n\s*tags: \['v\*'\]/);
  assert.match(workflow, /matrix:\s*\n\s*os: \[windows-latest, macos-latest, ubuntu-latest\]/);
  assert.match(workflow, /uses: actions\/checkout@v4/);
  assert.match(workflow, /uses: actions\/setup-node@v4/);
  assert.match(workflow, /node-version: '20'/);
  assert.match(workflow, /run: npm install/);
  assert.match(workflow, /run: npm run build:\$\{\{ matrix\.target \}\}/);
  assert.match(workflow, /uses: actions\/upload-artifact@v4/);
  assert.match(workflow, /name: film-lab-\$\{\{ matrix\.os \}\}/);
  assert.match(workflow, /path: dist-electron\//);

  // Each matrix target must map to a script that exists in package.json.
  for (const target of workflow.match(/target: (win|mac|linux)/g) || []) {
    assert.ok(pkg.scripts[`build:${target.split(': ')[1]}`], `missing ${target} script`);
  }

  // Fourth build job: Android APK.
  assert.match(workflow, /^  android:$/m);
  assert.match(workflow, /uses: actions\/setup-java@v4/);
  assert.match(workflow, /java-version: '17'/);
  assert.match(workflow, /run: npm run web:stage/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npx cap sync android/);
  assert.match(workflow, /run: chmod \+x android\/gradlew/);
  assert.match(workflow, /run: \.\/gradlew assembleDebug/);
  assert.match(workflow, /working-directory: android/);
  assert.match(workflow, /name: film-lab-android/);
  assert.match(workflow, /path: android\/app\/build\/outputs\/apk\/debug\/app-debug\.apk/);

  // The native Android project is tracked so `npx cap sync android` and `./gradlew` succeed in CI.
  assert.ok(fs.existsSync(path.join(root, 'package-lock.json')), 'package-lock.json must exist for npm ci');
  assert.ok(fs.existsSync(path.join(root, 'android', 'gradlew')), 'android/gradlew must exist');
  assert.ok(fs.existsSync(path.join(root, 'android', 'app', 'build.gradle')), 'android/app/build.gradle must exist');
  assert.ok(fs.existsSync(path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'filmlab', 'app', 'MainActivity.java')));
});

test('a final job publishes a GitHub Release with all desktop installers and the Android APK', () => {
  // It must run only after the desktop matrix and Android build have finished.
  assert.match(workflow, /^  release:$/m);
  assert.match(workflow, /needs: \[build, android\]/);
  assert.match(workflow, /uses: actions\/download-artifact@v4/);
  assert.match(workflow, /uses: softprops\/action-gh-release@v1/);
  assert.match(workflow, /name: Film Lab \$\{\{ github\.ref_name \}\}/);
  assert.match(workflow, /tag_name: \$\{\{ github\.ref_name \}\}/);
  assert.match(workflow, /tag_name: latest-build/);

  // The release must attach the .exe, .dmg, .AppImage and .apk packages.
  for (const ext of ['exe', 'dmg', 'AppImage', 'apk']) {
    assert.match(workflow, new RegExp(`artifacts/\\*/\\*\\.${ext}`), `release must attach .${ext} files`);
  }
});
