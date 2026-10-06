// === FILM LAB VIDEO TOOLS =====================================================================
// The CapCut-style video feature model: keyframes with easing, speed ramps with freeze and
// reverse, text / caption / sticker layers, per-clip blend modes and opacity, and chroma key.
//
// Everything here is deliberately free of app state: the timeline module and the editor both call
// the same helpers, and the same `drawScene` renderer paints the live preview and the export
// frame, which is what keeps "what you see" and "what you download" identical. The chroma key
// maths exists twice on purpose — once as GLSL for the WebGL pass the editor runs, and once as a
// CPU reference used by tests and by the no-WebGL fallback — and a test asserts they agree.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FilmVideo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const round = (value, digits = 3) => Number(Number(value).toFixed(digits));

  /* ------------------------------------------------------------------ blend modes + opacity */
  // The canvas 2D composite names are the CSS mix-blend-mode names, so the preview canvas and the
  // export canvas understand every entry without a translation table.
  const BLEND_MODES = Object.freeze([
    'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
    'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
  ]);
  const BLEND_LABELS = Object.freeze({
    normal: 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken',
    lighten: 'Lighten', 'color-dodge': 'Color dodge', 'color-burn': 'Color burn', 'hard-light': 'Hard light',
    'soft-light': 'Soft light', difference: 'Difference', exclusion: 'Exclusion', hue: 'Hue',
    saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity',
  });
  function normalizeBlend(value) {
    const name = String(value || '').toLowerCase();
    return BLEND_MODES.includes(name) ? name : 'normal';
  }
  function blendOperation(value) {
    const mode = normalizeBlend(value);
    return mode === 'normal' ? 'source-over' : mode;
  }
  function normalizeOpacity(value, fallback = 1) {
    const raw = value === '' || value === null || value === undefined ? fallback : Number(value);
    if (!Number.isFinite(raw)) return fallback;
    // 0..1 in and out; a percentage is accepted too.
    return clamp(raw > 1 ? raw / 100 : raw, 0, 1);
  }

  /* ------------------------------------------------------------------ keyframes + easing */
  const KEYFRAME_PROPERTIES = Object.freeze(['position', 'scale', 'rotation', 'opacity']);
  const PROPERTY_LABELS = Object.freeze({position: 'Position', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity'});
  const EASINGS = Object.freeze(['linear', 'hold', 'ease-in', 'ease-out', 'ease-in-out']);
  const EASING_LABELS = Object.freeze({linear: 'Linear', hold: 'Hold', 'ease-in': 'Ease in', 'ease-out': 'Ease out', 'ease-in-out': 'Ease in-out'});
  function normalizeEasing(value) {
    const name = String(value || '').toLowerCase();
    return EASINGS.includes(name) ? name : 'linear';
  }
  // Progress in, eased progress out. `hold` keeps the previous key until the next one lands.
  function easeValue(easing, progress) {
    const t = clamp(progress, 0, 1);
    switch (normalizeEasing(easing)) {
      case 'hold': return 0;
      case 'ease-in': return t * t;
      case 'ease-out': return 1 - (1 - t) * (1 - t);
      case 'ease-in-out': return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
      default: return t;
    }
  }
  function defaultPropertyValue(property) {
    return property === 'position' ? {x: 0, y: 0} : property === 'opacity' ? 1 : property === 'rotation' ? 0 : 1;
  }
  function normalizePropertyValue(property, value) {
    if (property === 'position') {
      const source = value && typeof value === 'object' ? value : {};
      return {x: round(clamp(finite(source.x, 0), -2, 2), 4), y: round(clamp(finite(source.y, 0), -2, 2), 4)};
    }
    if (property === 'scale') return round(clamp(finite(value, 1), 0.05, 6), 4);
    if (property === 'rotation') return round(clamp(finite(value, 0), -360, 360), 3);
    return round(clamp(finite(value, 1), 0, 1), 4);
  }
  // Keyframes arrive from the UI (or from a saved project) in any order and are stored sorted with
  // one entry per property per time, so sampling is a plain neighbour lookup.
  function normalizeKeyframes(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const output = {};
    for (const property of KEYFRAME_PROPERTIES) {
      const list = Array.isArray(source[property]) ? source[property] : [];
      const seen = new Map();
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const time = round(Math.max(0, finite(entry.time, 0)), 4);
        seen.set(time, {time, value: normalizePropertyValue(property, entry.value), easing: normalizeEasing(entry.easing)});
      }
      output[property] = [...seen.values()].sort((a, b) => a.time - b.time);
    }
    return output;
  }
  function hasKeyframes(keyframes) {
    const list = keyframes && typeof keyframes === 'object' ? keyframes : {};
    return KEYFRAME_PROPERTIES.some((property) => (list[property] || []).length > 0);
  }
  function keyframeTimes(keyframes) {
    const list = keyframes && typeof keyframes === 'object' ? keyframes : {};
    const times = new Set();
    for (const property of KEYFRAME_PROPERTIES) for (const entry of list[property] || []) times.add(entry.time);
    return [...times].sort((a, b) => a - b);
  }
  // The value of one property at one time. Before the first key the first value holds, after the
  // last key the last value holds; between two keys the outgoing key's easing decides the curve.
  function sampleProperty(list, time, fallback) {
    const frames = Array.isArray(list) ? list : [];
    if (!frames.length) return fallback;
    if (time <= frames[0].time) return frames[0].value;
    const last = frames[frames.length - 1];
    if (time >= last.time) return last.value;
    for (let index = 0; index < frames.length - 1; index++) {
      const a = frames[index], b = frames[index + 1];
      if (time < a.time || time > b.time) continue;
      const span = Math.max(1e-6, b.time - a.time);
      const eased = easeValue(a.easing, (time - a.time) / span);
      if (a.value && typeof a.value === 'object') {
        return {x: a.value.x + (b.value.x - a.value.x) * eased, y: a.value.y + (b.value.y - a.value.y) * eased};
      }
      return a.value + (b.value - a.value) * eased;
    }
    return last.value;
  }
  function sampleKeyframes(keyframes, time, fallback = {}) {
    const list = keyframes && typeof keyframes === 'object' ? keyframes : {};
    const output = {};
    for (const property of KEYFRAME_PROPERTIES) {
      output[property] = sampleProperty(list[property], Math.max(0, finite(time, 0)), property in fallback ? fallback[property] : defaultPropertyValue(property));
    }
    return output;
  }
  // A keyframe sits on the playhead within half a frame.
  function keyframeAt(keyframes, property, time, tolerance = 0.5 / 24) {
    const list = (keyframes && keyframes[property]) || [];
    return list.find((entry) => Math.abs(entry.time - time) <= tolerance) || null;
  }
  // The diamond button: on an existing key it removes it, otherwise it records the current value.
  function toggleKeyframe(keyframes, property, time, value, easing = 'linear') {
    const next = normalizeKeyframes(keyframes);
    const at = round(Math.max(0, finite(time, 0)), 4);
    const existing = keyframeAt(next, property, at);
    if (existing) {
      next[property] = next[property].filter((entry) => entry !== existing);
      return {keyframes: next, action: 'removed', time: at, property, easing: existing.easing};
    }
    const entry = {time: at, value: normalizePropertyValue(property, value), easing: normalizeEasing(easing)};
    next[property] = [...next[property].filter((item) => item.time !== at), entry].sort((a, b) => a.time - b.time);
    return {keyframes: next, action: 'added', time: at, property, easing: entry.easing};
  }
  // The easing pill on a keyframe: every property that has a key at that moment keeps its value and
  // takes the new curve, which is what "the curve belongs to the moment, not the property" means in
  // an editor with a single diamond per time.
  function setKeyframeEasing(keyframes, time, easing, tolerance = 0.5 / 24) {
    const next = normalizeKeyframes(keyframes);
    const at = round(Math.max(0, finite(time, 0)), 4);
    const name = normalizeEasing(easing);
    let keys = 0;
    for (const property of KEYFRAME_PROPERTIES) {
      next[property] = next[property].map((entry) => {
        if (Math.abs(entry.time - at) > tolerance) return entry;
        keys += 1;
        return {...entry, easing: name};
      });
    }
    return {keyframes: next, keys, easing: name, time: at};
  }
  // Dragging a diamond moves the moment and keeps the value.
  function moveKeyframe(keyframes, fromTime, toTime, tolerance = 0.5 / 24) {
    const next = normalizeKeyframes(keyframes);
    const from = round(Math.max(0, finite(fromTime, 0)), 4);
    const to = round(clamp(finite(toTime, from), 0, 3600), 4);
    let properties = 0;
    for (const property of KEYFRAME_PROPERTIES) {
      const source = next[property];
      let touched = false;
      const moved = source.map((entry) => {
        if (Math.abs(entry.time - from) > tolerance) return entry;
        touched = true;
        return {...entry, time: to};
      });
      if (touched) { next[property] = moved; properties += 1; }
    }
    return {keyframes: next, properties, time: to, from};
  }
  function removeKeyframesAt(keyframes, time, tolerance = 0.5 / 24) {
    const next = normalizeKeyframes(keyframes);
    let removed = 0;
    for (const property of KEYFRAME_PROPERTIES) {
      const before = next[property].length;
      next[property] = next[property].filter((entry) => Math.abs(entry.time - time) > tolerance);
      removed += before - next[property].length;
    }
    return {keyframes: next, removed};
  }

  /* ------------------------------------------------------------------ speed, ramps, freeze, reverse */
  const SPEED_MIN = 0.1, SPEED_MAX = 8;
  const SPEED_RAMPS = Object.freeze([
    {id: 'none', label: 'Constant', hint: 'One steady speed for the whole clip'},
    {id: 'montage', label: 'Montage', hint: 'Slow start, fast middle — quick-cut energy'},
    {id: 'hero', label: 'Hero', hint: 'Fast start that settles into a slow hero moment'},
    {id: 'bullet', label: 'Bullet', hint: 'Very fast middle for a whip-pan punch'},
  ]);
  function normalizeSpeed(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const ramp = SPEED_RAMPS.some((preset) => preset.id === source.ramp) ? source.ramp : 'none';
    return {
      rate: round(clamp(finite(source.rate, 1), SPEED_MIN, SPEED_MAX), 3),
      reverse: source.reverse === true,
      freeze: source.freeze === true,
      ramp,
    };
  }
  // The ramp shape is a multiplier over the clip's own progress: 1 keeps the requested rate.
  function rampRate(profile, progress) {
    const t = clamp(progress, 0, 1);
    switch (profile) {
      case 'montage': return 0.45 + 2.1 * Math.sin(Math.PI * Math.min(1, t * 1.1));
      case 'hero': return 1.9 - 1.45 * Math.min(1, t * 1.25);
      case 'bullet': return 0.5 + 4.2 * Math.pow(Math.sin(Math.PI * t), 3);
      default: return 1;
    }
  }
  // Where inside the trimmed range an output-local second lands. Forward pours local * rate seconds
  // of source; reverse pours them from the end; freeze always lands on the same frame; a ramp walks
  // the curve instead of a straight line, integrated with small steps so it matches numerically.
  function sourceOffsetForLocal(local, length, speed) {
    const settings = normalizeSpeed(speed);
    const span = Math.max(1e-4, finite(length, 0));
    const t = clamp(local, 0, span);
    if (settings.freeze) return span * (settings.reverse ? 1 : 0);
    const steps = Math.max(24, Math.ceil(t * 12));
    let distance = 0;
    for (let index = 0; index < steps; index++) {
      const previous = index / steps, next = (index + 1) / steps;
      const progress = Math.max(previous, Math.min(1, next * t / span));
      distance += settings.rate * rampRate(settings.ramp, progress) * (t / steps);
    }
    const clamped = Math.min(span, distance);
    return settings.reverse ? span - clamped : clamped;
  }
  // How long a clip occupies the timeline once speed is applied.
  function clipOutputDuration(length, speed) {
    const settings = normalizeSpeed(speed);
    if (settings.freeze) return Math.max(1e-4, finite(length, 0));
    const span = Math.max(1e-4, finite(length, 0));
    const steps = 48;
    let distance = 0;
    for (let index = 0; index < steps; index++) {
      distance += settings.rate * rampRate(settings.ramp, (index + 0.5) / steps) / steps;
    }
    return Math.max(0.05, span / Math.max(0.05, distance));
  }

  /* ------------------------------------------------------------------ text, captions, stickers */
  const TEXT_FONTS = Object.freeze([
    {id: 'inter', label: 'Inter', family: 'Inter, system-ui, sans-serif', weight: 700},
    {id: 'display', label: 'Display', family: "'Bebas Neue','JetBrains Mono',Impact,sans-serif", weight: 600},
    {id: 'mono', label: 'Mono', family: "'JetBrains Mono',ui-monospace,monospace", weight: 600},
    {id: 'serif', label: 'Serif', family: 'Georgia,"Times New Roman",serif', weight: 700},
  ]);
  const TEXT_ANIMATIONS = Object.freeze([
    {id: 'none', label: 'None'}, {id: 'fade', label: 'Fade'}, {id: 'pop', label: 'Pop'}, {id: 'typewriter', label: 'Typewriter'},
  ]);
  const TEXT_ALIGNS = Object.freeze(['left', 'center', 'right']);
  function normalizeTextStyle(input) {
    const source = input && typeof input === 'object' ? input : {};
    const font = TEXT_FONTS.some((entry) => entry.id === source.font) ? source.font : 'inter';
    const animation = TEXT_ANIMATIONS.some((entry) => entry.id === source.animation) ? source.animation : 'fade';
    return {
      font,
      // 24..320 mirrors the sidebar sliders exactly, so a stored layer can never come back with a
      // size the controls cannot represent.
      size: round(clamp(finite(source.size, 72), 24, 320), 1),
      color: normalizeHex(source.color, '#ffffff'),
      stroke: normalizeHex(source.stroke, '#000000'),
      strokeWidth: round(clamp(finite(source.strokeWidth, 0), 0, 24), 1),
      background: normalizeHex(source.background, 'transparent', true),
      backgroundOpacity: round(clamp(finite(source.backgroundOpacity, 0.55), 0, 1), 3),
      align: TEXT_ALIGNS.includes(source.align) ? source.align : 'center',
      animation,
    };
  }
  function normalizeTextLayer(input, fallback = {}) {
    const source = input && typeof input === 'object' ? input : {};
    return {
      id: String(source.id || fallback.id || `text-${Date.now().toString(36)}`),
      kind: 'text',
      text: String(source.text ?? fallback.text ?? 'Your text').slice(0, 240),
      start: round(Math.max(0, finite(source.start, finite(fallback.start, 0))), 3),
      end: round(Math.max(0, finite(source.end, finite(fallback.end, 3))), 3),
      style: normalizeTextStyle(source.style || fallback.style),
      transform: {
        x: round(clamp(finite(source.transform?.x, 0), -2, 2), 4),
        y: round(clamp(finite(source.transform?.y, 0.55), -2, 2), 4),
      },
      opacity: normalizeOpacity(source.opacity, 1),
      blend: normalizeBlend(source.blend),
    };
  }
  // The animation state at a layer's own progress (0 at its start, 1 at its end).
  function textAnimationState(animation, progress) {
    const t = clamp(progress, 0, 1);
    const inWindow = Math.min(1, t / 0.22), outWindow = Math.min(1, (1 - t) / 0.18);
    switch (String(animation || 'none')) {
      case 'fade': return {alpha: Math.min(inWindow, outWindow), scale: 1, characters: Infinity};
      case 'pop': return {alpha: Math.min(1, inWindow * 1.6), scale: 0.7 + 0.35 * inWindow + 0.02 * Math.sin(Math.PI * Math.min(1, inWindow)), characters: Infinity};
      case 'typewriter': return {alpha: 1, scale: 1, characters: Math.ceil(t * 1.15 * 1000)};
      default: return {alpha: 1, scale: 1, characters: Infinity};
    }
  }
  function normalizeCaption(input, fallback = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const start = Math.max(0, finite(source.start, finite(fallback.start, 0)));
    return {
      id: String(source.id || fallback.id || `caption-${Date.now().toString(36)}`),
      text: String(source.text ?? fallback.text ?? 'Caption line').slice(0, 240),
      start: round(start, 3),
      end: round(Math.max(start + 0.2, finite(source.end, finite(fallback.end, start + 2))), 3),
    };
  }
  // SRT and WebVTT both reduce to "a text block preceded by a time range", so one parser reads
  // local caption files without any network round trip.
  function parseSubtitleStamp(value) {
    const match = String(value || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
    if (!match) return null;
    const [, hours, minutes, seconds, fraction] = match;
    const millis = Number(fraction.padEnd(3, '0').slice(0, 3));
    return (Number(hours || 0) * 3600) + (Number(minutes) * 60) + Number(seconds) + millis / 1000;
  }
  function parseSubtitles(text) {
    const source = String(text || '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
    const blocks = source.split(/\n{2,}/);
    const lines = [];
    for (const block of blocks) {
      const rows = block.split('\n').map((row) => row.trim()).filter((row, index, list) => !(index === 0 && /^WEBVTT/i.test(row)) && row.length);
      if (!rows.length) continue;
      const stampIndex = rows.findIndex((row) => row.includes('-->'));
      if (stampIndex < 0) continue;
      const [rawStart, rawEnd] = rows[stampIndex].split('-->').map((part) => part.trim().split(/\s+/)[0]);
      const start = parseSubtitleStamp(rawStart), end = parseSubtitleStamp(rawEnd);
      if (start === null || end === null) continue;
      const body = rows.slice(stampIndex + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      if (!body) continue;
      lines.push({start, end: Math.max(start + 0.2, end), text: body});
    }
    return normalizeCaptions(lines);
  }
  // Splitting a line at the playhead keeps the sentence on both sides and never produces a stub.
  function splitCaption(line, at) {
    const source = normalizeCaption(line);
    const span = Math.max(0.4, source.end - source.start);
    const cut = clamp(finite(at, source.start + span / 2), source.start + 0.2, source.end - 0.2);
    const words = source.text.split(/\s+/).filter(Boolean);
    const ratio = (cut - source.start) / span;
    const head = words.slice(0, Math.max(1, Math.round(words.length * ratio))).join(' ') || source.text;
    const tail = words.slice(Math.max(1, Math.round(words.length * ratio))).join(' ') || source.text;
    return [
      {...source, id: `${source.id}-a`, end: round(cut, 3), text: head},
      {...source, id: `${source.id}-b`, start: round(cut, 3), text: tail},
    ];
  }
  function mergeCaptions(first, second) {
    const a = normalizeCaption(first), b = normalizeCaption(second);
    const [head, tail] = a.start <= b.start ? [a, b] : [b, a];
    return {...head, start: head.start, end: Math.max(head.end, tail.end), text: `${head.text} ${tail.text}`.replace(/\s+/g, ' ').trim().slice(0, 240)};
  }
  function normalizeCaptions(list) {
    if (!Array.isArray(list)) return [];
    return list.map((entry, index) => normalizeCaption(entry, {id: `caption-${index + 1}`}))
      .sort((a, b) => a.start - b.start);
  }
  function captionAt(list, time) {
    const at = finite(time, 0);
    return normalizeCaptions(list).find((line) => at >= line.start && at < line.end) || null;
  }
  const CAPTION_STYLE = Object.freeze({
    size: 44, color: '#ffffff', background: '#000000', backgroundOpacity: 0.62, bottom: 0.12, strokeWidth: 3,
  });
  // Built-in stickers: inline SVG so nothing is fetched and the app stays fully offline.
  const STICKERS = Object.freeze([
    {id: 'star', label: 'Star', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#ffd166" stroke="#1a1a1a" stroke-width="3" stroke-linejoin="round" d="M32 5l8.2 16.7 18.4 2.7-13.3 13 3.1 18.3L32 47.1 15.6 55.7l3.1-18.3-13.3-13 18.4-2.7z"/></svg>'},
    {id: 'heart', label: 'Heart', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#ef476f" stroke="#1a1a1a" stroke-width="3" d="M32 56S6 40 6 23.5A13.5 13.5 0 0 1 32 17a13.5 13.5 0 0 1 26 6.5C58 40 32 56 32 56z"/></svg>'},
    {id: 'spark', label: 'Sparkles', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#ffe066" stroke="#1a1a1a" stroke-width="2.5" d="M32 4l6 20 20 6-20 6-6 20-6-20-20-6 20-6z"/><path fill="#fff" d="M52 8l2.5 6.5L61 17l-6.5 2.5L52 26l-2.5-6.5L43 17l6.5-2.5z"/></svg>'},
    {id: 'arrow', label: 'Arrow', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#4cc9f0" stroke="#1a1a1a" stroke-width="3" stroke-linejoin="round" d="M4 26h30V12l26 20-26 20V38H4z"/></svg>'},
    {id: 'speech', label: 'Speech', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#f7f7f7" stroke="#1a1a1a" stroke-width="3" stroke-linejoin="round" d="M6 12h52v32H32l-14 12V44H6z"/></svg>'},
    {id: 'crown', label: 'Crown', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#ffd166" stroke="#1a1a1a" stroke-width="3" stroke-linejoin="round" d="M6 48l4-30 12 12 10-18 10 18 12-12 4 30z"/></svg>'},
  ]);
  function stickerById(id) { return STICKERS.find((entry) => entry.id === id) || null; }
  function stickerDataUrl(id) {
    const sticker = stickerById(id) || STICKERS[0];
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sticker.svg)}`;
  }
  function normalizeStickerLayer(input, fallback = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const id = stickerById(source.sticker) ? source.sticker : 'star';
    const start = Math.max(0, finite(source.start, finite(fallback.start, 0)));
    return {
      id: String(source.id || fallback.id || `sticker-${Date.now().toString(36)}`),
      kind: 'sticker',
      sticker: id,
      start: round(start, 3),
      end: round(Math.max(start + 0.2, finite(source.end, finite(fallback.end, start + 2))), 3),
      transform: {
        x: round(clamp(finite(source.transform?.x, 0), -2, 2), 4),
        y: round(clamp(finite(source.transform?.y, -0.45), -2, 2), 4),
        scale: round(clamp(finite(source.transform?.scale, 0.28), 0.02, 3), 4),
        rotation: round(clamp(finite(source.transform?.rotation, 0), -360, 360), 3),
      },
      opacity: normalizeOpacity(source.opacity, 1),
      blend: normalizeBlend(source.blend),
    };
  }
  function normalizeLayer(input, fallback = {}) {
    const kind = input && input.kind === 'sticker' ? 'sticker' : 'text';
    return kind === 'sticker' ? normalizeStickerLayer(input, fallback) : normalizeTextLayer(input, fallback);
  }
  function layerProgress(layer, time) {
    const start = finite(layer?.start, 0), end = Math.max(start + 0.05, finite(layer?.end, start + 2));
    return clamp((finite(time, 0) - start) / (end - start), 0, 1);
  }

  /* ------------------------------------------------------------------ chroma key */
  const CHROMA_DEFAULT = Object.freeze({enabled: false, color: '#00ff00', tolerance: 30, softness: 18, spill: 45});
  function normalizeChromaKey(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return {
      enabled: source.enabled === true,
      color: normalizeHex(source.color, CHROMA_DEFAULT.color),
      tolerance: round(clamp(finite(source.tolerance, CHROMA_DEFAULT.tolerance), 0, 100), 2),
      softness: round(clamp(finite(source.softness, CHROMA_DEFAULT.softness), 0, 100), 2),
      spill: round(clamp(finite(source.spill, CHROMA_DEFAULT.spill), 0, 100), 2),
    };
  }
  function normalizeHex(value, fallback = '#000000', allowTransparent = false) {
    const text = String(value || '').trim().toLowerCase();
    if (allowTransparent && (text === 'transparent' || text === 'none')) return 'transparent';
    const short = /^#?([0-9a-f]{3})$/.exec(text);
    if (short) return `#${short[1].split('').map((character) => character + character).join('')}`;
    const long = /^#?([0-9a-f]{6})$/.exec(text);
    if (long) return `#${long[1]}`;
    return fallback;
  }
  function hexToRgb(hex) {
    const value = normalizeHex(hex, '#000000').slice(1);
    return {r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16)};
  }
  function rgbToHex(r, g, b) {
    const part = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
    return `#${part(r)}${part(g)}${part(b)}`;
  }
  // The uniform values the WebGL pass takes: a 0..1 colour, a 0..1 core radius and a 0..1 falloff.
  function chromaUniforms(chroma) {
    const settings = normalizeChromaKey(chroma);
    const rgb = hexToRgb(settings.color);
    return {
      color: [rgb.r / 255, rgb.g / 255, rgb.b / 255],
      tolerance: settings.tolerance / 100,
      softness: Math.max(0.004, settings.softness / 100),
      spill: settings.spill / 100,
    };
  }
  // CPU reference for the same maths the shader runs: distance in RGB, smoothstep alpha, and a
  // spill pass that pulls the key hue out of the surviving edges.
  function chromaKeyPixels(data, options = {}) {
    const settings = normalizeChromaKey(options.chroma || options);
    const uniforms = chromaUniforms(settings);
    const key = {r: uniforms.color[0] * 255, g: uniforms.color[1] * 255, b: uniforms.color[2] * 255};
    const tolerance = uniforms.tolerance * 441.67; // sqrt(3) * 255 — the largest RGB distance
    const softness = Math.max(1, uniforms.softness * 441.67);
    const output = new Uint8ClampedArray(data.length);
    for (let index = 0; index < data.length; index += 4) {
      const r = data[index], g = data[index + 1], b = data[index + 2], alpha = data[index + 3];
      const distance = Math.hypot(r - key.r, g - key.g, b - key.b);
      const ratio = clamp((distance - tolerance) / softness, 0, 1);
      const keyed = ratio * ratio * (3 - 2 * ratio);
      let outR = r, outG = g, outB = b;
      if (uniforms.spill > 0 && alpha > 0.001) {
        // Same formula as the shader: desaturate toward the pixel average, strongest on the key.
        const mix = uniforms.spill * (1 - keyed * 0.5);
        const average = (r + g + b) / 3;
        outR = r + (average - r) * mix;
        outG = g + (average - g) * mix;
        outB = b + (average - b) * mix;
      }
      output[index] = outR; output[index + 1] = outG; output[index + 2] = outB;
      output[index + 3] = alpha * keyed;
    }
    return output;
  }
  // The WebGL2 fragment shader the editor compiles. Kept here so the tests can prove the uniform
  // names and the maths stay in step with the CPU reference.
  const CHROMA_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_texCoord;
uniform sampler2D u_image;
uniform vec3 u_keyColor;
uniform float u_tolerance;
uniform float u_softness;
uniform float u_spill;
out vec4 outColor;
// Chroma key: RGB distance to the picked colour, smoothstep alpha so the edge softness slider
// spreads the cut, then a spill pass that desaturates the key hue out of the surviving pixels.
void main(){
  vec4 source=texture(u_image,v_texCoord);
  // 1.7320 is sqrt(3): the RGB distance is measured on the same 0 .. 255 scale the CPU
  // reference uses, so both produce the same alpha for the same sliders.
  float scaled=distance(source.rgb,u_keyColor)*1.7320;
  float core=u_tolerance*1.7320;
  float alpha=smoothstep(core,core+max(u_softness,0.004)*1.7320,scaled);
  vec3 rgb=source.rgb;
  if(u_spill>0.0 && alpha>0.001){
    float average=(source.r+source.g+source.b)/3.0;
    rgb=mix(rgb,vec3(average),u_spill*(1.0-alpha*0.5));
  }
  outColor=vec4(rgb,source.a*alpha);
}`;

  /* ------------------------------------------------------------------ shared scene renderer */
  // The reference height keeps text, stickers and captions the same relative size on the preview
  // canvas and on the exported frame, whatever resolution either one runs at.
  const REFERENCE_HEIGHT = 1080;
  function fitRect(width, height, sourceWidth, sourceHeight) {
    const scale = Math.min(width / Math.max(1, sourceWidth), height / Math.max(1, sourceHeight));
    const drawWidth = sourceWidth * scale, drawHeight = sourceHeight * scale;
    return {x: (width - drawWidth) / 2, y: (height - drawHeight) / 2, width: drawWidth, height: drawHeight};
  }
  function applyTransform(ctx, layer, width, height, unit) {
    const transform = layer.transform || {};
    const scale = clamp(finite(transform.scale, 1), 0.01, 8);
    const x = finite(transform.x, 0) * width, y = finite(transform.y, 0) * height;
    const rotation = finite(transform.rotation, 0) * Math.PI / 180;
    ctx.translate(width / 2 + x, height / 2 + y);
    if (rotation) ctx.rotate(rotation);
    if (scale !== 1) ctx.scale(scale, scale);
    return {scale, unit};
  }
  function wrapLines(ctx, text, maxWidth) {
    const lines = [];
    for (const paragraph of String(text ?? '').split('\n')) {
      if (!paragraph) { lines.push(''); continue; }
      let current = '';
      for (const word of paragraph.split(/\s+/)) {
        const candidate = current ? `${current} ${word}` : word;
        if (current && ctx.measureText(candidate).width > maxWidth) { lines.push(current); current = word; }
        else current = candidate;
      }
      if (current) lines.push(current);
    }
    return lines;
  }
  function drawTextLayer(ctx, layer, width, height, time) {
    const unit = height / REFERENCE_HEIGHT;
    const style = layer.style || {};
    const font = TEXT_FONTS.find((entry) => entry.id === style.font) || TEXT_FONTS[0];
    const animation = textAnimationState(style.animation, layerProgress(layer, time));
    const size = Math.max(4, finite(style.size, 72) * unit);
    const state = {alpha: animation.alpha * normalizeOpacity(layer.opacity, 1), scale: animation.scale, characters: animation.characters};
    if (state.alpha <= 0.002) return;
    const opacity = state.alpha;
    const text = state.characters === Infinity ? String(layer.text ?? '') : String(layer.text ?? '').slice(0, state.characters);
    ctx.save();
    ctx.globalCompositeOperation = blendOperation(layer.blend);
    ctx.globalAlpha = opacity;
    ctx.textAlign = style.align === 'left' ? 'left' : style.align === 'right' ? 'right' : 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${font.weight || 700} ${size}px ${font.family}`;
    applyTransform(ctx, {...layer, transform: {...layer.transform, scale: 1}}, width, height, unit);
    if (state.scale !== 1) ctx.scale(state.scale, state.scale);
    const maxWidth = width * 0.86;
    const lines = wrapLines(ctx, text, maxWidth);
    const lineHeight = size * 1.22;
    const total = lines.length * lineHeight;
    const anchor = ctx.textAlign;
    const strokeWidth = finite(style.strokeWidth, 0) * unit;
    if (style.background && style.background !== 'transparent') {
      const padding = size * 0.34;
      let widest = 0;
      for (const line of lines) widest = Math.max(widest, ctx.measureText(line).width);
      const boxWidth = Math.min(width * 0.94, widest + padding * 2);
      const boxHeight = total + padding * 1.1;
      const boxX = anchor === 'left' ? -boxWidth / 2 : anchor === 'right' ? -boxWidth / 2 : -boxWidth / 2;
      ctx.globalAlpha = opacity * clamp(finite(style.backgroundOpacity, 0.55), 0, 1);
      ctx.fillStyle = style.background;
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(boxX, -boxHeight / 2, boxWidth, boxHeight, size * 0.16); ctx.fill(); }
      else ctx.fillRect(boxX, -boxHeight / 2, boxWidth, boxHeight);
      ctx.globalAlpha = opacity;
    }
    lines.forEach((line, index) => {
      const y = -total / 2 + lineHeight * (index + 0.5);
      if (strokeWidth > 0) {
        ctx.lineJoin = 'round'; ctx.lineWidth = strokeWidth * 2; ctx.strokeStyle = style.stroke || '#000';
        ctx.strokeText(line, 0, y);
      }
      ctx.fillStyle = style.color || '#fff';
      ctx.fillText(line, 0, y);
    });
    ctx.restore();
  }
  // A sticker is only paintable once its inline SVG has decoded. `naturalWidth` is the reliable
  // signal: an <img> with no width attribute reports 0 from `.width` until the image is laid out.
  function imageReady(image) {
    if (!image) return false;
    if (image.complete === false) return false;
    return (image.naturalWidth || image.width || 0) > 0;
  }
  function drawStickerLayer(ctx, layer, image, width, height, time) {
    if (!imageReady(image)) return;
    const progress = layerProgress(layer, time);
    const fade = Math.min(1, progress / 0.18, (1 - progress) / 0.18 + 0.35);
    const alpha = normalizeOpacity(layer.opacity, 1) * clamp(fade, 0, 1);
    if (alpha <= 0.002) return;
    const size = width * 0.22 * clamp(finite(layer.transform?.scale, 0.28), 0.02, 3);
    ctx.save();
    ctx.globalCompositeOperation = blendOperation(layer.blend);
    ctx.globalAlpha = alpha;
    applyTransform(ctx, {...layer, transform: {...layer.transform, scale: 1}}, width, height);
    ctx.drawImage(image, -size / 2, -size / 2, size, size);
    ctx.restore();
  }
  function drawCaption(ctx, line, width, height) {
    if (!line) return;
    const unit = height / REFERENCE_HEIGHT;
    const size = CAPTION_STYLE.size * unit;
    const text = line.text;
    const progress = layerProgress({start: line.start, end: line.end}, (line.start + line.end) / 2);
    const fade = Math.min(1, progress / 0.2 + 0.6);
    ctx.save();
    ctx.globalAlpha = clamp(fade, 0, 1);
    ctx.font = `700 ${size}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const maxWidth = width * 0.86;
    const lines = wrapLines(ctx, text, maxWidth);
    const lineHeight = size * 1.25;
    const total = lines.length * lineHeight;
    const padding = size * 0.4;
    let widest = 0;
    for (const row of lines) widest = Math.max(widest, ctx.measureText(row).width);
    const boxWidth = Math.min(width * 0.92, widest + padding * 2);
    const boxHeight = total + padding;
    const centerY = height * (1 - CAPTION_STYLE.bottom) - boxHeight / 2;
    ctx.fillStyle = CAPTION_STYLE.background;
    ctx.globalAlpha *= CAPTION_STYLE.backgroundOpacity;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(width / 2 - boxWidth / 2, centerY - boxHeight / 2, boxWidth, boxHeight, size * 0.2); ctx.fill(); }
    else ctx.fillRect(width / 2 - boxWidth / 2, centerY - boxHeight / 2, boxWidth, boxHeight);
    ctx.globalAlpha = clamp(fade, 0, 1);
    ctx.fillStyle = CAPTION_STYLE.color;
    ctx.lineJoin = 'round'; ctx.lineWidth = CAPTION_STYLE.strokeWidth * unit * 2; ctx.strokeStyle = 'rgba(0,0,0,.65)';
    lines.forEach((row, index) => {
      const y = centerY - total / 2 + lineHeight * (index + 0.5);
      ctx.strokeText(row, width / 2, y);
      ctx.fillText(row, width / 2, y);
    });
    ctx.restore();
  }
  // Preview and export both call this with the same layer list. Media layers can carry a WebGL
  // chroma-keyed canvas; text, stickers and captions are drawn with their animation state.
  function drawScene(ctx, scene) {
    if (!ctx || !scene) return;
    const width = Math.max(1, Math.round(finite(scene.width, 1)));
    const height = Math.max(1, Math.round(finite(scene.height, 1)));
    const time = finite(scene.time, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (scene.clear !== false) ctx.clearRect(0, 0, width, height);
    for (const layer of scene.layers || []) {
      if (!layer) continue;
      try {
        if (layer.kind === 'media') {
          const image = layer.image;
          if (!image) continue;
          const sourceWidth = image.videoWidth || image.naturalWidth || image.width || width;
          const sourceHeight = image.videoHeight || image.naturalHeight || image.height || height;
          if (!(sourceWidth > 0 && sourceHeight > 0)) continue;
          const alpha = normalizeOpacity(layer.opacity, 1) * (layer.visible === false ? 0 : 1);
          if (alpha <= 0.002) continue;
          const rect = fitRect(width, height, sourceWidth, sourceHeight);
          ctx.save();
          ctx.globalCompositeOperation = blendOperation(layer.blend);
          ctx.globalAlpha = alpha;
          applyTransform(ctx, layer, width, height, height / REFERENCE_HEIGHT);
          ctx.drawImage(image, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
          ctx.restore();
        } else if (layer.kind === 'text') {
          drawTextLayer(ctx, layer, width, height, time);
        } else if (layer.kind === 'sticker') {
          drawStickerLayer(ctx, layer, layer.image, width, height, time);
        } else if (layer.kind === 'caption') {
          drawCaption(ctx, layer.line, width, height);
        }
      } catch (error) {
        // One broken layer must never blank the frame.
        if (window.console?.warn) console.warn('A video layer could not be drawn', error);
      }
    }
  }
  // Sticker images are decoded once and reused by the preview and by the export.
  const stickerImages = new Map();
  function stickerImage(id) {
    const key = stickerById(id) ? id : 'star';
    if (stickerImages.has(key)) return stickerImages.get(key);
    const image = new Image();
    image.decoding = 'async';
    image.src = stickerDataUrl(key);
    stickerImages.set(key, image);
    return image;
  }
  async function preloadStickerImages() {
    const jobs = STICKERS.map((sticker) => {
      const image = stickerImage(sticker.id);
      if (image.decode) return image.decode().catch(() => {});
      return Promise.resolve();
    });
    await Promise.all(jobs);
    return [...stickerImages.values()];
  }

  return {
    BLEND_MODES, BLEND_LABELS, normalizeBlend, blendOperation, normalizeOpacity,
    KEYFRAME_PROPERTIES, PROPERTY_LABELS, EASINGS, EASING_LABELS, normalizeEasing, easeValue,
    defaultPropertyValue, normalizePropertyValue, normalizeKeyframes, hasKeyframes, keyframeTimes,
    sampleProperty, sampleKeyframes, keyframeAt, toggleKeyframe, setKeyframeEasing, moveKeyframe, removeKeyframesAt,
    SPEED_MIN, SPEED_MAX, SPEED_RAMPS, normalizeSpeed, rampRate, sourceOffsetForLocal, clipOutputDuration,
    TEXT_FONTS, TEXT_ANIMATIONS, TEXT_ALIGNS, normalizeTextStyle, normalizeTextLayer, textAnimationState,
    normalizeCaption, normalizeCaptions, captionAt, CAPTION_STYLE, parseSubtitleStamp, parseSubtitles, splitCaption, mergeCaptions,
    STICKERS, stickerById, stickerDataUrl, normalizeStickerLayer, normalizeLayer, layerProgress,
    CHROMA_DEFAULT, normalizeChromaKey, normalizeHex, hexToRgb, rgbToHex, chromaUniforms, chromaKeyPixels,
    CHROMA_FRAGMENT_SHADER, REFERENCE_HEIGHT, fitRect, wrapLines, drawScene, imageReady, stickerImage, preloadStickerImages,
  };
});
