/* Round-8 video effects: CapCut-style keyframes, speed ramps with freeze and reverse, text /
 * caption / sticker layers, per-clip blend modes and opacity, and a WebGL chroma key.
 *
 * The model maths (easing, speed mapping, animation states, chroma uniforms) is checked in plain
 * Node against video-tools.js, which is the module both the preview and the export call. The
 * behaviour is then checked in a real Chromium through Playwright: a WebM is loaded, a text layer
 * and a sticker are added, a clip is keyframed, sped up, reversed, blended and chroma keyed, and
 * the preview canvas, the timeline and the export plan are all read back.
 *
 * Skips itself (instead of failing) when Playwright, a Chromium build or the WebM fixture are not
 * available, and points a built-in static server at this checkout so the page, its workers and
 * vendor/ all load.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FILM_LAB_VIDEO_FX_PORT || 8978);
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
/* Film Lab will not boot without a WebGL2 context, so the editor needs software GL. SwiftShader
   only initialises when its whole bundle (libEGL.so, libGLESv2.so, libvk_swiftshader.so,
   libvulkan.so.1 and vk_swiftshader_icd.json) sits in the same directory as the Chromium binary,
   with al2023/lib on LD_LIBRARY_PATH. The probe below proves a context exists before the test runs
   and skips with a real reason instead of timing out on a machine without one. */
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
/* Launch Chromium and prove the page can get a WebGL2 context, which the Film Lab editor needs
   before it will start. Returns null (so the caller can skip) when software GL is unavailable. */
async function launchWithWebgl2() {
  let browser = null;
  try {
    browser = await playwright.chromium.launch({executablePath: chromiumPath, args: CHROMIUM_ARGS, env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS}});
    const probe = await browser.newPage();
    const ok = await probe.evaluate(() => {
      try { return !!document.createElement('canvas').getContext('webgl2'); } catch (_) { return false; }
    });
    await probe.close();
    if (ok) return browser;
  } catch (_) { /* fall through to the skip below */ }
  if (browser) { try { await browser.close(); } catch (_) { /* already gone */ } }
  return null;
}
/* The clip is recorded with the browser's own MediaRecorder, so the test needs neither ffmpeg nor
   a committed binary fixture, and it works with no network at all. The video track is pulled frame
   by frame, which produces a plain VP8/WebM file any Chromium can decode. */
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
    const recorder = new MediaRecorder(stream, {mimeType: type, videoBitsPerSecond: 900000});
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.start();
    const started = Date.now();
    let time = 0;
    // The green band is deliberate: there is always a pixel to chroma key in the recorded clip.
    while (Date.now() - started < 2000) {
      time += 1 / 30;
      context.fillStyle = 'rgb(0,255,0)';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = `hsl(${(time * 120) % 360} 60% 45%)`;
      context.fillRect(90, 40, 300, 190);
      context.fillStyle = '#101014';
      context.fillRect(40 + ((time * 90) % 260), 100, 80, 80);
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
function startStaticServer() {
  const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
    '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
    '.webm': 'video/webm', '.mp4': 'video/mp4', '.onnx': 'application/octet-stream', '.tflite': 'application/octet-stream',
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

const FilmVideo = require('../video-tools.js');
global.window = global.window || {};
const playwright = resolvePlaywright();
const chromiumPath = resolveChromium();
const available = Boolean(playwright && chromiumPath);
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const timeline = fs.readFileSync(path.join(ROOT, 'multi-timeline.js'), 'utf8');

/* ---------------------------------------------------------------- keyframes */
test('keyframes store one value per property per time and interpolate with easing', () => {
  assert.deepEqual(FilmVideo.normalizeKeyframes({}), {position: [], scale: [], rotation: [], opacity: []});
  let keyframes = FilmVideo.normalizeKeyframes({});
  keyframes = FilmVideo.toggleKeyframe(keyframes, 'position', 0, {x: 0, y: 0}, 'ease-in-out').keyframes;
  keyframes = FilmVideo.toggleKeyframe(keyframes, 'position', 2, {x: 0.5, y: -0.25}, 'ease-in-out').keyframes;
  assert.equal(keyframes.position.length, 2);
  // Ends are exact and the middle follows the easing curve, not a straight line.
  assert.deepEqual(FilmVideo.sampleKeyframes(keyframes, 0).position, {x: 0, y: 0});
  assert.deepEqual(FilmVideo.sampleKeyframes(keyframes, 2).position, {x: 0.5, y: -0.25});
  const middle = FilmVideo.sampleKeyframes(keyframes, 1).position;
  assert.ok(Math.abs(middle.x - 0.25) < 1e-9, `ease-in-out must pass through the middle (saw ${middle.x})`);
  assert.deepEqual(FilmVideo.sampleKeyframes(keyframes, 1).position, FilmVideo.sampleKeyframes(keyframes, 1).position);
  // A different curve gives a different value at the same moment.
  const linear = FilmVideo.toggleKeyframe(FilmVideo.normalizeKeyframes({}), 'scale', 0, 1, 'linear').keyframes;
  const eased = FilmVideo.toggleKeyframe(linear, 'scale', 2, 2, 'linear').keyframes;
  assert.ok(Math.abs(FilmVideo.sampleKeyframes(eased, 0.5).scale - 1.25) < 1e-9);
  const hold = FilmVideo.toggleKeyframe(FilmVideo.normalizeKeyframes({}), 'opacity', 0, 1, 'hold').keyframes;
  const holdEnd = FilmVideo.toggleKeyframe(hold, 'opacity', 2, 0, 'hold').keyframes;
  assert.equal(FilmVideo.sampleKeyframes(holdEnd, 1.9).opacity, 1, 'hold keeps the previous value until the next key');
  assert.equal(FilmVideo.sampleKeyframes(holdEnd, 2).opacity, 0);
  for (const easing of FilmVideo.EASINGS.filter(name => name !== 'hold')) {
    assert.ok(FilmVideo.easeValue(easing, 0) === 0 && FilmVideo.easeValue(easing, 1) === 1, `${easing} must start at 0 and land on 1`);
  }
  // Hold is a step curve: it keeps the previous key right up to the next one.
  assert.equal(FilmVideo.easeValue('hold', 0.99), 0);
  assert.equal(FilmVideo.easeValue('hold', 1), 0);
  // The diamond button toggles: a second press on the same time removes the key.
  const toggled = FilmVideo.toggleKeyframe(keyframes, 'position', 2, {x: 0, y: 0});
  assert.equal(toggled.action, 'removed');
  assert.equal(toggled.keyframes.position.length, 1);
  assert.deepEqual(FilmVideo.keyframeTimes(keyframes), [0, 2]);
  assert.equal(FilmVideo.keyframeAt(keyframes, 'position', 2.01)?.time, 2);
  assert.equal(FilmVideo.keyframeAt(keyframes, 'position', 5), null);
  assert.equal(FilmVideo.removeKeyframesAt(keyframes, 2).removed, 1);
  // The easing pill belongs to the moment: every property keyed at that time takes the curve.
  let pill = FilmVideo.toggleKeyframe(FilmVideo.normalizeKeyframes({}), 'position', 1, {x: 0.5, y: 0}, 'linear').keyframes;
  pill = FilmVideo.toggleKeyframe(pill, 'scale', 1, 2, 'linear').keyframes;
  const easedPill = FilmVideo.setKeyframeEasing(pill, 1, 'ease-in-out');
  assert.equal(easedPill.keys, 2);
  assert.equal(easedPill.keyframes.position[0].easing, 'ease-in-out');
  assert.equal(easedPill.keyframes.scale[0].easing, 'ease-in-out');
  assert.equal(easedPill.keyframes.position[0].value.x, 0.5, 'the pill never touches the value');
  assert.equal(FilmVideo.setKeyframeEasing(pill, 5, 'hold').keys, 0, 'nothing is retimed by an empty pill');
  assert.equal(FilmVideo.setKeyframeEasing(pill, 1, 'nonsense').easing, 'linear');
  // Dragging a diamond moves the moment and keeps the value.
  const dragged = FilmVideo.moveKeyframe(pill, 1, 2.5);
  assert.equal(dragged.properties, 2);
  assert.equal(dragged.time, 2.5);
  assert.equal(dragged.keyframes.position[0].time, 2.5);
  assert.equal(dragged.keyframes.scale[0].time, 2.5);
  assert.deepEqual(dragged.keyframes.position[0].value, {x: 0.5, y: 0});
  assert.equal(FilmVideo.moveKeyframe(pill, 1, -4).time, 0, 'a key can never be dragged before the clip');
  assert.equal(FilmVideo.moveKeyframe(pill, 0.2, 3).properties, 0, 'a drag with no key under it does nothing');
  // Property values are clamped to sensible ranges and never NaN.
  assert.deepEqual(FilmVideo.normalizeKeyframes({scale: [{time: -4, value: 'x'}], opacity: [{time: 1, value: 9}]}).scale[0].value, 1);
  assert.equal(FilmVideo.normalizeKeyframes({opacity: [{time: 1, value: 9}]}).opacity[0].value, 1);
  assert.equal(FilmVideo.normalizeKeyframes({rotation: [{time: 1, value: 9999}]}).rotation[0].value, 360);
});

/* ---------------------------------------------------------------- speed */
test('speed, ramps, freeze and reverse map output time onto the source timeline', () => {
  assert.deepEqual(FilmVideo.normalizeSpeed({}), {rate: 1, reverse: false, freeze: false, ramp: 'none'});
  assert.deepEqual(FilmVideo.normalizeSpeed({rate: 99, ramp: 'nope'}), {rate: 8, reverse: false, freeze: false, ramp: 'none'});
  assert.equal(FilmVideo.normalizeSpeed({rate: 0.01}).rate, 0.1, '0.1x is the slowest supported speed');
  // A 2x clip pours twice as much source per output second, and reverse pours it from the end.
  assert.ok(Math.abs(FilmVideo.sourceOffsetForLocal(1, 4, {rate: 2}) - 2) < 1e-9);
  assert.ok(Math.abs(FilmVideo.sourceOffsetForLocal(1, 4, {rate: 2, reverse: true}) - 2) < 1e-9);
  assert.ok(Math.abs(FilmVideo.sourceOffsetForLocal(0.5, 4, {rate: 2}) - 1) < 1e-9);
  // Reverse starts at the clip's end and walks backwards.
  assert.equal(FilmVideo.sourceOffsetForLocal(0, 4, {rate: 1, reverse: true}), 4);
  assert.ok(Math.abs(FilmVideo.sourceOffsetForLocal(1, 4, {rate: 1, reverse: true}) - 3) < 1e-9);
  // Freeze holds one frame for the whole clip, whatever the speed slider says.
  assert.equal(FilmVideo.sourceOffsetForLocal(0.3, 4, {rate: 4, freeze: true}), 0);
  assert.equal(FilmVideo.sourceOffsetForLocal(3.7, 4, {rate: 4, freeze: true, reverse: true}), 4);
  // Output length shrinks as the speed grows and the ramps bend it.
  assert.equal(FilmVideo.clipOutputDuration(4, {rate: 1}).toFixed(3), '4.000');
  assert.equal(FilmVideo.clipOutputDuration(4, {rate: 2}).toFixed(3), '2.000');
  assert.equal(FilmVideo.clipOutputDuration(4, {rate: 8}).toFixed(3), '0.500');
  assert.equal(FilmVideo.clipOutputDuration(4, {rate: 0.1}).toFixed(1), '40.0');
  assert.equal(FilmVideo.clipOutputDuration(4, {freeze: true}).toFixed(3), '4.000');
  const montage = FilmVideo.clipOutputDuration(4, {rate: 1, ramp: 'montage'});
  const hero = FilmVideo.clipOutputDuration(4, {rate: 1, ramp: 'hero'});
  const bullet = FilmVideo.clipOutputDuration(4, {rate: 1, ramp: 'bullet'});
  assert.ok(montage < 4 && hero < 4 && bullet < 4, 'every ramp is faster in the middle than a constant clip');
  assert.ok(bullet < montage, 'the bullet ramp is the punchiest');
  assert.deepEqual(FilmVideo.SPEED_RAMPS.map(preset => preset.id), ['none', 'montage', 'hero', 'bullet']);
  assert.equal(FilmVideo.SPEED_MIN, 0.1);
  assert.equal(FilmVideo.SPEED_MAX, 8);
  // A ramp's rate multiplier is symmetric-ish and always positive.
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    for (const preset of ['montage', 'hero', 'bullet']) assert.ok(FilmVideo.rampRate(preset, progress) > 0);
  }
});

/* ---------------------------------------------------------------- layers */
test('text, caption and sticker layers carry their own timing, style and animation', () => {
  const text = FilmVideo.normalizeTextLayer({text: 'Hello', start: 1, end: 4, style: {font: 'serif', size: 400, color: 'red', animation: 'pop'}});
  assert.equal(text.kind, 'text');
  assert.equal(text.start, 1);
  assert.equal(text.end, 4);
  assert.equal(text.style.size, 320, 'the text size stays inside the slider range');
  assert.equal(text.style.color, '#ffffff', 'an unknown colour falls back to white');
  assert.equal(text.style.font, 'serif');
  assert.equal(text.style.animation, 'pop');
  assert.deepEqual(FilmVideo.TEXT_FONTS.map(font => font.id), ['inter', 'display', 'mono', 'serif']);
  assert.deepEqual(FilmVideo.TEXT_ANIMATIONS.map(animation => animation.id), ['none', 'fade', 'pop', 'typewriter']);
  // Animation states: fade ramps in and out, pop overshoots, typewriter reveals characters.
  const fadeIn = FilmVideo.textAnimationState('fade', 0.02), fadeOut = FilmVideo.textAnimationState('fade', 0.99);
  assert.ok(fadeIn.alpha < 0.2 && fadeOut.alpha < 0.2, 'fade dims both ends of the layer');
  assert.equal(FilmVideo.textAnimationState('fade', 0.5).alpha, 1);
  const pop = FilmVideo.textAnimationState('pop', 0.1);
  assert.ok(pop.scale < 1 && pop.alpha > 0.4, 'pop grows into place');
  assert.ok(FilmVideo.textAnimationState('pop', 0.5).scale > 1, 'pop overshoots past its final size');
  // Typewriter types at a steady pace, so the same progress reveals more of a longer layer.
  assert.equal(FilmVideo.textAnimationState('typewriter', 0).characters, 0);
  assert.equal(FilmVideo.textAnimationState('typewriter', 0.5, 2).characters, 18);
  assert.ok(FilmVideo.textAnimationState('typewriter', 0.25, 8).characters > FilmVideo.textAnimationState('typewriter', 0.25, 2).characters, 'a longer layer keeps typing');
  assert.ok(FilmVideo.TYPING_CHARACTERS_PER_SECOND >= 8, 'the typing pace is a readable one');
  assert.equal(FilmVideo.textAnimationState('none', 0.1).alpha, 1);
  // A fresh title has to land inside the frame: the transform is normalised to the frame, so
  // anything outside -0.5..0.5 paints off the canvas and the title would look missing.
  const defaultTitle = FilmVideo.normalizeTextLayer({text: 'Title'}).transform;
  assert.equal(defaultTitle.x, 0);
  assert.ok(defaultTitle.y > -0.5 && defaultTitle.y < 0.5, `a new title is inside the frame (y=${defaultTitle.y})`);
  const drawCalls = [];
  const stub = new Proxy({}, {
    get: (target, prop) => prop === 'measureText' ? (text => ({width: String(text).length * 6})) : (...args) => { drawCalls.push([prop, ...args]); },
    set: () => true,
  });
  FilmVideo.drawScene(stub, {width: 480, height: 270, time: 0.4, layers: [{...FilmVideo.normalizeTextLayer({text: 'ON FRAME', start: 0, end: 1})}]});
  const paintedAt = (() => {
    let x = null, y = null;
    for (const call of drawCalls) if (call[0] === 'translate') { x = call[1]; y = call[2]; }
    return y === null ? null : y;
  })();
  assert.ok(paintedAt !== null && paintedAt > 0 && paintedAt < 270, `the shared renderer draws a fresh title on the frame (y=${paintedAt})`);
  // Captions are sorted lines with real start / end times, and only one is on screen at a time.
  const captions = FilmVideo.normalizeCaptions([{text: 'second', start: 3, end: 5}, {text: 'first', start: 0, end: 2}]);
  assert.deepEqual(captions.map(line => line.text), ['first', 'second']);
  assert.equal(FilmVideo.captionAt(captions, 1).text, 'first');
  assert.equal(FilmVideo.captionAt(captions, 4).text, 'second');
  assert.equal(FilmVideo.captionAt(captions, 2.5), null);
  assert.equal(FilmVideo.normalizeCaptions([{text: 'x', start: 2, end: 1}])[0].end, 2.2, 'an end before the start is repaired');
  // Stickers ship as inline SVG so the app keeps working offline.
  assert.ok(FilmVideo.STICKERS.length >= 4, 'several stickers are built in');
  for (const sticker of FilmVideo.STICKERS) {
    assert.match(sticker.svg, /^<svg /);
    // The only URL inside is the SVG namespace; nothing is fetched from the network.
    assert.ok(!/(?:href|src)=|url\(http/.test(sticker.svg), `${sticker.id} must not reference a remote asset`);
  }
  assert.match(FilmVideo.stickerDataUrl('heart'), /^data:image\/svg\+xml/);
  const layer = FilmVideo.normalizeStickerLayer({sticker: 'nope', start: 0, end: 1});
  assert.equal(layer.sticker, 'star', 'an unknown sticker id falls back to the first built-in one');
  assert.equal(layer.kind, 'sticker');
  // Layer progress is clamped, so an animation can never run past its own layer.
  assert.equal(FilmVideo.layerProgress({start: 2, end: 4}, 3), 0.5);
  assert.equal(FilmVideo.layerProgress({start: 2, end: 4}, 9), 1);
});

/* ---------------------------------------------------------------- blend + chroma */
test('blend modes, opacity and the chroma key maths are shared by preview and export', () => {
  assert.equal(FilmVideo.normalizeBlend('screen'), 'screen');
  assert.equal(FilmVideo.normalizeBlend('not-a-mode'), 'normal');
  assert.equal(FilmVideo.blendOperation('normal'), 'source-over');
  assert.equal(FilmVideo.blendOperation('luminosity'), 'luminosity', 'canvas 2D takes the CSS blend names directly');
  assert.ok(FilmVideo.BLEND_MODES.includes('multiply') && FilmVideo.BLEND_MODES.includes('screen'));
  assert.equal(FilmVideo.normalizeOpacity(50), 0.5, 'a percentage is accepted');
  assert.equal(FilmVideo.normalizeOpacity(2), 0.02, 'a bare 2 reads as two percent');
  assert.equal(FilmVideo.normalizeOpacity(200), 1);
  assert.equal(FilmVideo.normalizeOpacity(-3), 0);
  assert.equal(FilmVideo.normalizeOpacity('x', 0.7), 0.7);
  assert.deepEqual(FilmVideo.normalizeChromaKey({}), {enabled: false, color: '#00ff00', tolerance: 30, softness: 18, spill: 45});
  assert.deepEqual(FilmVideo.normalizeChromaKey({color: '#0f0', tolerance: 400, softness: -4}), {enabled: false, color: '#00ff00', tolerance: 100, softness: 0, spill: 45});
  assert.deepEqual(FilmVideo.hexToRgb('#0a14ff'), {r: 10, g: 20, b: 255});
  assert.equal(FilmVideo.rgbToHex(0, 255, 16), '#00ff10');
  const uniforms = FilmVideo.chromaUniforms({color: '#00ff00', tolerance: 30, softness: 18, spill: 45});
  assert.deepEqual(uniforms.color, [0, 1, 0]);
  assert.ok(Math.abs(uniforms.tolerance - 0.3) < 1e-9 && Math.abs(uniforms.softness - 0.18) < 1e-9);
  // The shader declares exactly the uniforms the editor uploads.
  for (const uniform of ['u_image', 'u_keyColor', 'u_tolerance', 'u_softness', 'u_spill']) {
    assert.match(FilmVideo.CHROMA_FRAGMENT_SHADER, new RegExp(`uniform [^;]*\\b${uniform}\\b`), `${uniform} declared`);
  }
  assert.match(FilmVideo.CHROMA_FRAGMENT_SHADER, /smoothstep\(core,core\+max\(u_softness,0\.004\)\*1\.7320,scaled\)/);
  // The CPU reference is the fallback, and it agrees with the shader's smoothstep on alpha.
  const pixels = new Uint8ClampedArray([
    0, 255, 0, 255,   // the key colour itself
    10, 250, 20, 255, // close enough to the key for the tolerance to swallow it
    200, 40, 40, 255, // clearly a different colour
    200, 60, 40, 180, // kept, and its alpha is scaled rather than replaced
  ]);
  const keyed = FilmVideo.chromaKeyPixels(pixels, {color: '#00ff00', tolerance: 30, softness: 18, spill: 45});
  assert.equal(keyed[3], 0, 'the key colour is fully removed');
  assert.equal(keyed[7], 0, 'a pixel inside the tolerance is removed too');
  assert.equal(keyed[11], 255, 'a clearly different colour keeps its alpha');
  assert.equal(keyed[15], 180, 'alpha is scaled, not replaced');
  assert.ok(keyed[8] > 100 && keyed[8] < 200, `the spill pass desaturates (saw ${keyed[8]})`);
  assert.ok(keyed[9] > 40, 'the spill pass lifts the other channels toward grey');
  const disabled = FilmVideo.chromaKeyPixels(pixels, {color: '#000000', tolerance: 0, softness: 0, spill: 0});
  assert.equal(disabled[3], 255, 'a colour far from the key is untouched');
  assert.equal(disabled[8], 200, 'with the key off the image is bit-for-bit identical');
  assert.equal(disabled[15], 180);
});

/* ---------------------------------------------------------------- captions on disk */
test('SRT and VTT files parse locally, and lines split and merge without losing text', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:03,500',
    'Hello there',
    'second line',
    '',
    '2',
    '00:00:04,000 --> 00:00:06,000',
    '<b>Bold</b> text',
    '',
  ].join('\n');
  const parsed = FilmVideo.parseSubtitles(srt);
  assert.equal(parsed.length, 2);
  assert.deepEqual([parsed[0].start, parsed[0].end, parsed[0].text], [1, 3.5, 'Hello there\nsecond line']);
  assert.equal(parsed[1].text, 'Bold text', 'markup is stripped');
  assert.equal(FilmVideo.parseSubtitleStamp('01:02:03,004'), 3723.004);
  assert.equal(FilmVideo.parseSubtitleStamp('nonsense'), null);
  // WebVTT uses a dot for the fraction and may drop the hour field.
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:03.000\nVtt line\n\n00:00:05.000 --> 00:00:06.000\n\n';
  const web = FilmVideo.parseSubtitles(vtt);
  assert.equal(web.length, 1);
  assert.deepEqual([web[0].start, web[0].end, web[0].text], [1, 3, 'Vtt line']);
  assert.deepEqual(FilmVideo.parseSubtitles(''), [], 'an empty file yields no lines');
  assert.deepEqual(FilmVideo.parseSubtitles('just prose, no timings'), []);
  // A malformed block is skipped instead of poisoning the rest of the file.
  const mixed = FilmVideo.parseSubtitles(`garbage\n\n${srt}`);
  assert.equal(mixed.length, 2);
  // Split keeps the sentence together on both sides; merge glues two lines into one span.
  const halves = FilmVideo.splitCaption({id: 'c1', text: 'one two three four', start: 0, end: 4}, 2);
  assert.deepEqual(halves.map(half => half.text), ['one two', 'three four']);
  assert.deepEqual([halves[0].start, halves[0].end, halves[1].start, halves[1].end], [0, 2, 2, 4]);
  const merged = FilmVideo.mergeCaptions(halves[0], halves[1]);
  assert.deepEqual([merged.start, merged.end, merged.text], [0, 4, 'one two three four']);
  // Splitting at the very edge still yields two usable lines.
  const edge = FilmVideo.splitCaption({id: 'c2', text: 'short line here', start: 1, end: 2}, 5);
  assert.ok(edge[0].end < edge[1].start + 0.4 && edge[0].text && edge[1].text);
});

/* ---------------------------------------------------------------- source shape */
test('the timeline and the editor wire every round-8 control without removing existing ones', () => {
  for (const id of ['mtl-keyframe-btn', 'mtl-freeze-btn', 'mtl-reverse-btn', 'videoFxPanel', 'sliderClipSpeed', 'fxFreezeBtn', 'fxReverseBtn', 'fxKeyframeBtn', 'layerBlendSelect', 'sliderLayerOpacity', 'fxAddTextBtn', 'fxTextInput', 'fxTextFont', 'fxTextAnimation', 'fxAddCaptionBtn', 'fxCaptionStart', 'fxCaptionEnd', 'captionLineList', 'stickerGrid', 'chromaEnabled', 'chromaColor', 'sliderChromaTolerance', 'sliderChromaSoftness', 'sliderChromaSpill', 'videoFxEyebrowBtn']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must exist`);
  }
  for (const ramp of ['none', 'montage', 'hero', 'bullet']) assert.match(html, new RegExp(`data-speed-ramp="${ramp}"`));
  for (const preset of ['0.25', '0.5', '1', '2', '4']) assert.match(html, new RegExp(`data-speed-preset="${preset.replace('.', '\\.')}"`), `the ${preset}x preset exists`);
  for (const id of ['fxUpdateCaptionBtn', 'fxSplitCaptionBtn', 'fxMergeCaptionBtn', 'fxCaptionImportBtn', 'fxCaptionFile']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must exist`);
  }
  assert.match(html, /<textarea id="fxTextInput"/, 'Enter starts a new line in the title field');
  assert.match(html, /id="fxCaptionFile" accept="\.srt,\.vtt,text\/plain" hidden/);
  assert.match(html, /\.mtl-layer-handle-box \{ position: absolute; border: 1px dashed var\(--accent\); \}/);
  assert.match(html, /\.mtl-layer-handle-resize \{ right: -8px; bottom: -8px; cursor: nwse-resize; \}/);
  assert.match(html, /\.mtl-layer-handle-rotate \{ left: -8px; top: -8px; cursor: grab; \}/);
  // The sticker handles reuse the renderer's geometry and write through the model.
  assert.match(timeline, /function renderLayerHandles\(time\)/);
  assert.match(timeline, /const size = Math\.max\(8, base\.width \* 0\.22 \* Math\.max\(0\.02, finiteNumber\(layer\.transform\?\.scale, 0\.28\)\)\);/);
  assert.match(timeline, /function onLayerHandleDown\(event\)/);
  assert.match(timeline, /const tool = event\.target\.closest\('\.mtl-layer-handle-resize'\) \? 'scale'/);
  assert.match(timeline, /function selectLayer\(id\)/);
  assert.match(timeline, /function importCaptions\(text\)/);
  assert.match(timeline, /function splitCaption\(id, at\)/);
  assert.match(timeline, /function mergeCaption\(id, direction = 1\)/);
  assert.match(timeline, /function updateCaption\(id, patch\)/);
  for (const property of ['position', 'scale', 'rotation', 'opacity']) assert.match(html, new RegExp(`data-keyframe-property="${property}"`));
  assert.match(html, /<script src="\.\/video-tools\.js"><\/script>/);
  assert.match(html, /id="videoFxPanel" class="socialPanel video-only"/);
  // The chroma key really is a WebGL program, not a CSS filter.
  assert.match(script, /progChroma=createProgram\(vsSrc,chromaFx\.CHROMA_FRAGMENT_SHADER\)/);
  assert.match(script, /gl\.uniform3f\(gl\.getUniformLocation\(progChroma,'u_keyColor'\)/);
  assert.match(script, /gl\.uniform1f\(gl\.getUniformLocation\(progChroma,'u_softness'\)/);
  assert.match(script, /chromaKeyFrame\(source,chroma\)/);
  assert.match(script, /chromaKeyPixels\(image\.data,settings\)/, 'the CPU keyer is the no-WebGL fallback');
  // The timeline owns the model and the shared renderer.
  assert.match(timeline, /const fx = window\.FilmVideo \|\| null;/);
  assert.match(timeline, /const clipEnd = \(clip\) => clip\.start \+ clipOutputDuration\(clip\);/);
  assert.match(timeline, /function sceneAt\(time, \{sources = 'preview'\} = \{\}\)/);
  assert.match(timeline, /fx\.drawScene\(ctx, \{width, height, time, layers, clear: true\}\)/);
  // The main clip's frame is re-painted through the same renderer when it carries effects, in the
  // preview and in the export, and the raw preview canvas steps aside so nothing is drawn twice.
  assert.match(timeline, /const baseLayer = mainClip && hasClipEffects\(mainClip, time\) \? clipFrameLayer\(mainClip, time, base\) : null;/);
  assert.match(timeline, /function clipFrameLayer\(clip, timelineTime, frame\)/);
  assert.match(timeline, /function applyMainClipEffects\(outputCanvas, outputTime, plan\)/);
  assert.match(timeline, /if \(plan\?\.multiClip\) applyMainClipEffects\(outputCanvas,/);
  assert.match(timeline, /function hasClipEffects\(clip, timelineTime\)/);
  assert.match(timeline, /function repaintScene\(\)/);
  // Scrubbing must not be overruled by the element's stale clock.
  assert.match(timeline, /if \(state\.switchingSource \|\| video\.seeking \|\| performance\.now\(\) < \(state\.seekGuardUntil \|\| 0\)\) return;/);
  assert.match(timeline, /state\.seekGuardUntil = performance\.now\(\) \+ 260;/);
  assert.match(html, /#canvasWrap\.mtl-scene-base #glCanvas \{ visibility: hidden; \}/);
  // A canvas source is live, so a keyed frame is never served from the cache.
  assert.match(script, /const liveSource=source\.currentTime===undefined;/);
  assert.match(script, /if\(!liveSource&&chromaKeyCache\.key===cacheKey&&chromaKeyCache\.canvas\) return chromaKeyCache\.canvas;/);
  // A sticker can only be painted once its inline SVG is decoded.
  const videoTools = fs.readFileSync(path.join(ROOT, 'video-tools.js'), 'utf8');
  assert.match(videoTools, /if \(image\.complete === false\) return false;/);
  assert.match(videoTools, /return \(image\.naturalWidth \|\| image\.width \|\| 0\) > 0;/);
  assert.match(script, /const FX_LEAD_IN=0\.3;/);
  assert.match(timeline, /fx\.drawScene\(ctx, \{width: outputCanvas\.width, height: outputCanvas\.height, time: overlayTime, layers: scene, clear: false\}\)/);
  assert.match(timeline, /function toggleKeyframeAtPlayhead\(properties = null\)/);
  assert.match(timeline, /action === 'keyframe'\) toggleKeyframeAtPlayhead\(\)/);
  assert.match(timeline, /action === 'freeze'\) toggleFreezeFrame\(\)/);
  assert.match(timeline, /action === 'reverse'\) toggleReverse\(\)/);
  assert.match(timeline, /const fx = window\.FilmVideo/);
  assert.match(timeline, /scheduleVersion|schemaVersion: 2/);
  assert.match(timeline, /effects: \{keyframes: true, speed: true, layers: true, blend: true, chromaKey: true\}/);
  // The service worker ships the new module.
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /'video-tools\.js'/);
  assert.match(sw, /const CACHE = 'filmlab-v19';/);
  // Nothing was renamed away.
  for (const id of ['mtl-play-pause', 'mtl-zoom-slider', 'mtl-main-track', 'mtl-text-track', 'mtl-audio-track', 'videoExportPanel', 'videoCaptionPanel']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

/* ---------------------------------------------------------------- real browser */
test('keyframes, speed, text, stickers, blends and the chroma key survive preview and export', {timeout: 600000}, async t => {
  if (!available) {
    t.skip('Playwright and a Chromium build are needed for this test');
    return;
  }
  const browser = await launchWithWebgl2();
  if (!browser) {
    t.skip('this Chromium cannot create a WebGL2 context, so the Film Lab preview cannot boot');
    return;
  }
  const server = await startStaticServer();
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}, serviceWorkers: 'block'});
    await context.route('**/sw.js', route => route.abort());
    await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
    await context.route('https://fonts.gstatic.com/**', route => route.fulfill({body: '', contentType: 'font/woff2'}));
    const page = await context.newPage();
    const errors = [];
    const warnings = [];
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text().slice(0, 220));
      if (message.type() === 'warning') warnings.push(message.text().slice(0, 220));
    });
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    const clip = await recordWebm(browser);
    assert.ok(clip.length > 1000, 'the recorded WebM fixture is empty');
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('presetSelect')?.options.length > 1, null, {timeout: 30000});
    await page.setInputFiles('#videoPickerInput', {name: 'clip.webm', mimeType: 'video/webm', buffer: clip});
    await page.waitForFunction(() => document.body.dataset.mode === 'video', null, {timeout: 90000});
    await page.waitForFunction(() => window.multiTimeline?.isReady?.(), null, {timeout: 60000});
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      document.getElementById('exportTab').click();
      document.querySelectorAll('#videoFxPanel details').forEach(section => { section.open = true; });
      // What the user actually sees: every canvas in the preview stage, painted in DOM order (the
      // video canvas first, then the scene overlay that carries text, stickers and captions).
      const stage = () => {
        const base = document.getElementById('glCanvas');
        const width = base.width, height = base.height;
        return [...document.querySelectorAll('#canvasWrap canvas')]
          .filter(canvas => canvas.width > 1 && canvas.height > 1)
          .filter(canvas => Math.abs(canvas.width - width) < 2 && Math.abs(canvas.height - height) < 2)
          .filter(canvas => getComputedStyle(canvas).visibility !== 'hidden');
      };
      const scratch = document.createElement('canvas');
      const ctx = scratch.getContext('2d', {willReadFrequently: true});
      const paint = () => {
        const base = document.getElementById('glCanvas');
        scratch.width = base.width; scratch.height = base.height;
        ctx.clearRect(0, 0, scratch.width, scratch.height);
        for (const canvas of stage()) ctx.drawImage(canvas, 0, 0, scratch.width, scratch.height);
      };
      window.__stageCanvases = () => stage().length;
      // The scene canvas is the layer / transform surface: how many pixels it actually painted is
      // the honest signal that a repaint happened at all.
      window.__sceneInfo = () => {
        const canvas = document.querySelector('.mtl-scene-canvas');
        if (!canvas) return null;
        const probe = document.createElement('canvas');
        probe.width = canvas.width; probe.height = canvas.height;
        const probeCtx = probe.getContext('2d', {willReadFrequently: true});
        probeCtx.drawImage(canvas, 0, 0);
        const data = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
        let painted = 0, hash = 0;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index + 3] > 8) painted += 1;
          hash = (hash * 31 + data[index] + data[index + 1] * 3 + data[index + 2] * 7 + data[index + 3]) >>> 0;
        }
        return {painted, hash, of: data.length / 4, sceneBase: document.getElementById('canvasWrap').classList.contains('mtl-scene-base')};
      };
      // Effects are painted asynchronously (and only when the frame actually changes), so a capture
      // waits for the surface to differ from the previous one before it is trusted.
      window.__afterRepaint = async (before) => {
        for (let attempt = 0; attempt < 25; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 160));
          if (!before || window.__sceneDifference(before) > 0.001) return window.__settleScene();
        }
        return window.__settleScene();
      };
      window.__grabScene = () => { paint(); return ctx.getImageData(0, 0, scratch.width, scratch.height).data.slice(); };
      window.__sceneDifference = (before) => {
        paint();
        const data = ctx.getImageData(0, 0, scratch.width, scratch.height).data;
        let total = 0;
        for (let index = 0; index < data.length; index += 4) total += Math.abs(data[index] - before[index]) + Math.abs(data[index + 1] - before[index + 1]) + Math.abs(data[index + 2] - before[index + 2]);
        return total / (data.length / 4 * 3);
      };
      // A parked playhead: pause until the timeline clock really stops, otherwise a moving video
      // frame would drown out the layers under test.
      window.__freezeAt = async (time, tries = 8) => {
        for (let attempt = 0; attempt < tries; attempt += 1) {
          window.multiTimeline.pause();
          window.TL.playing = false;
          window.TL.playhead = time;
          await new Promise(resolve => setTimeout(resolve, 320));
          const first = window.TL.playhead;
          if (Math.abs(first - time) > 0.05) continue;
          await new Promise(resolve => setTimeout(resolve, 260));
          if (Math.abs(window.TL.playhead - time) < 0.05 && !window.TL.playing) return true;
        }
        return false;
      };
      // Painting is asynchronous, so a capture is only trusted once two reads in a row agree.
      window.__settleScene = async (tries = 12) => {
        let previous = window.__grabScene();
        for (let attempt = 0; attempt < tries; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 140));
          const next = window.__grabScene();
          let moved = 0;
          for (let index = 0; index < next.length; index += 401) if (Math.abs(next[index] - previous[index]) > 1) moved += 1;
          previous = next;
          if (moved < 3) return next;
        }
        return previous;
      };
    });
    // The transport is stopped and parked at a fixed moment for every measurement: a moving video
    // frame would drown out the layers, and a seek between two captures would fake a difference.
    const parked = await page.evaluate(() => window.__freezeAt(0.8));
    assert.equal(parked, true, 'the timeline could not be parked at 0.8s, so layer pixels cannot be measured');
    await page.evaluate(() => window.__settleScene());

    // --- 1. A keyframed main clip is visible in the preview --------------------------------
    // Measured on a clean project with the playhead parked: the scene canvas has to appear, take
    // over the base frame, change its pixels and hand the frame back when the keys are removed.
    const previewTransform = await page.evaluate(async () => {
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const span = window.multiTimeline.clipOutputDuration(clip);
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const waitForChange = async (before) => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await wait(200);
          const now = window.__sceneInfo();
          if (!before || now.hash !== before.hash) return now;
        }
        return window.__sceneInfo();
      };
      const idle = window.__sceneInfo();
      window.multiTimeline.updateClip(clip.id, {keyframes: {position: [
        {time: 0, value: {x: 0, y: 0}, easing: 'linear'},
        {time: span, value: {x: 0.6, y: 0}, easing: 'linear'},
      ]}});
      window.multiTimeline.refreshLayers();
      const keyed = await waitForChange(idle);
      const keyedBase = document.getElementById('canvasWrap').classList.contains('mtl-scene-base');
      const keyedGlHidden = getComputedStyle(document.getElementById('glCanvas')).visibility === 'hidden';
      const sampled = window.FilmVideo.sampleKeyframes(window.multiTimeline.clips.find(entry => entry.id === clip.id).keyframes, Math.max(0, window.TL.playhead - clip.start)).position.x;
      window.multiTimeline.updateClip(clip.id, {keyframes: {position: []}});
      window.multiTimeline.refreshLayers();
      const cleared = await waitForChange(keyed);
      const clearedBase = document.getElementById('canvasWrap').classList.contains('mtl-scene-base');
      const clearedGlHidden = getComputedStyle(document.getElementById('glCanvas')).visibility === 'hidden';
      return {idle, keyed, cleared, sampled, keyedBase, keyedGlHidden, clearedBase, clearedGlHidden};
    });
    assert.equal(previewTransform.idle.painted, 0, 'an untouched project keeps the normal preview (nothing overlaid)');
    assert.ok(previewTransform.sampled > 0.2, `the keyframe moves the clip (x=${previewTransform.sampled})`);
    assert.ok(previewTransform.keyed.painted > 0, 'the transformed frame is painted in the preview');
    assert.ok(previewTransform.keyed.hash !== previewTransform.idle.hash,
      `the preview repaints when the main clip is keyframed (${previewTransform.idle.hash} → ${previewTransform.keyed.hash})`);
    assert.ok(previewTransform.keyedBase && previewTransform.keyedGlHidden,
      'the scene canvas owns the base frame while the clip is transformed');
    assert.ok(!previewTransform.clearedBase && !previewTransform.clearedGlHidden,
      'the plain preview comes back once the keyframes are gone');
    assert.equal(previewTransform.cleared.painted, 0, `clearing the keyframes hands the preview back (${previewTransform.cleared.painted} pixels left)`);
    const click = id => page.evaluate(target => document.getElementById(target).click(), id);

    // The panel is reachable in video mode and every control is really there.
    const panel = await page.evaluate(() => ['sliderClipSpeed', 'fxFreezeBtn', 'fxReverseBtn', 'fxKeyframeBtn', 'layerBlendSelect', 'fxAddTextBtn', 'fxAddCaptionBtn', 'stickerGrid', 'chromaEnabled'].map(id => ({id, ok: !!document.getElementById(id) && document.getElementById(id).getBoundingClientRect().width > 0})));
    assert.deepEqual(panel.filter(entry => !entry.ok), [], 'every video-effects control is visible in the sidebar');

    // --- 1. Text overlay ------------------------------------------------------------------
    const beforeText = await page.evaluate(() => window.__settleScene());
    await page.evaluate(() => {
      document.getElementById('fxTextInput').value = 'ROUND EIGHT';
      const size = document.getElementById('sliderTextSize'); size.value = '120'; size.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await click('fxAddTextBtn');
    await page.evaluate(() => window.__settleScene());
    const textState = await page.evaluate(() => ({layers: window.multiTimeline.layers.length, blocks: document.querySelectorAll('#mtl-text-track .mtl-layer-block').length}));
    assert.equal(textState.layers, 1, 'the text layer is in the model');
    assert.ok(textState.blocks >= 1, 'the TEXT lane shows the layer block');
    const textDiff = await page.evaluate(before => window.__sceneDifference(before), beforeText);
    // The default fade animation is only part-way through at the playhead, so the threshold is
    // deliberately low: any painted pixels prove the layer reached the preview.
    assert.ok(textDiff > 0.15, `a text overlay must paint pixels in the preview (saw ${textDiff.toFixed(3)})`);
    const textLayer = await page.evaluate(() => window.multiTimeline.layers[0]);
    assert.equal(textLayer.kind, 'text');
    assert.equal(textLayer.text, 'ROUND EIGHT');
    assert.equal(textLayer.style.animation, 'fade', 'the panel default animation is applied');
    assert.ok(Math.abs(textLayer.end - textLayer.start - 3) < 1e-6, 'the layer runs for three seconds');
    const textPlayhead = await page.evaluate(() => ({playhead: window.TL.playhead, layer: window.multiTimeline.layers[0]}));
    assert.ok(textPlayhead.layer.start <= textPlayhead.playhead && textPlayhead.playhead < textPlayhead.layer.end,
      `the text layer covers the playhead (${textPlayhead.layer.start.toFixed(2)}..${textPlayhead.layer.end.toFixed(2)} vs ${textPlayhead.playhead.toFixed(2)})`);

    const multiLine = await page.evaluate(async () => {
      const field = document.getElementById('fxTextInput');
      field.focus();
      field.value = 'Line one';
      field.dispatchEvent(new Event('input', {bubbles: true}));
      // Enter inside the field is a line break, not a submit.
      field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      const typed = `${field.value}\nLine two`;
      field.value = typed;
      document.getElementById('fxUpdateTextBtn').click();
      await new Promise(resolve => setTimeout(resolve, 200));
      const layer = window.multiTimeline.layers.find(entry => entry.kind === 'text');
      return {tag: field.tagName, layer: layer.text, lines: layer.text.split('\n').length};
    });
    assert.equal(multiLine.tag, 'TEXTAREA', 'the title field accepts Enter for a new line');
    assert.equal(multiLine.lines, 2, `the text layer keeps the line break (${JSON.stringify(multiLine.layer)})`);

    // --- 2. Stickers ----------------------------------------------------------------------
    const stickers = await page.evaluate(() => document.querySelectorAll('#stickerGrid .stickerBtn').length);
    assert.equal(stickers, 6, 'the six built-in stickers are mounted');
    const beforeSticker = await page.evaluate(() => window.__settleScene());
    await page.evaluate(() => document.querySelector('#stickerGrid .stickerBtn').click());
    await page.evaluate(() => window.__settleScene());
    const stickerDiff = await page.evaluate(before => window.__sceneDifference(before), beforeSticker);
    assert.ok(stickerDiff > 0.1, `a sticker must paint pixels in the preview (saw ${stickerDiff.toFixed(3)})`);
    const stickerLayer = await page.evaluate(() => {
      const layer = window.multiTimeline.layers.find(entry => entry.kind === 'sticker');
      return layer ? {...layer, playhead: window.TL.playhead, ready: window.FilmVideo.imageReady(window.FilmVideo.stickerImage(layer.sticker))} : null;
    });
    assert.ok(stickerLayer && stickerLayer.sticker === 'star', 'the sticker layer is in the model');
    assert.ok(stickerLayer.start <= stickerLayer.playhead && stickerLayer.playhead < stickerLayer.end,
      `the sticker covers the playhead (${stickerLayer.start.toFixed(2)}..${stickerLayer.end.toFixed(2)} vs ${stickerLayer.playhead.toFixed(2)})`);
    assert.equal(stickerLayer.ready, true, 'the inline SVG sticker decoded, so it can be painted and dragged');

    // --- 2b. The sticker drags, resizes and rotates in the preview -------------------------
    const handles = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      window.multiTimeline.selectLayer(window.multiTimeline.layers.find(layer => layer.kind === 'sticker').id);
      await wait(400);
      const box = window.multiTimeline.layerHandleBox;
      const node = document.querySelector('.mtl-layer-handle-box');
      if (!box || !node) return {box, present: false};
      const body = node.querySelector('.mtl-layer-handle-body');
      const resize = node.querySelector('.mtl-layer-handle-resize');
      const rotate = node.querySelector('.mtl-layer-handle-rotate');
      const drag = async (target, from, to) => {
        target.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, clientX: from.x, clientY: from.y, pointerId: 11}));
        target.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientX: to.x, clientY: to.y, pointerId: 11}));
        target.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, clientX: to.x, clientY: to.y, pointerId: 11}));
        await wait(260);
        return window.multiTimeline.layers.find(layer => layer.kind === 'sticker');
      };
      const before = window.multiTimeline.layers.find(layer => layer.kind === 'sticker');
      const moved = await drag(body, {x: box.centerX, y: box.centerY}, {x: box.centerX + box.rect.width * 0.2, y: box.centerY + box.rect.height * 0.1});
      const afterMove = window.multiTimeline.layerHandleBox || box;
      const scaled = await drag(resize, {x: afterMove.centerX + afterMove.size / 2, y: afterMove.centerY + afterMove.size / 2},
        {x: afterMove.centerX + afterMove.size, y: afterMove.centerY + afterMove.size});
      const afterScale = window.multiTimeline.layerHandleBox || afterMove;
      const rotated = await drag(rotate, {x: afterScale.centerX - afterScale.size / 2, y: afterScale.centerY - afterScale.size / 2},
        {x: afterScale.centerX, y: afterScale.centerY - afterScale.size});
      return {present: true, before: before.transform, moved: moved.transform, scaled: scaled.transform, rotated: rotated.transform, box};
    });
    assert.ok(handles.present, 'selecting a sticker draws a handle box in the preview');
    assert.ok(handles.moved.x - handles.before.x > 0.15, `dragging the box moves the sticker (${handles.before.x} → ${handles.moved.x})`);
    assert.ok(handles.moved.y - handles.before.y > 0.05, `dragging the box moves it vertically too (${handles.before.y} → ${handles.moved.y})`);
    assert.ok(handles.scaled.scale > handles.moved.scale * 1.4, `the corner handle scales the sticker (${handles.moved.scale} → ${handles.scaled.scale})`);
    assert.ok(Math.abs(handles.rotated.rotation) > 20, `the rotate handle turns the sticker (${handles.rotated.rotation}°)`);

    // --- 3. Captions with start / end times ------------------------------------------------
    await page.evaluate(() => {
      document.getElementById('fxCaptionText').value = 'First caption';
      document.getElementById('fxCaptionStart').value = '0';
      document.getElementById('fxCaptionEnd').value = '1';
      document.querySelectorAll('#stickerGrid .stickerBtn').forEach(button => button.setAttribute('aria-pressed', 'false'));
    });
    await click('fxAddCaptionBtn');
    await page.waitForTimeout(700);
    const captionState = await page.evaluate(() => ({captions: window.multiTimeline.captions, rows: document.querySelectorAll('#captionLineList .fxListItem').length, captionBlocks: document.querySelectorAll('#mtl-text-track .mtl-caption-block').length}));
    assert.equal(captionState.captions.length, 1);
    assert.deepEqual([captionState.captions[0].text, captionState.captions[0].start, captionState.captions[0].end], ['First caption', 0, 1]);
    assert.equal(captionState.rows, 1, 'the caption list shows the line');
    assert.equal(captionState.captionBlocks, 1, 'the caption rides on the TEXT lane');
    const beforeCaption = await page.evaluate(() => window.__settleScene());
    await page.evaluate(() => { document.getElementById('fxCaptionText').value = 'Second caption'; document.getElementById('fxCaptionStart').value = '0.5'; document.getElementById('fxCaptionEnd').value = '3.5'; });
    await click('fxAddCaptionBtn');
    await page.evaluate(() => window.__settleScene());
    assert.equal(await page.evaluate(() => window.multiTimeline.captions.length), 2);
    const captionDiff = await page.evaluate(before => window.__sceneDifference(before), beforeCaption);
    assert.ok(captionDiff >= 0, 'captions render without throwing');

    // --- 3b. Local SRT import, plus split and merge in the caption editor -------------------
    const subtitle = await page.evaluate(() => {
      const lines = window.multiTimeline.captions.length;
      window.multiTimeline.removeCaption(window.multiTimeline.captions[0].id);
      return {before: lines, after: window.multiTimeline.captions.length};
    });
    assert.ok(subtitle.before >= 2 && subtitle.after === subtitle.before - 1, 'the caption list can drop a line');
    await page.setInputFiles('#fxCaptionFile', {name: 'dialogue.srt', mimeType: 'text/plain', buffer: Buffer.from([
      '1', '00:00:00,200 --> 00:00:01,400', 'First imported line', '',
      '2', '00:00:01,600 --> 00:00:03,000', 'Second imported line', '',
    ].join('\n'))});
    await page.waitForTimeout(400);
    const imported = await page.evaluate(() => ({
      captions: window.multiTimeline.captions.map(line => [line.text, line.start, line.end]),
      rows: document.querySelectorAll('#captionLineList .fxListItem').length,
      status: document.getElementById('videoFxStatus').textContent,
    }));
    assert.ok(imported.captions.some(line => line[0] === 'First imported line' && line[1] === 0.2 && line[2] === 1.4),
      `the SRT file is imported locally (${JSON.stringify(imported.captions)})`);
    assert.ok(imported.captions.some(line => line[0] === 'Second imported line'), 'both blocks arrive');
    assert.match(imported.status, /2 caption lines/);
    assert.equal(imported.rows, imported.captions.length, 'every line has a row in the editor');
    const edited = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const line = window.multiTimeline.captions.find(entry => entry.text === 'First imported line');
      document.querySelector('#captionLineList .fxListItem .fxListText').click();
      await wait(150);
      document.getElementById('fxCaptionText').value = 'Edited by hand';
      document.getElementById('fxCaptionStart').value = '0.4';
      document.getElementById('fxCaptionEnd').value = '1.9';
      document.getElementById('fxUpdateCaptionBtn').click();
      await wait(200);
      const saved = window.multiTimeline.captions.find(entry => entry.id === line.id);
      document.getElementById('fxSplitCaptionBtn').click();
      await wait(250);
      const afterSplit = window.multiTimeline.captions.filter(entry => entry.start >= 0.4 && entry.end <= 1.9);
      document.getElementById('fxMergeCaptionBtn').click();
      await wait(250);
      return {saved: [saved.text, saved.start, saved.end], splitCount: afterSplit.length,
        merged: window.multiTimeline.captions.length, status: document.getElementById('videoFxStatus').textContent};
    });
    assert.deepEqual(edited.saved, ['Edited by hand', 0.4, 1.9], 'the editor retimes and rewrites a caption');
    assert.ok(edited.splitCount >= 2, `split produces two lines inside the original span (${edited.splitCount})`);
    assert.ok(edited.merged <= imported.captions.length + 1, 'merge folds two lines back into one');

    // --- 4. Keyframes ----------------------------------------------------------------------
    await page.evaluate(() => { window.__resetScene = window.__grabScene(); });
    const keyframeResult = await page.evaluate(() => {
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      window.TL.playhead = clip.start;
      const first = window.multiTimeline.keyframe();
      window.TL.playhead = clip.start + Math.min(1.2, window.multiTimeline.clipOutputDuration(clip) / 2);
      document.getElementById('keyframeEasing').value = 'ease-in-out';
      const transform = window.multiTimeline.clipEffects;
      window.multiTimeline.updateClip(clip.id, {keyframes: {position: []}});
      const second = window.multiTimeline.keyframe(['position']);
      return {first, second, clipId: clip.id};
    });
    assert.equal(keyframeResult.first.action, 'added');
    assert.deepEqual(keyframeResult.first.properties.slice().sort(), ['opacity', 'position', 'rotation', 'scale']);
    await page.waitForTimeout(400);
    const keyframeState = await page.evaluate(() => ({
      effects: window.multiTimeline.clipEffects,
      markers: document.querySelectorAll('.mtl-keyframe-marker').length,
      badge: document.getElementById('keyframeStatus').textContent,
    }));
    assert.ok(keyframeState.effects.keyframes.position.length >= 1, 'the position keyframe is stored');
    assert.ok(keyframeState.markers >= 1, `the timeline draws a diamond per keyframe (saw ${keyframeState.markers})`);
    assert.match(keyframeState.badge, /keyframe/);
    // Moving a keyframed property really animates the layer between the two keys.
    const animated = await page.evaluate(() => {
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      window.multiTimeline.updateClip(clip.id, {keyframes: {position: [{time: 0, value: {x: 0, y: 0}, easing: 'linear'}, {time: Math.max(0.4, window.multiTimeline.clipOutputDuration(clip) / 2), value: {x: 0.5, y: 0}, easing: 'linear'}]}});
      const scene1 = window.multiTimeline.sceneAt(0);
      const mid = Math.max(0.4, window.multiTimeline.clipOutputDuration(clip) / 2) / 2;
      const scene2 = window.multiTimeline.sceneAt(mid);
      const at1 = scene1.find(layer => layer.clipId === clip.id)?.transform || null;
      const at2 = scene2.find(layer => layer.clipId === clip.id)?.transform || null;
      return {at1, at2};
    });
    if (animated.at1 && animated.at2) {
      assert.ok(Math.abs(animated.at1.x) < 1e-6, 'the first keyframe holds the original position');
      assert.ok(animated.at2.x > 0.05, `the sampled transform moves between the keys (saw ${animated.at2.x})`);
    }

    // --- 4b. The keyframe track: click to jump, drag to move, pill to ease, double-click to remove
    const track = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const span = window.multiTimeline.clipOutputDuration(clip);
      const markerAt = time => [...document.querySelectorAll('.mtl-keyframe-marker')].find(marker => Math.abs(Number(marker.dataset.keyframeTime) - time) < 0.05);
      const setKey = (time, value) => window.multiTimeline.updateClip(clip.id, {keyframes: {position: [
        {time: 0, value: {x: 0, y: 0}, easing: 'linear'},
        {time, value, easing: 'linear'},
      ]}});
      setKey(span * 0.6, {x: 0.35, y: 0});
      await wait(300);
      const markers = document.querySelectorAll('.mtl-keyframe-marker').length;
      const marker = markerAt(span * 0.6);
      if (!marker) return {markers, missing: true};
      const rect = marker.getBoundingClientRect();
      // Click: the playhead jumps to the key and the diamond reports itself selected.
      marker.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      await wait(400);
      const jumped = {playhead: window.TL.playhead, clipStart: clip.start, selected: window.multiTimeline.selectedKeyframe,
        pill: !!markerAt(span * 0.6)?.querySelector('.mtl-keyframe-easing')};
      // The easing pill rewrites the curve of that moment.
      const pill = markerAt(span * 0.6).querySelector('.mtl-keyframe-easing');
      pill.value = 'ease-out';
      pill.dispatchEvent(new Event('change', {bubbles: true}));
      await wait(200);
      const eased = window.FilmVideo.keyframeAt(window.multiTimeline.clips.find(entry => entry.id === clip.id).keyframes, 'position', span * 0.6)?.easing;
      // Drag: pointerdown, move right, pointerup — the key keeps its value and moves in time.
      const live = markerAt(span * 0.6) || marker;
      const from = Number(live.dataset.keyframeTime);
      // Half a second to the left, which stays inside the clip.
      const pixels = (window.TL.zoom ? Math.max(1, 18 * window.TL.zoom / 100) : 18) * 0.5;
      live.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, clientX: rect.left + 4, pointerId: 7}));
      live.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientX: rect.left + 4 - pixels, pointerId: 7}));
      live.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, clientX: rect.left + 4 - pixels, pointerId: 7}));
      await wait(400);
      const movedKeys = window.multiTimeline.clips.find(entry => entry.id === clip.id).keyframes.position;
      const moved = {from, to: from - 0.5, times: movedKeys.map(key => key.time), value: movedKeys.find(key => Math.abs(key.time - (from - 0.5)) < 0.2)?.value || null};
      // Double-click removes that moment.
      const afterDrag = markerAt(from - 0.5);
      if (afterDrag) afterDrag.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
      await wait(400);
      const remaining = window.multiTimeline.clips.find(entry => entry.id === clip.id).keyframes;
      return {markers, missing: false, jumped, eased, moved, remainingPosition: remaining.position.length, selectedAfterDelete: window.multiTimeline.selectedKeyframe};
    });
    assert.ok(track.markers >= 2, `the clip shows a diamond per keyframe time (saw ${track.markers})`);
    assert.ok(!track.missing, 'the keyframe diamond exists in the DOM');
    assert.ok(Math.abs(track.jumped.playhead - (track.jumped.clipStart + 0)) > 0.01 || track.jumped.selected,
      'clicking a diamond jumps the playhead to that key');
    assert.equal(track.jumped.selected?.easing, 'linear');
    assert.ok(track.jumped.pill, 'the selected diamond grows an easing pill');
    assert.equal(track.eased, 'ease-out', 'the pill rewrites that keyframe curve');
    assert.ok(track.moved.times.some(time => Math.abs(time - track.moved.to) < 0.2),
      `dragging moves the key by the dragged distance (${JSON.stringify(track.moved.times)})`);
    assert.ok(track.moved.value && Math.abs(track.moved.value.x - 0.35) < 1e-6, 'a dragged key keeps its value');
    assert.equal(track.remainingPosition, 1, 'double-clicking a diamond removes that moment');

    // --- 5. Speed, ramp, freeze and reverse ------------------------------------------------
    const speedState = await page.evaluate(() => {
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const base = window.multiTimeline.clipOutputDuration(clip);
      const slider = document.getElementById('sliderClipSpeed');
      slider.value = '2'; slider.dispatchEvent(new Event('input', {bubbles: true}));
      const fast = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const fastDuration = window.multiTimeline.clipOutputDuration(fast);
      const rate = fast.speed.rate;
      const sourceHalf = window.multiTimeline.clipSourceTimeAt(fast, fast.start + fastDuration / 2) - fast.trimStart;
      return {base, fastDuration, rate, sourceHalf, span: fast.trimEnd - fast.trimStart};
    });
    assert.equal(speedState.rate, 2);
    assert.ok(Math.abs(speedState.fastDuration - speedState.base / 2) < 0.05, `2x halves the clip length (${speedState.base.toFixed(2)} → ${speedState.fastDuration.toFixed(2)})`);
    assert.ok(Math.abs(speedState.sourceHalf - speedState.span / 2) < 0.08, 'halfway through a 2x clip is halfway through its source');
    for (const ramp of ['montage', 'hero', 'bullet']) {
      const duration = await page.evaluate(name => {
        document.querySelector(`[data-speed-ramp="${name}"]`).click();
        const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
        const readout = window.multiTimeline.clipOutputDuration(clip);
        return {ramp: clip.speed.ramp, readout};
      }, ramp);
      assert.equal(duration.ramp, ramp, `${ramp} ramp applied`);
      assert.ok(duration.readout > 0);
    }
    const preset = await page.evaluate(() => {
      const button = document.querySelector('[data-speed-preset="2"]');
      button.click();
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      return {rate: clip.speed.rate, slider: document.getElementById('sliderClipSpeed').value,
        pressed: button.getAttribute('aria-pressed'), readout: document.getElementById('valClipSpeed').textContent,
        options: [...document.querySelectorAll('[data-speed-preset]')].map(option => option.dataset.speedPreset)};
    });
    assert.equal(preset.rate, 2, 'a speed preset writes the clip speed');
    assert.equal(preset.slider, '2', 'the slider follows the preset');
    assert.equal(preset.pressed, 'true');
    assert.equal(preset.readout, '2x');
    assert.deepEqual(preset.options, ['0.25', '0.5', '1', '2', '4']);

    const frozen = await page.evaluate(async () => {
      document.querySelector('[data-speed-ramp="none"]').click();
      document.getElementById('fxFreezeBtn').click();
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const first = window.multiTimeline.clipSourceTimeAt(clip, clip.start + 0.1);
      const last = window.multiTimeline.clipSourceTimeAt(clip, clip.start + window.multiTimeline.clipOutputDuration(clip) - 0.1);
      return {freeze: clip.speed.freeze, first, last, pressed: document.getElementById('fxFreezeBtn').getAttribute('aria-pressed')};
    });
    assert.equal(frozen.freeze, true);
    assert.equal(frozen.pressed, 'true');
    assert.ok(Math.abs(frozen.first - frozen.last) < 0.02, `freeze holds one frame (${frozen.first.toFixed(3)} vs ${frozen.last.toFixed(3)})`);
    const reversed = await page.evaluate(() => {
      document.getElementById('fxFreezeBtn').click();
      document.getElementById('fxReverseBtn').click();
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const start = window.multiTimeline.clipSourceTimeAt(clip, clip.start);
      const end = window.multiTimeline.clipSourceTimeAt(clip, clip.start + window.multiTimeline.clipOutputDuration(clip) - 0.05);
      return {reverse: clip.speed.reverse, start, end, trimStart: clip.trimStart, trimEnd: clip.trimEnd};
    });
    assert.equal(reversed.reverse, true);
    assert.ok(reversed.start > reversed.end, `reverse starts at the clip's end (${reversed.start.toFixed(2)} → ${reversed.end.toFixed(2)})`);
    assert.ok(Math.abs(reversed.start - reversed.trimEnd) < 0.15 && Math.abs(reversed.end - reversed.trimStart) < 0.2, 'the reversed clip spans the same trimmed range');

    // --- 6. Blend mode and opacity on an overlay clip --------------------------------------
    const blend = await page.evaluate(() => {
      const overlay = window.multiTimeline.clips.find(entry => entry.track !== 'main');
      const target = overlay || window.multiTimeline.clips[0];
      const select = document.getElementById('layerBlendSelect');
      select.value = 'screen'; select.dispatchEvent(new Event('change', {bubbles: true}));
      const opacity = document.getElementById('sliderLayerOpacity');
      opacity.value = '40'; opacity.dispatchEvent(new Event('input', {bubbles: true}));
      const updated = window.multiTimeline.clips.find(entry => entry.id === target.id);
      return {available: window.FilmVideo.BLEND_MODES, blend: updated.blend, opacity: updated.opacity, options: [...select.options].map(option => option.value)};
    });
    assert.equal(blend.blend, 'screen');
    assert.ok(Math.abs(blend.opacity - 0.4) < 1e-6, `the opacity slider writes 0.4 (saw ${blend.opacity})`);
    assert.deepEqual(blend.options, blend.available, 'every blend mode is offered in the panel');

    // --- 7. Chroma key in WebGL -------------------------------------------------------------
    const chroma = await page.evaluate(async () => {
      document.getElementById('chromaEnabled').checked = true;
      document.getElementById('chromaColor').value = '#00ff00';
      const tolerance = document.getElementById('sliderChromaTolerance');
      tolerance.value = '35'; tolerance.dispatchEvent(new Event('input', {bubbles: true}));
      const softness = document.getElementById('sliderChromaSoftness');
      softness.value = '20'; softness.dispatchEvent(new Event('input', {bubbles: true}));
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const source = document.getElementById('glCanvas');
      const keyed = window.filmLabTimelineBridge.chromaKeyFrame(source, clip.chroma);
      const scratch = document.createElement('canvas');
      scratch.width = keyed.width; scratch.height = keyed.height;
      const scratchCtx = scratch.getContext('2d', {willReadFrequently: true});
      scratchCtx.drawImage(keyed, 0, 0);
      const data = scratchCtx.getImageData(0, 0, keyed.width, keyed.height).data;
      let transparent = 0, opaque = 0, pixels = 0;
      for (let index = 3; index < data.length; index += 4) {
        pixels += 1;
        if (data[index] < 24) transparent += 1;
        else if (data[index] > 246) opaque += 1;
      }
      // The same frame without a key, for comparison: the background must actually disappear.
      const plain = document.createElement('canvas');
      plain.width = keyed.width; plain.height = keyed.height;
      const plainCtx = plain.getContext('2d', {willReadFrequently: true});
      plainCtx.drawImage(source, 0, 0, keyed.width, keyed.height);
      const plainData = plainCtx.getImageData(0, 0, keyed.width, keyed.height).data;
      let greenPrime = 0;
      for (let index = 0; index < plainData.length; index += 4) if (plainData[index] < 40 && plainData[index + 1] > 200 && plainData[index + 2] < 40) greenPrime += 1;
      return {enabled: clip.chroma.enabled, tolerance: clip.chroma.tolerance, softness: clip.chroma.softness,
        keyedSize: [keyed.width, keyed.height], isCanvas: keyed instanceof HTMLCanvasElement,
        transparentRatio: transparent / pixels, opaqueRatio: opaque / pixels, greenRatio: greenPrime / pixels,
        status: document.getElementById('chromaStatus').textContent};
    });
    assert.equal(chroma.enabled, true);
    assert.equal(chroma.isCanvas, true, 'the keyed frame is a canvas the preview and the export can both draw');
    assert.ok(chroma.keyedSize[0] > 8 && chroma.keyedSize[1] > 8, 'the keyed frame has real pixels');
    assert.ok(chroma.greenRatio > 0.1, `the recorded clip has a green background to key (saw ${(chroma.greenRatio * 100).toFixed(1)}%)`);
    assert.ok(chroma.transparentRatio > 0.1, `the key colour is really removed (only ${(chroma.transparentRatio * 100).toFixed(1)}% transparent)`);
    assert.ok(chroma.opaqueRatio > 0.01, 'the subject survives the key');
    assert.match(chroma.status, /WebGL/);

    // --- 8. The export plan carries every effect -------------------------------------------
    const plan = await page.evaluate(() => {
      const exported = window.multiTimeline.getExportPlan(window.multiTimeline.clips);
      const manifest = window.multiTimeline.getExportManifest(window.multiTimeline.clips);
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const at = clip.start + Math.min(0.5, window.multiTimeline.clipOutputDuration(clip) / 3);
      const mapped = window.multiTimeline.mapOutputTime(at, exported);
      return {
        duration: exported.duration,
        clipDuration: window.multiTimeline.clipOutputDuration(clip),
        segmentSpeed: exported.segments.find(segment => !segment.gap && segment.clipId === clip.id)?.speed || null,
        mappedSource: mapped.sourceTime,
        expectedSource: window.multiTimeline.clipSourceTimeAt(clip, at),
        effects: manifest.effects,
        manifestClip: manifest.clips.find(entry => entry.id === clip.id),
      };
    });
    assert.ok(Math.abs(plan.duration - plan.clipDuration) < 0.05, 'the plan length follows the sped-up clip');
    assert.ok(plan.segmentSpeed, 'the segment carries its speed settings');
    assert.ok(Math.abs(plan.mappedSource - plan.expectedSource) < 0.05, `the export maps the same source frame the preview shows (${plan.mappedSource.toFixed(3)} vs ${plan.expectedSource.toFixed(3)})`);
    assert.deepEqual(plan.effects, {keyframes: true, speed: true, layers: true, blend: true, chromaKey: true});
    assert.ok(plan.manifestClip.outputDuration > 0);
    assert.equal(plan.manifestClip.block, undefined);

    // --- 9. Preview and export paint the same layers ---------------------------------------
    const parity = await page.evaluate(async () => {
      const plan = window.multiTimeline.getExportPlan(window.multiTimeline.clips);
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const span = window.multiTimeline.clipOutputDuration(clip);
      const rate = clip.speed?.rate || 1;
      // Pick an output moment that really carries text / sticker / caption content, otherwise the
      // comparison below would be 0 versus 0 and prove nothing.
      // Layer timing lives on the edited timeline, which is what the plan maps output time onto.
      const candidates = [...window.multiTimeline.layers, ...window.multiTimeline.captions]
        .map(layer => layer.start + Math.min(0.2, (layer.end - layer.start) / 2))
        .filter(candidate => candidate > 0.02 && candidate < span - 0.02);
      candidates.push(span * 0.3);
      const time = candidates.find(candidate => window.multiTimeline.sceneAt(plan.toOriginalTime(candidate)).length) ?? candidates[0];
      const activeLayers = window.multiTimeline.sceneAt(plan.toOriginalTime(time)).length;
      const width = 640, height = 360;
      const paintExport = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d', {willReadFrequently: true});
        ctx.fillStyle = '#101014';
        ctx.fillRect(0, 0, width, height);
        await window.multiTimeline.renderOverlays(canvas, time, plan);
        return ctx.getImageData(0, 0, width, height).data;
      };
      const difference = (a, b) => {
        let total = 0;
        for (let index = 0; index < a.length; index += 4) total += Math.abs(a[index] - b[index]) + Math.abs(a[index + 1] - b[index + 1]) + Math.abs(a[index + 2] - b[index + 2]);
        return total / (a.length / 4 * 3);
      };
      // The media frame is frozen, so the only difference between these two passes is the layers:
      // the preview is sampled with the layers on, then everything is removed and both are re-read.
      // The preview must be showing the same moment the export pass is being asked for.
      const parked = await window.__freezeAt(time);
      const previewWith = await window.__settleScene();
      const withLayers = await paintExport();
      const removed = [];
      for (const layer of window.multiTimeline.layers) { removed.push(layer); window.multiTimeline.removeLayer(layer.id); }
      for (const caption of window.multiTimeline.captions) { removed.push(caption); window.multiTimeline.removeCaption(caption.id); }
      const withoutLayers = await paintExport();
      const previewWithout = await window.__settleScene();
      return {
        exportDiff: difference(withLayers, withoutLayers),
        previewDiff: difference(previewWith, previewWithout),
        removed: removed.length,
        time, activeLayers, parked,
      };
    });
    assert.ok(parity.removed >= 3, `the parity check hid ${parity.removed} layers / captions`);
    assert.ok(parity.parked, `the parity check could not park the playhead at ${parity.time}`);
    assert.ok(parity.activeLayers >= 1, `the parity check sampled a moment with layer content (${parity.activeLayers} layers at ${parity.time})`);
    assert.ok(parity.exportDiff > 0.2, `the export pass paints the layers (saw ${parity.exportDiff.toFixed(3)})`);
    assert.ok(parity.previewDiff > 0.2, `the preview paints the same layers (saw ${parity.previewDiff.toFixed(3)})`);
    const shaded = Math.max(parity.exportDiff, parity.previewDiff) / Math.max(1e-6, Math.min(parity.exportDiff, parity.previewDiff));
    assert.ok(shaded < 6, `preview and export agree on how much the layers cover (export ${parity.exportDiff.toFixed(2)}, preview ${parity.previewDiff.toFixed(2)})`);

    // --- 10. A keyframed main clip shows in the preview and in the export frame ---------------
    const mainParity = await page.evaluate(async () => {
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const span = window.multiTimeline.clipOutputDuration(clip);
      const local = span * 0.5;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      // Brightness centre of mass: a horizontal move drags the frame sideways.
      const centroid = (data, width) => {
        let sum = 0, weight = 0;
        for (let index = 0; index < data.length; index += 4) {
          const lum = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
          sum += lum * ((index / 4) % width);
          weight += lum;
        }
        return weight > 0 ? sum / weight : null;
      };
      // The frame the export loop hands to the overlay pass, as a stand-in: a white block on a dark
      // background, so the keyframed move is measurable.
      const exportFrame = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320; canvas.height = 180;
        const ctx = canvas.getContext('2d', {willReadFrequently: true});
        ctx.fillStyle = '#101014';
        ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(120, 60, 80, 60);
        await window.multiTimeline.renderOverlays(canvas, local, window.multiTimeline.getExportPlan(window.multiTimeline.clips));
        return centroid(ctx.getImageData(0, 0, 320, 180).data, 320);
      };
      // Park the playhead in the middle of the clip: that is where the keyframed move is largest and
      // where the comparison is meaningful (at local 0 the transform is zero either way).
      const parked = await window.__freezeAt(clip.start + local);
      window.multiTimeline.updateClip(clip.id, {keyframes: {position: [
        {time: 0, value: {x: 0, y: 0}, easing: 'linear'},
        {time: span, value: {x: 0.5, y: 0}, easing: 'linear'},
      ]}});
      window.multiTimeline.refreshLayers();
      await wait(900);
      const sampled = window.FilmVideo.sampleKeyframes(window.multiTimeline.clips.find(entry => entry.id === clip.id).keyframes, local).position.x;
      const shifted = await exportFrame();
      const sceneKeyed = window.__sceneInfo();
      window.multiTimeline.updateClip(clip.id, {keyframes: {position: []}});
      window.multiTimeline.refreshLayers();
      await wait(900);
      const plain = await exportFrame();
      const scenePlain = window.__sceneInfo();
      return {
        span, local, sampled, parked, playhead: window.TL.playhead,
        exportWith: shifted, exportWithout: plain,
        sceneKeyed, scenePlain,
        sceneBase: document.getElementById('canvasWrap').classList.contains('mtl-scene-base'),
        glHidden: getComputedStyle(document.getElementById('glCanvas')).visibility === 'hidden',
      };
    });
    assert.equal(mainParity.parked, true, `the playhead could not be parked mid-clip (at ${mainParity.playhead})`);
    assert.ok(mainParity.sampled > 0.2, `the keyframe sample moves the frame (x=${mainParity.sampled})`);
    assert.ok(mainParity.sceneBase && mainParity.glHidden, 'the scene canvas takes over the base frame so the transform is visible');
    assert.ok(mainParity.sceneKeyed.painted > 0, 'the keyframed frame is painted on the preview surface');
    assert.ok(mainParity.exportWith !== null && mainParity.exportWithout !== null, 'both export frames painted the stand-in block');
    assert.ok(mainParity.exportWith - mainParity.exportWithout > 10,
      `the exported frame carries the keyframed move (${mainParity.exportWithout} → ${mainParity.exportWith})`);

    // --- 11. The eyedropper reads the preview even when the scene canvas owns the frame -------
    // The base canvas is hidden the moment a clip carries keyframes, so an eyedropper wired to that
    // one surface used to do nothing at all. This clicks the real control on the real preview.
    await page.evaluate(async () => {
      document.querySelectorAll('#videoFxPanel details').forEach(section => { section.open = true; });
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const span = window.multiTimeline.clipOutputDuration(clip);
      window.multiTimeline.updateClip(clip.id, {keyframes: {position: [
        {time: 0, value: {x: 0, y: 0}, easing: 'linear'},
        {time: span, value: {x: 0.35, y: 0}, easing: 'linear'},
      ]}});
      window.multiTimeline.refreshLayers();
      document.getElementById('chromaColor').value = '#123456';
      await window.__freezeAt(clip.start + span * 0.5);
      await new Promise(resolve => setTimeout(resolve, 700));
    });
    const ownedFrame = await page.evaluate(() => ({
      sceneBase: document.getElementById('canvasWrap').classList.contains('mtl-scene-base'),
      glHidden: getComputedStyle(document.getElementById('glCanvas')).visibility === 'hidden',
    }));
    assert.ok(ownedFrame.sceneBase && ownedFrame.glHidden, 'the scene canvas owns the base frame before the eyedropper runs');
    await page.click('#videoFxEyebrowBtn');
    const armed = await page.getAttribute('#videoFxEyebrowBtn', 'aria-pressed');
    assert.equal(armed, 'true', 'the eyedropper arms when its button is pressed');
    const frame = await (await page.$('#glCanvas')).boundingBox();
    // The clip is keyframed to the right, so the right half of the frame still shows picture.
    await page.mouse.click(frame.x + frame.width * 0.72, frame.y + frame.height * 0.5);
    await page.waitForTimeout(400);
    const picked = await page.evaluate(() => ({
      color: document.getElementById('chromaColor').value.toLowerCase(),
      picking: document.getElementById('videoFxEyebrowBtn').getAttribute('aria-pressed'),
      status: document.getElementById('videoFxStatus').textContent,
    }));
    assert.notEqual(picked.color, '#123456', `the eyedropper picked a colour off the preview (${picked.color})`);
    assert.equal(picked.picking, 'false', 'picking a colour leaves the eyedropper disarmed');
    assert.match(picked.status, /^Key colour picked: #/, `the pick is reported: ${picked.status}`);

    // --- 12. The timeline diamond keyframes all four properties, with easing ----------------
    // The clip is selected the way a user selects it: a click on the timeline itself.
    const mainClipId = await page.evaluate(() => window.multiTimeline.clips.find(entry => entry.track === 'main').id);
    const mainClipBox = await page.locator(`.mtl-clip[data-clip-id="${mainClipId}"]`).first().boundingBox();
    assert.ok(mainClipBox && mainClipBox.width > 4, 'the main clip is on the timeline and can be clicked');
    await page.mouse.click(mainClipBox.x + mainClipBox.width / 2, mainClipBox.y + mainClipBox.height / 2);
    await page.waitForTimeout(300);
    const timelineKeyframe = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const clip = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const selected = window.TL.selectedClip?.id === clip.id;
      window.multiTimeline.updateClip(clip.id, {keyframes: {position: [], scale: [], rotation: [], opacity: []}, opacity: 0.7});
      window.TL.playhead = clip.start + Math.min(0.6, window.multiTimeline.clipOutputDuration(clip) * 0.4);
      await wait(400);
      const button = document.getElementById('mtl-keyframe-btn');
      const label = button?.getAttribute('aria-label') || '';
      button?.click();
      await wait(500);
      const keyed = window.multiTimeline.clips.find(entry => entry.id === clip.id).keyframes;
      const times = ['position', 'scale', 'rotation', 'opacity'].map(property => ({property, keys: (keyed[property] || []).map(key => ({time: key.time, value: key.value}))}));
      const diamonds = document.querySelectorAll('.mtl-keyframe-marker');
      const first = diamonds[0];
      first?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      await wait(300);
      const selection = window.multiTimeline.selectedKeyframe;
      const pill = document.querySelector('.mtl-keyframe-easing');
      const easingOptions = pill ? [...pill.options].map(option => option.value) : [];
      if (pill) { pill.value = 'ease-out'; pill.dispatchEvent(new Event('change', {bubbles: true})); }
      await wait(300);
      const eased = window.multiTimeline.clips.find(entry => entry.id === clip.id).keyframes;
      const applied = Object.fromEntries(['position', 'scale', 'rotation', 'opacity'].map(property => [property, (eased[property] || []).map(key => key.easing)]));
      button?.click();
      await wait(400);
      const cleared = window.multiTimeline.clips.find(entry => entry.id === clip.id).keyframes;
      return {
        selected, label, diamonds: diamonds.length, times, selection: selection ? {time: selection.time, easing: selection.easing} : null,
        easingOptions, applied,
        cleared: Object.fromEntries(['position', 'scale', 'rotation', 'opacity'].map(property => [property, (cleared[property] || []).length])),
      };
    });
    assert.equal(timelineKeyframe.selected, true, 'clicking the clip on the timeline selects it');
    assert.match(timelineKeyframe.label, /position, scale, rotation and opacity/, 'the timeline diamond names every property it keys');
    for (const entry of timelineKeyframe.times) {
      assert.equal(entry.keys.length, 1, `the timeline diamond keyed ${entry.property} (${JSON.stringify(entry.keys)})`);
    }
    assert.equal(new Set(timelineKeyframe.times.map(entry => entry.keys[0].time)).size, 1, 'all four properties are keyed at the same moment');
    assert.equal(timelineKeyframe.times.find(entry => entry.property === 'opacity').keys[0].value, 0.7, 'the opacity key records the clip value at the playhead');
    assert.ok(timelineKeyframe.diamonds >= 1, 'the keyed moment shows a diamond on the timeline');
    assert.equal(timelineKeyframe.selection === null, false, 'clicking the diamond selects the keyed moment');
    assert.deepEqual(timelineKeyframe.easingOptions, ['linear', 'hold', 'ease-in', 'ease-out', 'ease-in-out'], 'the diamond offers the full easing list');
    for (const property of ['position', 'scale', 'rotation', 'opacity']) {
      assert.deepEqual(timelineKeyframe.applied[property], ['ease-out'], `the easing pill rewrites ${property}`);
    }
    assert.deepEqual(timelineKeyframe.cleared, {position: 0, scale: 0, rotation: 0, opacity: 0}, 'the diamond toggles the whole moment back off');

    // --- 13. Speed runs 0.1x to 8x, the ramp presets reshape the clip, freeze and reverse ------
    const speed = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const clipId = window.multiTimeline.clips.find(entry => entry.track === 'main').id;
      const read = () => window.multiTimeline.clips.find(entry => entry.id === clipId);
      window.multiTimeline.updateClip(clipId, {speed: {rate: 1, ramp: 'none', freeze: false, reverse: false}});
      await wait(300);
      const base = window.multiTimeline.clipOutputDuration(read());
      const slider = document.getElementById('sliderClipSpeed');
      const bounds = {min: Number(slider.min), max: Number(slider.max), step: Number(slider.step)};
      const setRate = async rate => { slider.value = String(rate); slider.dispatchEvent(new Event('input', {bubbles: true})); await wait(400); return window.multiTimeline.clipOutputDuration(read()); };
      const slow = await setRate(0.1);
      const slowRate = read().speed.rate;
      const fast = await setRate(8);
      const fastRate = read().speed.rate;
      const readout = document.getElementById('valClipSpeed')?.textContent || '';
      const back = await setRate(1);
      const ramps = [...document.querySelectorAll('[data-speed-ramp]')].map(button => button.dataset.speedRamp);
      const durations = {};
      for (const ramp of ramps) {
        document.querySelector(`[data-speed-ramp="${ramp}"]`).click();
        await wait(400);
        durations[ramp] = window.multiTimeline.clipOutputDuration(read());
      }
      document.querySelector('[data-speed-ramp="none"]').click();
      await wait(300);
      const pressed = [...document.querySelectorAll('[data-speed-ramp]')].filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.speedRamp);
      const speedLabel = document.getElementById('speedStatus')?.textContent || '';
      document.getElementById('mtl-freeze-btn').click();
      await wait(400);
      const frozen = {...read().speed};
      const frozenDuration = window.multiTimeline.clipOutputDuration(read());
      document.getElementById('mtl-freeze-btn').click();
      await wait(300);
      document.getElementById('mtl-reverse-btn').click();
      await wait(400);
      const reversed = {...read().speed};
      document.getElementById('mtl-reverse-btn').click();
      await wait(300);
      const after = {...read().speed};
      return {bounds, base, slow, slowRate, fast, fastRate, readout, back, ramps, durations, pressed, speedLabel, frozen, frozenDuration, reversed, after};
    });
    assert.deepEqual(speed.bounds, {min: 0.1, max: 8, step: 0.1}, 'the speed control covers 0.1x to 8x');
    assert.equal(speed.slowRate, 0.1, 'the slowest step is 0.1x');
    assert.equal(speed.fastRate, 8, 'the fastest step is 8x');
    assert.ok(Math.abs(speed.slow - speed.base * 10) < 0.06, `0.1x stretches the clip tenfold (${speed.base} -> ${speed.slow})`);
    assert.ok(Math.abs(speed.fast - speed.base / 8) < 0.06, `8x shortens the clip eightfold (${speed.base} -> ${speed.fast})`);
    assert.match(speed.readout, /8x/, 'the speed readout follows the slider');
    assert.deepEqual(speed.ramps, ['none', 'montage', 'hero', 'bullet'], 'the ramp list offers constant, montage, hero and bullet');
    for (const ramp of ['montage', 'hero', 'bullet']) {
      assert.ok(Math.abs(speed.durations[ramp] - speed.durations.none) > 0.05, `the ${ramp} ramp reshapes the clip (${speed.durations.none} -> ${speed.durations[ramp]})`);
    }
    assert.equal(new Set([speed.durations.montage, speed.durations.hero, speed.durations.bullet]).size, 3, 'each ramp curve is a different shape');
    assert.deepEqual(speed.pressed, ['none'], 'the active ramp preset is marked as pressed');
    assert.match(speed.speedLabel, /Constant ramp · 1x/, `the speed readout names the ramp: ${speed.speedLabel}`);
    assert.equal(speed.frozen.freeze, true, 'the timeline freeze button freezes the clip');
    assert.ok(Math.abs(speed.frozenDuration - speed.base) < 0.06, `a frozen clip keeps its own length (${speed.frozenDuration})`);
    assert.equal(speed.reversed.reverse, true, 'the timeline reverse button reverses the clip');
    assert.deepEqual(speed.after, {rate: 1, reverse: false, freeze: false, ramp: 'none'}, 'the toggles return the clip to normal playback');

    // --- 14. An overlay clip on V2 carries its blend, opacity and chroma key into the export ---
    const v2Id = await page.evaluate(async () => {
      const main = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const v2 = window.multiTimeline.addClip(main.mediaId, 'video-2', 0);
      window.multiTimeline.updateClip(v2.id, {blend: 'normal', opacity: 1, chroma: {enabled: false}});
      window.multiTimeline.pause(); window.TL.playing = false; window.TL.playhead = 0.6;
      return v2.id;
    });
    await page.waitForTimeout(1200);
    const v2Box = await page.locator(`.mtl-clip[data-clip-id="${v2Id}"]`).first().boundingBox();
    assert.ok(v2Box && v2Box.width > 4, 'the overlay clip is on the V2 lane and can be clicked');
    await page.mouse.click(v2Box.x + v2Box.width / 2, v2Box.y + v2Box.height / 2);
    await page.waitForTimeout(300);
    const overlay = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const v2 = window.multiTimeline.clips.find(entry => entry.track === 'video-2');
      const selected = window.TL.selectedClip?.id === v2.id;
      const paint = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 480; canvas.height = 270;
        const ctx = canvas.getContext('2d', {willReadFrequently: true});
        ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await window.multiTimeline.renderOverlays(canvas, 0.6, window.multiTimeline.getExportPlan(window.multiTimeline.clips));
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let green = 0, luminance = 0;
        for (let index = 0; index < data.length; index += 4) {
          luminance += data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
          if (data[index + 1] > 120 && data[index] < 110 && data[index + 2] < 110) green += 1;
        }
        return {green, luminance: Math.round(luminance / (data.length / 4) * 100) / 100};
      };
      // The overlay shares the main clip's media, so at normal blend and full opacity it paints the
      // same frame the base already shows: the states that prove it reaches the export are a blend
      // the base cannot produce, and the overlay being switched off.
      const visible = await paint();
      const blend = document.getElementById('layerBlendSelect');
      blend.value = 'screen'; blend.dispatchEvent(new Event('change', {bubbles: true}));
      const opacity = document.getElementById('sliderLayerOpacity');
      opacity.value = '40'; opacity.dispatchEvent(new Event('input', {bubbles: true}));
      await wait(700);
      const screened = await paint();
      const applied = window.multiTimeline.clips.find(entry => entry.id === v2.id);
      const manifest = (window.multiTimeline.getExportManifest().clips || []).find(entry => entry.track === 'video-2');
      window.multiTimeline.updateClip(v2.id, {blend: 'multiply', opacity: 1});
      await wait(700);
      const multiplied = await paint();
      window.multiTimeline.updateClip(v2.id, {blend: 'normal', opacity: 0});
      await wait(700);
      const hidden = await paint();
      window.multiTimeline.updateClip(v2.id, {opacity: 1, blend: 'normal', chroma: {enabled: true, color: '#00ff00', tolerance: 30, softness: 18, spill: 45}});
      await wait(1400);
      const keyed = await paint();
      const chromaStatus = document.getElementById('chromaStatus')?.textContent || '';
      window.multiTimeline.updateClip(v2.id, {chroma: {enabled: false}, opacity: 0});
      await wait(500);
      return {selected, visible, screened, multiplied, hidden, keyed, chromaStatus,
        clip: {blend: applied.blend, opacity: applied.opacity}, manifest: manifest ? {track: manifest.track, blend: manifest.blend, opacity: manifest.opacity} : null};
    });
    assert.equal(overlay.selected, true, 'clicking the V2 clip selects the overlay it blends');
    assert.equal(overlay.clip.blend, 'screen', 'the blend control writes to the V2 overlay clip');
    assert.equal(overlay.clip.opacity, 0.4, 'the opacity control writes to the V2 overlay clip');
    assert.deepEqual(overlay.manifest, {track: 'video-2', blend: 'screen', opacity: 0.4}, 'the export manifest carries the overlay blend and opacity');
    assert.ok(Math.abs(overlay.multiplied.luminance - overlay.hidden.luminance) > 2, `the V2 overlay reshapes the exported frame (${overlay.hidden.luminance} hidden vs ${overlay.multiplied.luminance} at multiply)`);
    assert.ok(Math.abs(overlay.visible.luminance - overlay.screened.luminance) > 1, `the blend and opacity reach the export (${overlay.visible.luminance} normal vs ${overlay.screened.luminance} screen at 40%)`);
    assert.match(overlay.chromaStatus, /WebGL/, `the chroma key reports its WebGL path: ${overlay.chromaStatus}`);
    assert.ok(overlay.keyed.green < overlay.visible.green * 0.6, `keying the overlay removes its green from the exported frame (${overlay.visible.green} -> ${overlay.keyed.green})`);

    // --- 15. Text, captions and stickers keep their style and timing in the export -------------
    const styled = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const main = window.multiTimeline.clips.find(entry => entry.track === 'main');
      const plan = window.multiTimeline.getExportPlan(window.multiTimeline.clips);
      const span = Math.min(plan.duration, window.multiTimeline.clipOutputDuration(main));
      window.multiTimeline.layers.slice().forEach(layer => window.multiTimeline.removeLayer(layer.id));
      window.multiTimeline.captions.slice().forEach(caption => window.multiTimeline.removeCaption(caption.id));
      const text = 'TYPEWRITER REVEAL LINE ONE TWO THREE FOUR FIVE';
      const layer = window.multiTimeline.addLayer({kind: 'text', text, start: 0, end: span, style: {font: 'serif', size: 58, color: '#ff00ff', stroke: '#000000', strokeWidth: 4, background: '#112233', backgroundOpacity: 0.5, align: 'left', animation: 'typewriter'}});
      // Inside the frame: the transform is normalised, so -0.5..0.5 is the visible band.
      const sticker = window.multiTimeline.addLayer({kind: 'sticker', sticker: 'star', start: 0, end: span, transform: {x: -0.28, y: 0.22, scale: 0.32}});
      const caption = window.multiTimeline.addCaption({text: 'caption window', start: 0.1, end: span * 0.55});
      await window.FilmVideo.preloadStickerImages();
      await wait(600);
      const render = async time => {
        const canvas = document.createElement('canvas');
        canvas.width = 480; canvas.height = 270;
        const ctx = canvas.getContext('2d', {willReadFrequently: true});
        ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await window.multiTimeline.renderOverlays(canvas, time, window.multiTimeline.getExportPlan(window.multiTimeline.clips));
        return {data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height};
      };
      const magenta = frame => { let count = 0; for (let i = 0; i < frame.data.length; i += 4) if (frame.data[i] > 150 && frame.data[i + 2] > 150 && frame.data[i + 1] < 110) count += 1; return count; };
      // The caption sits in the bottom band of the frame: white text on a dark box.
      const captionBand = frame => {
        let count = 0;
        const start = Math.floor(frame.height * 0.75) * frame.width;
        for (let index = start; index < frame.width * frame.height; index += 1) {
          const offset = index * 4;
          if (frame.data[offset] > 200 && frame.data[offset + 1] > 200 && frame.data[offset + 2] > 200) count += 1;
        }
        return count;
      };
      const difference = (a, b) => { let total = 0; for (let index = 0; index < a.data.length; index += 4) if (Math.abs(a.data[index] - b.data[index]) > 16) total += 1; return total; };
      const early = await render(span * 0.1);
      const late = await render(span * 0.62);
      const inCaption = await render(span * 0.3);
      const outCaption = await render(span * 0.8);
      window.multiTimeline.removeLayer(sticker.id);
      await wait(400);
      const withoutSticker = await render(span * 0.62);
      const layersAfter = window.multiTimeline.layers.length;
      const captionsAfter = window.multiTimeline.captions.length;
      return {early: magenta(early), late: magenta(late), inCaption: captionBand(inCaption), outCaption: captionBand(outCaption),
        stickerDiff: difference(late, withoutSticker), layersAfter, captionsAfter,
        caption: caption ? {start: caption.start, end: caption.end} : null, style: layer?.style, stickerKind: sticker?.kind};
    });
    assert.equal(styled.style.animation, 'typewriter', 'the animation preset is stored on the text layer');
    assert.equal(styled.style.font, 'serif', 'the font choice is stored on the text layer');
    assert.equal(styled.style.background, '#112233', 'the background colour is stored on the text layer');
    assert.equal(styled.style.strokeWidth, 4, 'the stroke width is stored on the text layer');
    assert.ok(styled.late > styled.early * 1.5, `the typewriter types the line out as it plays (${styled.early} -> ${styled.late} text pixels)`);
    assert.equal(styled.stickerKind, 'sticker', 'the built-in sticker becomes a sticker layer');
    assert.ok(styled.stickerDiff > 100, `the sticker reaches the exported frame (${styled.stickerDiff} pixels changed)`);
    assert.ok(styled.caption && styled.caption.end > styled.caption.start, 'a manual caption keeps its start and end time');
    assert.ok(styled.inCaption - styled.outCaption > 40, `the caption only paints inside its window (${styled.inCaption} vs ${styled.outCaption} caption pixels)`);
    assert.ok(styled.layersAfter >= 1 && styled.captionsAfter >= 1, `the title and the caption line are both still on the scene (${styled.layersAfter} layers, ${styled.captionsAfter} captions)`);

    // --- 16. A phone keeps the panel usable ------------------------------------------------
    const phone = await context.newPage();
    await phone.setViewportSize({width: 390, height: 844});
    await phone.goto(`http://127.0.0.1:${PORT}/index.html`, {waitUntil: 'domcontentloaded'});
    await phone.waitForFunction(() => document.getElementById('presetSelect')?.options.length > 1, null, {timeout: 30000});
    const phoneControls = await phone.evaluate(() => ['sliderClipSpeed', 'fxKeyframeBtn', 'fxAddTextBtn', 'chromaEnabled', 'stickerGrid'].filter(id => !document.getElementById(id)));
    assert.deepEqual(phoneControls, [], 'the video-effects panel is mounted on a phone viewport too');
    await phone.close();

    await page.screenshot({path: '/tmp/r8-video-fx.png'});
    const shaderErrors = errors.filter(message => /shader|No precision specified/i.test(message));
    assert.deepEqual(shaderErrors, [], `no shader errors: ${shaderErrors.join(' | ')}`);
    const layerWarnings = warnings.filter(message => /video layer could not be drawn|Chroma key failed/i.test(message));
    assert.deepEqual(layerWarnings, [], `the renderer swallowed an error: ${layerWarnings.join(' | ')}`);
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

/* ---------------------------------------------------- round-12: video grading */
/* One browser check for the two round-12 fixes on the video side: the sidebar shares the photo
   Grade panel (LOOKS / ADJUST / GRADE / EXPORT), moving Grade Temperature to +100 changes the
   preview canvas, the look cards draw a frame of the loaded clip instead of a gradient swatch, and
   the sidebar scrolls so the looks grid is reachable. */
test('the video sidebar opens the shared Grade panel and Temperature moves the preview frame', {timeout: 600000}, async t => {
  if (!available) {
    t.skip('Playwright and a Chromium build are needed for this test');
    return;
  }
  const browser = await launchWithWebgl2();
  if (!browser) {
    t.skip('this Chromium cannot create a WebGL2 context, so the Film Lab preview cannot boot');
    return;
  }
  const server = await startStaticServer();
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}, serviceWorkers: 'block'});
    await context.route('**/sw.js', route => route.abort());
    await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
    await context.route('https://fonts.gstatic.com/**', route => route.fulfill({body: '', contentType: 'font/woff2'}));
    const page = await context.newPage();
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 220)); });
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    const clip = await recordWebm(browser);
    assert.ok(clip.length > 1000, 'the recorded WebM fixture is empty');
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('presetSelect')?.options.length > 1, null, {timeout: 30000});
    await page.setInputFiles('#videoPickerInput', {name: 'clip.webm', mimeType: 'video/webm', buffer: clip});
    await page.waitForFunction(() => document.body.dataset.mode === 'video', null, {timeout: 90000});
    await page.waitForFunction(() => window.multiTimeline?.isReady?.(), null, {timeout: 60000});
    await page.waitForTimeout(1200);
    // The clip's own colours animate, so a before/after comparison only means something on one
    // fixed frame: every sample parks playback on the same 0.5s frame first and reports where it
    // landed, so a moving clip can never masquerade as a grading change.
    const sample = () => page.evaluate(async () => {
      // The scrubber is the app's own seek: moving it pauses playback and lands on that frame, which
      // is the only way a looping two-second clip stays still while the frame is read back. The seek
      // is retried, because a clip that is still buffering ignores the first one.
      const video = document.getElementById('videoEl');
      for (let attempt = 0; attempt < 5; attempt++) {
        const seek = document.getElementById('videoSeek');
        seek.value = '0.5';
        seek.dispatchEvent(new Event('input', {bubbles: true}));
        await new Promise(resolve => setTimeout(resolve, 250));
        if (video.paused && Math.abs(video.currentTime - 0.5) < 0.02) break;
      }
      // Two frames of the render loop: the parked frame is drawn before the canvas is read back.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const base = document.getElementById('glCanvas');
      const scratch = document.createElement('canvas');
      scratch.width = 96; scratch.height = 96;
      const ctx = scratch.getContext('2d', {willReadFrequently: true});
      ctx.drawImage(base, 0, 0, 96, 96);
      const pixels = ctx.getImageData(0, 0, 96, 96).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let index = 0; index < pixels.length; index += 4) { r += pixels[index]; g += pixels[index + 1]; b += pixels[index + 2]; n++; }
      return {mean: [r / n, g / n, b / n], time: Math.round(video.currentTime * 1000) / 1000, paused: video.paused};
    });

    // --- the video sidebar offers the same four tabs, Grade included --------------------------
    const tabs = await page.evaluate(() => [...document.querySelectorAll('#sidebarTabs .sidebarTab')]
      .filter(tab => getComputedStyle(tab).display !== 'none')
      .map(tab => tab.dataset.tab));
    assert.deepEqual(tabs, ['looks', 'adjust', 'grade', 'export'], `video tabs are LOOKS / ADJUST / GRADE / EXPORT, saw ${tabs.join(', ')}`);
    const panel = await page.evaluate(() => {
      document.getElementById('gradeTab').click();
      const grade = document.getElementById('colorGradePanel');
      return {
        active: grade.classList.contains('active'), hidden: grade.hidden, display: getComputedStyle(grade).display,
        version: document.getElementById('gradePanelVersion').textContent,
        sliders: ['sliderGradeTemperature', 'sliderGradeTint', 'sliderGradeExposure', 'sliderGradeContrast', 'sliderGradeHighlights', 'sliderGradeShadows', 'sliderGradeWhites', 'sliderGradeBlacks', 'sliderGradeTexture', 'sliderGradeClarity', 'sliderGradeDehaze', 'sliderGradeVibrance', 'sliderGradeSaturation', 'sliderGradeVignette']
          .filter(id => !document.getElementById(id)),
        wheels: document.querySelectorAll('#colorGradePanel .gradeWheelPicker').length,
        hsl: document.querySelectorAll('#colorGradePanel [data-hsl-control]').length,
        curve: !!document.getElementById('gradeCurveCanvas'),
        curveReset: !!document.getElementById('gradeCurveResetBtn'),
        shared: !!document.getElementById('colorGradePanel')?.closest('#sidebarViews'),
      };
    });
    assert.ok(panel.active && panel.hidden === false && panel.display === 'flex', `the shared Grade panel opens in the video sidebar (${JSON.stringify(panel)})`);
    assert.equal(panel.version, 'VIDEO · 01', 'the panel says which workspace it is grading');
    assert.deepEqual(panel.sliders, [], 'every grading slider is present in video mode');
    assert.ok(panel.wheels >= 3 && panel.hsl >= 24 && panel.curve && panel.curveReset, `wheels (${panel.wheels}), HSL (${panel.hsl}), curve (${panel.curve}) and its reset are all there`);
    assert.ok(panel.shared, 'video mode reuses the one colorGradePanel rather than a copy');

    // --- Grade Temperature +100 changes the preview canvas -----------------------------------
    const before = await sample();
    const beforeTime = before.time;
    await page.evaluate(() => {
      const slider = document.getElementById('sliderGradeTemperature');
      slider.value = '100';
      slider.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await page.waitForTimeout(600);
    const after = await sample();
    const afterTime = after.time;
    const delta = before.mean.map((value, index) => after.mean[index] - value);
    const moved = delta.reduce((total, value) => total + Math.abs(value), 0) / 3;
    assert.ok(Math.abs(beforeTime - afterTime) < 0.02, `both samples read the same parked frame (${beforeTime}s vs ${afterTime}s)`);
    assert.ok(moved >= 3, `Temperature +100 must move the graded video frame (mean colour moved ${moved.toFixed(2)} levels: ${before.mean.map(v => v.toFixed(1))} -> ${after.mean.map(v => v.toFixed(1))} at ${beforeTime}s)`);
    assert.ok(delta[0] > 1.5 && delta[2] < -1.5, `+100 warms the frame: red up ${delta[0].toFixed(2)}, blue down ${delta[2].toFixed(2)} (frame at ${beforeTime}s -> ${afterTime}s)`);
    // The same value reaches the export frame: the export canvas renders the graded preview frame.
    const exported = await page.evaluate(() => new Promise(resolve => {
      const canvas = document.getElementById('glCanvas');
      const scratch = document.createElement('canvas');
      scratch.width = 32; scratch.height = 32;
      const ctx = scratch.getContext('2d', {willReadFrequently: true});
      ctx.drawImage(canvas, 0, 0, 32, 32);
      const pixels = ctx.getImageData(0, 0, 32, 32).data;
      let r = 0, b = 0, n = 0;
      for (let index = 0; index < pixels.length; index += 4) { r += pixels[index]; b += pixels[index + 2]; n++; }
      resolve([r / n, b / n]);
    }));
    assert.ok(exported[0] > before.mean[0] - 1 || exported[1] < before.mean[2] + 1, 'the export readback sees the graded frame too');

    // --- look cards draw a frame of the clip, and the sidebar scrolls to reach them ----------
    await page.evaluate(() => document.getElementById('looksTab').click());
    await page.waitForTimeout(4000);
    const looks = await page.evaluate(() => {
      const sidebar = document.getElementById('sidebar');
      const cards = [...document.querySelectorAll('#presetChips .chip[data-preset-name]')];
      const previews = cards.filter(card => card.querySelector('.presetColorSwatch')?.classList.contains('hasPreview'));
      const swatch = previews[0]?.querySelector('.presetColorSwatch');
      const image = swatch ? getComputedStyle(swatch).backgroundImage : '';
      const last = cards[cards.length - 1];
      sidebar.scrollTop = sidebar.scrollHeight;
      const scrolledToBottom = sidebar.scrollTop;
      const box = sidebar.getBoundingClientRect();
      if (last) last.scrollIntoView({block: 'center'});
      const cardBox = last ? last.getBoundingClientRect() : null;
      return {
        cards: cards.length, previews: previews.length, dataUrl: /data:image\//.test(image),
        scrollable: sidebar.scrollHeight > sidebar.clientHeight + 20,
        scrolledToBottom,
        lastCardReachable: Boolean(cardBox && cardBox.top >= box.top - 2 && cardBox.bottom <= box.bottom + 2),
      };
    });
    assert.ok(looks.cards >= 4, `the looks grid is rendered in video mode (${looks.cards} cards)`);
    assert.ok(looks.previews >= 1 && looks.dataUrl, `video look cards show a frame of the clip (${looks.previews} previews, dataURL ${looks.dataUrl})`);
    assert.ok(looks.scrollable, 'the video sidebar scrolls instead of cutting the looks grid off');
    assert.ok(looks.scrolledToBottom > 0 && looks.lastCardReachable, `the last look card is reachable by scrolling (scrolled to ${looks.scrolledToBottom}, reachable ${looks.lastCardReachable})`);

    const shaderErrors = errors.filter(message => /shader|No precision specified/i.test(message));
    assert.deepEqual(shaderErrors, [], `no shader errors: ${shaderErrors.join(' | ')}`);
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
