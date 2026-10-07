#!/usr/bin/env node
/* Verifies the composite-shader film grain on the real editor.

   Usage:
     node scripts/verify-film-grain.cjs [siteDir] [port] [out.json]
     node scripts/verify-film-grain.cjs --self-test

   Drops a flat grey plate into the app and measures the grain the composite shader produces:
   mean / sigma / skew / kurtosis plus a Gaussian (KS) fit, and the axis autocorrelation.

   The autocorrelation is what tells "grain" apart from "texture with a pattern". Real grain is
   white noise shaped by a soft kernel: its profile decays once and never climbs back. A tile,
   grid or streak shows up as a second lobe - the profile falls, then jumps back up at the repeat
   lag. So the decisive numbers are `lobeEnd` (where the blob ends), `biggestRise` (the largest
   upward step after it) and `tailMax` (the largest value after it). The pre-rewrite shader scored
   0.74 / 0.32 / 0.16 on `biggestRise` for Size low/mid/high (its 8 px cell showing up at the
   repeat lag); the rewrite scores under 0.02, i.e. no repeat at any lag.

   `--self-test` runs the same measurements against synthetic fields (white noise, an 8 px tile,
   and blurred blobs) with no browser, so the detector itself is checked: it must stay quiet on
   noise, stay quiet on soft blobs, and fire on a known repeat.

   Needs playwright-core and a Chromium build; resolution mirrors tests/browser-shaders.test.cjs
   and can be overridden with FILM_LAB_PLAYWRIGHT_DIR / FILM_LAB_CHROMIUM_PATH. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : path.join(__dirname, '..'));
const PORT = Number(process.argv[3]) || 8975;
const OUT = process.argv[4] || null;
const SELF_TEST = process.argv.includes('--self-test');
const CROPS_INDEX = process.argv.indexOf('--crops');
const CROPS = CROPS_INDEX > -1 ? path.resolve(process.argv[CROPS_INDEX + 1] || 'grain-crops') : null;
const WINDOW = 256;        // measured plate, in output pixels (centre of the frame)
const MAX_LAG = 60;        // axis autocorrelation is reported out to this lag
const RADIAL_MIN = 20;     // sparse 2D check only looks outside the grain blob
const RADIAL_STEP = 4;
const RADIAL_MAX = 32;

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
const ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webm': 'video/webm', '.wasm': 'application/wasm'};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- measurements

function statistics(values) {
  const n = values.length;
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const value of values) {
    const d = value - mean;
    m2 += d * d; m3 += d * d * d; m4 += d * d * d * d;
  }
  m2 /= n; m3 /= n; m4 /= n;
  const sigma = Math.sqrt(m2);
  return {
    mean, sigma,
    skew: sigma > 1e-9 ? m3 / (sigma ** 3) : 0,
    kurtosis: sigma > 1e-9 ? m4 / (sigma ** 4) : 0,
  };
}
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
function gaussianKs(values, mean, sigma) {
  if (!(sigma > 1e-9)) return 0;
  const sorted = Float64Array.from(values).sort();
  let worst = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const empirical = (i + 0.5) / sorted.length;
    const fitted = 0.5 * (1 + erf((sorted[i] - mean) / (sigma * Math.SQRT2)));
    worst = Math.max(worst, Math.abs(empirical - fitted));
  }
  return worst;
}
// Normalised autocorrelation over a shifted window: r(dx,dy) = sum (a-mu)(b-mu) / (pairs * sigma^2).
// `variance` is the sum of squared deviations for the whole field, so callers can hoist it out of
// the radial scan (625 offsets would otherwise each re-derive the same two moments).
function correlationAt(values, size, dx, dy, mean, variance) {
  let sum = 0, pairs = 0;
  for (let y = 0; y < size; y += 1) {
    const y2 = y + dy;
    if (y2 < 0 || y2 >= size) continue;
    for (let x = 0; x < size; x += 1) {
      const x2 = x + dx;
      if (x2 < 0 || x2 >= size) continue;
      sum += (values[y * size + x] - mean) * (values[y2 * size + x2] - mean);
      pairs += 1;
    }
  }
  if (!pairs || variance <= 0) return 0;
  return sum / (pairs * (variance / values.length));
}
function moments(values) {
  const stats = statistics(values);
  let variance = 0;
  for (const value of values) variance += (value - stats.mean) ** 2;
  return {...stats, variance};
}
function axisProfiles(values, size, mean, variance) {
  const x = [], y = [];
  for (let lag = 0; lag <= MAX_LAG; lag += 1) {
    x.push(correlationAt(values, size, lag, 0, mean, variance));
    y.push(correlationAt(values, size, 0, lag, mean, variance));
  }
  const both = x.map((value, lag) => (value + y[lag]) / 2);
  return {x, y, both};
}
function analyse(values, size) {
  const stats = moments(values);
  const profile = axisProfiles(values, size, stats.mean, stats.variance);
  // The blob end is the first lag where the profile falls below 0.1. If it never falls that far
  // the field is smooth or periodic across the whole range, which no real grain is: mark it and
  // fail the untiled check rather than reporting an empty tail.
  let lobeEnd = null;
  for (let lag = 1; lag < profile.both.length; lag += 1) {
    if (profile.both[lag] < 0.1) { lobeEnd = lag; break; }
  }
  const continuous = lobeEnd === null;
  const from = continuous ? 4 : lobeEnd + 1;
  let tailMax = 0, tailMaxAt = 0, biggestRise = 0, biggestRiseAt = 0;
  for (let lag = from; lag < profile.both.length; lag += 1) {
    if (profile.both[lag] > tailMax) { tailMax = profile.both[lag]; tailMaxAt = lag; }
    const rise = profile.both[lag] - profile.both[lag - 1];
    if (rise > biggestRise) { biggestRise = rise; biggestRiseAt = lag; }
  }
  let radialWorst = 0, radialWorstAt = null, radialSum = 0, radialCount = 0;
  for (let dy = -RADIAL_MAX; dy <= RADIAL_MAX; dy += RADIAL_STEP) {
    for (let dx = -RADIAL_MAX; dx <= RADIAL_MAX; dx += RADIAL_STEP) {
      if (Math.hypot(dx, dy) < RADIAL_MIN || (dx === 0 && dy === 0)) continue;
      const value = correlationAt(values, size, dx, dy, stats.mean, stats.variance);
      radialSum += value; radialCount += 1;
      if (Math.abs(value) > Math.abs(radialWorst)) { radialWorst = value; radialWorstAt = `${dx},${dy}`; }
    }
  }
  return {
    mean: stats.mean, sigma: stats.sigma, skew: stats.skew, kurtosis: stats.kurtosis,
    gaussianKs: gaussianKs(values, stats.mean, stats.sigma),
    lobeEnd, continuous, tailMax, tailMaxAt, biggestRise, biggestRiseAt,
    radialWorst, radialWorstAt, radialMean: radialCount ? radialSum / radialCount : 0,
    axisX: profile.x, axisY: profile.y, axis: profile.both,
  };
}
function correlation(a, b) {
  const {mean: ma} = statistics(a), {mean: mb} = statistics(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}
// A blank plate has no grain at all, so a repeat can never be visible; single-pixel structure
// (a grid or a dither pattern) would still light up the tail check.
function verdict(entry) {
  return {
    untiled: !entry.continuous && entry.biggestRise < 0.15 && Math.abs(entry.radialMean) < 0.1,
    gaussian: entry.gaussianKs < 0.05,
    neutral: Math.abs(entry.mean - 128) < 0.5,
  };
}

// ---------------------------------------------------------------- self test

function selfTest() {
  const size = WINDOW;
  let seed = 12345;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gaussian = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
  const noise = () => Float64Array.from({length: size * size}, () => 128 + gaussian() * 7);
  const tile = 8;
  const cell = Float64Array.from({length: tile * tile}, () => gaussian() * 7);
  const tiled = Float64Array.from({length: size * size}, (_, i) => 128 + cell[(i % size) % tile + (((i / size) | 0) % tile) * tile]);
  const blurred = (() => {
    const source = noise();
    const out = new Float64Array(source.length);
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      let sum = 0, count = 0;
      for (let dy = -3; dy <= 3; dy += 1) for (let dx = -3; dx <= 3; dx += 1) {
        const x2 = x + dx, y2 = y + dy;
        if (x2 < 0 || y2 < 0 || x2 >= size || y2 >= size) continue;
        sum += source[y2 * size + x2]; count += 1;
      }
      out[y * size + x] = sum / count;
    }
    return out;
  })();
  const cases = [
    {name: 'white noise', field: noise(), maxRise: 0.05},
    {name: '8 px tile', field: tiled, minRise: 0.3},
    {name: 'soft blobs', field: blurred, maxRise: 0.05},
  ];
  let failed = 0;
  for (const testCase of cases) {
    const result = analyse(testCase.field, size);
    const pass = testCase.minRise !== undefined
      ? result.biggestRise >= testCase.minRise
      : result.biggestRise <= testCase.maxRise;
    if (!pass) failed += 1;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${testCase.name.padEnd(12)} sigma ${result.sigma.toFixed(2)}  lobeEnd ${String(result.lobeEnd).padStart(4)}  biggestRise ${result.biggestRise.toFixed(4)} @lag ${String(result.biggestRiseAt).padStart(2)}  tailMax ${result.tailMax.toFixed(4)}  radialMean ${result.radialMean.toFixed(4)}`);
  }
  console.log(failed ? `\n${failed} self-test check(s) failed` : '\nself-test: detector fires on a repeat and stays quiet on noise and blobs');
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------- browser run

function serve(root, port) {
  const server = http.createServer((request, response) => {
    const url = decodeURIComponent((request.url || '/').split('?')[0]);
    const file = path.resolve(root, url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404); response.end('not found'); return;
    }
    response.writeHead(200, {'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'});
    fs.createReadStream(file).pipe(response);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}
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
const HELPERS = `() => {
  window.__flat = (level, edge = 1024) => new Promise(resolve => {
    const canvas = document.createElement('canvas');
    canvas.width = edge; canvas.height = edge;
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgb(' + level + ',' + level + ',' + level + ')';
    context.fillRect(0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'flat-' + level + '.png', {type: 'image/png'}));
      window.dispatchEvent(new DragEvent('drop', {dataTransfer: transfer, bubbles: true, cancelable: true}));
      resolve(true);
    }, 'image/png');
  });
  window.__setGrain = values => {
    const ids = {amount: 'sliderGrain', size: 'sliderGrainSize', rough: 'sliderGrainRough'};
    for (const [key, value] of Object.entries(values)) {
      const slider = document.getElementById(ids[key]);
      slider.value = String(value);
      slider.dispatchEvent(new Event('input', {bubbles: true}));
    }
    return true;
  };
  window.__crop = (edge = 180, scale = 3) => {
    const canvas = document.getElementById('glCanvas');
    const size = Math.min(edge, canvas.width, canvas.height);
    const x = Math.floor((canvas.width - size) / 2), y = Math.floor((canvas.height - size) / 2);
    const out = document.createElement('canvas');
    out.width = size * scale; out.height = size * scale;
    const context = out.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.drawImage(canvas, x, y, size, size, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  };
  window.__read = (edge) => {
    const canvas = document.getElementById('glCanvas');
    const size = Math.min(edge, canvas.width, canvas.height);
    const x = Math.floor((canvas.width - size) / 2), y = Math.floor((canvas.height - size) / 2);
    const scratch = document.createElement('canvas');
    scratch.width = size; scratch.height = size;
    const context = scratch.getContext('2d');
    context.drawImage(canvas, x, y, size, size, 0, 0, size, size);
    const data = context.getImageData(0, 0, size, size).data;
    const values = new Array(size * size);
    for (let i = 0; i < values.length; i += 1) {
      values[i] = data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722;
    }
    return {size, values};
  };
}`;

async function main() {
  const playwright = resolvePlaywright();
  const chromium = resolveChromium();
  if (!playwright || !chromium) {
    console.error('skipped: needs playwright-core and a Chromium build');
    console.error('  playwright candidates: ' + PW_CANDIDATES.join(', '));
    console.error('  browser candidates:    ' + BROWSER_CANDIDATES.join(', '));
    console.error('  set FILM_LAB_PLAYWRIGHT_DIR / FILM_LAB_CHROMIUM_PATH to override');
    return 1;
  }
  const server = await serve(ROOT, PORT);
  const browser = await playwright.chromium.launch({executablePath: chromium, args: ARGS, env: {...process.env, LD_LIBRARY_PATH: CHROME_LIBS}});
  const consoleErrors = [];
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (/fonts\.googleapis|ERR_CONNECTION|ERR_BLOCKED/.test(text)) return;
      consoleErrors.push(text);
    });
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, {waitUntil: 'load'});
    await page.waitForFunction(() => !!document.getElementById('glCanvas'));
    await page.waitForTimeout(1500);
    await page.evaluate(eval(HELPERS));
    const sample = (edge = WINDOW) => page.evaluate(size => {
      const read = window.__read(size);
      return {size: read.size, values: read.values};
    }, edge);
    const setGrain = values => page.evaluate(settings => window.__setGrain(settings), values);
    const dropFlat = () => page.evaluate(() => window.__flat(128, 1024));
    if (CROPS) fs.mkdirSync(CROPS, {recursive: true});
    const capture = async name => {
      if (!CROPS) return;
      const dataUrl = await page.evaluate(() => window.__crop(180, 3));
      const file = path.join(CROPS, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log(`crop ${file}`);
    };

    // Load the plate with the grain off and wait until the neutral frame actually shows 128.
    await setGrain({amount: 0});
    await dropFlat();
    const deadline = Date.now() + 45000;
    let ready = false;
    while (Date.now() < deadline) {
      const probe = await sample(32);
      if (probe.size >= 32 && Math.abs(statistics(probe.values).mean - 128) < 1) { ready = true; break; }
      await wait(400);
    }
    if (!ready) throw new Error('the flat plate never rendered a neutral frame');
    await wait(600);

    const results = {site: ROOT, cleanPlate: null, sizes: {}, tight: null, stability: null, consoleErrors};
    const clean = await sample();
    results.cleanPlate = {...analyse(clean.values, clean.size), size: clean.size};
    await capture('clean-plate');

    const ladder = [['low', 0], ['mid', 50], ['high', 100]];
    for (const [label, size] of ladder) {
      await setGrain({amount: 80, size, rough: 50});
      await wait(500);
      await capture(`size-${label}`);
      const first = await sample();
      const second = await sample();
      const measured = analyse(first.values, first.size);
      results.sizes[label] = {...measured, slider: size, size: first.size, verdict: verdict(measured)};
      if (label === 'mid') {
        results.stability = Number(correlation(first.values, second.values).toFixed(4));
        results.tight = {...analyse(second.values, second.size), size: second.size};
      }
    }
    const report = results.sizes;
    console.log(`film grain on a flat 128 plate, Amount 80  (${results.cleanPlate.size} px window)`);
    console.log(`clean plate: mean ${results.cleanPlate.mean.toFixed(3)}  sigma ${results.cleanPlate.sigma.toFixed(3)}`);
    console.log('');
    console.log('Size   mean     sigma   skew    kurt    KS      lobeEnd  tailMax (lag)    biggestRise (lag)  radialWorst  untiled');
    for (const [label] of ladder) {
      const entry = report[label];
      console.log(`${label.padEnd(6)} ${entry.mean.toFixed(3).padStart(8)} ${entry.sigma.toFixed(3).padStart(7)} ${entry.skew.toFixed(3).padStart(7)} ${entry.kurtosis.toFixed(3).padStart(7)} ${entry.gaussianKs.toFixed(4).padStart(7)} ${String(entry.lobeEnd).padStart(8)} ${entry.tailMax.toFixed(4).padStart(9)} (${String(entry.tailMaxAt).padStart(2)}) ${entry.biggestRise.toFixed(4).padStart(12)} (${String(entry.biggestRiseAt).padStart(2)}) ${entry.radialWorst.toFixed(4).padStart(12)} ${entry.verdict.untiled ? 'yes' : 'NO'}`);
    }
    console.log(`\nphoto stability over two reads: correlation ${results.stability} (must be 1.0000)`);
    console.log(`console errors: ${consoleErrors.length ? consoleErrors.join(' | ') : 'none'}`);
    if (OUT) {
      fs.writeFileSync(OUT, JSON.stringify({...results, help: 'axis = normalised autocorrelation of the luminance over the centre 256 px; biggestRise is the largest upward step after the blob and is the tile/grid detector'}, null, 2));
      console.log(`wrote ${OUT}`);
    }
    const failures = [];
    if (report.low.biggestRise >= 0.15 || report.mid.biggestRise >= 0.15 || report.high.biggestRise >= 0.15) failures.push('a repeat lag is visible (biggestRise >= 0.15)');
    if (results.cleanPlate.sigma > 0.001) failures.push(`clean plate is not flat (sigma ${results.cleanPlate.sigma.toFixed(3)})`);
    for (const [label] of ladder) {
      if (!report[label].verdict.gaussian) failures.push(`${label}: not Gaussian (KS ${report[label].gaussianKs.toFixed(4)})`);
      if (!report[label].verdict.neutral) failures.push(`${label}: mean ${report[label].mean.toFixed(3)} is off neutral`);
    }
    if (results.stability !== 1) failures.push(`photo grain is not stable between renders (${results.stability})`);
    if (consoleErrors.length) failures.push(`${consoleErrors.length} console error(s)`);
    if (failures.length) {
      console.error('\nFAILED:\n  ' + failures.join('\n  '));
      return 1;
    }
    console.log('\nPASS: soft, round, random grain - no repeat lag, bell-shaped, neutral, stable per photo');
    return 0;
  } finally {
    await browser.close();
    server.close();
  }
}

if (SELF_TEST) process.exit(selfTest());
main().then(code => process.exit(code)).catch(error => { console.error('FAILED', error.message); process.exit(1); });
