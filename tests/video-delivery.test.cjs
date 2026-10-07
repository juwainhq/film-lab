/* Round 9 delivery suite: the audio lane, stabilisation, auto-reframe aspects, the delivery
 * presets and the look / LUT scope.
 *
 * The model maths (audio filter chains, the ffmpeg volume expression, the stabiliser filter, the
 * saliency centroid, the size estimate, the delivery geometry) is checked in plain Node against
 * audio-tools.js — the same module the editor and the exporter call. A real Chromium then checks
 * the UI the user touches: the waveform canvas, the fade and keyframe controls, the voice recorder,
 * the aspect pills with the draggable focus dot, the stabiliser controls and the size estimate.
 *
 * Skips itself (instead of failing) when Playwright, a Chromium build or software WebGL are missing.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FILM_LAB_DELIVERY_PORT || 8979);
const PW_CANDIDATES = [
  process.env.FILM_LAB_PLAYWRIGHT_DIR,
  path.join(ROOT, 'node_modules', 'playwright-core'),
  path.join(ROOT, 'node_modules', 'playwright'),
  '/tmp/pwtest/node_modules/playwright-core',
  '/tmp/pwrig/node_modules/playwright-core',
].filter(Boolean);
const BROWSER_CANDIDATES = [
  process.env.FILM_LAB_CHROMIUM_PATH,
  path.join(ROOT, 'node_modules', 'playwright-core', '.local-browsers'),
  '/tmp/chromium',
].filter(Boolean);
const CHROME_LIBS = process.env.FILM_LAB_CHROME_LIBS || '/tmp/al2023/lib:/tmp/al2023';
const CHROMIUM_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

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
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const script = html.slice(html.indexOf('const startFilmLab'), html.lastIndexOf('</script>'));
const timeline = fs.readFileSync(path.join(ROOT, 'multi-timeline.js'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const Audio = require('../audio-tools.js');

/* ---------------------------------------------------------------------------- model in Node */
test('the audio model builds the fade, keyframe, normalise and denoise chain the export runs', () => {
  assert.deepEqual(Audio.normalizeAudio({}), {gain: 1, fadeIn: 0, fadeOut: 0, normalize: false, denoise: false, denoiseAmount: 12, keyframes: []});
  // A constant gain is one volume filter; the automation expression replaces it when keys exist.
  assert.equal(Audio.audioFilterChain({gain: 1.5}, {duration: 4}), 'volume=1.5');
  assert.equal(Audio.audioFilterChain({}, {duration: 4}), null);
  const chain = Audio.audioFilterChain({fadeIn: 0.5, fadeOut: 1, denoise: true, denoiseAmount: 22, normalize: true}, {duration: 6});
  assert.equal(chain, 'afade=t=in:st=0:d=0.5,afade=t=out:st=5:d=1,afftdn=nf=-22:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11');
  // The automation ramps between keys and holds the first value before the first key.
  const expression = Audio.volumeExpression([{time: 0, value: 0}, {time: 1, value: 2}, {time: 3, value: 0.5}], {duration: 3});
  assert.equal(expression, 'if(lt(t,0),0,if(lt(t,1),(0+(2-0)*(t-0)/1),if(lt(t,3),(2+(0.5-2)*(t-1)/2),0.5)))');
  assert.equal(Audio.volumeExpression([], {duration: 3}), null);
  // Keyframes are sorted, deduped and clamped to a sane gain range.
  // Keyframes come back sorted, deduped (a key 5 ms from another replaces it) and clamped so a
  // typo cannot blow a listener's ears off.
  const keys = Audio.normalizeVolumeKeyframes([{time: 2, value: 9}, {time: 1, value: 0.5}, {time: 2.005, value: 0.25}, {time: -4, value: -2}]);
  assert.deepEqual(keys, [{time: 0, value: 0}, {time: 1, value: 0.5}, {time: 2.005, value: 0.25}]);
  const automated = Audio.audioFilterChain({keyframes: keys}, {duration: 5});
  assert.match(automated, /^volume='if\(/);
  assert.match(automated, /:eval=frame$/);
});

test('voice takes record, place and mix under the source audio', () => {
  const take = Audio.normalizeVoiceTake({name: 'Take 1', start: 2, duration: 3, gain: 2});
  assert.deepEqual({start: take.start, duration: take.duration, gain: take.gain}, {start: 2, duration: 3, gain: 2});
  const chain = Audio.takeFilterChain(take, {duration: 3});
  assert.equal(chain, 'volume=2,afade=t=in:st=0:d=0.05,afade=t=out:st=2.85:d=0.15,adelay=2000:all=1');
  const graph = Audio.audioGraph({fadeIn: 0.4}, [take], {duration: 5});
  // Input 0 is the concat list, so the source bed is [1:a] and the take follows it.
  assert.match(graph.filter, /^\[1:a\]afade=t=in:st=0:d=0\.4\[bed\];\[2:a\]volume=2/);
  assert.match(graph.filter, /\[bed\]\[take0\]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0\[audio\]$/);
  assert.deepEqual(graph.args.slice(-4), ['-map', '0:v:0', '-map', '[audio]']);
  assert.deepEqual(graph.args.slice(0, 2), ['-filter_complex', graph.filter]);
  // With no takes the graph collapses to a plain audio filter, so the mux keeps its old shape.
  const single = Audio.audioGraph({normalize: true}, [], {duration: 5});
  assert.equal(single.filter, null);
  assert.deepEqual(single.args, ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11']);
  assert.equal(Audio.audioGraph({}, [], {duration: 5}).args.length, 0);
});

test('stabilisation offers deshake, prefers vidstab when the engine has it, and copies audio', () => {
  assert.equal(Audio.stabilizationFilter({enabled: false, strength: 1}), null);
  assert.equal(Audio.stabilizationFilter({enabled: true, strength: 0}, {available: 'deshake'}), 'deshake=rx=8:ry=8:edge=1:blocksize=16');
  assert.equal(Audio.stabilizationFilter({enabled: true, strength: 1}, {available: 'deshake'}), 'deshake=rx=64:ry=64:edge=1:blocksize=16');
  assert.equal(Audio.stabilizationFilter({enabled: true, strength: 0.5}, {available: 'vidstab'}), 'vidstabdetect=shakiness=5:result=transforms.trf,vidstabtransform=smoothing=17');
  // A strength in the middle lands between the two ends of the radius.
  const mid = Number(Audio.stabilizationFilter({enabled: true, strength: 0.5}, {available: 'deshake'}).match(/rx=(\d+)/)[1]);
  assert.ok(mid > 8 && mid < 64, `the strength slider moves the radius (${mid})`);
  const args = Audio.stabilizeArgs({input: 'output.mp4', output: 'stable.mp4', container: 'mp4', quality: 'high', filter: 'deshake=rx=36:ry=36:edge=1:blocksize=16'});
  assert.deepEqual(args, ['-y', '-i', 'output.mp4', '-vf', 'deshake=rx=36:ry=36:edge=1:blocksize=16', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', 'stable.mp4']);
  assert.ok(args.includes('-c:a') && args[args.indexOf('-c:a') + 1] === 'copy', 'the stabiliser pass never re-encodes the audio');
});

test('auto-reframe finds the busiest region and the aspect presets keep the ratio exact', () => {
  // A bright block on the right of a dark frame pulls the focus point with it.
  const width = 64, height = 64;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(12);
  for (let y = 8; y < 56; y += 1) for (let x = 44; x < 60; x += 1) {
    const index = (y * width + x) * 4;
    pixels[index] = 250; pixels[index + 1] = 250; pixels[index + 2] = 250;
  }
  const focus = Audio.reframeFocus(Audio.saliencyMap(pixels, width, height));
  assert.ok(focus.x > 0.6, `auto-reframe aims at the bright block (x=${focus.x})`);
  assert.ok(focus.y > 0.3 && focus.y < 0.7, `and keeps the vertical centre (y=${focus.y})`);
  // A flat frame has nothing to aim at, so the centre is kept.
  const flat = Audio.reframeFocus(Audio.saliencyMap(new Uint8ClampedArray(width * height * 4).fill(20), width, height));
  assert.deepEqual({x: flat.x, y: flat.y}, {x: 0.5, y: 0.5});
  assert.deepEqual(Audio.ASPECT_PRESETS.map(preset => preset.id), ['9:16', '1:1', '4:5', '16:9', 'original']);
  // The ratio survives the scale: a 9:16 reel of a 1920x1080 clip is exactly 1080x1920.
  const portrait = Audio.deliveryGeometry({width: 1920, height: 1080, framing: {aspect: '9:16'}, delivery: {resolution: '1080', fps: 60, bitrate: 'high'}});
  assert.deepEqual({width: portrait.width, height: portrait.height, fps: portrait.fps}, {width: 1080, height: 1920, fps: 60});
  const square = Audio.deliveryGeometry({width: 1920, height: 1080, framing: {aspect: '1:1'}, delivery: {resolution: '720', fps: 30}});
  assert.equal(square.width, square.height, 'a 1:1 preset exports a square frame');
  const untouched = Audio.deliveryGeometry({width: 1080, height: 1920, framing: {aspect: 'original'}, delivery: {resolution: 'original'}});
  assert.deepEqual({width: untouched.width, height: untouched.height}, {width: 1080, height: 1920});
  assert.deepEqual(Audio.normalizeFraming({aspect: '9:16', focus: {x: 4, y: -3}}), {aspect: '9:16', ratio: 9 / 16, auto: false, focus: {x: 1, y: 0}});
});

test('the delivery presets cover 720p to 4K, 24 to 60 fps, and estimate the file size', () => {
  assert.deepEqual(Audio.RESOLUTION_PRESETS.map(preset => preset.id), ['original', '720', '1080', '2160']);
  assert.deepEqual(Audio.FRAME_RATE_PRESETS, [24, 30, 60]);
  assert.deepEqual(Audio.BITRATE_PRESETS.map(preset => preset.id), ['economy', 'standard', 'high', 'max']);
  assert.deepEqual(Audio.BITRATE_PRESETS.map(preset => preset.mbps), [4, 8, 16, 28]);
  const plan = Audio.normalizeDelivery({resolution: '2160', fps: 60, bitrate: 'high'});
  assert.deepEqual({shortEdge: plan.shortEdge, fps: plan.fps, mbps: plan.mbps, crf: plan.crf}, {shortEdge: 2160, fps: 60, mbps: 16, crf: '16'});
  // Anything unknown falls back to the standard preset rather than throwing.
  assert.equal(Audio.normalizeDelivery({resolution: '8k', fps: 12, bitrate: 'nonsense'}).fps, 30);
  // 8 Mbps of video plus 128 kbps of audio for 30 seconds is about 30 MB.
  const size = Audio.estimatedFileSize({duration: 30, mbps: 8, audio: true});
  assert.equal(size.mb, 30.5);
  assert.equal(Audio.sizeLabel(size), '31 MB');
  assert.equal(Audio.sizeLabel(Audio.estimatedFileSize({duration: 600, mbps: 16})), '1.21 GB');
  // The audio bitrate is 128 kbps, so it only nudges a video-sized estimate.
  assert.equal(Audio.estimatedFileSize({duration: 30, mbps: 8, audio: false}).mb, 30);
  assert.equal(Audio.sizeLabel(Audio.estimatedFileSize({duration: 3, mbps: 4})), '1.5 MB');
  // The estimate scales with the bitrate and follows the duration.
  assert.ok(Audio.estimatedFileSize({duration: 10, mbps: 16}).mb > Audio.estimatedFileSize({duration: 10, mbps: 8}).mb * 1.9);
});

test('a look can ride on one clip or on the whole timeline, and the clip wins', () => {
  assert.deepEqual(Audio.LOOK_SCOPES.map(scope => scope.id), ['clip', 'timeline']);
  assert.equal(Audio.resolveLook({}), null);
  const timelineLook = {id: 'lut-teal', name: 'Teal', scope: 'timeline', intensity: 0.8};
  assert.deepEqual(Audio.resolveLook({timeline: timelineLook}), {id: 'lut-teal', name: 'Teal', scope: 'timeline', intensity: 0.8});
  const clipLook = {id: 'lut-warm', name: 'Warm', scope: 'clip', intensity: 0.4};
  assert.deepEqual(Audio.resolveLook({timeline: timelineLook, clip: clipLook}), {id: 'lut-warm', name: 'Warm', scope: 'clip', intensity: 0.4});
  // A clip with no look of its own inherits the timeline look.
  assert.equal(Audio.resolveLook({timeline: timelineLook, clip: {id: null, scope: 'clip'}}).id, 'lut-teal');
  assert.equal(Audio.normalizeLook({intensity: 9}).intensity, 1);
  assert.equal(Audio.normalizeLook({scope: 'everything'}).scope, 'clip');
});

test('the editor wires every new control and the service worker ships the module', () => {
  for (const id of ['audioWaveCanvas', 'sliderAudioGain', 'sliderAudioFadeIn', 'sliderAudioFadeOut', 'audioKeyframeBtn', 'audioKeyframeClearBtn',
    'audioNormalizeBtn', 'audioDenoiseBtn', 'sliderAudioDenoise', 'audioRecordBtn', 'audioRecordStopBtn', 'audioTakeList',
    'lookScopePills', 'lookSelect', 'sliderLookIntensity', 'lookImportBtn', 'lookLutFile',
    'aspectPills', 'autoReframeBtn', 'focusResetBtn', 'focusHandle', 'stabilizeEnabled', 'sliderStabilize',
    'videoFps', 'videoBitrate', 'videoDeliveryEstimate']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is mounted`);
  }
  assert.match(html, /<option value="2160">4K<\/option>/, '4K is offered in the resolution list');
  assert.match(html, /<script src="\.\/audio-tools\.js"><\/script>/, 'the audio model is loaded by the app');
  for (const snippet of [
    /filmLabAnalyseWaveform/, /audioKeyframeBtn'\)\?\.addEventListener/,
    /new MediaRecorder\(stream/,
    /getUserMedia\(\{audio: true\}\)/,
    /filmLabAutoReframe/, /data-aspect/,
    /filmLabSyncStabilization/, /filmLabSyncDeliveryEstimate/,
    /window\.filmLabExportPlan = \(\) => filmLabDeliveryPlan\(\)/,
    /film-lab-video-loaded/,
  ]) assert.match(script, snippet, `the wiring block defines ${snippet}`);
  // The export bakes the audio graph, the takes and the stabiliser pass.
  assert.match(script, /audioModel\.audioGraph\(audioPlan,placedTakes/);
  assert.match(script, /social\.muxVideoArgs\(\{start:exportStart/);
  assert.match(script, /audioModel\.stabilizeArgs\(\{input:outputName,output:stableName/);
  assert.match(script, /const blob=await canvasBlob\(output,'image\/jpeg',delivery\.jpegQuality\)/);
  // The shared encoder helpers take the preset overrides.
  const social = fs.readFileSync(path.join(ROOT, 'social-tools.js'), 'utf8');
  assert.match(social, /function videoArgs\(\{fps = 24, start = 0, duration, container = 'mp4', quality = 'medium', audio = true, codec, source = 'source-video', output, crf, bitrate\}\)/);
  assert.match(social, /function muxVideoArgs\(\{start = 0, duration, container = 'mp4', audio = true, source = 'source-video', extraInputs = \[\], audioGraph = null, output\}\)/);
  // Cache bump + precache so the offline shells get the new module.
  assert.match(sw, /const CACHE = 'filmlab-v19';/);
  assert.match(sw, /'audio-tools\.js'/);
});

/* ------------------------------------------------------------------------- real browser run */
const playwright = resolvePlaywright();
const chromiumPath = resolveChromium();
const available = Boolean(playwright && chromiumPath);

function startStaticServer() {
  const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
    '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
    '.webm': 'video/webm', '.mp4': 'video/mp4', '.ogg': 'audio/ogg',
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
async function launchWithWebgl2() {
  let browser = null;
  try {
    browser = await playwright.chromium.launch({executablePath: chromiumPath, args: CHROMIUM_ARGS, env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS}});
    const probe = await browser.newPage();
    const ok = await probe.evaluate(() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (_) { return false; } });
    await probe.close();
    if (ok) return browser;
  } catch (_) { /* fall through to the skip */ }
  if (browser) { try { await browser.close(); } catch (_) { /* already gone */ } }
  return null;
}

test('the audio lane, reframe controls, stabiliser and delivery presets work in a real browser', {timeout: 600000}, async t => {
  if (!available) {
    t.skip('Playwright and a Chromium build are needed for this test');
    return;
  }
  const browser = await launchWithWebgl2();
  if (!browser) {
    t.skip('this Chromium cannot create a WebGL2 context, so the Film Lab editor cannot boot');
    return;
  }
  const server = await startStaticServer();
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}, serviceWorkers: 'block', permissions: ['microphone']});
    await context.route('**/sw.js', route => route.abort());
    await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
    await context.route('https://fonts.gstatic.com/**', route => route.fulfill({body: '', contentType: 'font/woff2'}));
    const page = await context.newPage();
    const errors = [];
    page.on('console', message => { if (message.type() === 'error' && !/ERR_CONNECTION|Failed to load resource/.test(message.text())) errors.push(message.text().slice(0, 220)); });
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    // A short clip with a real soundtrack, so the waveform has something to decode.
    const clip = await (async () => {
      const recorderPage = await browser.newPage();
      await recorderPage.setContent('<canvas id="clip" width="320" height="180"></canvas>');
      const base64 = await recorderPage.evaluate(async () => {
        const canvas = document.getElementById('clip'), context = canvas.getContext('2d');
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const audioContext = new AudioCtx();
        await audioContext.resume();
        const destination = audioContext.createMediaStreamDestination();
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.frequency.value = 220;
        gain.gain.value = 0.25;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        const stream = canvas.captureStream(0);
        destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
        const videoTrack = stream.getVideoTracks()[0];
        const recorder = new MediaRecorder(stream, {mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 600000});
        const chunks = [];
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.start();
        // A still, two-tone frame: stable pixels keep the look and waveform checks honest.
        context.fillStyle = '#8899aa';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#223344';
        context.fillRect(40, 40, 80, 80);
        const started = Date.now();
        while (Date.now() - started < 1800) {
          if (videoTrack.requestFrame) videoTrack.requestFrame();
          await new Promise(resolve => setTimeout(resolve, 33));
        }
        const stopped = new Promise(resolve => { recorder.onstop = resolve; });
        recorder.stop(); await stopped; oscillator.stop();
        audioContext.close();
        const bytes = new Uint8Array(await new Blob(chunks, {type: 'video/webm'}).arrayBuffer());
        let binary = '';
        for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192));
        return btoa(binary);
      });
      await recorderPage.close();
      return Buffer.from(base64, 'base64');
    })();

    // A deliberately loud 17³ LUT: every entry maps to the same mauve, so the graded frame is a
    // flat colour and the strength slider can be measured halfway between two known values.
    const flatLook = ['LUT_3D_SIZE 17'];
    for (let entry = 0; entry < 17 * 17 * 17; entry += 1) flatLook.push('0.9 0.1 0.6');
    const flatLookFile = Buffer.from(flatLook.join('\n'), 'utf8');

    await page.goto(`http://127.0.0.1:${PORT}/index.html`, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('presetSelect')?.options.length > 1, null, {timeout: 30000});
    await page.setInputFiles('#videoPickerInput', {name: 'clip.webm', mimeType: 'video/webm', buffer: clip});
    await page.waitForFunction(() => document.body.dataset.mode === 'video', null, {timeout: 90000});
    await page.waitForFunction(() => window.multiTimeline?.isReady?.(), null, {timeout: 60000});
    await page.waitForFunction(() => window.filmLabDeliveryReady === true, null, {timeout: 30000});
    await page.evaluate(() => {
      document.getElementById('exportTab').click();
      document.querySelectorAll('#videoFxPanel details, #videoExportPanel details').forEach(section => { section.open = true; });
    });
    await page.waitForTimeout(1200);

    // --- 1. The waveform is drawn from the clip's own audio ---------------------------------
    const waveform = await page.evaluate(async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const canvasNode = document.getElementById('audioWaveCanvas');
        if (canvasNode.dataset.empty === 'false') break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const canvasNode = document.getElementById('audioWaveCanvas');
      const ctx = canvasNode.getContext('2d');
      const data = ctx.getImageData(0, 0, canvasNode.width, canvasNode.height).data;
      let painted = 0;
      for (let index = 0; index < data.length; index += 4) if (data[index] > 180 && data[index + 1] > 180) painted += 1;
      return {empty: canvasNode.dataset.empty, painted, status: document.getElementById('audioWaveStatus').textContent};
    });
    assert.equal(waveform.empty, 'false', `the waveform canvas drew the clip's audio (${waveform.status})`);
    assert.ok(waveform.painted > 500, `the waveform has visible bars (${waveform.painted} bright pixels)`);

    // --- 2. Fades, gain, normalise, denoise and the volume keyframe list --------------------
    const audioControls = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const set = (id, value) => { const node = document.getElementById(id); node.value = String(value); node.dispatchEvent(new Event('input', {bubbles: true})); };
      set('sliderAudioGain', 140); set('sliderAudioFadeIn', 0.8); set('sliderAudioFadeOut', 1.2);
      await wait(200);
      document.getElementById('audioNormalizeBtn').click();
      document.getElementById('audioDenoiseBtn').click();
      await wait(200);
      set('sliderAudioDenoise', 24);
      window.TL.playhead = 0.6;
      await wait(200);
      document.getElementById('audioKeyframeBtn').click();
      window.TL.playhead = 1.2;
      await wait(150);
      document.getElementById('audioKeyframeBtn').click();
      await wait(250);
      const settings = window.filmLabAudio.settings;
      const chain = window.FilmAudio.audioFilterChain(settings, {duration: 3});
      return {
        settings, chain,
        keyRows: document.querySelectorAll('#audioKeyframeList .fxListItem').length,
        denoiseRowHidden: document.getElementById('audioDenoiseRow').hidden,
        normalizePressed: document.getElementById('audioNormalizeBtn').getAttribute('aria-pressed'),
        fadeOut: document.getElementById('valAudioFadeOut').textContent,
        gain: document.getElementById('valAudioGain').textContent,
      };
    });
    assert.equal(audioControls.settings.gain, 1.4, 'the volume slider reaches the model');
    assert.equal(audioControls.settings.fadeIn, 0.8, 'the fade-in slider reaches the model');
    assert.equal(audioControls.settings.fadeOut, 1.2, 'the fade-out slider reaches the model');
    assert.equal(audioControls.gain, '140%');
    assert.equal(audioControls.fadeOut, '1.2s');
    assert.equal(audioControls.normalizePressed, 'true', 'normalise is a toggle');
    assert.equal(audioControls.denoiseRowHidden, false, 'the noise floor slider appears with noise reduction');
    assert.equal(audioControls.settings.denoiseAmount, 24);
    assert.equal(audioControls.keyRows, 2, 'both volume keyframes are listed');
    assert.equal(audioControls.settings.keyframes.length, 2, 'the keyframes are in the model');
    assert.match(audioControls.chain, /^volume='if\(lt\(t,/, 'the export uses the automation expression');
    assert.match(audioControls.chain, /afade=t=in:st=0:d=0\.8/);
    assert.match(audioControls.chain, /afade=t=out:st=/);
    assert.match(audioControls.chain, /afftdn=nf=-24:tn=1/);
    assert.match(audioControls.chain, /loudnorm=I=-16:TP=-1\.5:LRA=11/);

    // --- 3. Recording a voice take with MediaRecorder --------------------------------------
    const take = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      window.TL.playhead = 0.4;
      await wait(200);
      document.getElementById('audioRecordBtn').click();
      await wait(1500);
      const recordingDisabled = document.getElementById('audioRecordStopBtn').disabled;
      document.getElementById('audioRecordStopBtn').click();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await wait(250);
        if ((window.filmLabAudio.takes || []).length) break;
      }
      const takes = window.filmLabAudio.takes || [];
      const graph = takes.length ? window.FilmAudio.audioGraph(window.filmLabAudio.settings, takes, {duration: 4}) : null;
      return {
        recordingDisabled, count: takes.length,
        first: takes[0] ? {start: takes[0].start, duration: takes[0].duration, hasBlob: !!takes[0].blob, size: takes[0].blob?.size || 0} : null,
        rows: document.querySelectorAll('#audioTakeList .fxListItem').length,
        status: document.getElementById('audioStatus').textContent,
        graph: graph ? graph.filter : null,
      };
    });
    assert.equal(take.recordingDisabled, false, 'the stop button is live while recording');
    assert.ok(take.count >= 1, `a voice take was recorded (${take.status})`);
    assert.ok(take.first.hasBlob && take.first.size > 0, 'the take carries its recorded audio blob');
    assert.ok(take.first.duration > 0.5, `the take knows how long it ran (${take.first.duration}s)`);
    assert.equal(take.rows, 1, 'the take is listed in the panel');
    assert.match(take.graph, /amix=inputs=2/, 'the take is mixed with the source audio');

    // --- 4. Aspect presets, the focus dot and auto-reframe ----------------------------------
    const framing = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      document.querySelector('[data-aspect="9:16"]').click();
      await wait(300);
      const afterPill = {
        aspect: window.filmLabFraming.aspect,
        ratio: window.filmLabFraming.ratio,
        // The app's own crop contract: the export, the overlay and the sidebar crop row all read
        // exportOptions.format, so the pill must reach it.
        format: document.getElementById('videoFrameFormat').value,
        cropRowPressed: document.querySelector('[data-format="story"]').getAttribute('aria-pressed'),
        overlayHidden: document.getElementById('cropOverlay').hidden,
        pressed: document.querySelector('[data-aspect="9:16"]').getAttribute('aria-pressed'),
        handleHidden: document.getElementById('focusHandle').hidden,
      };
      // Drag the focus dot: it must land where the pointer left it.
      const handle = document.getElementById('focusHandle');
      const box = document.getElementById('glCanvas').getBoundingClientRect();
      handle.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, pointerId: 71, clientX: box.left + box.width * 0.5, clientY: box.top + box.height * 0.5}));
      handle.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, pointerId: 71, clientX: box.left + box.width * 0.75, clientY: box.top + box.height * 0.25}));
      handle.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerId: 71, clientX: box.left + box.width * 0.75, clientY: box.top + box.height * 0.25}));
      await wait(300);
      const focused = {...window.filmLabFraming.focus};
      document.getElementById('focusResetBtn').click();
      await wait(200);
      const recentred = {...window.filmLabFraming.focus};
      const auto = await window.filmLabAutoReframe();
      const status = document.getElementById('framingStatus').textContent;
      const estimate = document.getElementById('videoDeliveryEstimate').textContent;
      return {afterPill, focused, recentred, auto, status, estimate};
    });
    assert.equal(framing.afterPill.aspect, '9:16');
    assert.equal(framing.afterPill.ratio, 9 / 16);
    assert.equal(framing.afterPill.pressed, 'true', 'the aspect pill is marked pressed');
    assert.equal(framing.afterPill.format, 'story', 'the 9:16 pill drives the app crop format');
    assert.equal(framing.afterPill.cropRowPressed, 'true', 'the sidebar crop row follows the pill');
    assert.equal(framing.afterPill.overlayHidden, false, 'the crop overlay marks the frame that will be exported');
    assert.equal(framing.afterPill.handleHidden, false, 'the focus dot appears with an aspect preset');
    assert.ok(Math.abs(framing.focused.x - 0.75) < 0.06, `the focus dot follows the pointer horizontally (${framing.focused.x})`);
    assert.ok(Math.abs(framing.focused.y - 0.25) < 0.06, `and vertically (${framing.focused.y})`);
    assert.deepEqual(framing.recentred, {x: 0.5, y: 0.5}, 'the centre button recentres the focus');
    // The sidebar's own crop buttons write the same record back.
    const fromRow = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      document.querySelector('[data-format="square"]').click();
      await wait(250);
      return {aspect: window.filmLabFraming.aspect, ratio: window.filmLabFraming.ratio,
        storyPill: document.querySelector('[data-aspect="9:16"]').getAttribute('aria-pressed'),
        squarePill: document.querySelector('[data-aspect="1:1"]').getAttribute('aria-pressed'),
        frame: window.filmLabExportFrame()};
    });
    assert.equal(fromRow.aspect, '1:1', 'the crop row updates the aspect preset');
    assert.equal(fromRow.ratio, 1, 'and its ratio');
    assert.deepEqual([fromRow.storyPill, fromRow.squarePill], ['false', 'true'], 'the pills follow the crop row');
    assert.equal(fromRow.frame.width, fromRow.frame.height, `a square export is square (${JSON.stringify(fromRow.frame)})`);
    await page.evaluate(() => { document.querySelector('[data-aspect="9:16"]').click(); });
    assert.ok(framing.auto && framing.auto.x > 0 && framing.auto.x < 1, `auto-reframe produced a focus point (${JSON.stringify(framing.auto)})`);
    assert.match(framing.status, /Auto-reframe/, `the status reports the reframe: ${framing.status}`);
    assert.match(framing.estimate, /9:16|1080 × 1920|Estimate/i, `the delivery estimate is live: ${framing.estimate}`);

    // --- 5. Stabiliser controls and the delivery presets ------------------------------------
    const delivery = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const set = (id, value) => { const node = document.getElementById(id); node.value = String(value); node.dispatchEvent(new Event('change', {bubbles: true})); };
      const checkbox = document.getElementById('stabilizeEnabled');
      checkbox.checked = true; checkbox.dispatchEvent(new Event('change', {bubbles: true}));
      const strength = document.getElementById('sliderStabilize');
      strength.value = '80'; strength.dispatchEvent(new Event('input', {bubbles: true}));
      await wait(250);
      const stabilization = {...window.filmLabStabilization};
      const filter = window.FilmAudio.stabilizationFilter(stabilization, {available: 'deshake'});
      set('videoResolution', '2160'); set('videoFps', '60'); set('videoBitrate', 'high');
      await wait(300);
      const settings = window.filmLabDelivery;
      const estimate = document.getElementById('videoDeliveryEstimate').textContent;
      const plan = window.FilmAudio.normalizeDelivery(settings);
      // The exporter reads the panel through these two helpers, so check them, not just the settings.
      const exportPlan = window.filmLabExportPlan();
      const exportSize = window.filmLabEstimatedExportSize(30);
      const filterProbe = window.filmLabFilterAvailable('deshake');
      return {stabilization, filter, rowHidden: document.getElementById('stabilizeRow').hidden,
        exportFps: exportPlan.fps, exportCrf: exportPlan.crf, exportQuality: exportPlan.jpegQuality, exportMbps: exportPlan.mbps,
        exportSize, filterProbe, frame: window.filmLabExportFrame(), estimate,
        strengthLabel: document.getElementById('valStabilize').textContent, settings, estimate, plan,
        fpsOptions: [...document.getElementById('videoFps').options].map(option => option.value),
        bitrateOptions: [...document.getElementById('videoBitrate').options].map(option => option.value),
        resolutionOptions: [...document.getElementById('videoResolution').options].map(option => option.value)};
    });
    assert.equal(delivery.stabilization.enabled, true, 'the stabiliser toggle reaches the model');
    assert.equal(delivery.stabilization.strength, 0.8);
    assert.equal(delivery.rowHidden, false, 'the strength slider appears with the toggle');
    assert.equal(delivery.strengthLabel, '80%');
    assert.equal(delivery.filter, 'deshake=rx=53:ry=53:edge=1:blocksize=16');
    assert.deepEqual(delivery.resolutionOptions, ['original', '1080', '720', '2160'], '720p, 1080p and 4K are offered');
    assert.deepEqual(delivery.fpsOptions, ['24', '30', '60']);
    assert.deepEqual(delivery.bitrateOptions, ['economy', 'standard', 'high', 'max']);
    assert.equal(delivery.settings.fps, 60, 'the fps preset reaches the model');
    assert.equal(delivery.settings.mbps, 16, 'the bitrate preset reaches the model');
    assert.equal(delivery.plan.shortEdge, 2160);
    // The export path reads the same panel the user set, and the estimate follows the bitrate.
    assert.equal(delivery.exportFps, 60, 'the exporter uses the chosen frame rate');
    assert.equal(delivery.exportMbps, 16, 'the exporter uses the chosen bitrate');
    assert.ok(Number(delivery.exportCrf) <= 20, 'the quality preset tightens the encoder CRF');
    assert.ok(delivery.exportQuality >= 0.9 && delivery.exportQuality <= 1, 'the frame quality stays high');
    assert.equal(delivery.exportSize.label, '61 MB', `a 30s 4K export is sized from the panel (${JSON.stringify(delivery.exportSize)})`);
    assert.equal(delivery.filterProbe, false, 'an engine with no filter list is answered "no", so deshake is used');
    assert.match(delivery.estimate, /Estimated size: /, `the size estimate is shown: ${delivery.estimate}`);
    // 4K vertical from a 16:9 source: the crop is scaled, never padded, and both numbers are even.
    assert.deepEqual(delivery.frame, {width: 2160, height: 3840}, `the export frame is exact (${JSON.stringify(delivery.frame)})`);
    assert.match(delivery.estimate, /2160 × 3840/, `the estimate reports the frame the encoder gets: ${delivery.estimate}`);

    // --- 6. A look applies to one clip and to the whole timeline -----------------------------
    const looks = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const options = [...document.getElementById('lookSelect').options].map(option => option.value);
      document.querySelector('[data-look-scope="timeline"]').click();
      await wait(200);
      window.filmLabApplyLook({id: 'look-test', name: 'Test look', intensity: 0.5}, 'timeline look');
      await wait(200);
      const timelineLook = JSON.parse(JSON.stringify(window.filmLabLook.timeline));
      const forClip = window.filmLabLookForClip('whatever');
      document.querySelector('[data-look-scope="clip"]').click();
      await wait(200);
      window.filmLabApplyLook({id: 'look-clip', name: 'Clip look'}, 'clip look');
      await wait(200);
      const resolved = window.filmLabLookForClip(window.TL.selectedClip?.id || window.multiTimeline.clips[0].id);
      const pressed = [...document.querySelectorAll('[data-look-scope]')].map(button => button.getAttribute('aria-pressed'));
      const status = document.getElementById('lookStatus').textContent;
      return {options, timelineLook, forClip, resolved, pressed, status};
    });
    assert.ok(looks.options.includes(''), 'the look list offers a no-look entry');
    assert.deepEqual(looks.timelineLook, {id: 'look-test', name: 'Test look', scope: 'timeline', intensity: 0.5}, 'the timeline look is stored');
    assert.equal(looks.forClip.id, 'look-test', 'a clip without its own look inherits the timeline look');
    assert.equal(looks.resolved.id, 'look-clip', 'a clip look wins over the timeline look');
    assert.deepEqual(looks.pressed, ['true', 'false'], 'the scope pills stay in step');

    // --- 7. A look actually reaches the rendered frame, at the strength it was set to --------
    await page.evaluate(() => {
      window.__sampleFrame = () => {
        const canvasNode = document.getElementById('glCanvas');
        const scratch = document.createElement('canvas');
        scratch.width = 96; scratch.height = 54;
        const ctx = scratch.getContext('2d', {willReadFrequently: true});
        ctx.clearRect(0, 0, scratch.width, scratch.height);
        ctx.drawImage(canvasNode, 0, 0, scratch.width, scratch.height);
        const data = ctx.getImageData(0, 0, scratch.width, scratch.height).data;
        const sum = [0, 0, 0];
        for (let index = 0; index < data.length; index += 4) { sum[0] += data[index]; sum[1] += data[index + 1]; sum[2] += data[index + 2]; }
        const count = data.length / 4;
        return sum.map(value => Math.round(value / count));
      };
    });
    const ungraded = await page.evaluate(() => window.__sampleFrame());
    await page.setInputFiles('#gradeLutInput', {name: 'flat-look.cube', mimeType: 'text/plain', buffer: flatLookFile});
    await page.waitForFunction(() => [...document.getElementById('lookSelect').options].some(option => option.textContent === 'flat-look.cube'), null, {timeout: 20000});
    const pixels = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const settle = async () => { await wait(500); return window.__sampleFrame(); };
      // Clear the look the earlier section left on the clip (a clip look always wins over the
      // timeline one), then aim the panel at the whole timeline.
      document.querySelector('[data-look-scope="clip"]').click();
      await wait(150);
      document.getElementById('lookClearBtn').click();
      await wait(150);
      document.querySelector('[data-look-scope="timeline"]').click();
      await wait(200);
      // The import activated the LUT in the Grade tab; clearing the look hands the frame back
      // ungraded, which is the reference the mixed result is measured against.
      const base = await settle();
      const select = document.getElementById('lookSelect');
      select.value = [...select.options].find(option => option.textContent === 'flat-look.cube').value;
      select.dispatchEvent(new Event('change', {bubbles: true}));
      // The picker keeps the strength it had; ask for the full look first.
      const strength = document.getElementById('sliderLookIntensity');
      strength.value = '100'; strength.dispatchEvent(new Event('input', {bubbles: true}));
      const full = await settle();
      const lookAtFull = JSON.parse(JSON.stringify(window.filmLabLook.timeline));
      const gradeAtFull = window.filmLabGradeLookState('main');
      strength.value = '50'; strength.dispatchEvent(new Event('input', {bubbles: true}));
      const half = await settle();
      document.getElementById('lookClearBtn').click();
      const cleared = await settle();
      return {base, full, half, cleared, amount: window.filmLabLookAmount, lookAtFull, gradeAtFull,
        gradeWarning: document.getElementById('toastStack')?.textContent.includes('color grading features') || false,
        status: document.getElementById('lookStatus').textContent};
    });
    const close = (actual, expected, tolerance, label) => {
      for (let channel = 0; channel < 3; channel += 1) {
        assert.ok(Math.abs(actual[channel] - expected[channel]) <= tolerance,
          `${label}: channel ${channel} was ${actual[channel]}, expected about ${expected[channel]} (${JSON.stringify(actual)})`);
      }
    };
    close(pixels.base, ungraded, 12, 'the ungraded frame is the clip\'s own colour');
    assert.ok(pixels.lookAtFull && pixels.lookAtFull.id, `the look is stored on the timeline (${JSON.stringify(pixels.lookAtFull)})`);
    assert.equal(pixels.gradeAtFull.id, pixels.lookAtFull.id, 'the grade wears the timeline look');
    // Every LUT entry is (0.9, 0.1, 0.6), so a full-strength look paints exactly that.
    close(pixels.full, [230, 26, 153], 30, 'the full-strength look paints the LUT colour');
    const halfway = pixels.base.map((value, index) => Math.round((value + [230, 26, 153][index]) / 2));
    close(pixels.half, halfway, 26, 'the strength slider mixes halfway');
    close(pixels.cleared, pixels.base, 14, 'clearing the look restores the ungraded frame');
    assert.equal(pixels.amount, 1, 'a cleared look leaves the grade at full strength');
    assert.equal(pixels.gradeAtFull.amount, 1, 'and the strength slider reached the grade at 100%');
    assert.equal(pixels.gradeWarning, false, 'the grading shader compiled with the new amount uniform');
    assert.match(pixels.status, /No look/, `the panel reports the look was cleared: ${pixels.status}`);

    // --- 8. The export plan reports the delivery the panel is showing -----------------------
    const plan = await page.evaluate(() => {
      const model = window.FilmAudio;
      const settings = window.filmLabDelivery;
      const geometry = model.deliveryGeometry({width: 1080, height: 1920, framing: window.filmLabFraming, delivery: settings});
      return {geometry, audio: model.audioFilterChain(window.filmLabAudio.settings, {duration: 3}), takes: window.filmLabAudio.takes.length};
    });
    assert.equal(plan.geometry.fps, 60);
    assert.equal(plan.geometry.shortEdge ?? plan.geometry.width, plan.geometry.width);
    assert.ok(plan.audio && plan.audio.length > 10, 'the export has an audio chain to run');
    // A look travels with the clip it belongs to, so the exporter asks per clip, per frame.
    assert.match(script, /window\.filmLabApplyGradeLook\(frameClipId\)/, 'the frame loop resolves the look for each clip');
    assert.match(script, /u_lutAmount/, 'the strength reaches the grading shader');
    assert.match(script, /color=mix\(color,texture\(u_lut,coordinate\)\.rgb,clamp\(u_lutAmount,0\.0,1\.0\)\)/, 'the LUT is mixed, not overwritten');
    assert.ok(plan.takes >= 1, 'the recorded take is still queued for the mix');

    assert.deepEqual(errors, [], `no console errors: ${errors.join(' | ')}`);
    await page.screenshot({path: '/tmp/r9-delivery.png'});
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
