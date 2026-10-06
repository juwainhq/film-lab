/* Real-browser test for the Lightroom-style photo tools added on top of the editor:
 * white-balance eyedropper + Auto WB, Auto tone, a draggable before/after split, snapshots with a
 * clickable history list, crop aspect-ratio presets + straighten, and per-photo copy / paste /
 * sync inside the carousel.
 *
 * These are rendering results, not source strings, so the heavy assertions drive Chromium through
 * Playwright exactly like tests/slider-calibration.test.cjs does: a real photo is uploaded, the
 * canvas is measured, and the controls are clicked the way a person would. The lighter checks keep
 * the pure helpers honest in plain Node.
 *
 * Skips itself (instead of failing) when Playwright or a Chromium build is not available, and
 * points a built-in static server at this checkout so the page, its workers and vendor/ all load.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FILM_LAB_LIGHTROOM_PORT || 8974);
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

const social = require('../social-tools.js');
const grading = require('../color-grading.js');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const styles = html.split('<style>')[1].split('</style>')[0];

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

const playwright = resolvePlaywright();
const chromiumPath = resolveChromium();
const available = Boolean(playwright && chromiumPath);

/* ---------------------------------------------------------------- pure helpers */
test('the white-balance eyedropper solves Temperature and Tint from a neutral point', () => {
  // A neutral grey needs no correction at all.
  const neutral = grading.whiteBalanceFromSample({r: 128, g: 128, b: 128});
  assert.equal(neutral.temperature, 0);
  assert.equal(neutral.tint, 0);
  assert.equal(neutral.usable, true);
  // A blue cast is warmed up, an orange one is cooled down, and a magenta one goes green.
  const blue = grading.whiteBalanceFromSample({r: 140, g: 150, b: 160});
  assert.ok(blue.temperature > 20, `a blue cast must warm the photo (saw ${blue.temperature})`);
  assert.ok(grading.isWhiteBalanced({r: 140, g: 150, b: 160}, blue.temperature, blue.tint, 0.03), 'the sample must read neutral after the correction');
  const warm = grading.whiteBalanceFromSample({r: 160, g: 150, b: 130});
  assert.ok(warm.temperature < -20, `a warm cast must cool the photo (saw ${warm.temperature})`);
  const magenta = grading.whiteBalanceFromSample({r: 160, g: 140, b: 160});
  assert.ok(magenta.tint < -20, `a magenta point must add green (saw ${magenta.tint})`);
  assert.ok(grading.isWhiteBalanced({r: 160, g: 140, b: 160}, magenta.temperature, magenta.tint, 0.03));
  // Out-of-range samples are reported instead of silently producing a wrong pair.
  assert.equal(grading.whiteBalanceFromSample({r: 3, g: 4, b: 5}).usable, false);
  assert.equal(grading.whiteBalanceFromSample({r: 254, g: 253, b: 255}).usable, false);
  assert.equal(grading.whiteBalanceFromSample({r: 120, g: 150, b: 200}).saturated, true);
  // The Adjust-tab Temperature also shifts the channels, so its share is removed from the ask.
  const withLegacy = grading.whiteBalanceFromSample({r: 140, g: 150, b: 160}, {legacyTemperature: 60});
  assert.notEqual(withLegacy.temperature, blue.temperature);
  assert.ok(withLegacy.temperature < blue.temperature, 'a warm legacy slider must be compensated for');
  // The exported gains mirror the shader model (linear-light exp2 channel gains).
  const gains = grading.whiteBalanceGains(100, 0);
  assert.ok(Math.abs(gains[0] - Math.pow(2, 0.38)) < 1e-9 && Math.abs(gains[2] - Math.pow(2, -0.38)) < 1e-9);
  assert.ok(Math.abs(gains[1] - 1) < 1e-9);
});

test('crop aspect presets cover 1:1, 4:5, 16:9, 3:2, 9:16 and the original frame', () => {
  const expected = {'1:1': [1, 1], '4:5': [4, 5], '16:9': [16, 9], '3:2': [3, 2], '9:16': [9, 16]};
  assert.deepEqual(social.CROP_RATIO_PRESETS.map(preset => preset.id), ['1:1', '4:5', '16:9', '3:2', '9:16', 'original']);
  for (const [id, [w, h]] of Object.entries(expected)) {
    const preset = social.cropRatioPreset(id);
    assert.ok(preset, `${id} must exist`);
    const ratio = social.cropRatio({format: preset.format});
    assert.ok(Math.abs(ratio - w / h) < 1e-9, `${id} must crop at ${w}:${h} (saw ${ratio})`);
    assert.ok(social.FORMATS[preset.format].width > 0);
  }
  assert.equal(social.cropRatio({format: social.cropRatioPreset('original').format}), null);
  // Straighten fills the frame instead of showing wedges, and stays inside ±45°.
  assert.equal(social.straightenFillScale(1200, 900, 0), 1);
  const scale = social.straightenFillScale(1200, 900, 45);
  assert.ok(scale > 1.6 && scale < 1.7, `45° on 4:3 should need ~1.65× (saw ${scale})`);
  assert.ok(social.straightenFillScale(900, 1200, 20) > 1);
  assert.equal(social.clampStraighten(120), 45);
  assert.equal(social.clampStraighten(-90), -45);
  assert.equal(social.clampStraighten(12.26), 12.5);
  assert.equal(social.clampStraighten(NaN), 0);
});

test('the full snapshot payload keeps the grade state, crop angle and framing', () => {
  const payload = social.normalizeFullSettings({
    settings: {version: 2, values: {Exposure: 12}, effects: {grain: false}},
    grade: {values: {sliderGradeTemperature: '20'}},
    straighten: 130,
    crop: {x: 1.4, y: -0.2},
    origin: 'portrait.png',
  });
  assert.equal(payload.straighten, 45);
  assert.deepEqual(payload.crop, {x: 1, y: 0});
  assert.equal(payload.grade.values.sliderGradeTemperature, '20');
  assert.equal(payload.settings.values.Exposure, 12);
  assert.equal(payload.origin, 'portrait.png');
  // The nested shape and the bare settings shape both read, and junk is rejected.
  assert.equal(social.normalizeFullSettings({version: 1, values: {Exposure: 1}}).straighten, 0);
  assert.throws(() => social.normalizeFullSettings({nope: true}), /Film Lab settings payload/);
  assert.throws(() => social.normalizeFullSettings(null), /Film Lab settings payload/);
});

test('Auto tone writes exposure, contrast, highlights, shadows, whites and blacks', () => {
  const flat = new Uint8ClampedArray(256 * 4);
  for (let index = 0; index < 256; index++) flat.set([120, 120, 120, 255], index * 4);
  const auto = grading.autoAdjustFromPixels({data: flat});
  for (const key of ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks']) {
    assert.ok(Number.isFinite(auto[key]), `${key} must be a number`);
  }
  assert.ok(auto.contrast > 0, 'a flat frame gains contrast');
  assert.ok(auto.highlights > 0 && auto.shadows < 0, 'flat mid-tones get a little shape');
  // Every key the panel needs is wired to a real Grade slider in the markup.
  for (const key of ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks']) {
    const id = `sliderGrade${key[0].toUpperCase()}${key.slice(1)}`;
    assert.match(html, new RegExp(`id="${id}"`), `${id} must exist for Auto tone`);
  }
  assert.match(script, /const adjustments=colorGrading\.autoAdjustFromPixels\(pixels\);/);
  // The histogram helper names its keys exposure / contrast / … while the sliders are
  // sliderGradeExposure / …; the mapping has to capitalise them or Auto tone silently no-ops.
  assert.match(script, /const slider=\$\(`sliderGrade\$\{name\[0\]\.toUpperCase\(\)\}\$\{name\.slice\(1\)\}`\);/);
  assert.match(script, /if\(!Number\.isFinite\(value\)\)continue;/);
});

test('the new controls are wired into the existing editor without removing anything', () => {
  // White balance tools live in the Grade panel next to the temperature / tint sliders.
  assert.match(html, /id="wbEyedropperBtn"[^>]*aria-pressed="false"/);
  assert.match(html, /id="wbAutoBtn"/);
  assert.match(script, /canvas\.addEventListener\('pointerdown',event=>\{\n  if\(!wbPicking\) return;/);
  assert.match(script, /function runWbEyedropperAt\(clientX,clientY\)/);
  assert.match(script, /function runAutoWhiteBalance\(\)/);
  assert.match(script, /const sample=samplePhotoPixel\(\(clientX-box\.left\)\/box\.width,\(clientY-box\.top\)\/box\.height,2\)/);
  // The split view is draggable and sits beside the existing hold-to-compare button.
  assert.match(html, /id="holdCompareBtn"[\s\S]{0,260}id="splitToggleBtn"/);
  assert.match(html, /id="splitDivider" role="separator"[^>]*tabindex="0"/);
  assert.match(script, /function moveSplitTo\(clientX\)/);
  assert.match(script, /gl\.uniform1f\(gl\.getUniformLocation\(progDither,'u_splitPosition'\),splitPosition\)/);
  assert.match(script, /\$\('splitDivider'\)\.addEventListener\('pointerdown'/);
  assert.match(script, /\$\('holdCompareBtn'\)/);
  // Snapshots and a clickable history list.
  assert.match(html, /id="snapshotChips"[\s\S]{0,700}id="historyList"/);
  assert.match(script, /function pushHistory\(label\)/);
  assert.match(script, /function applyHistoryEntry\(index\)/);
  assert.match(script, /function addSnapshot\(\)/);
  assert.match(script, /const HISTORY_LIMIT=30, SNAPSHOT_KEY='film_lab_snapshots_v1', SNAPSHOT_LIMIT=12;/);
  // Straighten is baked into the source the renderer and the export share.
  assert.match(html, /id="sliderStraighten" min="-45" max="45" step="0\.5"/);
  assert.match(script, /function applyStraightenToSource\(source,width,height,angle\)/);
  assert.match(script, /const straightened=applyStraightenToSource\(rotateCanvas\(baseSource,baseW,baseH,rotation\),w,h,item\.straighten\);/);
  // Spot heal is baked on top of the straightened pixels, and both feed the same source.
  assert.match(script, /const source=applyHealToSource\(straightened,w,h,item\.healStrokes\);/);
  assert.match(script, /scheduleHistoryCommit\(`Straighten/);
  // Crop presets drive the existing data-format handler.
  for (const id of ['cropRatio1x1', 'cropRatio4x5', 'cropRatio16x9', 'cropRatio3x2', 'cropRatio9x16', 'cropRatioOriginal']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="cropRatio16x9" data-format="wide"/);
  assert.match(html, /id="cropRatio3x2" data-format="threeTwo"/);
  // Carousel copy / paste / sync.
  assert.match(html, /id="copyPhotoSettingsBtn"[\s\S]{0,90}/);
  assert.match(html, /id="selectPhotosBtn" aria-pressed="false"/);
  assert.match(html, /id="syncSelectedBtn"/);
  assert.match(script, /async function syncSettingsToPhotos\(targets,/);
  assert.match(script, /function applyPhotoSettingsOverride\(item\)/);
  assert.match(script, /suppressPhotoOverride=true;/);
  // Existing carousel behaviour is untouched: the strip renderer stays byte-identical.
  const strip = script.slice(script.indexOf('function renderPhotoStrip(){'), script.indexOf('\n}', script.indexOf('function renderPhotoStrip(){')));
  assert.match(strip, /btn\.addEventListener\('click',\(\)=>activatePhoto\(index\)\)/);
  assert.match(html, /<p id="carouselHint" class="socialHint">One shared edit\./);
  // 44px touch targets for the new controls.
  const coarse = styles.slice(styles.lastIndexOf('@media (pointer: coarse) {'));
  for (const id of ['addSnapshotBtn', 'selectPhotosBtn', 'syncSelectedBtn', 'wbEyedropperBtn', 'wbAutoBtn']) {
    assert.match(coarse, new RegExp(`#${id}`), `${id} needs a coarse-pointer target`);
  }
  assert.match(coarse, /\.cropRatioBtn,\.straightenResetBtn,\.historyItem/);
});

/* ---------------------------------------------------------------- browser helpers */
async function openApp(browser, {viewport = {width: 1440, height: 900}, touch = false} = {}) {
  const context = await browser.newContext({viewport, hasTouch: touch, isMobile: false});
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
  await context.route('https://fonts.gstatic.com/**', route => route.fulfill({body: '', contentType: 'font/woff2'}));
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 200)); });
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => document.getElementById('presetSelect')?.options.length > 1, null, {timeout: 30000});
  return {context, page, errors};
}
/* The two fixtures are drawn in the page so both the pixels and the click coordinates are known:
   a 640x480 frame with a neutral grey card (used by the eyedropper) plus a low-contrast ramp, and
   a second frame with different content for the carousel tests. */
const FIXTURE_SCRIPT = async (variant) => {
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 480;
  const context = canvas.getContext('2d');
  if (variant === 2) {
    const sky = context.createLinearGradient(0, 0, 0, 480);
    sky.addColorStop(0, '#cfe0f2'); sky.addColorStop(1, '#5d6b7a');
    context.fillStyle = sky; context.fillRect(0, 0, 640, 480);
    context.fillStyle = '#f0c060'; context.fillRect(200, 300, 240, 140);
  } else {
    const wash = context.createLinearGradient(0, 0, 640, 480);
    wash.addColorStop(0, '#8fa6c8'); wash.addColorStop(1, '#c8bfae');
    context.fillStyle = wash; context.fillRect(0, 0, 640, 480);
    // A low-contrast band so Auto tone has something to stretch.
    for (let y = 0; y < 480; y++) {
      const value = 104 + Math.round((y / 479) * 48);
      context.fillStyle = `rgb(${value},${value},${value})`;
      context.fillRect(320, y, 320, 1);
    }
    // Neutral grey card at x 60..220, y 180..300 (fractions 0.094..0.344 x 0.375..0.625).
    context.fillStyle = '#8d9bb0';
    context.fillRect(60, 180, 160, 120);
    context.fillStyle = '#ffffff'; context.fillRect(420, 60, 120, 80);
  }
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const buffer = await blob.arrayBuffer();
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
};
async function fixture(page, variant = 1) {
  const base64 = await page.evaluate(FIXTURE_SCRIPT, variant);
  return {name: variant === 1 ? 'neutral-card.png' : 'sky.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64')};
}
async function loadPhoto(page, file) {
  await page.setInputFiles('#photoPickerInput', file);
  await page.waitForFunction(() => document.body.dataset.mode === 'photo' && document.getElementById('glCanvas').width > 8, null, {timeout: 60000});
  await page.waitForTimeout(1500);
}
const CANVAS_HELPERS = () => {
  const canvas = document.getElementById('glCanvas');
  const scratch = document.createElement('canvas');
  window.__grab = () => {
    scratch.width = canvas.width; scratch.height = canvas.height;
    const context = scratch.getContext('2d', {willReadFrequently: true});
    context.clearRect(0, 0, scratch.width, scratch.height);
    context.drawImage(canvas, 0, 0);
    return context.getImageData(0, 0, scratch.width, scratch.height);
  };
  const stats = (image, region) => {
    const x0 = Math.round(region.x * image.width), y0 = Math.round(region.y * image.height);
    const w = Math.max(1, Math.round(region.w * image.width)), h = Math.max(1, Math.round(region.h * image.height));
    let r = 0, g = 0, b = 0, count = 0;
    for (let y = y0; y < Math.min(image.height, y0 + h); y++) for (let x = x0; x < Math.min(image.width, x0 + w); x++) {
      const o = (y * image.width + x) * 4;
      r += image.data[o]; g += image.data[o + 1]; b += image.data[o + 2]; count++;
    }
    return {r: r / count, g: g / count, b: b / count};
  };
  window.__region = (region) => stats(window.__grab(), region);
  window.__difference = (before, region = null) => {
    const after = window.__grab();
    let total = 0, count = 0;
    const x0 = region ? Math.round(region.x * after.width) : 0, y0 = region ? Math.round(region.y * after.height) : 0;
    const x1 = region ? Math.round((region.x + region.w) * after.width) : after.width;
    const y1 = region ? Math.round((region.y + region.h) * after.height) : after.height;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = (y * after.width + x) * 4;
      total += Math.abs(after.data[o] - before.data[o]) + Math.abs(after.data[o + 1] - before.data[o + 1]) + Math.abs(after.data[o + 2] - before.data[o + 2]);
      count++;
    }
    return total / Math.max(1, count * 3);
  };
};
const GREY_CARD = {x: 0.09, y: 0.36, w: 0.26, h: 0.28};
const LEFT_BAND = {x: 0.02, y: 0.1, w: 0.2, h: 0.8};
const RIGHT_BAND = {x: 0.78, y: 0.1, w: 0.2, h: 0.8};
const corner = (x, y) => ({x, y, w: 0.08, h: 0.08});

test('the eyedropper, Auto WB, Auto tone and the draggable split drive real pixels', {timeout: 420000}, async t => {
  if (!available) {
    t.skip('Playwright and/or a Chromium build are not available in this environment');
    return;
  }
  const server = await startStaticServer();
  const browser = await playwright.chromium.launch({executablePath: chromiumPath, args: CHROMIUM_ARGS, env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS}});
  try {
    const {context, page, errors} = await openApp(browser);
    await loadPhoto(page, await fixture(page, 1));
    await page.evaluate(CANVAS_HELPERS);
    await page.evaluate(() => { document.getElementById('gradeTab').click(); for (const section of document.querySelectorAll('#colorGradePanel details')) section.open = true; });
    await page.waitForTimeout(600);

    const readSliders = () => page.evaluate(() => ({
      temperature: Number(document.getElementById('sliderGradeTemperature').value),
      tint: Number(document.getElementById('sliderGradeTint').value),
      exposure: Number(document.getElementById('sliderGradeExposure').value),
      contrast: Number(document.getElementById('sliderGradeContrast').value),
      highlights: Number(document.getElementById('sliderGradeHighlights').value),
      shadows: Number(document.getElementById('sliderGradeShadows').value),
      whites: Number(document.getElementById('sliderGradeWhites').value),
      blacks: Number(document.getElementById('sliderGradeBlacks').value),
    }));
    const neutral = await page.evaluate(() => window.__grab());
    // The two bands the split test reads, captured from the untouched photo.
    const baselineBands = await page.evaluate(({left, right}) => ({left: window.__region(left), right: window.__region(right)}), {left: LEFT_BAND, right: RIGHT_BAND});
    const before = await readSliders();
    assert.equal(before.temperature, 0, 'the photo must open with a neutral Grade panel');
    const cardBefore = await page.evaluate(region => window.__region(region), GREY_CARD);

    // --- 1. White balance eyedropper -------------------------------------------------------
    await page.click('#wbEyedropperBtn');
    assert.equal(await page.getAttribute('#wbEyedropperBtn', 'aria-pressed'), 'true');
    assert.match(await page.textContent('#wbStatus'), /Click a neutral/);
    const box = await page.locator('#glCanvas').boundingBox();
    await page.mouse.click(box.x + (GREY_CARD.x + GREY_CARD.w / 2) * box.width, box.y + (GREY_CARD.y + GREY_CARD.h / 2) * box.height);
    await page.waitForFunction(() => Number(document.getElementById('sliderGradeTemperature').value) !== 0, null, {timeout: 8000});
    await page.waitForTimeout(900);
    const picked = await readSliders();
    assert.ok(picked.temperature > 10, `the blue-grey card must warm the photo (saw ${picked.temperature})`);
    assert.match(await page.textContent('#wbStatus'), /White balance set from a neutral point/);
    assert.equal(await page.getAttribute('#wbEyedropperBtn', 'aria-pressed'), 'false', 'picking ends after one click');
    const cardAfter = await page.evaluate(region => window.__region(region), GREY_CARD);
    const neutralBefore = Math.abs(cardBefore.r - cardBefore.b);
    const neutralAfter = Math.abs(cardAfter.r - cardAfter.b);
    assert.ok(neutralAfter < neutralBefore * 0.4, `the picked card must become neutral (|R-B| ${neutralBefore.toFixed(1)} → ${neutralAfter.toFixed(1)})`);
    assert.ok(await page.evaluate(before => window.__difference(before), neutral) > 1, 'the eyedropper must change the rendered pixels');

    // --- 2. Auto WB on the whole frame ------------------------------------------------------
    await page.evaluate(() => {
      const temperature = document.getElementById('sliderGradeTemperature');
      [temperature, document.getElementById('sliderGradeTint')].forEach(slider => {
        slider.value = '0';
        slider.dispatchEvent(new Event('input', {bubbles: true}));
        slider.dispatchEvent(new Event('change', {bubbles: true}));
      });
    });
    await page.waitForTimeout(600);
    await page.click('#wbAutoBtn');
    await page.waitForFunction(() => Number(document.getElementById('sliderGradeTemperature').value) !== 0, null, {timeout: 8000});
    await page.waitForTimeout(800);
    const autoWb = await readSliders();
    assert.ok(autoWb.temperature > 3 && autoWb.temperature <= 100, `Auto WB must warm this cast (saw ${autoWb.temperature})`);
    assert.match(await page.textContent('#wbStatus'), /Auto white balance/);

    // --- 3. Auto tone writes the six tone sliders -------------------------------------------
    await page.click('#gradeAutoBtn');
    await page.waitForTimeout(1200);
    const toned = await readSliders();
    for (const key of ['contrast', 'highlights', 'shadows', 'whites', 'blacks']) {
      assert.notEqual(toned[key], 0, `Auto tone must set ${key}`);
    }
    assert.notEqual(toned.exposure, 0, 'Auto tone must set exposure');
    assert.ok(Math.abs(toned.exposure) <= 1.5 && Math.abs(toned.contrast) <= 35, 'Auto tone stays inside the calibrated ranges');

    // --- 4. Draggable before / after split --------------------------------------------------
    await page.evaluate(() => {
      const temperature = document.getElementById('sliderGradeTemperature');
      temperature.value = '85';
      temperature.dispatchEvent(new Event('input', {bubbles: true}));
      temperature.dispatchEvent(new Event('change', {bubbles: true}));
    });
    await page.waitForTimeout(900);
    await page.click('#splitToggleBtn');
    await page.waitForFunction(() => !document.getElementById('splitDivider').hidden, null, {timeout: 5000});
    const offCentre = await page.evaluate(() => {
      const divider = document.getElementById('splitDivider');
      const wrap = document.getElementById('canvasWrap').getBoundingClientRect();
      const box = divider.getBoundingClientRect();
      return {left: box.left - wrap.left, width: wrap.width, value: Number(divider.getAttribute('aria-valuenow'))};
    });
    assert.ok(Math.abs(offCentre.value - 50) <= 2, `the split starts centred (saw ${offCentre.value})`);
    const splitBox = await page.locator('#splitDivider').boundingBox();
    await page.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y + splitBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(splitBox.x + splitBox.width / 2 - 200, splitBox.y + splitBox.height / 2, {steps: 8});
    await page.mouse.up();
    await page.waitForTimeout(500);
    const dragged = await page.evaluate(() => ({
      value: Number(document.getElementById('splitDivider').getAttribute('aria-valuenow')),
      left: document.getElementById('splitDivider').getBoundingClientRect().left - document.getElementById('canvasWrap').getBoundingClientRect().left,
    }));
    assert.ok(dragged.value < 45 && dragged.value > 20, `dragging left must move the boundary (saw ${dragged.value})`);
    const bands = await page.evaluate(({left, right}) => ({left: window.__region(left), right: window.__region(right)}), {left: LEFT_BAND, right: RIGHT_BAND});
    // Lightroom's convention: the left of the divider is the untouched photo, the right is the
    // edit. Both bands are measured against their own imported value, so this cannot pass by
    // accident when one half happens to be brighter than the other.
    const closeTo = (now, was, tolerance) => Math.abs(now.r - was.r) <= tolerance && Math.abs(now.g - was.g) <= tolerance && Math.abs(now.b - was.b) <= tolerance;
    assert.ok(closeTo(bands.left, baselineBands.left, 3), `the half left of the divider must stay untouched (${JSON.stringify(bands.left)} vs ${JSON.stringify(baselineBands.left)})`);
    assert.ok(!closeTo(bands.right, baselineBands.right, 6), `the half right of the divider must show the edit (${JSON.stringify(bands.right)} vs ${JSON.stringify(baselineBands.right)})`);
    assert.ok(bands.right.r - bands.right.b > baselineBands.right.r - baselineBands.right.b + 12,
      `the edited half must be the warm version (R-B ${(bands.right.r - bands.right.b).toFixed(1)} vs ${(baselineBands.right.r - baselineBands.right.b).toFixed(1)})`);
    // The existing hold-to-compare still works next to it.
    await page.mouse.move(10, 10);
    const holdBox = await page.locator('#holdCompareBtn').boundingBox();
    await page.mouse.move(holdBox.x + holdBox.width / 2, holdBox.y + holdBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(400);
    const holding = await page.evaluate(() => ({
      label: document.getElementById('beforeLabel').classList.contains('show'),
      divider: document.getElementById('splitDivider').hidden,
    }));
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.equal(holding.label, true, 'hold-to-compare must still reveal the original');
    assert.equal(holding.divider, true, 'the split divider hides while the original is held');
    await page.click('#splitToggleBtn');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.getElementById('splitDivider').hidden), true, 'the split toggle turns the divider off again');
    assert.deepEqual(errors, [], `no console errors on the video path (${errors.join(' | ')})`);
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});

test('crop presets, straighten, snapshots and the history list work together', {timeout: 420000}, async t => {
  if (!available) {
    t.skip('Playwright and/or a Chromium build are not available in this environment');
    return;
  }
  const server = await startStaticServer();
  const browser = await playwright.chromium.launch({executablePath: chromiumPath, args: CHROMIUM_ARGS, env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS}});
  try {
    const {context, page, errors} = await openApp(browser);
    await loadPhoto(page, await fixture(page, 1));
    await page.evaluate(CANVAS_HELPERS);
    const neutral = await page.evaluate(() => window.__grab());

    // --- 1. Crop aspect-ratio presets -------------------------------------------------------
    await page.evaluate(() => { document.getElementById('exportTab').click(); document.getElementById('cropPanelBody').hidden = false; });
    await page.waitForTimeout(400);
    const frameRect = () => page.evaluate(() => {
      const box = document.getElementById('cropFrame').getBoundingClientRect();
      return {width: box.width, height: box.height, hidden: document.getElementById('cropOverlay').hidden};
    });
    for (const [id, format, text] of [
      ['cropRatio1x1', 'square', '1:1'], ['cropRatio4x5', 'portrait', '4:5'],
      ['cropRatio16x9', 'wide', '16:9'], ['cropRatio3x2', 'threeTwo', '3:2'],
      ['cropRatio9x16', 'story', '9:16'], ['cropRatioOriginal', 'original', null],
    ]) {
      await page.click(`#${id}`);
      await page.waitForTimeout(400);
      for (const pill of await page.$$('.cropRatioBtn')) {
        const pressed = await pill.getAttribute('aria-pressed');
        const pillFormat = await pill.getAttribute('data-format');
        assert.equal(pressed, String(pillFormat === format), `${id} must be the only pressed ratio pill`);
      }
      const size = social.FORMATS[format];
      const dimensions = await page.textContent('#outputDimensions');
      if (!text) {
        // Original keeps the imported 640x480 frame and hides the crop frame entirely.
        assert.equal(dimensions, '640 × 480', `Original must keep the imported size (saw "${dimensions}")`);
        assert.equal((await frameRect()).hidden, true, 'the crop frame hides in Original');
        continue;
      }
      assert.equal(dimensions, `${size.width} × ${size.height}`, `${text} must report the ${format} export size`);
      const frame = await frameRect();
      assert.equal(frame.hidden, false, `${text} must show the crop frame`);
      const expected = {'1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9, '3:2': 3 / 2, '9:16': 9 / 16}[text];
      assert.ok(Math.abs(frame.width / frame.height - expected) / expected < 0.03,
        `${text} must frame the photo at ${expected.toFixed(3)} (saw ${(frame.width / frame.height).toFixed(3)})`);
      assert.equal(Math.abs(social.cropRatio({format}) - expected) < 1e-9, true, `${text} must be the ${format} ratio`);
    }

    // --- 2. Straighten ---------------------------------------------------------------------
    await page.click('#cropRatio3x2');
    await page.waitForTimeout(300);
    const straightBefore = await page.evaluate(() => window.__grab());
    await page.evaluate(() => {
      const slider = document.getElementById('sliderStraighten');
      slider.value = '12';
      slider.dispatchEvent(new Event('input', {bubbles: true}));
      slider.dispatchEvent(new Event('change', {bubbles: true}));
    });
    await page.waitForTimeout(2200);
    const straightened = await page.evaluate((before) => {
      const corners = [window.__region({x: 0, y: 0, w: 0.06, h: 0.06}), window.__region({x: 0.94, y: 0, w: 0.06, h: 0.06}),
        window.__region({x: 0, y: 0.94, w: 0.06, h: 0.06}), window.__region({x: 0.94, y: 0.94, w: 0.06, h: 0.06})];
      return {difference: window.__difference(before), corners};
    }, straightBefore);
    assert.equal(await page.inputValue('#sliderStraighten'), '12');
    assert.equal((await page.textContent('#valStraighten')).trim(), '+12');
    assert.ok(straightened.difference > 6, `straighten must move pixels (saw ${straightened.difference.toFixed(2)})`);
    for (const [index, cornerStats] of straightened.corners.entries()) {
      const luma = (cornerStats.r + cornerStats.g + cornerStats.b) / 3;
      assert.ok(luma > 40, `straighten must fill the frame, corner ${index + 1} went dark (luma ${luma.toFixed(1)})`);
    }
    await page.click('#straightenResetBtn');
    await page.waitForTimeout(1500);
    assert.equal(await page.inputValue('#sliderStraighten'), '0');

    // --- 3. Snapshots and the history list --------------------------------------------------
    const historyBefore = await page.evaluate(() => [...document.querySelectorAll('#historyList .historyItem')].map(item => item.textContent));
    assert.ok(historyBefore.some(label => /Opened /.test(label)), `the photo opening must be the first history step (saw ${historyBefore.join(' | ')})`);
    await page.evaluate(() => {
      document.getElementById('looksTab').click();
      const slider = document.getElementById('sliderExposure');
      slider.value = '-60';
      slider.dispatchEvent(new Event('input', {bubbles: true}));
      slider.dispatchEvent(new Event('change', {bubbles: true}));
    });
    await page.waitForTimeout(700);
    page.once('dialog', dialog => dialog.accept('Snapshot A'));
    await page.click('#addSnapshotBtn');
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#snapshotChips .chip').length), 1, 'the snapshot chip appears');
    await page.evaluate(() => {
      const slider = document.getElementById('sliderExposure');
      slider.value = '70';
      slider.dispatchEvent(new Event('input', {bubbles: true}));
      slider.dispatchEvent(new Event('change', {bubbles: true}));
    });
    await page.waitForTimeout(700);
    assert.equal(await page.inputValue('#sliderExposure'), '70');
    await page.click('#snapshotChips .chip');
    await page.waitForTimeout(900);
    assert.equal(await page.inputValue('#sliderExposure'), '-60', 'applying the snapshot restores every setting');
    const historyAfter = await page.evaluate(() => [...document.querySelectorAll('#historyList .historyItem')].map(item => item.textContent));
    assert.ok(historyAfter.length > historyBefore.length, `history must grow with each edit (${historyBefore.length} → ${historyAfter.length})`);
    assert.ok(historyAfter.some(label => /Snapshot/.test(label)), `history lists the snapshot apply (saw ${historyAfter.join(' | ')})`);
    // Clicking an older step returns to that state.
    const neutralIndex = historyAfter.findIndex(label => /Opened /.test(label));
    await page.locator('#historyList .historyItem').nth(neutralIndex).click();
    await page.waitForTimeout(900);
    assert.equal(await page.inputValue('#sliderExposure'), '0', 'clicking the first history step returns to the untouched photo');
    assert.ok(await page.evaluate(before => window.__difference(before), neutral) < 3, 'and the canvas is back to the imported pixels');
    // Snapshots survive a reload on this browser.
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('presetSelect')?.options.length > 1, null, {timeout: 30000});
    assert.equal(await page.evaluate(() => document.querySelectorAll('#snapshotChips .chip').length), 1, 'snapshots are stored on the device');
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});

test('a 390px phone viewport keeps every new control reachable and syncs edits between carousel photos', {timeout: 420000}, async t => {
  if (!available) {
    t.skip('Playwright and/or a Chromium build are not available in this environment');
    return;
  }
  const server = await startStaticServer();
  const browser = await playwright.chromium.launch({executablePath: chromiumPath, args: CHROMIUM_ARGS, env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS}});
  try {
    const {context, page, errors} = await openApp(browser, {viewport: {width: 390, height: 844}, touch: true});
    const first = await fixture(page, 1);
    const second = await fixture(page, 2);
    await page.setInputFiles('#photoPickerInput', [first, second]);
    await page.waitForFunction(() => document.body.dataset.mode === 'photo' && document.querySelectorAll('#photoThumbnails .photoThumb').length === 2, null, {timeout: 60000});
    await page.waitForTimeout(1800);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).width !== '0px'), true);

    // Mobile reachability: the tabs open the sheet, and the new controls are at least 44px tall.
    const measure = ids => page.evaluate(list => {
      const out = {};
      for (const id of list) {
        const node = document.getElementById(id);
        const rect = node ? node.getBoundingClientRect() : null;
        out[id] = rect && {w: Math.round(rect.width), h: Math.round(rect.height), visible: rect.width > 0 && rect.height > 0};
      }
      return out;
    }, ids);
    const sizesOn = async tab => {
      await page.click(`#${tab}`);
      await page.waitForTimeout(700);
      return measure(['cropRatio16x9', 'sliderStraighten', 'straightenResetBtn', 'addSnapshotBtn', 'clearHistoryBtn', 'wbEyedropperBtn', 'splitToggleBtn', 'selectPhotosBtn', 'syncSelectedBtn']);
    };
    const exportSizes = await sizesOn('exportTab');
    const looksSizes = await sizesOn('looksTab');
    const gradeSizes = await sizesOn('gradeTab');
    const sizes = {...exportSizes, ...looksSizes, ...gradeSizes};
    // The export-tab controls, the snapshot / history controls and the white-balance tools each
    // have to be laid out, visible and reachable on the phone; the carousel buttons are always on
    // screen because the strip sits outside the sheet.
    for (const name of ['cropRatio16x9', 'sliderStraighten', 'straightenResetBtn']) {
      assert.ok(exportSizes[name].visible && exportSizes[name].h >= 30, `${name} must be laid out on the export tab (${JSON.stringify(exportSizes[name])})`);
    }
    assert.ok(looksSizes.addSnapshotBtn.visible && looksSizes.addSnapshotBtn.h >= 44, `the snapshot button must be laid out (${JSON.stringify(looksSizes.addSnapshotBtn)})`);
    for (const name of ['wbEyedropperBtn', 'splitToggleBtn']) {
      assert.ok(gradeSizes[name].visible && gradeSizes[name].h >= 30, `${name} must be laid out on the grade tab (${JSON.stringify(gradeSizes[name])})`);
    }
    assert.ok(exportSizes.cropRatio16x9.h >= 44 && exportSizes.straightenResetBtn.h >= 44 && looksSizes.addSnapshotBtn.h >= 44
      && gradeSizes.wbEyedropperBtn.h >= 44 && gradeSizes.splitToggleBtn.h >= 44,
      `touch targets must reach 44px (${JSON.stringify(sizes)})`);
    // The carousel strip is space constrained on a phone, so its buttons keep the house style —
    // a slightly shorter visual button with an invisible 44px hit area. Prove both halves of that:
    // the hit box is 44px, and a tap just outside the visible edge still presses the button.
    const hitAreas = await page.evaluate(() => {
      const out = {};
      for (const id of ['selectPhotosBtn', 'syncSelectedBtn']) {
        const style = getComputedStyle(document.getElementById(id), '::before');
        out[id] = {width: parseFloat(style.width) || 0, height: parseFloat(style.height) || 0};
      }
      return out;
    });
    assert.ok(sizes.selectPhotosBtn.h >= 30 && sizes.syncSelectedBtn.h >= 30, `the strip buttons stay visible (${JSON.stringify(sizes)})`);
    assert.ok(hitAreas.selectPhotosBtn.height >= 44 && hitAreas.syncSelectedBtn.height >= 44,
      `the strip buttons need a 44px touch target (${JSON.stringify(hitAreas)})`);
    const selectBox = await page.locator('#selectPhotosBtn').boundingBox();
    await page.touchscreen.tap(selectBox.x + selectBox.width / 2, selectBox.y - 3);
    await page.waitForTimeout(400);
    assert.equal(await page.getAttribute('#selectPhotosBtn', 'aria-pressed'), 'true', 'a tap just above the visible edge still presses Select');
    // The label changes while select mode is on, so re-read the button before the second tap.
    const selectingBox = await page.locator('#selectPhotosBtn').boundingBox();
    await page.touchscreen.tap(selectingBox.x + selectingBox.width / 2, selectingBox.y - 3);
    await page.waitForTimeout(400);
    assert.equal(await page.getAttribute('#selectPhotosBtn', 'aria-pressed'), 'false', 'and it toggles back off');
    await page.click('#exportTab');
    await page.waitForTimeout(500);
    await page.click('#cropRatio4x5');
    await page.waitForTimeout(400);
    assert.equal(await page.getAttribute('.cropRatioBtn[data-format="portrait"]', 'aria-pressed'), 'true');
    assert.equal(await page.getAttribute('.formatBtn[data-format="portrait"]', 'aria-pressed'), 'true',
      'the ratio pill presses the matching legacy format button');
    assert.equal(await page.textContent('#outputDimensions'), '1080 × 1350');

    // The grade tools are reachable on the phone too.
    await page.click('#gradeTab');
    await page.waitForTimeout(600);
    assert.ok(await page.locator('#wbEyedropperBtn').isVisible(), 'the eyedropper is visible on the phone');
    assert.ok(await page.locator('#splitToggleBtn').isVisible(), 'the split toggle is visible on the phone');
    await page.click('#splitToggleBtn');
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.getElementById('splitDivider').hidden), false, 'the draggable divider shows on the phone');
    const dividerWidth = await page.evaluate(() => {
      const divider = document.getElementById('splitDivider');
      const style = getComputedStyle(divider, '::before');
      return {hit: parseInt(style.width, 10), visible: divider.getBoundingClientRect().width};
    });
    assert.ok(dividerWidth.hit >= 44, `the divider needs a 44px grab area on touch (saw ${dividerWidth.hit})`);
    assert.equal(dividerWidth.visible, 2, 'the divider itself stays a hairline');
    // Dragging it works at 390px too (the drag maths uses the canvas, not the window).
    const phoneDivider = await page.locator('#splitDivider').boundingBox();
    await page.mouse.move(phoneDivider.x + phoneDivider.width / 2, phoneDivider.y + phoneDivider.height / 2);
    await page.mouse.down();
    await page.mouse.move(phoneDivider.x - 60, phoneDivider.y + phoneDivider.height / 2, {steps: 6});
    await page.mouse.up();
    await page.waitForTimeout(400);
    const phoneSplit = await page.evaluate(() => Number(document.getElementById('splitDivider').getAttribute('aria-valuenow')));
    assert.ok(phoneSplit < 45 && phoneSplit >= 8, `the phone drag must move the split (saw ${phoneSplit})`);
    await page.click('#splitToggleBtn');

    // --- carousel copy / paste / sync -------------------------------------------------------
    const exposure = value => page.evaluate(next => {
      const slider = document.getElementById('sliderExposure');
      slider.value = String(next);
      slider.dispatchEvent(new Event('input', {bubbles: true}));
      slider.dispatchEvent(new Event('change', {bubbles: true}));
    }, value);
    assert.equal(await page.evaluate(() => document.getElementById('carouselCount').textContent), 'Carousel / 01 of 02');
    await page.evaluate(() => document.getElementById('adjustTab').click());
    await page.waitForTimeout(400);
    await exposure(60);
    await page.waitForTimeout(600);
    // Copy this photo's settings, then hand them to the second photo.
    await page.evaluate(() => document.getElementById('looksTab').click());
    await page.waitForTimeout(400);
    // The copy / paste pair lives in the collapsible "Copy / paste & share" panel.
    await page.click('#settingsToolsToggle');
    await page.waitForTimeout(400);
    assert.equal(await page.getAttribute('#settingsToolsToggle', 'aria-expanded'), 'true');
    await page.click('#copyPhotoSettingsBtn');
    await page.waitForTimeout(400);
    assert.match(await page.textContent('#settingsStatus'), /Copied every setting of photo 1/);
    await page.evaluate(() => document.querySelectorAll('#photoThumbnails .photoThumb')[1].click());
    await page.waitForFunction(() => document.getElementById('carouselCount').textContent.includes('02 of 02'), null, {timeout: 30000});
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.getElementById('adjustTab').click());
    await page.waitForTimeout(300);
    await exposure(-50);
    await page.waitForTimeout(500);
    await page.evaluate(() => document.getElementById('looksTab').click());
    await page.waitForTimeout(400);
    await page.click('#copyToPhotoBtn');
    await page.waitForTimeout(1200);
    assert.equal(await page.inputValue('#sliderExposure'), '60', 'paste gives the open photo the copied settings');
    assert.match(await page.textContent('#settingsStatus'), /Settings pasted onto photo 2/);
    // Photo 1 keeps the shared edit; photo 2 now owns its payload.
    await page.evaluate(() => document.querySelectorAll('#photoThumbnails .photoThumb')[0].click());
    await page.waitForFunction(() => document.getElementById('carouselCount').textContent.includes('01 of 02'), null, {timeout: 30000});
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.getElementById('adjustTab').click());
    await page.waitForTimeout(300);
    await exposure(-20);
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelectorAll('#photoThumbnails .photoThumb')[1].click());
    await page.waitForFunction(() => document.getElementById('carouselCount').textContent.includes('02 of 02'), null, {timeout: 30000});
    await page.waitForTimeout(1400);
    assert.equal(await page.inputValue('#sliderExposure'), '60', 'the second photo restores its own pasted settings instead of the shared edit');
    // Select + sync from the first photo onto the second.
    await page.evaluate(() => document.querySelectorAll('#photoThumbnails .photoThumb')[0].click());
    await page.waitForFunction(() => document.getElementById('carouselCount').textContent.includes('01 of 02'), null, {timeout: 30000});
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.getElementById('adjustTab').click());
    await page.waitForTimeout(300);
    await exposure(85);
    await page.waitForTimeout(600);
    await page.click('#selectPhotosBtn');
    await page.waitForTimeout(300);
    assert.equal(await page.getAttribute('#selectPhotosBtn', 'aria-pressed'), 'true');
    await page.evaluate(() => document.querySelectorAll('#photoThumbnails .photoThumb')[1].click());
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#photoThumbnails .photoThumb')[1].dataset.selected), 'true', 'select mode marks the tapped thumbnail');
    assert.equal(await page.evaluate(() => document.getElementById('carouselCount').textContent), 'Carousel / 01 of 02', 'select mode does not switch photos');
    assert.match(await page.textContent('#syncSelectedBtn'), /Sync selected \(1\)/);
    await page.click('#syncSelectedBtn');
    await page.waitForTimeout(700);
    assert.match(await page.textContent('#toast'), /Synced onto 1 photo|onto 1 photo/);
    await page.click('#selectPhotosBtn');
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelectorAll('#photoThumbnails .photoThumb')[1].click());
    await page.waitForFunction(() => document.getElementById('carouselCount').textContent.includes('02 of 02'), null, {timeout: 30000});
    await page.waitForTimeout(1400);
    assert.equal(await page.inputValue('#sliderExposure'), '85', 'Sync selected copies the edit onto the selected photo');
    // Apply to all still works and now records real per-photo payloads.
    await page.evaluate(() => document.getElementById('adjustTab').click());
    await page.waitForTimeout(300);
    await exposure(15);
    await page.waitForTimeout(500);
    await page.click('#applyAllBtn');
    await page.waitForTimeout(700);
    await page.evaluate(() => document.querySelectorAll('#photoThumbnails .photoThumb')[0].click());
    await page.waitForFunction(() => document.getElementById('carouselCount').textContent.includes('01 of 02'), null, {timeout: 30000});
    await page.waitForTimeout(1400);
    await page.evaluate(() => document.getElementById('adjustTab').click());
    await page.waitForTimeout(300);
    assert.equal(await page.inputValue('#sliderExposure'), '15', 'Apply to all reaches every carousel photo');
    const filtered = errors.filter(message => !/ERR_CONNECTION_CLOSED|Failed to load resource/.test(message));
    assert.deepEqual(filtered, [], `no console errors on the phone layout (${filtered.join(' | ')})`);
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});
