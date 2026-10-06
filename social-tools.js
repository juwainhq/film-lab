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
      type: input.type === 'png' ? 'png' : 'jpeg',
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
  const SETTINGS_VERSION = 2;
  const VIGNETTE_ID = 'VignStrength';
  function sanitizeSettings(input, ids, effectNames) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![1, SETTINGS_VERSION].includes(Number(input.version)) || !input.values || typeof input.values !== 'object' || Array.isArray(input.values)) {
      throw new Error('Not a Film Lab settings file');
    }
    const legacyVignette = Number(input.version) < SETTINGS_VERSION;
    const values = {};
    let recognized = 0;
    for (const id of ids) {
      if (own(input.values, id) && typeof input.values[id] === 'number' && Number.isFinite(input.values[id])) recognized++;
      const value = legacyVignette && id === VIGNETTE_ID ? -finite(input.values[id], 0) : finite(input.values[id], 0);
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
    if (typeof hash !== 'string' || hash.length > 16000 || !/^#look=v[12]\.[A-Za-z0-9_-]+$/.test(hash)) throw new Error('Invalid look link');
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
  function videoArgs({fps = 24, start = 0, duration, container = 'mp4', quality = 'medium', audio = true, codec, source = 'source-video', output}) {
    const profile = ({low:{crf:'28',webm:'1.5M'},medium:{crf:'20',webm:'4M'},high:{crf:'16',webm:'8M'}})[quality] || {crf:'20',webm:'4M'};
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
  function muxVideoArgs({start = 0, duration, container = 'mp4', audio = true, source = 'source-video'}) {
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', 'segments.txt'];
    if (audio) args.push('-ss', String(start), '-t', String(duration), '-i', source, '-map', '0:v:0', '-map', '1:a:0?');
    else args.push('-an');
    args.push('-t', String(duration), '-c:v', 'copy');
    if (audio) args.push('-c:a', container === 'webm' ? 'libopus' : 'aac', '-b:a', '128k');
    if (container === 'mp4') args.push('-movflags', '+faststart');
    args.push('output.' + container);
    return args;
  }
  return {FORMATS, COMPARISONS, CROP_RATIO_PRESETS, STRAIGHTEN_LIMIT, DEFAULT_EXPORT, DEFAULT_DITHER, MAX_PHOTOS, SETTINGS_VERSION, VIGNETTE_ID, clamp, normalizeExport, normalizeDitherSettings, outputSize, cropRatio, cropRect, moveCrop, cropRatioPreset, clampStraighten, straightenFillScale, normalizeFullSettings, trimRange, autoTrim, timeLabel, sanitizeSettings, encodeSettings, decodeSettings, safeFilename, crc32, createZip, videoArgs, muxVideoArgs};
});
