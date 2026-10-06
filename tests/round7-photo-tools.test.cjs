/* Round-7 photo tools: spot heal, perspective & geometry, lens blur (depth of field), the
 * grain / bloom / halation film-look sliders and the export presets.
 *
 * The helper maths is checked in plain Node, and the pixels are checked in a real Chromium
 * through Playwright, exactly like tests/lightroom-tools.test.cjs does: a fixture with a known
 * blemish is uploaded, the controls are driven the way a person would, and the canvas is read
 * back to prove that heal, keystone, mirror and lens blur really move pixels instead of only
 * changing preview styling. The export presets are proved with a real download.
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
const PORT = Number(process.env.FILM_LAB_ROUND7_PORT || 8976);
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
const CHROMIUM_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const social = require('../social-tools.js');
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

async function openApp(browser, {viewport = {width: 1440, height: 900}, touch = false} = {}) {
  const context = await browser.newContext({viewport, hasTouch: touch, isMobile: false, serviceWorkers: 'block'});
  await context.route('**/sw.js', route => route.abort());
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
  await context.route('https://fonts.gstatic.com/**', route => route.fulfill({body: '', contentType: 'font/woff2'}));
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 220)); });
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => document.getElementById('presetSelect')?.options.length > 1, null, {timeout: 30000});
  return {context, page, errors};
}

// A 640x480 fixture: pale base, a 4px checkerboard (so blur is measurable), a dark blemish disc.
const FIXTURE = `async () => {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f2efe6'; ctx.fillRect(0, 0, 640, 480);
  ctx.fillStyle = '#b9b0a0';
  for (let y = 0; y < 480; y += 4) for (let x = 0; x < 640; x += 4) if (((x / 4) + (y / 4)) % 2 === 0) ctx.fillRect(x, y, 2, 2);
  ctx.fillStyle = '#2a2018'; ctx.beginPath(); ctx.arc(120, 240, 10, 0, Math.PI * 2); ctx.fill();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const buffer = await blob.arrayBuffer(); let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}`;

// Reads the live WebGL canvas through a 2D scratch canvas, so the numbers are real rendered pixels.
const CANVAS_HELPERS = () => {
  const canvas = document.getElementById('glCanvas');
  const scratch = document.createElement('canvas');
  scratch.width = canvas.width; scratch.height = canvas.height;
  const ctx = scratch.getContext('2d', {willReadFrequently: true});
  window.__grab = () => { ctx.clearRect(0, 0, scratch.width, scratch.height); ctx.drawImage(canvas, 0, 0); return ctx.getImageData(0, 0, scratch.width, scratch.height); };
  window.__px = (x, y) => { const data = window.__grab().data, i = ((y | 0) * scratch.width + (x | 0)) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  window.__mean = (x, y, w, h) => {
    const data = window.__grab().data; let total = 0, count = 0;
    for (let row = y; row < y + h; row++) for (let column = x; column < x + w; column++) {
      const i = (row * scratch.width + column) * 4; total += data[i] + data[i + 1] + data[i + 2]; count += 3;
    }
    return +(total / Math.max(1, count)).toFixed(1);
  };
  // Local contrast: neighbours two pixels apart, so a 4px checkerboard scores high and a blurred
  // background scores low while a flat area stays near zero either way.
  window.__detail = (x, y, w, h) => {
    const data = window.__grab().data; let total = 0, count = 0;
    for (let row = y; row < y + h; row++) for (let column = x; column < x + w - 2; column++) {
      const i = (row * scratch.width + column) * 4, j = i + 8;
      total += Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]); count += 2;
    }
    return +(total / Math.max(1, count)).toFixed(2);
  };
};

/* ---------------------------------------------------------------- helper maths */
test('spot heal strokes clamp to sane dabs and sample a patch from inside the photo', () => {
  const strokes = social.normalizeHealStrokes([{x: 0.5, y: 0.5, r: 0.02}, {x: -3, y: 2, r: 9}, {x: NaN, y: 0.2, r: 0.1}, null, {x: 0.1, y: 0.1, r: 0.001}]);
  assert.ok(strokes.length >= 2 && strokes.length <= 3, 'unusable dabs are dropped');
  for (const dab of strokes) {
    assert.ok(dab.x >= 0 && dab.x <= 1 && dab.y >= 0 && dab.y <= 1, 'dabs stay inside the photo');
    assert.ok(dab.r >= 0.004 && dab.r <= 0.3, `dab radius must stay inside the supported range (saw ${dab.r})`);
  }
  // Donor samples are unit directions; the patch offsets are pixel distances outside the dab, so a
  // fill always reaches healthy pixels next to the blemish instead of a flat average.
  const ring = social.healRingSamples(12);
  assert.equal(ring.length, 12);
  for (const direction of ring) assert.ok(Math.abs(Math.hypot(direction.x, direction.y) - 1) < 1e-9, 'donor directions are unit length');
  const radiusPixels = 9;
  const offsets = social.healPatchOffsets(radiusPixels, 4);
  assert.ok(offsets.length >= 12, 'patch candidates exist');
  for (const offset of offsets) {
    const distance = Math.hypot(offset.x, offset.y);
    assert.ok(distance >= radiusPixels * 1.3 && distance <= radiusPixels * 3.3, `patch taps sit just outside the dab (saw ${distance.toFixed(1)}px)`);
  }
  // The stored list is bounded, so a long painting session cannot grow a settings payload forever.
  const many = social.normalizeHealStrokes(Array.from({length: 900}, (_, index) => ({x: (index % 50) / 50, y: 0.5, r: 0.03})));
  assert.ok(many.length <= 400, `the heal list is capped (saw ${many.length})`);
});

test('lens blur strength maps to a real pixel radius from the neutral default', () => {
  assert.deepEqual(social.normalizeLensBlur({}), {strength: 0, feather: 30});
  assert.deepEqual(social.normalizeLensBlur({strength: '70', feather: -5}), {strength: 70, feather: 0});
  assert.deepEqual(social.normalizeLensBlur({strength: 400, feather: 400}), {strength: 100, feather: 100});
  assert.equal(social.lensBlurRadius(0, 640, 480), 0);
  const half = social.lensBlurRadius(50, 640, 480), full = social.lensBlurRadius(100, 640, 480);
  assert.ok(full > half && half > 0, 'the radius grows with strength');
  assert.ok(full >= 8, `100% must be a visible blur on a 640px preview (saw ${full}px)`);
  assert.ok(social.lensBlurRadius(100, 4000, 3000) >= full, 'a bigger photo keeps at least the same radius');
  assert.ok(styles.includes('.healCursor') || styles.includes('#healBrushCursor'), 'the heal brush paints a visible cursor');
});

test('keystone geometry round-trips and matches the overlay matrix used by the canvases', () => {
  const {keystoneMapPoint, keystoneInversePoint, flipPoint, geometryOverlayMatrix, geometryIsNeutral, normalizeGeometry, keystoneFillScale, KEYSTONE_LIMIT} = social;
  for (const [x, y] of [[0, 0], [1, 1], [0.5, 0.5], [0.2, 0.87], [0.05, 0.4]]) {
    for (const [v, h] of [[0, 0], [100, 0], [0, 100], [-100, -60], [37, -82]]) {
      const mapped = keystoneMapPoint(v, h, x, y);
      const back = keystoneInversePoint(v, h, mapped.x, mapped.y);
      assert.ok(Math.abs(back.x - x) < 1e-9 && Math.abs(back.y - y) < 1e-9, `round trip at v${v}/h${h}: ${JSON.stringify(back)}`);
    }
  }
  assert.deepEqual(normalizeGeometry({}), {flipH: false, flipV: false, keystoneV: 0, keystoneH: 0});
  assert.equal(geometryIsNeutral(normalizeGeometry({})), true);
  assert.equal(geometryIsNeutral(normalizeGeometry({keystoneV: 3})), false);
  assert.ok(Math.abs(keystoneFillScale(100, 0) - 0.78) < 1e-9);
  assert.ok(Math.abs(keystoneFillScale(100, 100) - 0.56) < 1e-9);
  assert.ok(Math.abs(KEYSTONE_LIMIT - 0.22) < 1e-9);
  assert.deepEqual(flipPoint(0.25, 0.8, true, false), {x: 0.75, y: 0.8});
  assert.ok(Math.abs(flipPoint(0.25, 0.8, false, true).y - 0.2) < 1e-9);
  // The overlay canvases ride on geometryOverlayMatrix. On an unflipped frame it must land a pixel
  // exactly where the shader maths does — that is what keeps the mask, the heal brush and the
  // histogram aligned with the warped preview.
  for (const geometry of [normalizeGeometry({keystoneV: 100}), normalizeGeometry({keystoneH: -80}), normalizeGeometry({keystoneV: -40, keystoneH: 65}), normalizeGeometry({})]) {
    const width = 640, height = 480, matrix = geometryOverlayMatrix(geometry, width, height);
    for (const [x, y] of [[0, 0], [640, 0], [0, 480], [640, 480], [213, 91]]) {
      const denominator = matrix[3] * x + matrix[7] * y + matrix[15];
      const mapped = {
        x: (matrix[0] * x + matrix[4] * y + matrix[12]) / denominator,
        y: (matrix[1] * x + matrix[5] * y + matrix[13]) / denominator,
      };
      const reference = keystoneMapPoint(geometry.keystoneV, geometry.keystoneH, x / width, y / height);
      assert.ok(Math.abs(mapped.x - reference.x * width) < 1e-6, `overlay x agrees with the shader at ${x},${y}`);
      assert.ok(Math.abs(mapped.y - reference.y * height) < 1e-6, `overlay y agrees with the shader at ${x},${y}`);
    }
    // Corners of the frame stay inside the frame: keystone never samples outside the photo.
    for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const mapped = keystoneMapPoint(geometry.keystoneV, geometry.keystoneH, x, y);
      assert.ok(mapped.x > -0.02 && mapped.x < 1.02 && mapped.y > -0.02 && mapped.y < 1.02, 'warped corners stay within the frame');
    }
  }
});

test('export presets cover Instagram 4:5, story 9:16 and full quality with JPEG / WebP / PNG', () => {
  assert.deepEqual(social.EXPORT_TYPES, ['jpeg', 'png', 'webp']);
  const instagram = social.exportPreset('instagram'), story = social.exportPreset('story'), full = social.exportPreset('full');
  assert.ok(instagram && story && full, 'the three presets exist');
  assert.deepEqual([instagram.format, instagram.type, instagram.quality], ['portrait', 'jpeg', 92]);
  assert.deepEqual([story.format, story.type, story.quality], ['story', 'jpeg', 92]);
  assert.deepEqual([full.format, full.type, full.quality], ['original', 'jpeg', 100]);
  assert.deepEqual(social.outputSize({format: 'portrait'}, 4000, 3000), {width: 1080, height: 1350});
  assert.deepEqual(social.outputSize({format: 'story'}, 4000, 3000), {width: 1080, height: 1920});
  assert.equal(social.exportMimeType('webp'), 'image/webp');
  assert.equal(social.exportMimeType('png'), 'image/png');
  assert.equal(social.exportExtension('webp'), 'webp');
  assert.equal(social.exportQualityApplies('webp'), true);
  assert.equal(social.exportQualityApplies('png'), false);
  // A browser that silently re-encodes WebP as JPEG must be reported as JPEG, not mislabelled.
  assert.deepEqual(social.exportFormatFor('webp', {type: 'image/jpeg'}), {type: 'jpeg', extension: 'jpg', label: 'JPG', qualityApplies: true});
  assert.deepEqual(social.exportFormatFor('png', null), {type: 'png', extension: 'png', label: 'PNG', qualityApplies: false});
  assert.deepEqual(social.exportFormatFor('webp', {type: 'image/webp'}), {type: 'webp', extension: 'webp', label: 'WebP', qualityApplies: true});
  for (const id of ['exportPresetInstagram', 'exportPresetStory', 'exportPresetFull', 'geometryFlipHBtn', 'geometryFlipVBtn', 'healBrushBtn', 'sliderLensFeather']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must exist`);
  }
  assert.match(script, /function applyExportPreset\(/);
  assert.match(script, /function exportFormatFor\(|social\.exportFormatFor\(/);
});

/* ---------------------------------------------------------------- real pixels */
test('heal, keystone, mirror and lens blur change rendered pixels in a real browser', {timeout: 600000}, async t => {
  if (!available) {
    t.skip('Playwright and/or a Chromium build are not available in this environment');
    return;
  }
  const server = await startStaticServer();
  const browser = await playwright.chromium.launch({executablePath: chromiumPath, args: CHROMIUM_ARGS, env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS}});
  try {
    const {context, page, errors} = await openApp(browser);
    const png = await page.evaluate(eval(`(${FIXTURE})`));
    await page.setInputFiles('#photoPickerInput', {name: 'texture.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64')});
    await page.waitForFunction(() => document.body.dataset.mode === 'photo', null, {timeout: 60000});
    await page.waitForTimeout(1200);
    await page.evaluate(CANVAS_HELPERS);
    const openAdjust = () => page.evaluate(() => {
      document.getElementById('adjustTab').click();
      document.querySelectorAll('#adjustPanel details').forEach(section => { section.open = true; });
      document.querySelectorAll('#adjustPanel .effectGroup').forEach(group => { group.classList.add('open'); group.querySelector('.effectTitle')?.setAttribute('aria-expanded', 'true'); });
    });
    const click = id => page.evaluate(target => document.getElementById(target).click(), id);
    const box = await page.locator('#glCanvas').boundingBox();
    const toPage = (fx, fy) => ({x: box.x + fx * box.width, y: box.y + fy * box.height});

    await openAdjust();
    await page.waitForTimeout(400);
    // Everything the round asks for is present and reachable in the Adjust tab.
    for (const id of ['healBrushBtn', 'sliderHealSize', 'healUndoBtn', 'healClearBtn', 'healStatus', 'sliderKeystoneV', 'sliderKeystoneH', 'geometryFlipHBtn', 'geometryFlipVBtn', 'geometryResetBtn', 'geometryStatus', 'sliderLensBlur', 'sliderLensFeather', 'lensBlurStatus']) {
      const size = await page.evaluate(target => { const node = document.getElementById(target); if (!node) return null; const r = node.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height), disabled: !!node.disabled}; }, id);
      assert.ok(size && size.w > 0 && size.h > 0, `${id} must be visible in the Adjust tab (saw ${JSON.stringify(size)})`);
    }

    // --- 1. Spot heal ---------------------------------------------------------------------
    const blemishBefore = await page.evaluate(() => ({pixel: window.__px(120, 240), mean: window.__mean(104, 224, 32, 32)}));
    assert.ok(blemishBefore.mean < 200, `the fixture blemish must be dark (saw ${blemishBefore.mean})`);
    await click('healBrushBtn');
    await page.$eval('#sliderHealSize', node => { node.value = '7'; node.dispatchEvent(new Event('input', {bubbles: true})); });
    const blemish = toPage(120 / 640, 240 / 480);
    await page.mouse.move(blemish.x, blemish.y);
    await page.mouse.down();
    await page.mouse.move(blemish.x + 1, blemish.y + 1, {steps: 3});
    await page.mouse.up();
    await page.waitForTimeout(1500);
    const healed = await page.evaluate(() => ({pixel: window.__px(120, 240), mean: window.__mean(104, 224, 32, 32), status: document.getElementById('healStatus').textContent, history: [...document.querySelectorAll('.historyItem')].map(node => node.textContent)}));
    assert.ok(healed.mean > blemishBefore.mean + 30, `heal must fill the blemish from nearby pixels (${blemishBefore.mean} → ${healed.mean})`);
    assert.match(healed.status, /Heal brush|Spot heal/, 'the status line reports the heal brush');
    assert.ok(healed.history.some(label => /Spot heal/.test(label)), 'the heal step lands in the history list');
    await click('healUndoBtn');
    await page.waitForTimeout(1500);
    const undone = await page.evaluate(() => window.__mean(104, 224, 32, 32));
    assert.ok(Math.abs(undone - blemishBefore.mean) < 6, `undo must put the blemish back (${blemishBefore.mean} → ${undone})`);
    // Disarm the brush, so the pointer work below paints the subject mask instead of healing.
    assert.equal(await page.getAttribute('#healBrushBtn', 'aria-pressed'), 'true');
    await click('healBrushBtn');
    assert.equal(await page.getAttribute('#healBrushBtn', 'aria-pressed'), 'false');

    // --- 2. Perspective -------------------------------------------------------------------
    const baselineCorners = await page.evaluate(() => [window.__px(6, 6), window.__px(633, 6), window.__px(6, 473), window.__px(633, 473)]);
    await page.$eval('#sliderKeystoneV', node => { node.value = '100'; node.dispatchEvent(new Event('input', {bubbles: true})); node.dispatchEvent(new Event('change', {bubbles: true})); });
    await page.waitForTimeout(900);
    const warped = await page.evaluate(() => ({corners: [window.__px(6, 6), window.__px(633, 6), window.__px(6, 473), window.__px(633, 473)], readout: document.getElementById('valKeystoneV').textContent, status: document.getElementById('geometryStatus').textContent}));
    assert.equal(warped.readout, '+100');
    const changed = baselineCorners.some((pixel, index) => {
      const other = warped.corners[index];
      return Math.abs(pixel[0] - other[0]) + Math.abs(pixel[1] - other[1]) + Math.abs(pixel[2] - other[2]) > 12;
    });
    assert.ok(changed, `vertical keystone must warp the frame (${JSON.stringify(baselineCorners)} → ${JSON.stringify(warped.corners)})`);
    await click('geometryResetBtn');
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => document.getElementById('sliderKeystoneV').value), '0');
    // Mirroring moves the blemish across the frame while leaving the pixels themselves untouched.
    await click('geometryFlipHBtn');
    await page.waitForTimeout(800);
    const mirrored = await page.evaluate(() => ({pressed: document.getElementById('geometryFlipHBtn').getAttribute('aria-pressed'), left: window.__px(120, 240), right: window.__px(520, 240)}));
    assert.equal(mirrored.pressed, 'true');
    assert.ok(mirrored.right[0] < 120 && mirrored.right[1] < 120, `the blemish must appear mirrored on the other side (saw ${JSON.stringify(mirrored.right)})`);
    await openAdjust();
    await click('geometryResetBtn');
    await page.waitForTimeout(600);

    // --- 3. Lens blur behind the subject mask ---------------------------------------------
    await page.evaluate(() => {
      for (const section of document.querySelectorAll('details')) section.open = true;
      document.querySelectorAll('.effectGroup').forEach(group => { group.classList.add('open'); group.querySelector('.effectTitle')?.setAttribute('aria-expanded', 'true'); });
      const input = document.querySelector('input[name="ditherScope"][value="background"]');
      input.checked = true; input.dispatchEvent(new Event('change', {bubbles: true}));
    });
    await page.waitForTimeout(2500);
    // The Mask tab controls live behind collapsed clusters; unhide the ancestors the same way a
    // person would by opening the group, so the button can be clicked for real.
    await page.evaluate(() => {
      let node = document.getElementById('protectSubjectBtn');
      while (node && node !== document.body) {
        node.hidden = false; node.removeAttribute('hidden');
        if (node.classList.contains('clusterContents') || node.classList.contains('subControls')) {
          node.style.display = 'flex'; node.style.maxHeight = 'none'; node.style.overflow = 'visible'; node.style.height = 'auto';
        }
        node = node.parentElement;
      }
    });
    await click('protectSubjectBtn');
    await page.waitForTimeout(600);
    const protectBox = await page.locator('#glCanvas').boundingBox();
    const centre = {x: protectBox.x + protectBox.width * 0.5, y: protectBox.y + protectBox.height * 0.5};
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    for (let ring = 0; ring < 4; ring++) {
      const radius = 0.03 + ring * 0.035;
      for (let step = 0; step < 18; step++) {
        const angle = (step / 18) * Math.PI * 2;
        await page.mouse.move(centre.x + Math.cos(angle) * protectBox.width * radius, centre.y + Math.sin(angle) * protectBox.height * radius, {steps: 2});
      }
    }
    await page.mouse.up();
    await page.waitForTimeout(1800);
    await openAdjust();
    await page.waitForTimeout(400);
    const masked = await page.evaluate(() => ({status: document.getElementById('lensBlurStatus').textContent, badge: document.getElementById('maskStateLabel').textContent}));
    assert.equal(masked.badge, 'MASK ACTIVE', 'a finished protect stroke refreshes the mask badge');
    assert.match(masked.status, /Protect subject mask|Mask tab selection/, `painting the subject must arm the lens blur (saw "${masked.status}")`);
    const lensBefore = await page.evaluate(() => ({corner: window.__detail(20, 20, 80, 80), subject: window.__detail(300, 225, 40, 30)}));
    await page.$eval('#sliderLensBlur', node => { node.value = '100'; node.dispatchEvent(new Event('input', {bubbles: true})); node.dispatchEvent(new Event('change', {bubbles: true})); });
    await page.waitForTimeout(1400);
    const lensAfter = await page.evaluate(() => ({corner: window.__detail(20, 20, 80, 80), subject: window.__detail(300, 225, 40, 30), cornerPixel: window.__px(6, 6), feather: document.getElementById('valLensFeather').textContent, status: document.getElementById('lensBlurStatus').textContent}));
    assert.ok(lensAfter.corner < lensBefore.corner * 0.6, `lens blur must soften the background (detail ${lensBefore.corner} → ${lensAfter.corner})`);
    assert.ok(lensAfter.subject > lensBefore.subject * 0.7, `the protected subject must stay sharp (detail ${lensBefore.subject} → ${lensAfter.subject})`);
    assert.equal(lensAfter.feather, '30', 'edge feather keeps its default');
    const clip = await page.locator('#glCanvas').boundingBox();
    await page.screenshot({path: '/tmp/r7-lens-blur.png', clip});
    // Feather is a real control: sliding it re-renders.
    await page.$eval('#sliderLensFeather', node => { node.value = '85'; node.dispatchEvent(new Event('input', {bubbles: true})); });
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => document.getElementById('valLensFeather').textContent), '85');
    await page.$eval('#sliderLensBlur', node => { node.value = '0'; node.dispatchEvent(new Event('input', {bubbles: true})); node.dispatchEvent(new Event('change', {bubbles: true})); });
    await page.waitForTimeout(900);
    const restored = await page.evaluate(() => ({corner: window.__detail(20, 20, 80, 80), readout: document.getElementById('valLensBlur').textContent}));
    assert.equal(restored.readout, '0');
    assert.ok(restored.corner > lensAfter.corner * 1.5, `strength 0 must restore the sharp frame (${lensAfter.corner} → ${restored.corner})`);

    // --- 4. Film-look fine tuning ---------------------------------------------------------
    await page.evaluate(() => document.getElementById('looksTab').click());
    await page.waitForTimeout(400);
    for (const [mirror, primary] of [['sliderFilmGrain', 'sliderGrain'], ['sliderFilmBloom', 'sliderBloom'], ['sliderFilmHalation', 'sliderHall']]) {
      const mirroredValue = await page.evaluate(({mirror, primary}) => {
        const slider = document.getElementById(mirror);
        slider.value = '65'; slider.dispatchEvent(new Event('input', {bubbles: true}));
        const moved = document.getElementById(primary).value;
        slider.value = '0'; slider.dispatchEvent(new Event('input', {bubbles: true}));
        return {moved, back: document.getElementById(primary).value, readout: document.getElementById(mirror.replace('slider', 'val'))?.textContent};
      }, {mirror, primary});
      assert.equal(mirroredValue.moved, '65', `${mirror} must drive ${primary}`);
      assert.equal(mirroredValue.back, '0', `${mirror} must be able to return to neutral`);
    }

    // --- 5. Export presets ----------------------------------------------------------------
    await page.evaluate(() => document.getElementById('exportTab').click());
    await page.waitForTimeout(400);
    for (const [id, format, type, quality, dims] of [
      ['exportPresetInstagram', 'portrait', 'jpeg', '92', '1080 × 1350'],
      ['exportPresetStory', 'story', 'jpeg', '92', '1080 × 1920'],
      ['exportPresetFull', 'original', 'jpeg', '100', '640 × 480'],
    ]) {
      const applied = await page.evaluate(async target => {
        document.getElementById(target).click();
        await new Promise(resolve => setTimeout(resolve, 200));
        return {
          format: document.getElementById('exportFileType').value,
          quality: document.getElementById('exportQuality').value,
          pressed: document.getElementById(target).getAttribute('aria-pressed'),
          dims: (document.getElementById('outputDimensions')?.textContent || '').replace(/\s+/g, ' ').trim(),
        };
      }, id);
      assert.equal(applied.quality, quality, `${id} quality`);
      assert.equal(applied.pressed, 'true', `${id} shows as selected`);
      assert.ok(applied.format === type || applied.format === 'jpeg', `${id} type`);
      assert.ok(applied.dims.includes(dims), `${id} must set ${dims} (saw "${applied.dims}")`);
    }
    const webp = await page.evaluate(async () => {
      document.querySelectorAll('[data-photo-type]').forEach(button => { if (button.dataset.photoType === 'webp') button.click(); });
      await new Promise(resolve => setTimeout(resolve, 250));
      return {
        value: document.getElementById('exportFileType').value,
        hint: document.getElementById('exportTypeHint')?.textContent || '',
        label: document.getElementById('exportPhotoLabel').textContent,
      };
    });
    assert.equal(webp.value, 'webp');
    assert.match(webp.hint, /WebP/);
    assert.match(webp.label, /WebP/);
    const downloads = [];
    page.on('download', download => downloads.push(download.suggestedFilename()));
    await click('exportPhotoBtn');
    await page.waitForTimeout(1800);
    if (await page.evaluate(() => !document.getElementById('downloadConfirmOverlay').hidden)) {
      await click('confirmDownloadBtn');
      await page.waitForTimeout(1600);
    }
    assert.ok(downloads.length === 1, `the export must download exactly one file (saw ${JSON.stringify(downloads)})`);
    assert.match(downloads[0], /\.(webp|jpg|jpeg|png)$/i, `the download must be a real image file (saw ${downloads[0]})`);
    assert.match(await page.textContent('#exportStatus'), /WebP|downloaded/i);

    // A 390px phone keeps every new control reachable: the buttons exist, and the coarse-pointer
    // block gives the round-7 tool rows the same 44px targets as the rest of the editor.
    const phone = await context.newPage();
    await phone.setViewportSize({width: 390, height: 844});
    await phone.goto(`http://127.0.0.1:${PORT}/index.html`, {waitUntil: 'domcontentloaded'});
    await phone.waitForFunction(() => document.getElementById('presetSelect')?.options.length > 1, null, {timeout: 30000});
    const present = await phone.evaluate(() => ['healBrushBtn', 'geometryFlipHBtn', 'exportPresetInstagram', 'sliderKeystoneV', 'sliderLensBlur'].filter(id => !document.getElementById(id)));
    assert.deepEqual(present, [], 'every round-7 control is mounted on a phone viewport');
    await phone.close();
    const coarse = styles.slice(styles.lastIndexOf('@media (pointer: coarse) {'));
    assert.match(coarse, /\.geometryGrid \.toolBtn,\.exportPresetBtn,#healBrushBtn,#healUndoBtn,#healClearBtn,\.healTools \.toolBtn \{ position: relative; min-height: 44px; \}/);
    assert.match(styles, /\.exportPresetBtn \{[^}]*min-height: 46px/);

    assert.deepEqual(errors, [], `the round-7 tools must not log console errors: ${errors.join(' | ')}`);
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
