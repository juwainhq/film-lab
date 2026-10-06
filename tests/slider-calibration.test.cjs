/* Real-browser calibration test for the Adjust/Grade sliders.
 *
 * The targets this guards ("Temperature +100 must land at an R/B ratio of ~1.7 on a mid grey
 * patch", "vibrance must not tint a neutral wall", "vignette negative darkens") are rendering
 * results, not source strings: a pure source-level test cannot tell whether a slider actually
 * moves pixels, whether it clips, or whether a white-balance model preserves luminance. Node's
 * `node --test` runner therefore drives Chromium through Playwright exactly like
 * tests/browser-shaders.test.cjs does, measures a purpose-built chart in the rendered canvas and
 * also checks the stored-value migration for the flipped vignette.
 *
 * Skips itself (instead of failing) when Playwright or a Chromium build is not available, and
 * points a built-in static server at this checkout so the page, its workers and vendor/ all load.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FILM_LAB_CALIBRATION_PORT || 8972);
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
// SwiftShader is the only GL implementation available in CI-ish containers; --ignore-gpu-blocklist
// keeps Chromium from refusing the software renderer outright.
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

/* ---------------------------------------------------------------- fixture */
const crcTable = (() => { const table = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; } return table; })();
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}
function encodePng(width, height, rgba) {
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, {level: 6})), chunk('IEND', Buffer.alloc(0)),
  ]);
}
/* The 1200x900 chart is drawn so every region the assertions read has a known value: a mid grey
   white-balance patch, skin/low-saturation/saturated colour patches, a bright-to-dark ramp, a
   dark/bright step for highlights and halo checks, low-contrast fine detail for texture and
   sharpening, 1px lines, and two noise fields for noise reduction. The canvas keeps the image's
   aspect ratio, so canvas fractions map 1:1 onto these image pixels. */
const REGIONS = {
  gray: {x: 40 / 1200, y: 40 / 900, w: 200 / 1200, h: 200 / 900},
  skin: {x: 280 / 1200, y: 40 / 900, w: 200 / 1200, h: 200 / 900},
  lowSat: {x: 520 / 1200, y: 40 / 900, w: 200 / 1200, h: 200 / 900},
  saturated: {x: 760 / 1200, y: 40 / 900, w: 200 / 1200, h: 200 / 900},
  gradientHigh: {x: 200 / 1200, y: 283 / 900, w: 800 / 1200, h: 48 / 900},
  gradientMid: {x: 200 / 1200, y: 340 / 900, w: 800 / 1200, h: 30 / 900},
  stepDark: {x: 0, y: 460 / 900, w: 560 / 1200, h: 140 / 900},
  stepBright: {x: 640 / 1200, y: 460 / 900, w: 560 / 1200, h: 140 / 900},
  nearEdgeDark: {x: 566 / 1200, y: 460 / 900, w: 30 / 1200, h: 140 / 900},
  nearEdgeBright: {x: 604 / 1200, y: 460 / 900, w: 30 / 1200, h: 140 / 900},
  softDetail: {x: 40 / 1200, y: 640 / 900, w: 360 / 1200, h: 140 / 900},
  fineLines: {x: 800 / 1200, y: 640 / 900, w: 360 / 1200, h: 140 / 900},
  noise: {x: 40 / 1200, y: 820 / 900, w: 520 / 1200, h: 80 / 900},
  softNoise: {x: 640 / 1200, y: 820 / 900, w: 520 / 1200, h: 80 / 900},
  corner: {x: 30 / 1200, y: 30 / 900, w: 150 / 1200, h: 150 / 900},
  centre: {x: 520 / 1200, y: 400 / 900, w: 160 / 1200, h: 160 / 900},
};
function chartFixture() {
  const target = path.join(os.tmpdir(), 'filmlab-calibration-chart.png');
  const width = 1200, height = 900;
  const data = new Uint8Array(width * height * 4);
  const set = (x, y, r, g, b) => { const o = (y * width + x) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255; };
  const rect = (x0, y0, w, h, r, g, b) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, r, g, b); };
  rect(0, 0, width, height, 18, 18, 18);
  rect(40, 40, 200, 200, 128, 128, 128);
  rect(280, 40, 200, 200, 222, 160, 120);
  rect(520, 40, 200, 200, 152, 160, 172);
  rect(760, 40, 200, 200, 200, 60, 60);
  rect(1000, 40, 200, 200, 60, 90, 200);
  for (let y = 280; y < 420; y++) { const t = (y - 280) / 139, v = Math.round(236 + (16 - 236) * t); rect(0, y, width, 1, v, v, v); }
  rect(0, 460, 600, 140, 14, 14, 14);
  rect(600, 460, 600, 140, 242, 242, 242);
  for (let y = 640; y < 780; y++) {
    for (let x = 40; x < 400; x++) { const v = ((x >> 1) + (y >> 1)) % 2 ? 118 : 138; set(x, y, v, v, v); }
    for (let x = 440; x < 760; x++) { const v = ((x >> 1) + (y >> 1)) % 2 ? 90 : 170; set(x, y, v, v, v); }
    for (let x = 800; x < 1160; x++) { const v = x % 2 ? 70 : 190; set(x, y, v, v, v); }
  }
  let seed = 20261006;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 820; y < 900; y++) {
    for (let x = 40; x < 560; x++) { const v = 128 + Math.round((random() - 0.5) * 56); set(x, y, v, v, v); }
    for (let x = 640; x < 1160; x++) { const v = 128 + Math.round((random() - 0.5) * 12); set(x, y, v, v, v); }
  }
  fs.writeFileSync(target, encodePng(width, height, data));
  return target;
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

/* Measurement helpers injected into the page. Everything is read back from the rendered canvas,
   so the numbers describe what a user actually sees. */
const PAGE_HELPERS = () => {
  const canvas = document.getElementById('glCanvas');
  const scratch = document.createElement('canvas');
  const grab = () => {
    const context = scratch.getContext('2d', {willReadFrequently: true});
    scratch.width = canvas.width; scratch.height = canvas.height;
    context.drawImage(canvas, 0, 0);
    return context.getImageData(0, 0, scratch.width, scratch.height);
  };
  const toLinear = value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const regionStats = (image, region) => {
    const x0 = Math.round(region.x * image.width), y0 = Math.round(region.y * image.height);
    const w = Math.max(1, Math.round(region.w * image.width)), h = Math.max(1, Math.round(region.h * image.height));
    let linear = [0, 0, 0], srgb = [0, 0, 0], count = 0, clipped = 0, satSum = 0, lumaSum = 0, lumaSq = 0, hf = 0, hfCount = 0, maxValue = 0, minValue = 255;
    for (let y = y0; y < Math.min(image.height, y0 + h); y++) for (let x = x0; x < Math.min(image.width, x0 + w); x++) {
      const o = (y * image.width + x) * 4, r = image.data[o], g = image.data[o + 1], b = image.data[o + 2];
      linear[0] += toLinear(r); linear[1] += toLinear(g); linear[2] += toLinear(b);
      srgb[0] += r; srgb[1] += g; srgb[2] += b;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumaSum += luma; lumaSq += luma * luma;
      maxValue = Math.max(maxValue, r, g, b); minValue = Math.min(minValue, r, g, b);
      if (r >= 253 || g >= 253 || b >= 253) clipped++;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      satSum += (max - min) / Math.max(1, max);
      if (x + 1 < Math.min(image.width, x0 + w)) {
        const o2 = o + 4;
        const luma2 = 0.2126 * image.data[o2] + 0.7152 * image.data[o2 + 1] + 0.0722 * image.data[o2 + 2];
        hf += Math.abs(luma - luma2); hfCount++;
      }
      count++;
    }
    const mean = values => values.map(value => value / Math.max(1, count));
    const stats = {count, clipped: clipped / Math.max(1, count), saturation: satSum / Math.max(1, count), maxValue, minValue, srgb: mean(srgb), linear: mean(linear), hf: hf / Math.max(1, hfCount)};
    const lumaMean = lumaSum / Math.max(1, count);
    stats.luma = 0.2126 * stats.linear[0] + 0.7152 * stats.linear[1] + 0.0722 * stats.linear[2];
    stats.lumaStd = Math.sqrt(Math.max(0, lumaSq / Math.max(1, count) - lumaMean * lumaMean));
    return stats;
  };
  const wholeCanvas = (a, b) => {
    let total = 0, count = 0, clipped = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      total += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (a.data[i] >= 253 || a.data[i + 1] >= 253 || a.data[i + 2] >= 253) clipped++;
      count++;
    }
    return {meanAbs: total / (count * 3), clipped: clipped / count};
  };
  window.__neutral = grab();
  window.__snap = regions => {
    const image = grab();
    const out = {whole: wholeCanvas(image, window.__neutral), regions: {}};
    for (const [name, region] of Object.entries(regions)) out.regions[name] = regionStats(image, region);
    return out;
  };
  window.__baseline = regions => {
    const out = {regions: {}};
    for (const [name, region] of Object.entries(regions)) out.regions[name] = regionStats(window.__neutral, region);
    return out;
  };
};

const playwright = resolvePlaywright();
const chromiumPath = resolveChromium();
const available = Boolean(playwright && chromiumPath);

async function openApp(browser, {init, hash = ''} = {}) {
  const context = await browser.newContext({viewport: {width: 1440, height: 900}});
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
  await context.route('https://fonts.gstatic.com/**', route => route.fulfill({body: '', contentType: 'font/woff2'}));
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 200)); });
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  await page.goto(`http://127.0.0.1:${PORT}/index.html${hash}`, {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => document.getElementById('presetSelect')?.options.length > 1, null, {timeout: 30000});
  return {context, page, errors};
}
async function loadPhoto(page, file) {
  await page.setInputFiles('#photoPickerInput', file);
  await page.waitForFunction(() => document.body.dataset.mode === 'photo' && document.getElementById('glCanvas').width > 8, null, {timeout: 60000});
  await page.waitForTimeout(2000);
  await page.evaluate(() => { document.getElementById('gradeTab').click(); for (const section of document.querySelectorAll('#colorGradePanel details')) section.open = true; });
  await page.waitForTimeout(600);
}

test('slider calibration: white balance, tone, detail, noise, vibrance and vignette at +/-100', {timeout: 420000}, async t => {
  if (!available) {
    t.skip('Playwright and/or a Chromium build are not available in this environment');
    return;
  }
  const server = await startStaticServer();
  const browser = await playwright.chromium.launch({executablePath: chromiumPath, args: CHROMIUM_ARGS, env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS}});
  try {
    const fixture = chartFixture();
    const {context, page, errors} = await openApp(browser);
    await loadPhoto(page, fixture);
    await page.evaluate(PAGE_HELPERS);
    const baseline = await page.evaluate(regions => window.__baseline(regions), REGIONS);
    // The geometry check: the grey patch really is the mid grey the thresholds assume, so a
    // mis-measured region fails loudly here instead of silently passing a slider assertion.
    assert.ok(Math.abs(baseline.regions.gray.srgb[0] - 128) <= 4, `mid grey patch should render at ~128, saw ${baseline.regions.gray.srgb[0]}`);
    assert.ok(Math.abs(baseline.regions.gray.srgb[0] - baseline.regions.gray.srgb[2]) <= 2, 'mid grey patch must start neutral');

    const resetGrade = () => page.evaluate(() => {
      for (const input of document.querySelectorAll('#colorGradePanel input[type=range]')) {
        const fallback = input.dataset.gradeDefault !== undefined ? input.dataset.gradeDefault
          : (Number(input.min) <= 0 && Number(input.max) >= 0 ? 0 : input.value);
        if (input.value === String(fallback)) continue;
        input.value = String(fallback);
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
      }
    });
    const measure = async (id, value, panel = '#colorGradePanel') => {
      await resetGrade();
      await page.evaluate(({id, value}) => {
        const input = document.getElementById(id);
        input.value = String(value);
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
      }, {id, value});
      await page.waitForTimeout(700);
      return page.evaluate(regions => window.__snap(regions), REGIONS);
    };
    const ratio = (patch, index, other) => patch.linear[index] / Math.max(patch.linear[other], 1e-6);
    const relative = (now, before) => (now - before) / Math.max(before, 1e-6);

    // 1. White balance: a real gain model, luminance preserved, in both render paths.
    const warm = await measure('sliderGradeTemperature', 100);
    const cool = await measure('sliderGradeTemperature', -100);
    assert.ok(ratio(warm.regions.gray, 0, 2) >= 1.55 && ratio(warm.regions.gray, 0, 2) <= 1.95,
      `temperature +100 should be a strong warm shift (R/B ${ratio(warm.regions.gray, 0, 2).toFixed(2)})`);
    assert.ok(ratio(cool.regions.gray, 0, 2) <= 0.68 && ratio(cool.regions.gray, 0, 2) >= 0.48,
      `temperature -100 should be an equally strong cool shift (R/B ${ratio(cool.regions.gray, 0, 2).toFixed(2)})`);
    for (const [label, shot] of [['+100', warm], ['-100', cool]]) {
      const drift = Math.abs(shot.regions.gray.luma - baseline.regions.gray.luma) / baseline.regions.gray.luma;
      assert.ok(drift <= 0.02, `temperature ${label} must preserve luminance (drift ${(drift * 100).toFixed(2)}%)`);
    }
    const magenta = await measure('sliderGradeTint', 100);
    const green = await measure('sliderGradeTint', -100);
    assert.ok(ratio(magenta.regions.gray, 1, 0) <= 0.78, `tint +100 should be magenta (G/R ${ratio(magenta.regions.gray, 1, 0).toFixed(2)})`);
    assert.ok(ratio(green.regions.gray, 1, 0) >= 1.25, `tint -100 should be green (G/R ${ratio(green.regions.gray, 1, 0).toFixed(2)})`);
    for (const shot of [magenta, green]) {
      const drift = Math.abs(shot.regions.gray.luma - baseline.regions.gray.luma) / baseline.regions.gray.luma;
      assert.ok(drift <= 0.02, `tint must preserve luminance (drift ${(drift * 100).toFixed(2)}%)`);
    }
    // The legacy Adjust-path temperature uses the same model: same strength, still luminance safe.
    await resetGrade();
    await page.evaluate(() => { document.getElementById('adjustTab').click(); for (const section of document.querySelectorAll('#adjustPanel details')) section.open = true; });
    await page.waitForTimeout(500);
    await page.evaluate(PAGE_HELPERS);
    const adjustBaseline = await page.evaluate(regions => window.__baseline(regions), REGIONS);
    const adjustValue = async value => {
      await page.evaluate(({value}) => {
        for (const input of document.querySelectorAll('#adjustPanel input[type=range]')) {
          if (input.value === '0') continue;
          input.value = '0';
          input.dispatchEvent(new Event('input', {bubbles: true}));
          input.dispatchEvent(new Event('change', {bubbles: true}));
        }
        const input = document.getElementById('sliderTemperature');
        input.value = String(value);
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
      }, {value});
      await page.waitForTimeout(700);
      return page.evaluate(regions => window.__snap(regions), REGIONS);
    };
    const adjustWarm = await adjustValue(100);
    const adjustRatio = ratio(adjustWarm.regions.gray, 0, 2);
    assert.ok(adjustRatio >= 1.55 && adjustRatio <= 1.95, `legacy Adjust temperature +100 must match the Grade strength (R/B ${adjustRatio.toFixed(2)})`);
    assert.ok(Math.abs(adjustRatio - ratio(warm.regions.gray, 0, 2)) <= 0.15, 'both temperature paths should have the same strength');
    const adjustDrift = Math.abs(adjustWarm.regions.gray.luma - adjustBaseline.regions.gray.luma) / adjustBaseline.regions.gray.luma;
    assert.ok(adjustDrift <= 0.02, `legacy Adjust temperature must preserve luminance (drift ${(adjustDrift * 100).toFixed(2)}%)`);
    await page.evaluate(() => {
      const input = document.getElementById('sliderTemperature');
      input.value = '0';
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => document.getElementById('gradeTab').click());
    await page.waitForTimeout(500);
    await page.evaluate(PAGE_HELPERS);

    // 2. Highlights and whites: obvious at both ends, no clipping, no dark halo.
    const highlightsUp = await measure('sliderGradeHighlights', 100);
    const highlightsDown = await measure('sliderGradeHighlights', -100);
    assert.ok(highlightsUp.regions.gradientHigh.srgb[0] - baseline.regions.gradientHigh.srgb[0] >= 12,
      `highlights +100 should lift bright tones (${(highlightsUp.regions.gradientHigh.srgb[0] - baseline.regions.gradientHigh.srgb[0]).toFixed(1)} levels)`);
    assert.ok(baseline.regions.gradientHigh.srgb[0] - highlightsDown.regions.gradientHigh.srgb[0] >= 15,
      `highlights -100 should pull bright tones down (${(baseline.regions.gradientHigh.srgb[0] - highlightsDown.regions.gradientHigh.srgb[0]).toFixed(1)} levels)`);
    const whitesUp = await measure('sliderGradeWhites', 100);
    const whitesDown = await measure('sliderGradeWhites', -100);
    assert.ok(whitesUp.regions.gradientHigh.srgb[0] - baseline.regions.gradientHigh.srgb[0] >= 6,
      `whites +100 should lift the top end (${(whitesUp.regions.gradientHigh.srgb[0] - baseline.regions.gradientHigh.srgb[0]).toFixed(1)} levels)`);
    assert.ok(baseline.regions.stepBright.srgb[0] - whitesDown.regions.stepBright.srgb[0] >= 8,
      `whites -100 should recover the top end (${(baseline.regions.stepBright.srgb[0] - whitesDown.regions.stepBright.srgb[0]).toFixed(1)} levels)`);
    for (const [label, shot] of [['highlights +100', highlightsUp], ['whites +100', whitesUp], ['highlights -100', highlightsDown], ['whites -100', whitesDown]]) {
      assert.ok(shot.whole.clipped <= 0.005, `${label} must not blow out the image (${(shot.whole.clipped * 100).toFixed(2)}% clipped)`);
      assert.ok(shot.regions.nearEdgeDark.minValue >= 6, `${label} must not darken the shadow side of an edge (min ${shot.regions.nearEdgeDark.minValue})`);
    }

    // 3. Texture and sharpness: clearly stronger on fine detail, bounded at the edges.
    const textureUp = await measure('sliderGradeTexture', 100);
    const textureDown = await measure('sliderGradeTexture', -100);
    assert.ok(textureUp.regions.softDetail.hf / baseline.regions.softDetail.hf >= 1.5,
      `texture +100 should raise fine detail ~1.5-2x (${((textureUp.regions.softDetail.hf / baseline.regions.softDetail.hf - 1) * 100).toFixed(0)}%)`);
    assert.ok(textureDown.regions.softDetail.hf / baseline.regions.softDetail.hf <= 0.6,
      `texture -100 should visibly soften (${((textureDown.regions.softDetail.hf / baseline.regions.softDetail.hf - 1) * 100).toFixed(0)}%)`);
    const sharpen = await measure('sliderGradeSharpness', 100);
    assert.ok(sharpen.regions.softDetail.hf / baseline.regions.softDetail.hf >= 1.4,
      `sharpness 100 should raise fine detail (${((sharpen.regions.softDetail.hf / baseline.regions.softDetail.hf - 1) * 100).toFixed(0)}%)`);
    for (const [label, shot] of [['texture +100', textureUp], ['sharpness 100', sharpen]]) {
      assert.ok(shot.whole.clipped <= 0.005, `${label} must not clip (${(shot.whole.clipped * 100).toFixed(2)}% clipped)`);
      assert.ok(shot.regions.nearEdgeBright.maxValue <= 252, `${label} must not create a bright halo (max ${shot.regions.nearEdgeBright.maxValue})`);
    }

    // 4. Noise reduction: ~1.5x stronger, and it keeps more structure than before.
    const denoise = await measure('sliderGradeNoiseReduction', 100);
    assert.ok(denoise.regions.noise.lumaStd / baseline.regions.noise.lumaStd <= 0.6,
      `noise reduction 100 should cut grain (std ${baseline.regions.noise.lumaStd.toFixed(2)} -> ${denoise.regions.noise.lumaStd.toFixed(2)})`);
    assert.ok(denoise.regions.softNoise.lumaStd / baseline.regions.softNoise.lumaStd <= 0.7,
      `noise reduction 100 should calm low-amplitude grain (std ${baseline.regions.softNoise.lumaStd.toFixed(2)} -> ${denoise.regions.softNoise.lumaStd.toFixed(2)})`);
    assert.ok(denoise.regions.fineLines.hf / baseline.regions.fineLines.hf >= 0.4,
      `noise reduction 100 should keep fine structure (${((denoise.regions.fineLines.hf / baseline.regions.fineLines.hf - 1) * 100).toFixed(0)}%)`);

    // 5. Vibrance: muted colours move most, skin moves least, neutrals never gain a cast.
    const vibranceUp = await measure('sliderGradeVibrance', 100);
    const vibranceDown = await measure('sliderGradeVibrance', -100);
    const boostLow = relative(vibranceUp.regions.lowSat.saturation, baseline.regions.lowSat.saturation);
    const boostSat = relative(vibranceUp.regions.saturated.saturation, baseline.regions.saturated.saturation);
    const boostSkin = relative(vibranceUp.regions.skin.saturation, baseline.regions.skin.saturation);
    assert.ok(boostLow >= 0.4, `vibrance +100 should visibly lift muted colours (${(boostLow * 100).toFixed(0)}%)`);
    assert.ok(boostLow >= boostSat * 1.4, `vibrance must favour low-saturation colours (low ${(boostLow * 100).toFixed(0)}% vs saturated ${(boostSat * 100).toFixed(0)}%)`);
    assert.ok(boostLow >= boostSkin * 1.6, `vibrance must protect skin tones (low ${(boostLow * 100).toFixed(0)}% vs skin ${(boostSkin * 100).toFixed(0)}%)`);
    const cast = Math.abs(vibranceUp.regions.gray.srgb[0] - vibranceUp.regions.gray.srgb[2]);
    assert.ok(cast <= 3, `vibrance +100 must leave neutral greys neutral (R-B ${cast.toFixed(1)})`);
    assert.ok(Math.abs(vibranceUp.regions.gray.luma - baseline.regions.gray.luma) / baseline.regions.gray.luma <= 0.02, 'vibrance must not change overall brightness');
    const dropLow = relative(baseline.regions.lowSat.saturation, vibranceDown.regions.lowSat.saturation);
    const dropSkin = relative(baseline.regions.skin.saturation, vibranceDown.regions.skin.saturation);
    const dropSat = relative(baseline.regions.saturated.saturation, vibranceDown.regions.saturated.saturation);
    assert.ok(dropLow >= 0.55, `vibrance -100 should clearly desaturate muted colours (${(dropLow * 100).toFixed(0)}%)`);
    assert.ok(dropSat >= 0.25, `vibrance -100 should desaturate saturated colours (${(dropSat * 100).toFixed(0)}%)`);
    assert.ok(dropSkin <= 0.35 && dropSkin < dropLow, `vibrance -100 should spare skin tones (${(dropSkin * 100).toFixed(0)}%)`);
    assert.ok(Math.abs(vibranceDown.regions.gray.srgb[0] - vibranceDown.regions.gray.srgb[2]) <= 3, 'vibrance -100 must leave neutral greys neutral');

    // 6. Vignette: Lightroom direction (negative darkens, positive lightens), centre untouched.
    const vignetteDark = await measure('sliderGradeVignette', -100);
    const vignetteLight = await measure('sliderGradeVignette', 100);
    assert.ok(baseline.regions.corner.srgb[0] - vignetteDark.regions.corner.srgb[0] >= 40,
      `grade vignette -100 must darken the corners (${(baseline.regions.corner.srgb[0] - vignetteDark.regions.corner.srgb[0]).toFixed(1)} levels)`);
    assert.ok(vignetteLight.regions.corner.srgb[0] - baseline.regions.corner.srgb[0] >= 25,
      `grade vignette +100 must lighten the corners (${(vignetteLight.regions.corner.srgb[0] - baseline.regions.corner.srgb[0]).toFixed(1)} levels)`);
    assert.ok(Math.abs(vignetteDark.regions.centre.srgb[0] - baseline.regions.centre.srgb[0]) <= 2, 'vignette must leave the centre alone');
    assert.ok(Math.abs(vignetteLight.regions.centre.srgb[0] - baseline.regions.centre.srgb[0]) <= 2, 'vignette must leave the centre alone');
    await resetGrade();
    await page.evaluate(() => { document.getElementById('adjustTab').click(); for (const section of document.querySelectorAll('#adjustPanel details')) section.open = true; });
    await page.waitForTimeout(500);
    await page.evaluate(PAGE_HELPERS);
    const adjustCorner = await page.evaluate(regions => window.__baseline(regions), REGIONS);
    const adjustVignette = async value => {
      await page.evaluate(({value}) => {
        const input = document.getElementById('sliderVignStrength');
        input.value = String(value);
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
      }, {value});
      await page.waitForTimeout(700);
      return page.evaluate(regions => window.__snap(regions), REGIONS);
    };
    const adjustDark = await adjustVignette(-100);
    const adjustLight = await adjustVignette(100);
    assert.ok(adjustCorner.regions.corner.srgb[0] - adjustDark.regions.corner.srgb[0] >= 15,
      `Adjust vignette -100 must darken the corners (${(adjustCorner.regions.corner.srgb[0] - adjustDark.regions.corner.srgb[0]).toFixed(1)} levels)`);
    assert.ok(adjustLight.regions.corner.srgb[0] - adjustCorner.regions.corner.srgb[0] >= 8,
      `Adjust vignette +100 must lighten the corners (${(adjustLight.regions.corner.srgb[0] - adjustCorner.regions.corner.srgb[0]).toFixed(1)} levels)`);
    assert.ok(Math.abs(adjustDark.regions.centre.srgb[0] - adjustCorner.regions.centre.srgb[0]) <= 3, 'Adjust vignette must leave the centre alone');

    const shaderErrors = errors.filter(text => /no precision specified|shader|glsl|compile/i.test(text));
    assert.deepEqual(shaderErrors, [], `shader errors in Chromium: ${shaderErrors.join(' | ')}`);
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});

test('stored looks and links migrate to the new vignette direction without changing the look', {timeout: 240000}, async t => {
  if (!available) {
    t.skip('Playwright and/or a Chromium build are not available in this environment');
    return;
  }
  const server = await startStaticServer();
  const browser = await playwright.chromium.launch({executablePath: chromiumPath, args: CHROMIUM_ARGS, env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS}});
  try {
    const fixture = chartFixture();
    // An old settings link (version 1) and old saved presets: a grading preset written before the
    // flip and a custom look preset on the older data version. The link is loaded the way a shared
    // link is: through the URL hash on first paint.
    const legacyLook = Buffer.from(JSON.stringify({
      version: 1, values: {VignStrength: 60, Exposure: 10}, effects: {},
      scope: 'full', preset: null, export: {}, dither: {},
    }), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const {context, page, errors} = await openApp(browser, {init: () => {
      localStorage.setItem('film_lab_user_grade_presets_v1', JSON.stringify({
        format: 'film-lab-color-presets', version: 1,
        presets: [{name: 'Old grade', category: 'My Looks', snapshot: {values: {sliderGradeVignette: 18, sliderGradeContrast: 12}}}],
      }));
      localStorage.setItem('film_lab_presets_v4', JSON.stringify([{name: 'Old look', values: {VignStrength: 40, Exposure: -20}, version: 2}]));
    }, hash: `#look=v1.${legacyLook}`});
    const shared = await page.evaluate(() => Number(document.getElementById('sliderVignStrength').value));
    assert.equal(shared, -60, `a v1 look link must load as the negated value, saw ${shared}`);
    assert.equal(await page.evaluate(() => document.getElementById('settingsStatus').textContent), 'Shared look loaded. Upload your own photos to use it.');
    await loadPhoto(page, fixture);
    // The saved grading preset is migrated when it is read back.
    const cards = await page.evaluate(() => [...document.querySelectorAll('#gradePresetGrid .gradePresetCard')].map(card => card.textContent.trim()));
    const oldGradeCard = cards.findIndex(text => text.includes('Old grade'));
    assert.ok(oldGradeCard >= 0, `expected the saved grade preset among ${cards.length} cards`);
    await page.evaluate(index => {
      const card = [...document.querySelectorAll('#gradePresetGrid .gradePresetCard')][index];
      (card.querySelector('button') || card).click();
    }, oldGradeCard);
    await page.waitForTimeout(800);
    const migratedVignette = await page.evaluate(() => Number(document.getElementById('sliderGradeVignette').value));
    assert.equal(migratedVignette, -18, `a v1 grading snapshot must load with the negated vignette, saw ${migratedVignette}`);
    assert.equal(await page.evaluate(() => Number(document.getElementById('sliderGradeContrast').value)), 12, 'other snapshot values must be untouched');
    // Applying a built-in look proves the migrated tables still darken the corners.
    await page.evaluate(() => { document.getElementById('gradeTab').click(); });
    const builtin = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#gradePresetGrid .gradePresetCard')];
      const card = cards.find(item => /Teal & Ember/.test(item.textContent));
      if (!card) return null;
      (card.querySelector('button') || card).click();
      return card.textContent.trim();
    });
    assert.ok(builtin, 'expected the Teal & Ember studio preset');
    await page.waitForTimeout(900);
    const builtinVignette = await page.evaluate(() => Number(document.getElementById('sliderGradeVignette').value));
    assert.equal(builtinVignette, -13, `the built-in preset tables must store the Lightroom direction, saw ${builtinVignette}`);
    // Custom look presets: the app rewrites the migrated values back to storage.
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('film_lab_presets_v4') || '[]'));
    const migratedLook = stored.find(item => item.name === 'Old look');
    assert.ok(migratedLook, 'the saved custom look should survive');
    assert.equal(migratedLook.version, 3, 'custom presets move to data version 3');
    assert.equal(migratedLook.values.VignStrength, -40, `stored vignette must be negated, saw ${migratedLook.values.VignStrength}`);
    assert.equal(migratedLook.values.Exposure, -20, 'version 2 exposure is already in the signed range and must not be halved again');
    assert.deepEqual(errors.filter(text => /shader|precision/i.test(text)), []);
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});
