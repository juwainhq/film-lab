/* Pure, dependency-free helpers for the Instagram workflow. Also used by Node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FilmSocial = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const FORMATS = Object.freeze({
    original: {label: 'Original', width: 0, height: 0},
    square: {label: 'Square post', width: 1080, height: 1080},
    portrait: {label: 'Portrait post', width: 1080, height: 1350},
    story: {label: 'Story / Reel', width: 1080, height: 1920},
    landscape: {label: 'Landscape', width: 1080, height: 566},
    // Added for the Lightroom-style crop presets. Both ratios stay exact so a 16:9 or 3:2
    // frame never shifts the crop by a rounding error.
    wide: {label: 'Wide 16:9', width: 1600, height: 900},
    threeTwo: {label: 'Photo 3:2', width: 1080, height: 720},
  });
  // The crop preset row reads like Lightroom's ratio list and drives the existing formats.
  const CROP_RATIO_PRESETS = Object.freeze([
    Object.freeze({id: '1:1', label: '1:1', format: 'square'}),
    Object.freeze({id: '4:5', label: '4:5', format: 'portrait'}),
    Object.freeze({id: '16:9', label: '16:9', format: 'wide'}),
    Object.freeze({id: '3:2', label: '3:2', format: 'threeTwo'}),
    Object.freeze({id: '9:16', label: '9:16', format: 'story'}),
    Object.freeze({id: 'original', label: 'Original', format: 'original'}),
  ]);
  const COMPARISONS = Object.freeze({
    square: {label: 'Square pair · 1:1', width: 1080, height: 1080},
    landscape: {label: 'Landscape pair · 2:1', width: 2160, height: 1080},
    story: {label: 'Story pair · 9:16', width: 1080, height: 1920},
  });
  const DEFAULT_EXPORT = Object.freeze({format: 'original', type: 'jpeg', quality: 92, comparison: false, comparisonFormat: 'landscape', labels: true});
  const DEFAULT_DITHER = Object.freeze({algorithm:'bayer4',downscale:1,colorMode:'color',paletteSize:16,threshold:0.5,spread:1,angle:0,paletteShadow:'#111111',paletteHighlight:'#f5f5f5'});
  // Export presets: the three Instagram workflows the panel offers. `jpeg` keeps the files small
  // enough for a phone upload, `webp` is the smaller modern option and PNG stays lossless.
  const EXPORT_TYPES = Object.freeze(['jpeg', 'png', 'webp']);
  const EXPORT_TYPE_LABELS = Object.freeze({jpeg: 'JPG', png: 'PNG', webp: 'WebP'});
  const EXPORT_PRESETS = Object.freeze([
    Object.freeze({id: 'instagram', label: 'Instagram 4:5', detail: '1080 wide · 1080 × 1350', format: 'portrait', type: 'jpeg', quality: 92}),
    Object.freeze({id: 'story', label: 'Story / Reel 9:16', detail: '1080 × 1920 · full screen', format: 'story', type: 'jpeg', quality: 92}),
    Object.freeze({id: 'full', label: 'Full quality', detail: 'No crop · 100% quality', format: 'original', type: 'jpeg', quality: 100}),
  ]);
  const DITHER_ALGORITHMS = new Set(['floyd-steinberg','floyd-steinberg-serpentine','stucki','burkes','atkinson','jarvis-judice-ninke','sierra','two-row-sierra','bayer4','bayer8','halftone4','halftone8','halftone','none']);
  const DITHER_COLORS = new Set(['monochrome','duotone','color','custom']);
  const DITHER_PALETTE_SIZES = new Set([2,4,8,16,32]);
  const MAX_PHOTOS = 10;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function normalizeExport(input = {}) {
    if (!input || typeof input !== 'object') input = {};
    return {
      format: own(FORMATS, input.format) ? input.format : DEFAULT_EXPORT.format,
      type: EXPORT_TYPES.includes(input.type) ? input.type : DEFAULT_EXPORT.type,
      quality: Math.round(clamp(finite(input.quality, 92), 80, 100)),
      comparison: input.comparison === true,
      comparisonFormat: own(COMPARISONS, input.comparisonFormat) ? input.comparisonFormat : 'landscape',
      labels: input.labels !== false,
    };
  }
  function normalizeDitherSettings(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
    const color = (value, fallback) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
    const size = Number(input.paletteSize);
    return {
      algorithm: DITHER_ALGORITHMS.has(input.algorithm) ? input.algorithm : DEFAULT_DITHER.algorithm,
      downscale: Math.round(clamp(finite(input.downscale, DEFAULT_DITHER.downscale), 1, 8)),
      colorMode: DITHER_COLORS.has(input.colorMode) ? input.colorMode : DEFAULT_DITHER.colorMode,
      paletteSize: DITHER_PALETTE_SIZES.has(size) ? size : DEFAULT_DITHER.paletteSize,
      threshold: clamp(finite(input.threshold, DEFAULT_DITHER.threshold), 0, 1),
      spread: clamp(finite(input.spread, DEFAULT_DITHER.spread), 0, 2),
      angle: clamp(finite(input.angle, DEFAULT_DITHER.angle), -180, 180),
      paletteShadow: color(input.paletteShadow, DEFAULT_DITHER.paletteShadow),
      paletteHighlight: color(input.paletteHighlight, DEFAULT_DITHER.paletteHighlight),
    };
  }
  function outputSize(options, width, height, video = false) {
    const o = normalizeExport(options);
    const target = o.comparison && !video ? COMPARISONS[o.comparisonFormat] : FORMATS[o.format];
    let w = target.width || Math.max(1, Math.round(width || 1));
    let h = target.height || Math.max(1, Math.round(height || 1));
    // H.264 / yuv420p needs even dimensions. Padding happens after the crop.
    if (video) { w += w % 2; h += h % 2; }
    return {width: w, height: h};
  }
  function cropRatio(options, video = false) {
    const o = normalizeExport(options);
    if (o.comparison && !video) {
      const pair = COMPARISONS[o.comparisonFormat];
      return (pair.width / 2) / pair.height;
    }
    const target = FORMATS[o.format];
    return target.width ? target.width / target.height : null;
  }
  function cropRect(width, height, ratio, position = {}) {
    if (!(width > 0 && height > 0)) throw new Error('Image dimensions are unavailable');
    const r = typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 ? ratio : width / height;
    const w = Math.min(width, height * r), h = Math.min(height, width / r);
    const x = clamp(finite(position.x, 0.5), 0, 1), y = clamp(finite(position.y, 0.5), 0, 1);
    return {x: Math.max(0, width - w) * x, y: Math.max(0, height - h) * y, width: w, height: h};
  }
  function moveCrop(width, height, ratio, position, deltaX, deltaY) {
    const rect = cropRect(width, height, ratio, position);
    const travelX = width - rect.width, travelY = height - rect.height;
    return {
      x: travelX > 0.0001 ? clamp(finite(position.x, 0.5) + deltaX / travelX, 0, 1) : 0.5,
      y: travelY > 0.0001 ? clamp(finite(position.y, 0.5) + deltaY / travelY, 0, 1) : 0.5,
    };
  }
  function trimRange(duration, start, end, changed = 'end') {
    if (!(Number.isFinite(duration) && duration > 0)) throw new Error('Video duration is unavailable');
    const minimum = Math.min(0.1, duration), limit = Math.min(60, duration);
    let a = clamp(finite(start, 0), 0, duration - minimum);
    let b = clamp(finite(end, Math.min(duration, a + limit)), minimum, duration);
    if (b < a + minimum) {
      if (changed === 'start') b = Math.min(duration, a + minimum);
      else a = Math.max(0, b - minimum);
    }
    if (b - a > limit) {
      if (changed === 'start') b = a + limit;
      else a = b - limit;
    }
    return {start: a, end: b};
  }
  function autoTrim(duration, start, seconds) {
    const length = clamp(finite(seconds, 60), 0.1, 60);
    const a = clamp(finite(start, 0), 0, Math.max(0, duration - Math.min(length, duration)));
    return trimRange(duration, a, Math.min(duration, a + length), 'start');
  }
  function timeLabel(seconds) {
    const tenths = Math.round(Math.max(0, finite(seconds, 0)) * 10);
    return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
  }
  // Version 2 flips the vignette slider to Lightroom's direction (negative darkens, positive
  // lightens). Version 1 payloads and #look=v1 links are migrated by negating the stored value so
  // every saved look keeps the corners it had.
  const SETTINGS_VERSION = 3;
  const VIGNETTE_ID = 'VignStrength';
  const TEMPERATURE_ID = 'Temperature';
  // Version 2 flipped the vignette; version 3 rescaled the stored Temperature because the white
  // balance slider is 1.9x stronger (0.20 -> 0.38 in log2 space), so an old value means more now
  // than it did. Both migrations are applied per stored version, never twice.
  const VIGNETTE_VERSION = 2, WHITE_BALANCE_VERSION = 3;
  const WHITE_BALANCE_RESCALE = 0.20 / 0.38;
  function sanitizeSettings(input, ids, effectNames) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![1, 2, SETTINGS_VERSION].includes(Number(input.version)) || !input.values || typeof input.values !== 'object' || Array.isArray(input.values)) {
      throw new Error('Not a Film Lab settings file');
    }
    const version = Number(input.version);
    const legacyVignette = version < VIGNETTE_VERSION;
    const legacyWhiteBalance = version < WHITE_BALANCE_VERSION;
    const values = {};
    let recognized = 0;
    for (const id of ids) {
      if (own(input.values, id) && typeof input.values[id] === 'number' && Number.isFinite(input.values[id])) recognized++;
      let value = finite(input.values[id], 0);
      if (legacyVignette && id === VIGNETTE_ID) value = -value;
      // Old looks kept their colour: a stored temperature from the weaker slider is scaled back so
      // the photo renders exactly as it used to.
      if (legacyWhiteBalance && id === TEMPERATURE_ID) value *= WHITE_BALANCE_RESCALE;
      values[id] = Math.round(clamp(value, -100, 100)) + 0; // +0 keeps a negated zero from becoming JSON -0
    }
    if (!recognized) throw new Error('No compatible settings found');
    const effects = {};
    for (const name of effectNames) effects[name] = input.effects?.[name] !== false;
    return {
      version: SETTINGS_VERSION, values, effects, scope: input.scope === 'background' ? 'background' : 'full',
      preset: typeof input.preset === 'string' ? input.preset.slice(0, 120) : null,
      export: normalizeExport(input.export), dither: normalizeDitherSettings(input.dither),
    };
  }
  function encodeSettings(input) {
    const bytes = new TextEncoder().encode(JSON.stringify(input));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
    return '#look=v' + SETTINGS_VERSION + '.' + encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  function decodeSettings(hash, ids, effectNames) {
    if (typeof hash !== 'string' || hash.length > 16000 || !/^#look=v[123]\.[A-Za-z0-9_-]+$/.test(hash)) throw new Error('Invalid look link');
    const encoded = hash.slice(9).replace(/-/g, '+').replace(/_/g, '/');
    const padded = encoded + '='.repeat((4 - encoded.length % 4) % 4);
    const bytes = typeof atob === 'function'
      ? Uint8Array.from(atob(padded), char => char.charCodeAt(0))
      : new Uint8Array(Buffer.from(padded, 'base64'));
    return sanitizeSettings(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)), ids, effectNames);
  }
  // Straighten is a Lightroom-style ±45° rotation of the whole frame. The preview and the export
  // rotate about the frame centre and scale up just enough to keep the corners covered, so the
  // crop rectangle never shows a transparent wedge.
  const STRAIGHTEN_LIMIT = 45;
  function clampStraighten(angle, limit = STRAIGHTEN_LIMIT) {
    const value = Number(angle);
    if (!Number.isFinite(value)) return 0;
    return clamp(Math.round(value * 2) / 2, -Math.abs(limit), Math.abs(limit)) + 0;
  }
  function straightenFillScale(width, height, angle) {
    const w = Math.max(1, Number(width) || 1), h = Math.max(1, Number(height) || 1);
    const radians = Math.abs(clampStraighten(angle)) * Math.PI / 180;
    if (!radians) return 1;
    const cosine = Math.cos(radians), sine = Math.sin(radians);
    return cosine + sine * Math.max(h / w, w / h);
  }
  function cropRatioPreset(id) {
    return CROP_RATIO_PRESETS.find(preset => preset.id === id || preset.format === id) || null;
  }
  function exportPreset(id) {
    const preset = EXPORT_PRESETS.find(entry => entry.id === id);
    return preset ? {...preset} : null;
  }
  function exportMimeType(type) {
    return ({png: 'image/png', webp: 'image/webp'})[type] || 'image/jpeg';
  }
  function exportExtension(type) {
    return ({png: 'png', webp: 'webp'})[type] || 'jpg';
  }
  // PNG is lossless, so the quality slider does not apply to it.
  function exportQualityApplies(type) {
    return type !== 'png';
  }
  // What the encoder actually produced decides the extension and the label: a browser that
  // silently falls back to JPEG must not hand the user a file called .webp.
  function exportFormatFor(requestedType, blobType) {
    const labels = {jpeg: 'JPG', png: 'PNG', webp: 'WebP'};
    const mime = typeof blobType === 'string' ? blobType : blobType && blobType.type;
    const fromMime = mime === 'image/webp' ? 'webp' : mime === 'image/png' ? 'png' : mime ? 'jpeg' : null;
    const type = fromMime || (EXPORT_TYPES.includes(requestedType) ? requestedType : 'jpeg');
    return {type, extension: exportExtension(type), label: labels[type] || 'JPG', qualityApplies: exportQualityApplies(type)};
  }
  // === Perspective / keystone ================================================================
  // The preview shader maps an output coordinate to a source coordinate with the inverse of a
  // projective (homography) warp:
  //   p = (uv - 0.5) * 2      p' = p * scale / (1 - kH*p.x - kV*p.y)      uv' = p' * 0.5 + 0.5
  // Both helpers below mirror that maths on the CPU so the fill scale, the eyedropper sample and
  // the brush coordinates agree with what the GPU draws.
  const KEYSTONE_LIMIT = 0.22;
  function keystoneAmount(value) {
    return clamp(finite(Number(value), 0), -100, 100) / 100 * KEYSTONE_LIMIT;
  }
  // The warp divides by (1 - kH*x - kV*y), which magnifies the side that moves towards the camera.
  // Sampling therefore has to shrink by the smallest corner denominator, otherwise the magnified
  // corners would read outside the photo and smear; shrinking is what an auto-crop does — the
  // frame stays full, at the cost of a little of the original edges.
  function keystoneFillScale(vertical, horizontal) {
    const kV = keystoneAmount(vertical), kH = keystoneAmount(horizontal);
    if (!kV && !kH) return 1;
    return clamp(1 - Math.abs(kH) - Math.abs(kV), 0.3, 1);
  }
  // Output (normalized) point -> source (normalized) point, the same direction the shader uses.
  function keystoneMapPoint(vertical, horizontal, x, y) {
    const kV = keystoneAmount(vertical), kH = keystoneAmount(horizontal);
    const px = (finite(Number(x), 0.5) - 0.5) * 2, py = (finite(Number(y), 0.5) - 0.5) * 2;
    if (!kV && !kH) return {x: clamp(px * 0.5 + 0.5, 0, 1), y: clamp(py * 0.5 + 0.5, 0, 1)};
    const scale = keystoneFillScale(vertical, horizontal);
    const denominator = Math.max(0.2, 1 - kH * px - kV * py);
    return {x: clamp(px * scale / denominator * 0.5 + 0.5, 0, 1), y: clamp(py * scale / denominator * 0.5 + 0.5, 0, 1)};
  }
  // Source point -> output point: what the brush, the heal tool and the eyedropper need to read
  // the pixel under the pointer. The warp is linear in the source point once the denominator is
  // substituted, so it inverts exactly instead of by iteration.
  //   q = p * s / d(p)   with d(p) = 1 - kH*px - kV*py
  //   (s + qx*kH) px + (qx*kV) py = qx
  //          (qy*kH) px + (s + qy*kV) py = qy
  function keystoneInversePoint(vertical, horizontal, x, y) {
    const kV = keystoneAmount(vertical), kH = keystoneAmount(horizontal);
    const scale = keystoneFillScale(vertical, horizontal);
    const qx = (clamp(finite(Number(x), 0.5), 0, 1) - 0.5) * 2, qy = (clamp(finite(Number(y), 0.5), 0, 1) - 0.5) * 2;
    if (!kV && !kH) {
      const px = qx * scale, py = qy * scale;
      return {x: clamp(px * 0.5 + 0.5, 0, 1), y: clamp(py * 0.5 + 0.5, 0, 1)};
    }
    const a = scale + qx * kH, b = qx * kV, c = qy * kH, d = scale + qy * kV;
    const determinant = a * d - b * c;
    const px = Math.abs(determinant) < 1e-9 ? qx * scale : (qx * d - b * qy) / determinant;
    const py = Math.abs(determinant) < 1e-9 ? qy * scale : (a * qy - qx * c) / determinant;
    return {x: clamp(px * 0.5 + 0.5, 0, 1), y: clamp(py * 0.5 + 0.5, 0, 1)};
  }
  // Flip / mirror, shared by the shader uniforms and the pointer mapping.
  function flipPoint(x, y, horizontalFlip, verticalFlip) {
    const nx = clamp(finite(Number(x), 0.5), 0, 1), ny = clamp(finite(Number(y), 0.5), 0, 1);
    return {x: horizontalFlip ? 1 - nx : nx, y: verticalFlip ? 1 - ny : ny};
  }
  // === Lens blur ============================================================================
  // Strength is the blur radius behind the subject, feather is how far the transition between the
  // sharp subject and the blurred background spreads.
  function normalizeLensBlur(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return {
      strength: Math.round(clamp(finite(Number(source.strength), 0), 0, 100)),
      feather: Math.round(clamp(finite(Number(source.feather), 30), 0, 100)),
    };
  }
  // Pixel radius for the half-resolution blur passes; scaled by the frame so the look is the same
  // on a phone preview and a full-size export.
  function lensBlurRadius(strength, width, height) {
    const amount = clamp(finite(Number(strength), 0), 0, 100) / 100;
    if (!amount) return 0;
    const reference = Math.max(1, Math.min(finite(Number(width), 1), finite(Number(height), 1)));
    return Math.max(1, amount * (4 + reference * 0.02));
  }
  // CSS matrix3d (column-major argument order) for the same warp, so an overlay canvas laid over
  // the preview lines up with the photo. Returns 16 numbers; identity when the geometry is neutral.
  function geometryOverlayMatrix(geometry, width, height) {
    const g = normalizeGeometry(geometry);
    const w = Math.max(1, finite(Number(width), 1)), h = Math.max(1, finite(Number(height), 1));
    const kH = g.keystoneH / 100 * KEYSTONE_LIMIT, kV = g.keystoneV / 100 * KEYSTONE_LIMIT;
    const scale = keystoneFillScale(g.keystoneV, g.keystoneH);
    const flipX = g.flipH ? -1 : 1, flipY = g.flipV ? -1 : 1;
    const sum = 1 + kH * flipX + kV * flipY;
    const a = 2 * flipX * (scale - kH);
    const b = -2 * kH * flipX * h / w;
    const c = -2 * kV * flipY * w / h;
    const f = 2 * flipY * (scale - kV);
    // The denominator is 2*d, so the w row carries twice the d coefficients.
    return [
      a, b, 0, -4 * kH * flipX / w,
      c, f, 0, -4 * kV * flipY / h,
      0, 0, 1, 0,
      w * (sum - scale * flipX), h * (sum - scale * flipY), 0, 2 * sum,
    ];
  }
  function normalizeGeometry(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return {
      flipH: source.flipH === true,
      flipV: source.flipV === true,
      keystoneV: Math.round(clamp(finite(Number(source.keystoneV), 0), -100, 100)),
      keystoneH: Math.round(clamp(finite(Number(source.keystoneH), 0), -100, 100)),
    };
  }
  function geometryIsNeutral(geometry) {
    const g = normalizeGeometry(geometry);
    return !g.flipH && !g.flipV && !g.keystoneV && !g.keystoneH;
  }
  // === Spot heal =============================================================================
  // One dab fills a disc from a nearby patch. The patch is chosen by matching the ring of pixels
  // just outside the disc, so the fill picks up the surrounding texture and colour instead of a
  // flat average; the result is then blended in with a soft edge so no seam is left behind.
  function normalizeHealStrokes(input, limit = 400) {
    if (!Array.isArray(input)) return [];
    const strokes = [];
    for (const entry of input.slice(0, limit)) {
      if (!entry || typeof entry !== 'object') continue;
      const x = finite(Number(entry.x), NaN), y = finite(Number(entry.y), NaN), r = finite(Number(entry.r), NaN);
      if (![x, y, r].every(Number.isFinite)) continue;
      strokes.push({x: clamp(x, 0, 1), y: clamp(y, 0, 1), r: clamp(r, 0.004, 0.3)});
    }
    return strokes;
  }
  function healRingSamples(size = 16) {
    const count = Math.max(6, Math.min(48, Math.round(size)));
    const points = [];
    for (let index = 0; index < count; index++) {
      const angle = index / count * Math.PI * 2;
      points.push({x: Math.cos(angle), y: Math.sin(angle)});
    }
    return points;
  }
  // Candidate source offsets, ordered by distance so the closest usable patch wins ties.
  function healPatchOffsets(radiusPixels, ring = 4) {
    const offsets = [];
    for (const factor of [1.35, 1.7, 2.1, 2.6, 3.2].slice(0, Math.max(1, ring))) {
      for (let index = 0; index < 12; index++) {
        const angle = index / 12 * Math.PI * 2 + (factor - 1.35) * 0.9;
        offsets.push({x: Math.cos(angle) * radiusPixels * factor, y: Math.sin(angle) * radiusPixels * factor});
      }
    }
    return offsets;
  }

  // Snapshot / clipboard payloads carry the Adjust values, the Color Grade state, the crop angle
  // and the source photo name. `settings` keeps the existing sanitizeSettings shape so shared
  // look links stay byte-compatible.
  function normalizeFullSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Not a Film Lab settings payload');
    const source = input.settings && typeof input.settings === 'object' ? input.settings : input;
    if (!source.values || typeof source.values !== 'object') throw new Error('Not a Film Lab settings payload');
    const grade = input.grade && typeof input.grade === 'object' && !Array.isArray(input.grade) ? JSON.parse(JSON.stringify(input.grade)) : null;
    const position = input.crop && typeof input.crop === 'object' ? input.crop : null;
    return {
      settings: JSON.parse(JSON.stringify(source)),
      grade,
      straighten: clampStraighten(input.straighten),
      crop: position ? {x: clamp(finite(position.x, 0.5), 0, 1), y: clamp(finite(position.y, 0.5), 0, 1)} : null,
      geometry: normalizeGeometry(input.geometry),
      lens: normalizeLensBlur(input.lens),
      heal: normalizeHealStrokes(input.heal),
      origin: typeof input.origin === 'string' ? input.origin.slice(0, 120) : null,
    };
  }
  function safeFilename(name) {
    const stem = String(name || 'photo').replace(/\.[^.]+$/, '').normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return stem || 'photo';
  }
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  function crc32(bytes) {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  // JPEG / PNG are already compressed. A standards-compliant stored ZIP avoids a
  // CDN dependency and holds only one image's checksum buffer in memory at a time.
  async function createZip(entries, date = new Date()) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 65535) throw new Error('Invalid ZIP entries');
    const parts = [], central = [], encoder = new TextEncoder();
    let offset = 0, centralSize = 0;
    const year = clamp(date.getFullYear(), 1980, 2107);
    const stampDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const stampTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    for (const entry of entries) {
      if (!(entry.blob instanceof Blob)) throw new Error('ZIP entry must contain a Blob');
      if (!entry.name || /[\\/\u0000]/.test(entry.name) || entry.name === '..') throw new Error('Unsafe ZIP filename');
      const name = encoder.encode(entry.name), size = entry.blob.size;
      if (name.length > 65535 || size > 0xffffffff || offset + size + 30 + name.length > 0xffffffff) throw new Error('ZIP is too large');
      const checksum = crc32(new Uint8Array(await entry.blob.arrayBuffer()));
      const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(10, stampTime, true); lv.setUint16(12, stampDate, true); lv.setUint32(14, checksum, true);
      lv.setUint32(18, size, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true); local.set(name, 30);
      const directory = new Uint8Array(46 + name.length), dv = new DataView(directory.buffer);
      dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(8, 0x0800, true);
      dv.setUint16(12, stampTime, true); dv.setUint16(14, stampDate, true); dv.setUint32(16, checksum, true);
      dv.setUint32(20, size, true); dv.setUint32(24, size, true); dv.setUint16(28, name.length, true); dv.setUint32(42, offset, true); directory.set(name, 46);
      parts.push(local, entry.blob); central.push(directory);
      offset += local.length + size; centralSize += directory.length;
    }
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], {type: 'application/zip'});
  }
  function videoArgs({fps = 24, start = 0, duration, container = 'mp4', quality = 'medium', audio = true, codec, source = 'source-video', output, crf, bitrate}) {
    const base = ({low:{crf:'28',webm:'1.5M'},medium:{crf:'20',webm:'4M'},high:{crf:'16',webm:'8M'}})[quality] || {crf:'20',webm:'4M'};
    // The delivery presets pick their own CRF or bitrate; anything not supplied keeps the old ladder.
    const profile = {crf: crf !== undefined ? String(crf) : base.crf, webm: bitrate ? `${bitrate}M` : base.webm};
    const args = ['-y', '-framerate', String(fps), '-i', 'frame_%04d.jpg'];
    if (audio) args.push('-ss', String(start), '-t', String(duration), '-i', source, '-map', '0:v:0', '-map', '1:a:0?');
    else args.push('-an');
    args.push('-t', String(duration), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p');
    if (container === 'webm') {
      args.push('-c:v', codec || 'libvpx', '-b:v', profile.webm, '-threads', '1', '-deadline', 'realtime', '-cpu-used', '4', '-auto-alt-ref', '0');
      if (audio) args.push('-c:a', 'libopus', '-b:a', '128k');
      args.push(output || 'output.webm');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', profile.crf, '-movflags', '+faststart');
      if (audio) args.push('-c:a', 'aac', '-b:a', '128k');
      args.push(output || 'output.mp4');
    }
    return args;
  }
  function muxVideoArgs({start = 0, duration, container = 'mp4', audio = true, source = 'source-video', extraInputs = [], audioGraph = null, output}) {
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', 'segments.txt'];
    if (audio) args.push('-ss', String(start), '-t', String(duration), '-i', source);
    // Voice takes and any other local audio ride in as further inputs; the graph maps the mix.
    if (audio) for (const input of extraInputs) args.push('-i', input);
    if (audio && !audioGraph) args.push('-map', '0:v:0', '-map', '1:a:0?');
    if (!audio) args.push('-an');
    args.push('-t', String(duration), '-c:v', 'copy');
    if (audio && audioGraph) args.push(...audioGraph);
    if (audio) args.push('-c:a', container === 'webm' ? 'libopus' : 'aac', '-b:a', '128k');
    if (container === 'mp4') args.push('-movflags', '+faststart');
    args.push(output || ('output.' + container));
    return args;
  }
  return {FORMATS, COMPARISONS, CROP_RATIO_PRESETS, EXPORT_TYPES, EXPORT_TYPE_LABELS, EXPORT_PRESETS, KEYSTONE_LIMIT, STRAIGHTEN_LIMIT, DEFAULT_EXPORT, DEFAULT_DITHER, MAX_PHOTOS, SETTINGS_VERSION, VIGNETTE_ID, clamp, normalizeExport, normalizeDitherSettings, outputSize, cropRatio, cropRect, moveCrop, cropRatioPreset, exportPreset, exportMimeType, exportExtension, exportQualityApplies, exportFormatFor, keystoneAmount, keystoneFillScale, keystoneMapPoint, keystoneInversePoint, flipPoint, geometryOverlayMatrix, normalizeGeometry, geometryIsNeutral, normalizeLensBlur, lensBlurRadius, normalizeHealStrokes, healRingSamples, healPatchOffsets, clampStraighten, straightenFillScale, normalizeFullSettings, trimRange, autoTrim, timeLabel, sanitizeSettings, encodeSettings, decodeSettings, safeFilename, crc32, createZip, videoArgs, muxVideoArgs};
});
