/* Real-browser test for the multi-track video timeline (issue: it stayed hidden after a load).
 *
 * The timeline is opened by `multi-timeline.js`, but the video load path used to wait for the
 * filmstrip and the audio waveform before calling `adoptFirstVideo()`. Anything that made those two
 * helpers throw or hang (a stalled `decodeAudioData`, a failing GL upload, a blocked CDN next to a
 * slow disk) left the video loaded and the timeline hidden, with no error to explain it. A
 * source-level test cannot see that, so this drives Chromium through Playwright, loads a real WebM
 * and asserts the timeline is on screen — including when a preview helper is deliberately stalled.
 *
 * Skips itself (instead of failing) when Playwright or a Chromium build is not available, and points
 * a built-in static server at this checkout so the page, its workers and vendor/ all load.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FILM_LAB_VIDEO_TEST_PORT || 8973);
const PW_CANDIDATES = [
  process.env.FILM_LAB_PLAYWRIGHT_DIR,
  path.join(ROOT, 'node_modules', 'playwright-core'),
  path.join(ROOT, 'node_modules', 'playwright'),
  '/tmp/pwtest/node_modules/playwright-core',
].filter(Boolean);
const BROWSER_CANDIDATES = [
  process.env.FILM_LAB_CHROMIUM_PATH,
  path.join(ROOT, 'node_modules', 'playwright-core', '.local-browsers'),
  '/tmp/chromium',
].filter(Boolean);
const CHROME_LIBS = process.env.FILM_LAB_CHROME_LIBS || '/tmp/al2023/lib:/tmp/al2023';
const CHROMIUM_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

function resolvePlaywright() {
  for (const candidate of PW_CANDIDATES) {
    try { return require(candidate); } catch (_) { /* keep looking */ }
  }
  try { return require('playwright-core'); } catch (_) { return null; }
}
function resolveChromium() {
  for (const candidate of BROWSER_CANDIDATES) {
    try { if (candidate && fs.existsSync(candidate)) return candidate; } catch (_) { /* keep looking */ }
  }
  return null;
}
function startStaticServer() {
  const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
    '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
    '.onnx': 'application/octet-stream', '.tflite': 'application/octet-stream', '.task': 'application/octet-stream',
  };
  const server = http.createServer((request, response) => {
    const url = decodeURIComponent((request.url || '/').split('?')[0]);
    const relative = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const resolved = path.resolve(ROOT, relative);
    if (!resolved.startsWith(ROOT) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      response.writeHead(404); response.end('not found'); return;
    }
    response.writeHead(200, {'content-type': types[path.extname(resolved).toLowerCase()] || 'application/octet-stream'});
    fs.createReadStream(resolved).pipe(response);
  });
  return new Promise(resolve => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/* The clip is recorded with the browser's own MediaRecorder: the test then works offline, without
   ffmpeg and without a committed binary fixture. The video track is pulled frame by frame so the
   result is a plain VP8/WebM file any Chromium can decode. */
async function recordWebm(browser) {
  const page = await browser.newPage();
  await page.setContent('<canvas id="clip" width="480" height="270"></canvas>');
  const base64 = await page.evaluate(async () => {
    const canvas = document.getElementById('clip');
    const context = canvas.getContext('2d');
    const type = ['video/webm;codecs=vp8', 'video/webm'].find(candidate => window.MediaRecorder && MediaRecorder.isTypeSupported(candidate));
    if (!type) throw new Error('this Chromium cannot record WebM');
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const recorder = new MediaRecorder(stream, {mimeType: type, videoBitsPerSecond: 600000});
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.start();
    let time = 0;
    const started = Date.now();
    while (Date.now() - started < 1500) {
      time += 1 / 30;
      context.fillStyle = `hsl(${(time * 120) % 360} 60% 45%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#101014';
      context.fillRect(40 + ((time * 90) % 260), 90, 90, 90);
      if (track.requestFrame) track.requestFrame();
      await new Promise(resolve => setTimeout(resolve, 33));
    }
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(chunks, {type}).arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192));
    return btoa(binary);
  });
  await page.close();
  return Buffer.from(base64, 'base64');
}

/* Records every adoptFirstVideo() call, so the test can tell "the timeline was wired" from
   "the timeline happens to be visible". */
const TIMELINE_HOOK = () => {
  window.__timelineCalls = [];
  let value;
  Object.defineProperty(window, 'multiTimeline', {
    configurable: true,
    get() { return value; },
    set(next) {
      value = next;
      if (next && typeof next.adoptFirstVideo === 'function') {
        const original = next.adoptFirstVideo;
        next.adoptFirstVideo = function (...callArgs) {
          const entry = {at: Math.round(performance.now())};
          window.__timelineCalls.push(entry);
          try {
            const result = original.apply(this, callArgs);
            Promise.resolve(result).then(() => { entry.resolved = true; }, error => { entry.rejected = String(error && error.message || error); });
            return result;
          } catch (error) { entry.threw = String(error && error.message || error); throw error; }
        };
      }
    },
  });
};
// Preview helper that a browser really can hit: a decode that never resolves.
const HANG_AUDIO = () => {
  AudioContext.prototype.decodeAudioData = function () { return new Promise(() => {}); };
};
// Preview helper that fails outright (its DOM or a GL call underneath it).
const THROW_FILMSTRIP = () => {
  const original = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...args) {
    if (this.id === 'timelineFilmstrip') throw new Error('filmstrip helper failed');
    return original.apply(this, args);
  };
};

const playwright = resolvePlaywright();
const chromiumPath = resolveChromium();
const available = Boolean(playwright && chromiumPath);

async function openApp(browser, {init = []} = {}) {
  const context = await browser.newContext({viewport: {width: 1440, height: 900}});
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
  await context.route('https://fonts.gstatic.com/**', route => route.fulfill({body: '', contentType: 'font/woff2'}));
  await context.addInitScript(TIMELINE_HOOK);
  for (const script of init) await context.addInitScript(script);
  const page = await context.newPage();
  const messages = [];
  page.on('console', message => messages.push(`${message.type()}: ${message.text().split('\n')[0]}`));
  page.on('pageerror', error => messages.push(`pageerror: ${error.message}`));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => document.getElementById('presetSelect')?.options.length > 1, null, {timeout: 30000});
  return {context, page, messages};
}
async function loadClip(page, clip) {
  const before = Date.now();
  await page.setInputFiles('#videoPickerInput', {name: 'clip.webm', mimeType: 'video/webm', buffer: clip});
  return before;
}
// The previews render asynchronously; wait for the one a test is about before asserting.
async function waitForPreview(page, selector, timeout = 20000) {
  await page.waitForFunction(target => document.querySelector(target).children.length > 0, selector, {timeout}).catch(() => {});
}
const timelineState = page => page.evaluate(() => {
  const root = document.getElementById('multi-timeline');
  const visible = !root.hidden;
  return {
    visible,
    display: getComputedStyle(root).display,
    lanes: [...document.querySelectorAll('#multi-timeline .mtl-track-name')].map(node => node.textContent.trim()),
    calls: window.__timelineCalls || [],
    ready: window.multiTimeline?.isReady?.() ?? null,
    mode: document.body.dataset.mode,
    videoEl: !!document.getElementById('videoEl'),
    duration: document.getElementById('videoEl')?.duration ?? null,
    filmstrip: document.getElementById('timelineFilmstrip').children.length,
    waveform: document.getElementById('audioWaveform').children.length,
    toast: document.getElementById('toast').textContent.trim(),
  };
});

test('the multi-track timeline opens with a loaded video instead of waiting for its previews', {timeout: 300000}, async t => {
  if (!available) {
    t.skip('Playwright and/or a Chromium build are not available in this environment');
    return;
  }
  const server = await startStaticServer();
  const browser = await playwright.chromium.launch({executablePath: chromiumPath, args: CHROMIUM_ARGS, env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS}});
  try {
    const clip = await recordWebm(browser);
    assert.ok(clip.length > 1000, 'the recorded WebM fixture is empty');
    const {context, page, messages} = await openApp(browser);
    const started = await loadClip(page, clip);
    await page.waitForFunction(() => !document.getElementById('multi-timeline').hidden, null, {timeout: 10000})
      .catch(() => {});
    const state = await timelineState(page);
    assert.equal(state.visible, true, `#multi-timeline is still hidden (mode=${state.mode}, toast="${state.toast}")`);
    assert.equal(state.display, 'flex', 'the timeline is not laid out in video mode');
    assert.equal(state.mode, 'video', 'the app did not enter video mode');
    assert.equal(state.videoEl, true);
    assert.ok(Number.isFinite(state.duration) && state.duration > 0, `video duration is ${state.duration}`);
    assert.ok(state.calls.length >= 1, 'window.multiTimeline.adoptFirstVideo() was never called');
    assert.equal(state.calls[0].resolved, true, `adoptFirstVideo did not finish: ${JSON.stringify(state.calls[0])}`);
    assert.equal(state.ready, true, 'the multi-track timeline is not ready');
    // The default lanes exist and the shell is not empty-handedly hidden behind the video-only CSS.
    for (const lane of ['V1', 'V2', 'TEXT', 'AUDIO']) assert.ok(state.lanes.includes(lane), `the ${lane} lane is missing (saw ${state.lanes.join(', ')})`);
    await waitForPreview(page, '#timelineFilmstrip');
    await waitForPreview(page, '#audioWaveform');
    const withPreviews = await timelineState(page);
    assert.ok(withPreviews.filmstrip > 0 && withPreviews.waveform > 0, 'the previews did not render at all');
    // `#multi-timeline` is opening before the filmstrip/waveform work: it is on screen by the time
    // the video is committed (the previews take over a second on a cold load).
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10000, `the timeline took ${elapsed} ms to appear`);
    assert.deepEqual(messages.filter(line => /pageerror/.test(line)), []);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
});

test('a stalled preview helper cannot keep the timeline hidden or fail the load', {timeout: 300000}, async t => {
  if (!available) {
    t.skip('Playwright and/or a Chromium build are not available in this environment');
    return;
  }
  const server = await startStaticServer();
  const browser = await playwright.chromium.launch({executablePath: chromiumPath, args: CHROMIUM_ARGS, env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS}});
  try {
    const clip = await recordWebm(browser);
    const {context, page, messages} = await openApp(browser, {init: [HANG_AUDIO]});
    const started = await loadClip(page, clip);
    await page.waitForFunction(() => !document.getElementById('multi-timeline').hidden, null, {timeout: 12000}).catch(() => {});
    const state = await timelineState(page);
    assert.equal(state.visible, true, 'a stalled audio decode still left #multi-timeline hidden');
    assert.equal(state.display, 'flex');
    assert.equal(state.mode, 'video');
    assert.ok(state.calls.length >= 1, 'adoptFirstVideo() was skipped because the preview never finished');
    assert.equal(state.ready, true);
    assert.equal(state.waveform, 0, 'the stalled decode should not have produced a waveform');
    await waitForPreview(page, '#timelineFilmstrip');
    const withFilmstrip = await timelineState(page);
    assert.ok(withFilmstrip.filmstrip > 0, 'the filmstrip should still have rendered');
    // The guard reports the stalled preview once and the rest of the load continues without it.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !/Video loaded/.test((await timelineState(page)).toast)) await page.waitForTimeout(250);
    const after = await timelineState(page);
    assert.equal(after.visible, true, 'the timeline closed again while the preview was stalled');
    assert.equal(after.mode, 'video');
    assert.match(after.toast, /Video loaded/, `the load never continued past the stalled preview: "${after.toast}"`);
    assert.ok(messages.some(line => /Timeline previews are taking too long/.test(line)),
      `no warning was logged for the stalled preview (${messages.filter(line => /preview/i.test(line)).join(' | ') || 'none'})`);
    assert.ok(Date.now() - started < 25000, 'the load never continued past the stalled preview');
    assert.deepEqual(messages.filter(line => /pageerror/.test(line)), []);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
});

test('a preview helper that throws is a warning, not a failed video load', {timeout: 300000}, async t => {
  if (!available) {
    t.skip('Playwright and/or a Chromium build are not available in this environment');
    return;
  }
  const server = await startStaticServer();
  const browser = await playwright.chromium.launch({executablePath: chromiumPath, args: CHROMIUM_ARGS, env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS}});
  try {
    const clip = await recordWebm(browser);
    const {context, page, messages} = await openApp(browser, {init: [THROW_FILMSTRIP]});
    await loadClip(page, clip);
    await page.waitForFunction(() => !document.getElementById('multi-timeline').hidden, null, {timeout: 12000}).catch(() => {});
    const state = await timelineState(page);
    assert.equal(state.visible, true, 'a throwing filmstrip still left #multi-timeline hidden');
    assert.equal(state.mode, 'video');
    assert.ok(state.calls.length >= 1, 'adoptFirstVideo() was skipped because the filmstrip threw');
    assert.equal(state.filmstrip, 0, 'the injected failure should have stopped the filmstrip');
    await waitForPreview(page, '#audioWaveform');
    const withWaveform = await timelineState(page);
    assert.ok(withWaveform.waveform > 0, 'the waveform should be unaffected by the filmstrip failure');
    assert.match(state.toast, /Video loaded/, `the video load was reported as failed: "${state.toast}"`);
    assert.ok(!/unchanged/.test(state.toast), 'the load reported the media as unchanged although the video is loaded');
    assert.ok(messages.some(line => /Timeline previews are unavailable/.test(line)), 'the preview failure was not logged');
    assert.deepEqual(messages.filter(line => /pageerror/.test(line)), []);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
});
