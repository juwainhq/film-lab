'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n');
const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
const appScript = inlineScripts.find(source => source.includes('function updateVideoPlayback')) || '';
const installScript = inlineScripts.find(source => source.includes("beforeinstallprompt")) || '';
const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

test('the PWA manifest and generated icons use the Film Lab identity and GitHub Pages scope', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'Film Lab');
  assert.equal(manifest.short_name, 'Film Lab');
  // Relative (not "/film-lab/") so the same manifest works from a GitHub Pages
  // subpath, an Electron file:// desktop build, and a Capacitor https://localhost app.
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#0a0a0a');
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.json">/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-touch-icon/);
  assert.match(html, /name="theme-color"/);

  for (const size of [192, 512]) {
    const icon = fs.readFileSync(path.join(root, `icons/icon-${size}.png`));
    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(icon.readUInt32BE(16), size);
    assert.equal(icon.readUInt32BE(20), size);
  }
  assert.match(fs.readFileSync(path.join(root, 'scripts/generate-icons.cjs'), 'utf8'), /class Canvas/);
});

test('the service worker precaches only the app shell and leaves model and encoding assets uncached', () => {
  assert.match(serviceWorker, /const PRECACHE = \[/);
  assert.match(serviceWorker, /social-tools\.js/);
  assert.match(serviceWorker, /color-grading\.js/);
  assert.match(serviceWorker, /const CACHE = 'filmlab-v13'/);
  assert.match(serviceWorker, /timeline-module\.js/);
  assert.match(serviceWorker, /multi-timeline\.js/);
  assert.match(serviceWorker, /background-blur-worker\.js/);
  assert.match(serviceWorker, /mask-segmentation-worker\.js/);
  assert.match(serviceWorker, /vendor\/heic2any\.min\.js/);
  assert.match(serviceWorker, /icons\/icon-192\.png/);
  assert.match(serviceWorker, /path\.includes\('ffmpeg'\).*path\.includes\('mediapipe'\).*path\.includes\('tflite'\)/s);
  const precache = serviceWorker.match(/const PRECACHE = \[([\s\S]*?)\]\.map/)[1];
  assert.doesNotMatch(precache, /ffmpeg|mediapipe|tflite/i);
  assert.match(html, /navigator\.serviceWorker\.register\(new URL\('sw\.js', appBase\)\.href, \{scope: appBase\.pathname\}\)/);
});

test('the install banner appears two seconds after load when installable, and remembers dismissal or installation', () => {
  assert.ok(installScript);
  assert.match(installScript, /setTimeout\([\s\S]*?2000\)/);
  assert.match(installScript, /beforeinstallprompt/);
  // The banner only shows when the browser actually offers an install prompt.
  assert.match(installScript, /if \(!deferredPrompt \|\| !mayShow\(\)\) return;/);
  assert.match(installScript, /filmLabPwaInstallDismissed/);
  assert.match(installScript, /filmLabPwaInstalled/);
  assert.match(installScript, /localStorage\.setItem\(key, '1'\)/);
  assert.match(installScript, /appinstalled/);
  assert.match(html, /<strong>Install Film Lab<\/strong>/);
  assert.match(html, /Get the app for a better experience/);
  assert.match(html, /id="pwaInstallDismiss"/);
  assert.match(css, /#pwaInstallBanner \{[^}]*background: #1a1a1a/);
  assert.match(css, /@media \(min-width: 768px\) \{[\s\S]*?#pwaInstallBanner \{[^}]*right: 20px/);
});

test('mobile sheet changes refresh the existing preview and keep swipe/tap controls', () => {
  assert.match(html, /id="sidebarSheetHandle"/);
  assert.match(appScript, /function setMobileSheet\(open\)/);
  assert.match(appScript, /function refreshCanvasAfterSheetLayout\(\)[\s\S]*?updatePreviewZoom\(\)[\s\S]*?refreshPreviewResolution\(\)[\s\S]*?render\(performance\.now\(\)\)/);
  assert.match(appScript, /sheetHandle\.addEventListener\('click'/);
  assert.match(appScript, /sheetHandle\.addEventListener\('pointerdown'/);
  assert.match(appScript, /sheetHandle\.addEventListener\('pointerup'/);
  assert.match(appScript, /mobileSidebar\.addEventListener\('transitionend'/);
  assert.match(css, /#sidebar\.mobileSheetOpen \{ transform: translateY\(0\); \}/);
});

test('the mobile video scrubber is connected to existing playback and seeking logic', () => {
  assert.match(html, /id="mob-play"/);
  assert.match(html, /id="mob-scrubber"/);
  assert.match(html, /id="mob-time"/);
  assert.match(appScript, /\$\('mob-play'\)\.addEventListener\('click',toggleVideoPlayback\)/);
  assert.match(appScript, /\$\('mob-scrubber'\)\.addEventListener\('input'/);
  assert.match(appScript, /videoEl\.currentTime=videoEl\.duration\*Math\.max\(0,Math\.min\(100,Number\(event\.target\.value\)\|\|0\)\)\/100/);
  assert.match(appScript, /\$\('mob-scrubber'\)\.value=String\(mobilePercent\)/);
  assert.match(appScript, /\$\('mob-time'\)\.textContent=/);
});

test('the phone layout preserves workspace markup, safe areas, and touch-sized controls', () => {
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.match(html, /id="previewControls"/);
  assert.match(html, /id="holdCompareBtn"/);
  assert.match(html, /id="zoomControls"/);
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /env\(safe-area-inset-bottom,0px\)/);
  assert.match(css, /body\[data-mode="video"\] #app #content \.mtl-shell:not\(\[hidden\]\) \{ display: flex; \}/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*?#app\[data-workspace="video"\] #content > \.mtl-shell \{ height: 108px/);
  assert.doesNotMatch(css, /#app\[data-workspace="video"\] #multi-timeline \{ display: none !important/);
  assert.match(css, /#app\[data-workspace="video"\] \.videoPlaybackActions \.playbackSpeeds[\s\S]*display: flex !important/);
  assert.match(css, /@media \(max-width: 767px\) \{[\s\S]*?html,body \{ height: 100%; overflow-x: hidden;/);
  assert.match(css, /#app\[data-workspace="video"\] #mob-scrubber[\s\S]*min-height: 44px/);
});
