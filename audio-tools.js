// === FILM LAB AUDIO + DELIVERY TOOLS ==========================================================
// The model behind the audio lane, clip stabilisation, auto-reframe and the delivery presets.
//
// Like video-tools.js this module holds no app state: the editor, the timeline and the exporter all
// call the same helpers, and every function that produces an ffmpeg argument is pure, so a test can
// assert the exact command line the export will run. Nothing here reaches the network.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FilmAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const round = (value, digits = 3) => Number(Number(value).toFixed(digits));

  /* ------------------------------------------------------------------ audio: fades, volume keys */
  const AUDIO_DEFAULT = Object.freeze({gain: 1, fadeIn: 0, fadeOut: 0, normalize: false, denoise: false, denoiseAmount: 12, keyframes: []});
  const DENOISE_PRESETS = Object.freeze([
    {id: 'room', label: 'Room tone', nf: -28, hint: 'Light cleanup for a quiet room'},
    {id: 'hvac', label: 'Fan / hum', nf: -22, hint: 'Steady background noise'},
    {id: 'street', label: 'Street', nf: -16, hint: 'Heavy noise, keeps more of the voice'},
  ]);
  function normalizeVolumeKeyframe(input) {
    const source = input && typeof input === 'object' ? input : {};
    return {time: round(Math.max(0, finite(source.time, 0)), 3), value: round(clamp(finite(source.value, 1), 0, 4), 3)};
  }
  function normalizeVolumeKeyframes(list) {
    const frames = (Array.isArray(list) ? list : []).map(normalizeVolumeKeyframe);
    frames.sort((a, b) => a.time - b.time);
    const unique = [];
    for (const frame of frames) {
      const previous = unique[unique.length - 1];
      if (previous && Math.abs(previous.time - frame.time) <= 0.02) unique[unique.length - 1] = frame;
      else unique.push(frame);
    }
    return unique;
  }
  function normalizeAudio(input) {
    const source = input && typeof input === 'object' ? input : {};
    return {
      gain: round(clamp(finite(source.gain, 1), 0, 4), 3),
      fadeIn: round(clamp(finite(source.fadeIn, 0), 0, 30), 3),
      fadeOut: round(clamp(finite(source.fadeOut, 0), 0, 30), 3),
      normalize: source.normalize === true,
      denoise: source.denoise === true,
      denoiseAmount: round(clamp(finite(source.denoiseAmount, 12), 0, 40), 2),
      keyframes: normalizeVolumeKeyframes(source.keyframes),
    };
  }
  // The volume automation as an ffmpeg expression. `t` is evaluated per frame, keyframes are joined
  // with nested `if`, and a shot with no keyframes collapses to a constant.
  function volumeExpression(keyframes, {duration = 0} = {}) {
    const frames = normalizeVolumeKeyframes(keyframes);
    if (!frames.length) return null;
    const span = Math.max(0.05, finite(duration, frames[frames.length - 1].time || 1));
    let expression = String(frames[frames.length - 1].value);
    for (let index = frames.length - 2; index >= 0; index -= 1) {
      const from = frames[index], to = frames[index + 1];
      const width = Math.max(0.001, to.time - from.time);
      const ramp = `(${from.value}+(${to.value}-${from.value})*(t-${from.time})/${round(width, 4)})`;
      expression = `if(lt(t,${to.time}),${ramp},${expression})`;
    }
    const first = frames[0];
    return `if(lt(t,${first.time}),${first.value},${expression})`;
  }
  // One audio filter chain for the source audio: volume automation, then fades, then the cleanup
  // and loudness stages. Returns the `-af` value, or null when nothing was asked for.
  function audioFilterChain(input, {duration = 0} = {}) {
    const settings = normalizeAudio(input);
    const span = Math.max(0.05, finite(duration, 0));
    const filters = [];
    const expression = volumeExpression(settings.keyframes, {duration: span});
    if (expression) filters.push(`volume='${expression}':eval=frame`);
    else if (settings.gain !== 1) filters.push(`volume=${settings.gain}`);
    if (settings.fadeIn > 0) filters.push(`afade=t=in:st=0:d=${round(Math.min(settings.fadeIn, span), 3)}`);
    if (settings.fadeOut > 0) filters.push(`afade=t=out:st=${round(Math.max(0, span - settings.fadeOut), 3)}:d=${round(Math.min(settings.fadeOut, span), 3)}`);
    if (settings.denoise) filters.push(`afftdn=nf=${round(-Math.abs(settings.denoiseAmount), 2)}:tn=1`);
    if (settings.normalize) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
    return filters.length ? filters.join(',') : null;
  }
  /* The voice-over takes mixed under the source audio. Each take is a MediaRecorder blob recorded
   * in the browser; the mixer keeps the source bed at its own level and ducks nothing, so a take
   * that is simply louder wins, exactly as the recording sounded while it was made. */
  function normalizeVoiceTake(input) {
    const source = input && typeof input === 'object' ? input : {};
    const take = {
      id: String(source.id || `take-${Date.now().toString(36)}`),
      name: String(source.name || 'Voice take').slice(0, 80),
      start: round(Math.max(0, finite(source.start, 0)), 3),
      duration: round(Math.max(0.05, finite(source.duration, 0)), 3),
      gain: round(clamp(finite(source.gain, 1), 0, 4), 3),
      fadeIn: round(clamp(finite(source.fadeIn, 0.05), 0, 10), 3),
      fadeOut: round(clamp(finite(source.fadeOut, 0.15), 0, 10), 3),
    };
    // The recorded audio carries through normalisation: the export writes this blob into the video
    // engine before it builds the mix, while the filter maths below only ever reads the timing.
    if (source.blob) take.blob = source.blob;
    if (source.url) take.url = String(source.url);
    return take;
  }
  function normalizeVoiceTakes(list) {
    return (Array.isArray(list) ? list : []).map(normalizeVoiceTake).sort((a, b) => a.start - b.start);
  }
  function takeFilterChain(take, {duration = 0} = {}) {
    const settings = normalizeVoiceTake(take);
    const span = Math.max(0.05, finite(duration, settings.duration));
    const filters = [];
    if (settings.gain !== 1) filters.push(`volume=${settings.gain}`);
    if (settings.fadeIn > 0) filters.push(`afade=t=in:st=0:d=${round(Math.min(settings.fadeIn, span), 3)}`);
    if (settings.fadeOut > 0) filters.push(`afade=t=out:st=${round(Math.max(0, span - settings.fadeOut), 3)}:d=${round(Math.min(settings.fadeOut, span), 3)}`);
    if (settings.start > 0) filters.push(`adelay=${Math.round(settings.start * 1000)}:all=1`);
    return filters.length ? filters.join(',') : null;
  }
  // The full audio graph: source chain plus every take, mixed down to one stereo pair. Input 0 is
  // the concat list the export writes its video through, input 1 is the source audio, and the takes
  // follow it — so the bed is [1:a], not [0:a].
  function audioGraph(audio, takes, {duration = 0, hasSource = true, bedInput = 1} = {}) {
    const chain = audioFilterChain(audio, {duration});
    const list = normalizeVoiceTakes(takes);
    const nodes = [];
    const maps = [];
    const bed = Math.max(0, Math.round(bedInput));
    if (hasSource) {
      nodes.push(chain ? `[${bed}:a]${chain}[bed]` : `[${bed}:a]anull[bed]`);
      maps.push('[bed]');
    }
    list.forEach((take, index) => {
      const filtered = takeFilterChain(take, {duration: take.duration});
      const input = bed + 1 + index;
      nodes.push(filtered ? `[${input}:a]${filtered}[take${index}]` : `[${input}:a]anull[take${index}]`);
      maps.push(`[take${index}]`);
    });
    if (maps.length <= 1) return {args: chain ? ['-af', chain] : [], filter: null, takes: list.length};
    const mix = `${maps.join('')}amix=inputs=${maps.length}:duration=longest:dropout_transition=0:normalize=0[audio]`;
    return {args: ['-filter_complex', `${nodes.join(';')};${mix}`, '-map', '0:v:0', '-map', '[audio]'], filter: `${nodes.join(';')};${mix}`, takes: list.length};
  }
  /* ------------------------------------------------------------------ stabilisation */
  // deshake ships with every ffmpeg build; vidstab needs libvidstab, so it is preferred only when
  // the loaded engine reports it. Both are expressed as one video filter.
  const STABILIZATION_FILTERS = Object.freeze(['vidstab', 'deshake']);
  const STABILIZATION_DEFAULT = Object.freeze({enabled: false, strength: 0.5});
  function normalizeStabilization(input) {
    const source = input && typeof input === 'object' ? input : {};
    return {enabled: source.enabled === true, strength: round(clamp(finite(source.strength, 0.5), 0, 1), 3)};
  }
  function stabilizationFilter(input, {available = 'deshake'} = {}) {
    const settings = normalizeStabilization(input);
    if (!settings.enabled) return null;
    const engine = STABILIZATION_FILTERS.includes(available) && available === 'vidstab' ? 'vidstab' : 'deshake';
    if (engine === 'vidstab') {
      const smoothing = Math.round(4 + settings.strength * 26);
      return `vidstabdetect=shakiness=${Math.max(1, Math.round(2 + settings.strength * 6))}:result=transforms.trf,vidstabtransform=smoothing=${smoothing}`;
    }
    const radius = Math.round(8 + settings.strength * 56);
    return `deshake=rx=${radius}:ry=${radius}:edge=1:blocksize=16`;
  }
  // The optional extra pass re-encodes only the picture and copies the finished audio through.
  function stabilizeArgs({input = 'output.mp4', output, container = 'mp4', quality = 'medium', filter}) {
    const profile = ({low: {crf: '28'}, medium: {crf: '20'}, high: {crf: '16'}})[quality] || {crf: '20'};
    const args = ['-y', '-i', input, '-vf', filter, '-c:v', container === 'webm' ? 'libvpx' : 'libx264'];
    if (container === 'webm') args.push('-b:v', profile.crf === '16' ? '8M' : profile.crf === '28' ? '1.5M' : '4M', '-threads', '1', '-deadline', 'realtime', '-cpu-used', '4', '-auto-alt-ref', '0');
    else args.push('-preset', 'veryfast', '-crf', profile.crf, '-pix_fmt', 'yuv420p');
    args.push('-c:a', 'copy', '-movflags', '+faststart', output || `stable.${container}`);
    return args;
  }
  /* ------------------------------------------------------------------ framing + reframe */
  // A 9:16 crop of a landscape frame concentrates the picture, so the presets carry the ratio the
  // crop maths already understands, and the focus point is normalised 0..1 inside the source frame.
  const ASPECT_PRESETS = Object.freeze([
    {id: '9:16', ratio: 9 / 16, label: '9:16', hint: 'Reels, Shorts, TikTok'},
    {id: '1:1', ratio: 1, label: '1:1', hint: 'Square feed post'},
    {id: '4:5', ratio: 4 / 5, label: '4:5', hint: 'Portrait feed post'},
    {id: '16:9', ratio: 16 / 9, label: '16:9', hint: 'Landscape, YouTube'},
    {id: 'original', ratio: null, label: 'Original', hint: 'Keep the source shape'},
  ]);
  const REFRAME_DEFAULT = Object.freeze({aspect: 'original', focus: {x: 0.5, y: 0.5}, auto: false});
  function aspectPreset(id) { return ASPECT_PRESETS.find((entry) => entry.id === id) || ASPECT_PRESETS[ASPECT_PRESETS.length - 1]; }
  function normalizeFraming(input) {
    const source = input && typeof input === 'object' ? input : {};
    const preset = aspectPreset(source.aspect);
    return {
      aspect: preset.id,
      ratio: preset.ratio,
      auto: source.auto === true,
      focus: {x: round(clamp(finite(source.focus?.x, 0.5), 0, 1), 4), y: round(clamp(finite(source.focus?.y, 0.5), 0, 1), 4)},
    };
  }
  // Auto-reframe looks for the busiest part of the picture: a saliency map from luminance gradients,
  // scored on a grid, whose centroid becomes the focus point. No model, no network, no freeze.
  function saliencyMap(pixels, width, height, {columns = 12, rows = 12} = {}) {
    const cols = Math.max(1, Math.round(columns)), lineCount = Math.max(1, Math.round(rows));
    const map = new Array(cols * lineCount).fill(0);
    if (!pixels || width < 3 || height < 3) return {columns: cols, rows: lineCount, map, total: 0};
    const at = (x, y) => {
      const index = (Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 4;
      return pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
    };
    let total = 0;
    for (let y = 0; y < height - 1; y += 2) {
      for (let x = 0; x < width - 1; x += 2) {
        const gradient = Math.abs(at(x + 1, y) - at(x - 1, y)) + Math.abs(at(x, y + 1) - at(x, y - 1));
        const column = Math.min(cols - 1, Math.floor(x / width * cols));
        const row = Math.min(lineCount - 1, Math.floor(y / height * lineCount));
        map[row * cols + column] += gradient;
        total += gradient;
      }
    }
    return {columns: cols, rows: lineCount, map, total};
  }
  // The centroid of the saliency map, with the frame centre as the fallback for a flat picture.
  function reframeFocus(map) {
    const columns = Math.max(1, Math.round(finite(map?.columns, 1)));
    const rows = Math.max(1, Math.round(finite(map?.rows, 1)));
    const values = Array.isArray(map?.map) ? map.map : [];
    let weight = 0, x = 0, y = 0;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const value = Math.max(0, finite(values[row * columns + column], 0));
        if (!value) continue;
        weight += value;
        x += value * ((column + 0.5) / columns);
        y += value * ((row + 0.5) / rows);
      }
    }
    if (weight <= 0) return {x: 0.5, y: 0.5, weight: 0};
    return {x: round(clamp(x / weight, 0, 1), 4), y: round(clamp(y / weight, 0, 1), 4), weight: round(weight, 3)};
  }
  function normalizeFocusPoint(input) {
    const source = input && typeof input === 'object' ? input : {};
    return {x: round(clamp(finite(source.x, 0.5), 0, 1), 4), y: round(clamp(finite(source.y, 0.5), 0, 1), 4)};
  }
  /* ------------------------------------------------------------------ delivery presets */
  // The delivery ladder is expressed the way the export panel speaks: a short edge in pixels, a
  // frame rate, and a bitrate preset that also decides the JPEG frame quality the encoder receives.
  const RESOLUTION_PRESETS = Object.freeze([
    {id: 'original', label: 'Original', shortEdge: null},
    {id: '720', label: '720p', shortEdge: 720},
    {id: '1080', label: '1080p', shortEdge: 1080},
    {id: '2160', label: '4K', shortEdge: 2160},
  ]);
  const FRAME_RATE_PRESETS = Object.freeze([24, 30, 60]);
  const BITRATE_PRESETS = Object.freeze([
    {id: 'economy', label: 'Economy', mbps: 4, jpegQuality: 0.9, crf: '24'},
    {id: 'standard', label: 'Standard', mbps: 8, jpegQuality: 0.95, crf: '20'},
    {id: 'high', label: 'High', mbps: 16, jpegQuality: 0.98, crf: '16'},
    {id: 'max', label: 'Max', mbps: 28, jpegQuality: 0.99, crf: '13'},
  ]);
  // Audio is 128 kbps; file sizes are reported in decimal MB / GB, the way bitrates are quoted.
  const AUDIO_BITRATE = 128;
  function resolutionPreset(id) { return RESOLUTION_PRESETS.find((entry) => entry.id === String(id)) || RESOLUTION_PRESETS[0]; }
  function bitratePreset(id) { return BITRATE_PRESETS.find((entry) => entry.id === String(id)) || BITRATE_PRESETS[1]; }
  function normalizeDelivery(input) {
    const source = input && typeof input === 'object' ? input : {};
    const resolution = resolutionPreset(source.resolution);
    const bitrate = bitratePreset(source.bitrate);
    return {
      resolution: resolution.id, shortEdge: resolution.shortEdge,
      fps: FRAME_RATE_PRESETS.includes(Number(source.fps)) ? Number(source.fps) : 30,
      bitrate: bitrate.id, mbps: bitrate.mbps, jpegQuality: bitrate.jpegQuality, crf: bitrate.crf,
    };
  }
  // Video plus audio, in megabytes, for the estimate under the export button.
  function estimatedFileSize({duration = 0, mbps = 8, audio = true} = {}) {
    const seconds = Math.max(0, finite(duration, 0));
    // The audio track rides on top of the video bitrate, and the two are quoted in the same unit.
    const rate = Math.max(0, finite(mbps, 0)) + (audio ? AUDIO_BITRATE / 1000 : 0);
    const bytes = Math.round(seconds * rate * 1e6 / 8);
    return {bytes, mb: round(bytes / 1e6, 1)};
  }
  function sizeLabel(size) {
    const mb = Math.max(0, finite(size?.mb, 0));
    return mb >= 1000 ? `${round(mb / 1000, 2)} GB` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  // The frame the encoder is asked for, given the source geometry and the framing.
  function deliveryGeometry({width = 1080, height = 1920, framing = {}, delivery = {}} = {}) {
    const settings = normalizeDelivery(delivery);
    const frame = normalizeFraming(framing);
    // Kept as floats until the very end: rounding a 607.5 px crop edge before scaling used to drift
    // a 9:16 reel to 1918 px tall instead of 1920.
    let outWidth = Math.max(2, finite(width, 1080));
    let outHeight = Math.max(2, finite(height, 1920));
    if (frame.ratio) {
      const source = outWidth / outHeight;
      if (source > frame.ratio) outWidth = outHeight * frame.ratio;
      else outHeight = outWidth / frame.ratio;
    }
    if (settings.shortEdge) {
      const scale = settings.shortEdge / Math.min(outWidth, outHeight);
      outWidth *= scale; outHeight *= scale;
    }
    outWidth = Math.max(2, Math.round(outWidth));
    outHeight = Math.max(2, Math.round(outHeight));
    if (outWidth % 2) outWidth += 1;
    if (outHeight % 2) outHeight += 1;
    return {width: outWidth, height: outHeight, fps: settings.fps, jpegQuality: settings.jpegQuality, crf: settings.crf, mbps: settings.mbps};
  }
  /* ------------------------------------------------------------------ looks + LUT scoping */
  // A look can ride on one clip or on the whole timeline; the clip's own look wins where both exist.
  const LOOK_SCOPES = Object.freeze([
    {id: 'clip', label: 'This clip'},
    {id: 'timeline', label: 'Whole timeline'},
  ]);
  function normalizeLook(input) {
    const source = input && typeof input === 'object' ? input : {};
    const scope = source.scope === 'timeline' ? 'timeline' : 'clip';
    return {
      id: source.id ? String(source.id).slice(0, 80) : null,
      name: source.name ? String(source.name).slice(0, 120) : null,
      scope,
      intensity: round(clamp(finite(source.intensity, 1), 0, 1), 3),
    };
  }
  function resolveLook({timeline = null, clip = null} = {}) {
    const global = timeline ? normalizeLook(timeline) : null;
    const local = clip ? normalizeLook(clip) : null;
    const chosen = local && local.id ? local : global && global.id ? global : null;
    return chosen ? {id: chosen.id, name: chosen.name, scope: local && local.id ? 'clip' : 'timeline', intensity: chosen.intensity} : null;
  }
  return {
    AUDIO_DEFAULT, DENOISE_PRESETS, normalizeVolumeKeyframe, normalizeVolumeKeyframes, volumeExpression,
    normalizeAudio, audioFilterChain, normalizeVoiceTake, normalizeVoiceTakes, takeFilterChain, audioGraph,
    STABILIZATION_FILTERS, STABILIZATION_DEFAULT, normalizeStabilization, stabilizationFilter, stabilizeArgs,
    ASPECT_PRESETS, REFRAME_DEFAULT, aspectPreset, normalizeFraming, saliencyMap, reframeFocus, normalizeFocusPoint,
    RESOLUTION_PRESETS, FRAME_RATE_PRESETS, BITRATE_PRESETS, AUDIO_BITRATE, resolutionPreset, bitratePreset,
    normalizeDelivery, estimatedFileSize, sizeLabel, deliveryGeometry,
    LOOK_SCOPES, normalizeLook, resolveLook,
  };
});
