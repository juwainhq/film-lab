/* Real-browser test for the grading shaders and the look cards.
 *
 * The shader bug this guards against only shows up in a browser's own GLSL compiler
 * (`sampler3D` has no default precision in GLSL ES 3.00 fragment shaders, so ANGLE rejects the
 * grade-finish program and every color wheel, LUT and black-and-white mix silently stops working),
 * which a source-level test cannot catch. Node's `node --test` runner therefore shells out to
 * Chromium through Playwright, exactly like tests/zoom.test.cjs does for its geometry checks.
 *
 * Skips itself (rather than failing) when Playwright or a Chromium build is not available, and
 * points the built-in static server at this checkout so the page, its workers and vendor/ all load.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {execFileSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FILM_LAB_BROWSER_TEST_PORT || 8971);
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
function photoFixture() {
  // Portrait-shaped PNG with distinct colour bands so a wheel change is measurable everywhere.
  const target = path.join(os.tmpdir(), 'filmlab-browser-test-photo.png');
  if (fs.existsSync(target) && fs.statSync(target).size > 1000) return target;
  try {
    execFileSync('convert', ['-size', '640x480', 'gradient:#20456b-#f0c58a', '-fill', '#8a3350',
      '-draw', 'circle 320,300 320,190', '-fill', '#2b1a2c', '-draw', 'polygon 230,480 230,330 320,280 410,330 410,480',
      target], {stdio: 'ignore'});
  } catch (_) { /* fall through to the raw writer below */ }
  if (!fs.existsSync(target)) {
    // Minimal PNG fallback: 64x48 solid mid grey.
    const zlib = require('node:zlib');
    const width = 64, height = 48, raw = Buffer.alloc((width * 3 + 1) * height, 0);
    for (let y = 0; y < height; y++) {
      raw[y * (width * 3 + 1)] = 0;
      for (let x = 0; x < width; x++) {
        const o = y * (width * 3 + 1) + 1 + x * 3;
        raw[o] = 96 + Math.round((x / width) * 90); raw[o + 1] = 90; raw[o + 2] = 120;
      }
    }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(require('node:zlib').crc32 ? zlib.crc32(body) : crc32(body));
      return Buffer.concat([len, body, crc]);
    };
    const crc32 = buffer => {
      let crc = 0xffffffff;
      for (const byte of buffer) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
      return (crc ^ 0xffffffff) >>> 0;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
    fs.writeFileSync(target, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]));
  }
  return target;
}
function lutFixture() {
  // 17^3 identity LUT with a teal cast: the sampler3D upload path is what the wheels/LUT bug hid.
  const target = path.join(os.tmpdir(), 'filmlab-browser-test-lut.cube');
  if (fs.existsSync(target) && fs.statSync(target).size > 1000) return target;
  const size = 17, lines = [`TITLE "film lab browser test"`, `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const R = r / (size - 1), G = g / (size - 1), B = b / (size - 1);
    lines.push(`${(R * 0.75).toFixed(6)} ${Math.min(1, G * 0.95 + 0.12 * (1 - R)).toFixed(6)} ${Math.min(1, B * 0.85 + 0.22 * (1 - R)).toFixed(6)}`);
  }
  fs.writeFileSync(target, lines.join('\n') + '\n');
  return target;
}

function startStaticServer() {
  const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
    '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
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

test('the grading shaders compile in a real Chromium and the look cards keep their names', {timeout: 240000}, async t => {
  if (!available) {
    t.skip('Playwright and/or a Chromium build are not available in this environment');
    return;
  }
  const server = await startStaticServer();
  const browser = await playwright.chromium.launch({
    executablePath: chromiumPath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS},
  });
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}});
    await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
    await context.route('https://fonts.gstatic.com/**', route => route.fulfill({body: '', contentType: 'font/woff2'}));
    const page = await context.newPage();
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));

    await page.goto(`http://127.0.0.1:${PORT}/index.html`, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.body.dataset.mode !== undefined, null, {timeout: 30000});
    await page.setInputFiles('#photoPickerInput', photoFixture());
    await page.waitForFunction(() => {
      const canvas = document.getElementById('glCanvas');
      return document.body.dataset.mode === 'photo' && canvas.width > 0;
    }, null, {timeout: 60000});
    await page.waitForTimeout(1500);

    // 1. No shader compilation complaints at all.
    const shaderErrors = errors.filter(text => /no precision specified|shader|glsl|compile/i.test(text));
    assert.deepEqual(shaderErrors, [], `Shader errors in Chromium: ${shaderErrors.join(' | ')}`);
    const samplerError = errors.filter(text => /sampler3D/i.test(text));
    assert.deepEqual(samplerError, []);

    // The extended grade program really compiled (it is only built when GLSL accepted it).
    const programState = await page.evaluate(() => ({
      finish: window.__filmLabDebug ? true : null,
      wheelsVisible: !document.getElementById('gradeColorWheelsSection')?.hidden,
    }));
    assert.equal(programState.wheelsVisible, true);

    // 2. Look cards: every featured card shows a photo-shaped preview with its name under it.
    const lookCards = await page.evaluate(() => [...document.querySelectorAll('#presetChips .chip')].map(chip => {
      const swatch = chip.querySelector('.presetColorSwatch');
      const cardRect = chip.getBoundingClientRect(), swatchRect = swatch.getBoundingClientRect();
      const textNode = [...chip.childNodes].find(node => node.nodeType === 3 && node.textContent.trim());
      const range = document.createRange();
      let labelTop = null;
      if (textNode) { range.selectNodeContents(textNode); labelTop = range.getBoundingClientRect().top; }
      const style = getComputedStyle(swatch);
      return {
        name: (textNode ? textNode.textContent : chip.textContent).trim(),
        ratio: swatchRect.width / swatchRect.height,
        labelBelow: labelTop === null ? false : labelTop >= swatchRect.bottom - 1,
        labelWidth: textNode ? range.getBoundingClientRect().width : 0,
        hasPhotoPreview: /url\("data:image\/jpeg;base64,/.test(style.backgroundImage),
        relative: style.position === 'relative',
        fitsCard: swatchRect.height <= cardRect.height && swatchRect.width <= cardRect.width,
      };
    }));
    assert.ok(lookCards.length >= 4, `expected look cards, saw ${lookCards.length}`);
    for (const card of lookCards) {
      assert.ok(card.hasPhotoPreview, `look ${card.name} has no photo preview`);
      assert.ok(card.name.length > 1, 'a look card is missing its name');
      assert.ok(card.labelWidth > 0, `look ${card.name} name is not laid out`);
      assert.ok(card.labelBelow, `look ${card.name} name is not below its preview`);
      assert.ok(card.ratio > 1.24 && card.ratio < 1.42, `look ${card.name} preview ratio ${card.ratio.toFixed(2)} is not about 4:3`);
      assert.ok(card.relative, `look ${card.name} preview is still absolutely positioned`);
      assert.ok(card.fitsCard, `look ${card.name} preview overflows its card`);
    }

    // 3. A color wheel drag changes the canvas pixels.
    const canvas = page.locator('#glCanvas');
    await page.evaluate(() => document.getElementById('gradeTab').click());
    await page.waitForTimeout(700);
    // The wheels live in a collapsible grade section, which starts closed.
    await page.evaluate(() => {
      for (const section of document.querySelectorAll('#colorGradePanel details')) section.open = true;
    });
    await page.waitForTimeout(400);
    const shots = path.join(os.tmpdir(), 'filmlab-browser-test-shots');
    fs.mkdirSync(shots, {recursive: true});
    const capture = async name => {
      const file = path.join(shots, `${name}.png`);
      await canvas.screenshot({path: file});
      return fs.readFileSync(file);
    };
    const neutral = await capture('neutral');
    const wheelLocator = page.locator('[data-grade-wheel="midtones"]');
    await wheelLocator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const wheelBox = await wheelLocator.boundingBox();
    assert.ok(wheelBox && wheelBox.width > 20, 'the midtones color wheel is not visible');
    const viewport = page.viewportSize();
    assert.ok(wheelBox.y > 0 && wheelBox.y + wheelBox.height < viewport.height - 4,
      `the wheel is outside the viewport (y=${Math.round(wheelBox.y)} of ${viewport.height})`);
    await page.evaluate(() => {
      const slider = document.getElementById('sliderGradeWheelMidtonesIntensity');
      if (slider) { slider.value = '100'; slider.dispatchEvent(new Event('input', {bubbles: true})); slider.dispatchEvent(new Event('change', {bubbles: true})); }
    });
    await page.mouse.move(wheelBox.x + wheelBox.width * 0.82, wheelBox.y + wheelBox.height * 0.28);
    await page.mouse.down();
    await page.mouse.move(wheelBox.x + wheelBox.width * 0.92, wheelBox.y + wheelBox.height * 0.2, {steps: 8});
    await page.mouse.up();
    await page.waitForTimeout(1500);
    const tinted = await capture('tinted');
    const wheelState = await page.evaluate(() => {
      const wheel = document.querySelector('[data-grade-wheel="midtones"]');
      return {now: wheel?.getAttribute('aria-valuenow'), text: wheel?.getAttribute('aria-valuetext')};
    });
    assert.ok(Number(wheelState.now) > 0, `the wheel did not move (aria-valuenow=${wheelState.now})`);
    assert.notEqual(tinted.compare(neutral), 0, 'moving a color wheel did not change the canvas pixels');

    // Optional stronger check: a real pixel difference when ImageMagick is present.
    let pixelDelta = null;
    try {
      const value = execFileSync('convert', ['-quiet', path.join(shots, 'neutral.png'), path.join(shots, 'tinted.png'),
        '-compose', 'difference', '-composite', '-format', '%[fx:mean*255]', 'info:'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
      pixelDelta = Number(value);
      assert.ok(pixelDelta > 0.2, `the wheel tint changed the canvas by only ${pixelDelta}/255`);
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error; // ImageMagick ran and the delta was too small
    }

    // Double-clicking the wheel clears the tint again: the pixels move back toward the original.
    await page.evaluate(() => document.querySelector('[data-grade-wheel="midtones"]').dispatchEvent(new MouseEvent('dblclick', {bubbles: true})));
    await page.waitForTimeout(1500);
    const cleared = await capture('cleared');
    assert.notEqual(cleared.compare(tinted), 0, 'clearing the wheel did not change the canvas back');
    const resetState = await page.evaluate(() => document.querySelector('[data-grade-wheel="midtones"]').getAttribute('aria-valuenow'));
    assert.equal(Number(resetState), 0);

    // 4b. A .cube LUT really uploads to the sampler3D texture and changes the picture.
    await page.evaluate(() => { for (const section of document.querySelectorAll('#colorGradePanel details')) section.open = true; });
    await page.waitForTimeout(300);
    const beforeLut = await capture('before-lut');
    await page.setInputFiles('#gradeLutInput', lutFixture());
    await page.waitForTimeout(1800);
    const lutState = await page.evaluate(() => ({
      status: document.getElementById('gradeLutStatus').textContent,
      clearEnabled: !document.getElementById('gradeLutClearBtn').disabled,
    }));
    assert.match(lutState.status, /17³ LUT active/, `LUT import failed: ${lutState.status}`);
    assert.equal(lutState.clearEnabled, true);
    const afterLut = await capture('after-lut');
    assert.notEqual(afterLut.compare(beforeLut), 0, 'the imported LUT did not change the canvas');

    // 5. Still clean.
    const lateErrors = errors.filter(text => !/sampler3D|No precision specified/i.test(text));
    assert.deepEqual(lateErrors, [], `Console errors: ${lateErrors.join(' | ')}`);
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

/* A flat grey plate: the film grain's own pattern is the only thing on it, so a tile, a grid or a
   vertical band is impossible to miss in the autocorrelation below. */
function greyFixture() {
  const target = path.join(os.tmpdir(), 'filmlab-browser-test-grey.png');
  if (fs.existsSync(target) && fs.statSync(target).size > 500) return target;
  const zlib = require('node:zlib');
  const width = 512, height = 512, raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) { raw[row + 1 + x * 3] = 128; raw[row + 2 + x * 3] = 128; raw[row + 3 + x * 3] = 128; }
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
    const crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([Buffer.from(type), body])) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuffer = Buffer.alloc(4); crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, Buffer.from(type), body, crcBuffer]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  fs.writeFileSync(target, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
  return target;
}

test('film grain is soft, random and untiled on a flat plate', {timeout: 240000}, async t => {
  if (!available) {
    t.skip('Playwright and/or a Chromium build are not available in this environment');
    return;
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // Comments explain the old shader, so the source checks look only at executable text.
  const shaderCode = html.replace(/\/\*[\s\S]*?\*\//g, '');
  // The old float hash lost precision at large coordinates and repeated; the integer one cannot.
  assert.doesNotMatch(shaderCode, /fract\(p\*vec2\(123\.34,345\.45\)/, 'the old float grain hash is back');
  assert.doesNotMatch(shaderCode, /grainValueNoise/, 'the lattice value noise is back');
  assert.match(shaderCode, /uint grainHash\(uint value\)/, 'the grain needs the integer hash');
  assert.match(shaderCode, /grainFields\(/, 'the grain needs the jittered-cell sampler');
  const server = await startStaticServer();
  const browser = await playwright.chromium.launch({
    executablePath: chromiumPath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS},
  });
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}});
    await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
    await context.route('https://fonts.gstatic.com/**', route => route.fulfill({body: '', contentType: 'font/woff2'}));
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('presetSelect')?.options.length > 1, null, {timeout: 30000});
    await page.setInputFiles('#photoPickerInput', greyFixture());
    await page.waitForFunction(() => {
      const canvas = document.getElementById('glCanvas');
      return document.body.dataset.mode === 'photo' && canvas && canvas.width > 300;
    }, null, {timeout: 60000});
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      for (const [id, value] of Object.entries({sliderGrain: 80, sliderGrainSize: 0, sliderGrainRough: 50, sliderGrainColor: 35, sliderGrainLuma: 50, sliderGrainSoft: 20})) {
        const slider = document.getElementById(id);
        slider.value = String(value);
        slider.dispatchEvent(new Event('input', {bubbles: true}));
      }
    });
    await page.waitForTimeout(900);

    /* Mean, shape and autocorrelation, read straight off the rendered canvas. */
    const read = () => page.evaluate(() => {
      const canvas = document.getElementById('glCanvas');
      const scratch = document.createElement('canvas');
      scratch.width = canvas.width; scratch.height = canvas.height;
      const context = scratch.getContext('2d');
      context.drawImage(canvas, 0, 0);
      const {data} = context.getImageData(0, 0, scratch.width, scratch.height);
      const luma = new Float64Array(scratch.width * scratch.height);
      for (let i = 0, p = 0; i < data.length; i += 4, p++) luma[p] = (data[i] + data[i + 1] + data[i + 2]) / 3;
      return {width: scratch.width, height: scratch.height, luma: Array.from(luma)};
    });
    const frame = await read();
    const {width, height, luma} = frame;
    const border = 24;
    let sum = 0, count = 0;
    for (let y = border; y < height - border; y++) for (let x = border; x < width - border; x++) { sum += luma[y * width + x]; count++; }
    const mean = sum / count;
    let m2 = 0, m4 = 0;
    for (let y = border; y < height - border; y++) for (let x = border; x < width - border; x++) { const d = luma[y * width + x] - mean; m2 += d * d; m4 += d * d * d * d; }
    m2 /= count; m4 /= count;
    const sigma = Math.sqrt(m2), kurtosis = m4 / (m2 * m2);
    assert.ok(Math.abs(mean - 128) < 1.5, `grain shifted the exposure by ${(mean - 128).toFixed(2)} levels`);
    assert.ok(sigma > 4, `amount 80 produced no visible grain (sigma ${sigma.toFixed(2)})`);

    /* Autocorrelation on the centre window: the axis profiles must decay and stay decayed, which is
       exactly what the tiled value noise failed (it read 0.98 at lag 16). */
    const size = Math.min(140, width - 2 * border, height - 2 * border);
    const ox = Math.round((width - size) / 2), oy = Math.round((height - size) / 2);
    let windowMean = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) windowMean += luma[(oy + y) * width + ox + x];
    windowMean /= size * size;
    const centred = new Float64Array(size * size);
    let variance = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const value = luma[(oy + y) * width + ox + x] - windowMean;
      centred[y * size + x] = value; variance += value * value;
    }
    variance /= size * size;
    const correlate = (dx, dy) => {
      let total = 0, n = 0;
      for (let y = 0; y < size; y++) {
        const sy = y + dy; if (sy < 0 || sy >= size) continue;
        for (let x = 0; x < size; x++) { const sx = x + dx; if (sx < 0 || sx >= size) continue; total += centred[y * size + x] * centred[sy * size + sx]; n++; }
      }
      return variance ? (total / n) / variance : 0;
    };
    const axisX = [], axisY = [];
    for (let lag = 0; lag <= 40; lag++) { axisX.push(correlate(lag, 0)); axisY.push(correlate(0, lag)); }
    assert.ok(axisX[0] > 0.7 && axisY[0] > 0.7, 'the grain has no local structure at all');
    // A grain about two pixels wide is correlated over its own size and then forgets: past lag 6
    // the profile must stay flat. The tiled value noise this replaces read 0.66-0.98 out there.
    const axisPeriod = Math.max(...axisX.slice(6).map(Math.abs), ...axisY.slice(6).map(Math.abs));
    assert.ok(axisPeriod < 0.3, `the grain repeats along an axis (max |correlation| ${axisPeriod.toFixed(3)} past lag 6)`);
    let radialPeriod = 0;
    for (let radius = 6; radius <= 40; radius++) {
      const steps = Math.max(8, Math.round(radius * 6));
      for (let step = 0; step < steps; step++) {
        const angle = step / steps * Math.PI * 2;
        radialPeriod = Math.max(radialPeriod, Math.abs(correlate(Math.round(Math.cos(angle) * radius), Math.round(Math.sin(angle) * radius))));
      }
    }
    assert.ok(radialPeriod < 0.35, `the grain has a repeating period (max |correlation| ${radialPeriod.toFixed(3)} at radius 6-40)`);
    assert.ok(kurtosis > 2.4 && kurtosis < 6, `the grain histogram is not bell shaped (kurtosis ${kurtosis.toFixed(2)})`);

    /* A photo's grain is one stable field: reading it again without touching anything is identical. */
    const second = await read();
    const identical = second.luma.slice(0, 2000).every((value, index) => value === frame.luma[index]);
    assert.ok(identical, 'the photo grain changed while nothing was touched');
    assert.doesNotMatch(shaderCode, /u_grainStrength\*0\.0/, 'the grain amplitude was zeroed out');
  } finally {
    await browser.close();
    server.close();
  }
});

test('a grading shader that will not compile shows the visible fallback notice', {timeout: 180000}, async t => {
  if (!available) {
    t.skip('Playwright and/or a Chromium build are not available in this environment');
    return;
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const precisionLine = 'precision highp float;\nprecision highp sampler3D;\nin vec2 v_texCoord;\nuniform sampler2D u_image;\nuniform sampler3D u_lut;';
  const broken = html.replace(precisionLine, precisionLine.replace('precision highp sampler3D;\n', ''));
  assert.notEqual(broken, html, 'the Sampler3D precision line was not found in index.html');

  const server = await startStaticServer();
  const browser = await playwright.chromium.launch({
    executablePath: chromiumPath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS},
  });
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}});
    await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
    await context.route('https://fonts.gstatic.com/**', route => route.fulfill({body: '', contentType: 'font/woff2'}));
    await context.route('**/index.html', route => route.fulfill({body: broken, contentType: 'text/html'}));
    await context.addInitScript(() => {
      window.__toastLog = [];
      const start = () => {
        const toast = document.getElementById('toast');
        if (!toast) return setTimeout(start, 20);
        const record = () => {
          const text = toast.textContent.trim();
          if (text && window.__toastLog[window.__toastLog.length - 1] !== text) window.__toastLog.push(text);
        };
        new MutationObserver(record).observe(toast, {childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class']});
        record();
      };
      start();
    });
    const page = await context.newPage();
    const messages = [];
    page.on('console', message => messages.push(`${message.type()}: ${message.text()}`));
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.body.dataset.mode !== undefined, null, {timeout: 30000});
    await page.setInputFiles('#photoPickerInput', photoFixture());
    await page.waitForFunction(() => document.body.dataset.mode === 'photo', null, {timeout: 60000});
    await page.waitForTimeout(1500);
    assert.ok(messages.some(text => /No precision specified/i.test(text)), 'the broken shader did not report itself to the console');
    const toastLog = await page.evaluate(() => window.__toastLog);
    assert.ok(toastLog.some(text => /Some color grading features are unavailable on this device/.test(text)),
      `the fallback notice was never shown: ${JSON.stringify(toastLog)}`);
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
