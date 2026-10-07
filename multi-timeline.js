// === MULTI-TIMELINE MODULE ===
(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const root = byId('multi-timeline');
  if (!root) return;

  const bridge = () => window.filmLabTimelineBridge || {};
  // === CapCut-style video effects =============================================================
  // Keyframes, speed ramps, text / caption / sticker layers, blend modes and chroma key all come
  // from video-tools.js, which the preview and the export share. A missing module downgrades to
  // plain behaviour instead of breaking the timeline.
  const fx = window.FilmVideo || null;
  // The inline editor script has its own clamp01(); an external file cannot see it, so this module
  // keeps a local copy for the keyframe and ramp maths.
  const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const finiteNumber = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const normalizeKeyframes = (value) => (fx ? fx.normalizeKeyframes(value) : {});
  const normalizeSpeed = (value) => (fx ? fx.normalizeSpeed(value) : {rate: 1, reverse: false, freeze: false, ramp: 'none'});
  const normalizeBlend = (value) => (fx ? fx.normalizeBlend(value) : 'normal');
  const normalizeOpacity = (value, fallback = 1) => (fx ? fx.normalizeOpacity(value, fallback) : fallback);
  const normalizeChroma = (value) => (fx ? fx.normalizeChromaKey(value) : {enabled: false, color: '#00ff00', tolerance: 30, softness: 18, spill: 45});
  const normalizeLayerInput = (value, fallback) => (fx ? fx.normalizeLayer(value, fallback) : null);
  function ensureClipEffects(clip) {
    if (!clip) return clip;
    clip.keyframes = normalizeKeyframes(clip.keyframes);
    clip.speed = normalizeSpeed(clip.speed);
    clip.blend = normalizeBlend(clip.blend);
    clip.opacity = normalizeOpacity(clip.opacity, 1);
    clip.chroma = normalizeChroma(clip.chroma);
    return clip;
  }
  // The sampled transform of a clip at a moment inside its own timeline span. A keyframed opacity
  // multiplies the clip's base opacity, so the slider stays the ceiling.
  function clipTransformAt(clip, timelineTime) {
    if (!clip) return {position: {x: 0, y: 0}, scale: 1, rotation: 0, opacity: 1};
    const local = Math.max(0, (timelineTime ?? clip.start) - clip.start);
    const base = normalizeOpacity(clip.opacity, 1);
    const sampled = fx ? fx.sampleKeyframes(clip.keyframes, local, {position: {x: 0, y: 0}, scale: 1, rotation: 0, opacity: base})
      : {position: {x: 0, y: 0}, scale: 1, rotation: 0, opacity: base};
    const sampledOpacity = sampled.opacity === undefined ? base : sampled.opacity;
    return {...sampled, opacity: clamp01(Math.min(base, sampledOpacity))};
  }
  // True when a clip carries something the app's own renderer cannot show by itself: keyframes, a
  // moved / scaled / rotated frame, a fade, a blend mode or a chroma key.
  function hasClipEffects(clip, timelineTime) {
    if (!clip || !fx) return false;
    const transform = clipTransformAt(clip, timelineTime ?? clip.start);
    const moved = Math.abs(transform.position.x) > 1e-4 || Math.abs(transform.position.y) > 1e-4;
    const reshaped = Math.abs(transform.scale - 1) > 1e-4 || Math.abs(transform.rotation) > 1e-4;
    return fx.hasKeyframes(normalizeKeyframes(clip.keyframes)) || moved || reshaped ||
      transform.opacity < 0.999 || normalizeBlend(clip.blend) !== 'normal' || !!normalizeChroma(clip.chroma).enabled;
  }
  // A frame the app has already rendered (the graded main frame), wrapped as a scene layer so the
  // shared renderer can apply the clip's keyframed transform, blend, opacity and chroma key to it.
  // The preview and the export call this, which is what makes them match.
  function clipFrameLayer(clip, timelineTime, frame) {
    const transform = clipTransformAt(clip, timelineTime);
    const chroma = normalizeChroma(clip.chroma);
    const keyed = chroma.enabled && frame ? (bridge().chromaKeyFrame?.(frame, chroma) || frame) : frame;
    return {
      kind: 'media', clipId: clip.id, track: 'main', element: keyed, image: keyed, chroma,
      blend: normalizeBlend(clip.blend),
      opacity: transform.opacity,
      transform: {x: transform.position.x, y: transform.position.y, scale: transform.scale, rotation: transform.rotation},
    };
  }
  const view = byId('mtl-scroll');
  const canvas = byId('mtl-canvas');
  const ruler = byId('mtl-ruler');
  const pool = byId('mtl-media-pool');
  const mainTrack = byId('mtl-main-track');
  const overlayTrack = byId('mtl-overlay-track');
  const audioTrack = byId('mtl-audio-track');
  const playhead = byId('mtl-playhead');
  const emptyHint = byId('mtl-empty');
  const transitionMenu = byId('mtl-transition-popover');
  const transitionDurationSlider = byId('mtl-transition-duration');
  const transitionDurationValue = byId('mtl-transition-duration-value');
  const contextMenu = byId('mtl-context-menu');
  const timeArea = byId('mtl-time-area');
  const globalPlayhead = playhead;
  const rulerPlayhead = byId('mtl-ruler-playhead');
  const extraVideoTracks = byId('mtl-extra-video-tracks');
  const extraPhotoTracks = byId('mtl-extra-photo-tracks');
  const zoomSlider = byId('mtl-zoom-slider');
  const filmLabState = window.filmLabState || (window.filmLabState = { clips: [] });
  filmLabState.clips ||= [];
  const state = {
    clips: filmLabState.clips, tracks: [], media: new Map(), selected: null, contextClip: null, contextTime: 0,
    projectDuration: 0, pixelsPerSecond: 18, zoom: 100, timelineTime: 0,
    activeMain: null, transportPlaying: false, inGap: false, pendingMain: null, switchToken: 0, switchingSource: false,
    lastTick: 0, raf: 0, undo: [], redo: [], initialized: false,
    firstMediaId: null, nextVideoTrack: 3, nextPhotoTrack: 3, lastOverlaySignature: '',
    selectedKeyframe: null, selectedLayerId: null, handleBox: null, handleDrag: null,
  };
  // Start with two video lanes, two photo lanes, the text lane and the locked source-audio lane.
  state.tracks.push(
    { id: 'main', kind: 'video', label: 'V1' }, { id: 'video-2', kind: 'video', label: 'V2' },
    { id: 'photo-1', kind: 'photo', label: 'PHOTO 1' }, { id: 'photo-2', kind: 'photo', label: 'PHOTO 2' },
    { id: 'text', kind: 'text', label: 'TEXT', editable: false },
    { id: 'audio', kind: 'audio', label: 'AUDIO', editable: false },
  );
  let boundVideoElement = null;
  let activePointer = null;
  let scrubPointer = null;
  let clipSequence = 1;
  let mediaSequence = 1;
  let overlayLayer = null;
  let layerHandles = null;
  let transitionLayer = null;
  const transitionPreviewElements = new Map();
  const overlayTransitionCanvases = new Map();
  let transitionPreviewSignature = '';
  const sharedTimeline = window.filmLabTimeline || (window.filmLabTimeline = {});
  Object.defineProperties(sharedTimeline, {
    tracks: { configurable: true, enumerable: true, get: () => state.tracks.map((track) => ({ ...track })) },
    playhead: { configurable: true, enumerable: true, get: () => state.timelineTime },
    zoom: { configurable: true, enumerable: true, get: () => state.zoom },
    playing: { configurable: true, enumerable: true, get: () => state.transportPlaying },
    selectedClip: { configurable: true, enumerable: true, get: () => state.selected ? { ...state.selected } : null },
  });

  const FRAME_RATE = 24;
  const MIN_CLIP_DURATION = 0.1;
  const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(clipSequence++).toString(36)}`;
  const snapFrame = (time) => Math.max(0, Math.round(time * FRAME_RATE) / FRAME_RATE);
  const mainClips = () => state.clips.filter((clip) => clip.track === 'main').sort((a, b) => a.start - b.start);
  const overlayClips = () => state.clips.filter((clip) => clip.track !== 'main').sort((a, b) => {
    const aTrack = state.tracks.find((track) => track.id === a.track);
    const bTrack = state.tracks.find((track) => track.id === b.track);
    const layerA = aTrack?.kind === 'photo' ? 1 : 0;
    const layerB = bTrack?.kind === 'photo' ? 1 : 0;
    return layerA - layerB || state.tracks.indexOf(aTrack) - state.tracks.indexOf(bTrack) || a.start - b.start;
  });
  const clipDuration = (clip) => Math.max(MIN_CLIP_DURATION, clip.trimEnd - clip.trimStart);
  // Speed / reverse / freeze change how long a clip occupies the timeline, and every consumer
  // (gaps, collisions, transitions, the export plan) reads the length through clipOutputDuration.
  const clipOutputDuration = (clip) => {
    if (!fx) return clipDuration(clip);
    const span = Math.max(MIN_CLIP_DURATION, clip.trimEnd - clip.trimStart);
    const settings = normalizeSpeed(clip.speed);
    if (settings.freeze) return clipDuration(clip);
    return Math.max(MIN_CLIP_DURATION, fx.clipOutputDuration(span, settings));
  };
  const clipRate = (clip) => normalizeSpeed(clip?.speed).rate;
  const clipNeedsManualDrive = (clip) => {
    const settings = normalizeSpeed(clip?.speed);
    return settings.freeze || settings.reverse || settings.ramp !== 'none';
  };
  const trackRows = () => [...root.querySelectorAll('.mtl-track[data-track-id]')];
  const trackContent = (id) => root.querySelector(`.mtl-track[data-track-id="${CSS.escape(id)}"] .mtl-track-content`);
  const rememberTracks = () => state.tracks.map((track) => ({ ...track }));
  function ensureTrack(kind, id = null) {
    if (id && state.tracks.some((track) => track.id === id)) return state.tracks.find((track) => track.id === id);
    if (kind === 'video' && (!id || id === 'main')) {
      const empty = state.tracks.find((track) => track.kind === 'video' && track.id !== 'main' && !state.clips.some((clip) => clip.track === track.id));
      if (empty) return empty;
      const track = { id: `video-${state.nextVideoTrack}`, kind: 'video', label: `V${state.nextVideoTrack}` };
      state.nextVideoTrack++;
      state.tracks.push(track);
      appendTrackRow(track, extraVideoTracks);
      return track;
    }
    if (kind === 'photo' && (!id || id === 'photo-1')) {
      const empty = state.tracks.find((track) => track.kind === 'photo' && !state.clips.some((clip) => clip.track === track.id));
      if (empty) return empty;
      const track = { id: `photo-${state.nextPhotoTrack}`, kind: 'photo', label: `PHOTO ${state.nextPhotoTrack}` };
      state.nextPhotoTrack++;
      state.tracks.push(track);
      appendTrackRow(track, extraPhotoTracks);
      return track;
    }
    return state.tracks.find((track) => track.id === (id || 'main')) || null;
  }
  function appendTrackRow(track, container) {
    if (!container || root.querySelector(`.mtl-track[data-track-id="${CSS.escape(track.id)}"]`)) return;
    const row = document.createElement('div');
    row.className = `mtl-track mtl-${track.kind}-row mtl-dynamic-track`;
    row.dataset.trackId = track.id;
    const label = document.createElement('span');
    label.className = 'mtl-track-name'; label.textContent = track.label;
    const content = document.createElement('div');
    content.className = 'mtl-track-content'; content.dataset.track = track.id;
    row.append(label, content); container.appendChild(row);
    addDropHandlers(content, track.id);
    content.addEventListener('click', snapPointerToTime);
  }
  function availableTrack(media, requested) {
    if (media.type === 'video' && requested === 'main') return 'main';
    if (media.type === 'video' && !requested) return state.firstMediaId || mainClips().length ? ensureTrack('video').id : 'main';
    const explicit = state.tracks.find((track) => track.id === requested);
    if (explicit && explicit.kind === (media.type === 'image' ? 'photo' : 'video')) return requested;
    if (media.type === 'image' || requested === 'photo' || requested === 'overlay') {
      if (!state.clips.some((clip) => clip.track === 'photo-1')) return 'photo-1';
      return ensureTrack('photo').id;
    }
    if (!state.firstMediaId && !mainClips().length && requested !== 'video') return 'main';
    return ensureTrack('video').id;
  }
  function resolveTrackStart(trackName, desired, duration, excludedId = null) {
    const others = state.clips.filter((clip) => clip.track === trackName && clip.id !== excludedId);
    const candidates = [safeTime(desired), 0, ...others.flatMap((clip) => [Math.max(0, clip.start - duration), clipEnd(clip)])];
    const valid = candidates.filter((candidate) => others.every((clip) => candidate + duration <= clip.start + 0.015 || candidate >= clipEnd(clip) - 0.015));
    return valid.sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired))[0] ?? Math.max(0, ...others.map(clipEnd));
  }
  const clipEnd = (clip) => clip.start + clipOutputDuration(clip);
  const safeTime = (time) => Math.max(0, Number.isFinite(time) ? time : 0);
  const TRANSITION_TYPES = new Set(['none', 'dissolve', 'fade-to-black', 'fade-from-white', 'slide-left', 'wipe']);
  function canTransition(clip) {
    if (!clip || clip.track === 'audio') return false;
    const track = state.tracks.find((item) => item.id === clip.track);
    const media = state.media.get(clip.mediaId);
    return !!track && ['video', 'photo'].includes(track.kind) && !!media && ['video', 'image'].includes(media.type);
  }
  function transitionInfo(clip) {
    const transition = clip?.transitionOut || {};
    const duration = Math.max(0.1, Math.min(2, Number(transition.duration) || 0.5));
    if (!canTransition(clip)) return { type: 'none', duration };
    const requestedType = transition.type || clip?.transition || 'none';
    return { type: TRANSITION_TYPES.has(requestedType) ? requestedType : 'none', duration };
  }
  function transitionSourceTime(transition, clip, side, time) {
    const start = Math.max(0, Number(clip.trimStart) || 0);
    const end = Math.max(start, (Number(clip.trimEnd) || start + 0.001) - 0.001);
    let sourceTime;
    if (side === 'outgoing') sourceTime = time < transition.cut ? start + time - clip.start : end;
    else if (transition.type === 'dissolve') sourceTime = start + transition.progress * transition.duration;
    else sourceTime = time < transition.cut ? start : start + time - transition.cut;
    return Math.max(start, Math.min(end, sourceTime));
  }
  function setTransition(clip, type, duration = transitionInfo(clip).duration) {
    if (!canTransition(clip)) return false;
    const normalizedType = TRANSITION_TYPES.has(type) ? type : 'none';
    clip.transitionOut = { type: normalizedType, duration: Math.max(0.1, Math.min(2, Number(duration) || 0.5)) };
    clip.transition = normalizedType;
    if (normalizedType !== 'none') {
      const incoming = state.clips.filter((item) => item.track === clip.track && item.id !== clip.id && Math.abs(item.start - clipEnd(clip)) <= 0.025).sort((a, b) => a.start - b.start)[0];
      if (incoming && canTransition(incoming)) {
        getTransitionSource(state.media.get(clip.mediaId), clip.id, clip.track);
        getTransitionSource(state.media.get(incoming.mediaId), incoming.id, clip.track);
      }
    }
    return true;
  }
  const makeSnapshot = () => ({ clips: state.clips.map((clip) => ({ ...clip })), selected: state.selected?.id || null, timelineTime: state.timelineTime });

  function remember() {
    state.undo.push(makeSnapshot());
    if (state.undo.length > 60) state.undo.shift();
    state.redo.length = 0;
    updateHistoryButtons();
  }
  function updateHistoryButtons() {
    root.querySelector('[data-mtl-action="undo"]').disabled = !state.undo.length;
    root.querySelector('[data-mtl-action="redo"]').disabled = !state.redo.length;
  }
  function restoreSnapshot(snapshot, destination) {
    if (!snapshot) return;
    destination.push(makeSnapshot());
    state.clips.splice(0, state.clips.length, ...snapshot.clips.map((clip) => ({ ...clip })));
    filmLabState.clips = state.clips;
    state.selected = state.clips.find((clip) => clip.id === snapshot.selected) || null;
    state.timelineTime = snapshot.timelineTime;
    state.activeMain = null;
    state.inGap = false;
    updateHistoryButtons();
    render();
    seekTo(state.timelineTime, false);
  }
  function undo() { restoreSnapshot(state.undo.pop(), state.redo); }
  function redo() { restoreSnapshot(state.redo.pop(), state.undo); }

  function getProjectEnd() {
    return Math.max(0, ...state.clips.map(clipEnd), state.timelineTime);
  }
  function getTimelinePixels() {
    return Math.max(240, view.clientWidth - 58, state.projectDuration * state.pixelsPerSecond);
  }
  function refreshLayout() {
    state.projectDuration = Math.max(0.25, getProjectEnd());
    const contentWidth = getTimelinePixels();
    canvas.style.width = `${58 + contentWidth}px`;
    canvas.style.minWidth = `${58 + contentWidth}px`;
    ruler.style.width = `${contentWidth}px`;
    const step = state.pixelsPerSecond;
    const majorStep = step < 8 ? 10 : step < 14 ? 5 : 2;
    const frag = document.createDocumentFragment();
    for (let sec = 0; sec <= state.projectDuration + 0.001; sec += majorStep) {
      const tick = document.createElement('div');
      tick.className = 'mtl-ruler-tick';
      tick.style.left = `${sec * step}px`;
      const label = document.createElement('span');
      label.textContent = formatTime(sec);
      tick.appendChild(label);
      frag.appendChild(tick);
    }
    ruler.replaceChildren(frag, rulerPlayhead);
    byId('mtl-zoom-label').textContent = `${Math.round(state.zoom)}%`;
    zoomSlider.value = String(state.zoom);
    byId('mtl-timecode').textContent = `${formatTime(state.timelineTime)} / ${formatTime(state.projectDuration)}`;
    updatePlayhead();
  }
  function formatTime(seconds) {
    seconds = Math.max(0, seconds || 0);
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const tenths = Math.floor((seconds % 1) * 10);
    return `${mins}:${String(secs).padStart(2, '0')}.${tenths}`;
  }
  function updatePlayhead() {
    const pixel = state.timelineTime * state.pixelsPerSecond;
    playhead.style.left = `${58 + pixel}px`;
    globalPlayhead.style.left = `${58 + pixel}px`;
    rulerPlayhead.style.left = `${pixel}px`;
    for (const handle of [playhead, rulerPlayhead]) {
      handle.setAttribute('aria-valuemax', String(state.projectDuration));
      handle.setAttribute('aria-valuenow', String(state.timelineTime));
    }
    byId('mtl-timecode').textContent = `${formatTime(state.timelineTime)} / ${formatTime(state.projectDuration)}`;
    const active = state.clips.find((clip) => state.timelineTime >= clip.start && state.timelineTime < clipEnd(clip));
    const label = state.tracks.find((track) => track.id === state.selected?.track)?.label || state.selected?.track?.toUpperCase();
    const activeLabel = state.tracks.find((track) => track.id === active?.track)?.label || active?.track?.toUpperCase();
    byId('mtl-selection-status').textContent = state.selected ? `${label} · ${formatTime(clipDuration(state.selected))}` : active ? `${activeLabel} PLAYING` : 'Select a clip';
  }
  // The TEXT lane shows the text and sticker layers as blocks on the same time ruler.
  function renderLayerLane() {
    const lane = byId('mtl-text-track');
    if (!lane) return;
    lane.querySelectorAll('.mtl-layer-block').forEach((node) => node.remove());
    for (const layer of normalizeLayers()) {
      const block = document.createElement('button');
      block.type = 'button';
      block.className = `mtl-layer-block mtl-layer-${layer.kind}${state.selectedLayerId === layer.id ? ' mtl-selected' : ''}`;
      block.dataset.layerId = layer.id;
      block.style.left = `${Math.max(0, layer.start) * state.pixelsPerSecond}px`;
      block.style.width = `${Math.max(26, (layer.end - layer.start) * state.pixelsPerSecond)}px`;
      block.textContent = layer.kind === 'sticker' ? `✦ ${layer.sticker}` : layer.text.slice(0, 24) || 'Text';
      block.title = `${block.textContent} · ${formatTime(layer.start)} → ${formatTime(layer.end)}`;
      block.addEventListener('click', (event) => {
        event.stopPropagation();
        state.selectedLayerId = layer.id;
        window.dispatchEvent(new CustomEvent('film-lab-layer-selected', {detail: {id: layer.id}}));
        renderLayers();
      });
      lane.appendChild(block);
    }
    renderCaptionsLane();
  }
  function renderCaptionsLane() {
    const lane = byId('mtl-text-track');
    if (!lane) return;
    lane.querySelectorAll('.mtl-caption-block').forEach((node) => node.remove());
    for (const caption of (filmLabState.captions || [])) {
      const block = document.createElement('button');
      block.type = 'button';
      block.className = 'mtl-layer-block mtl-caption-block';
      block.dataset.captionId = caption.id;
      block.style.left = `${Math.max(0, caption.start) * state.pixelsPerSecond}px`;
      block.style.width = `${Math.max(24, (caption.end - caption.start) * state.pixelsPerSecond)}px`;
      block.textContent = `CC ${caption.text.slice(0, 20)}`;
      block.addEventListener('click', (event) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent('film-lab-caption-selected', {detail: {id: caption.id}})); });
      lane.appendChild(block);
    }
  }
  function renderLayers() { renderLayerLane(); }
  function renderGaps() {
    root.querySelectorAll('.mtl-track-content .mtl-gap,.mtl-track-content .mtl-transition').forEach((node) => node.remove());
    const primary = mainClips();
    for (let i = 0; i < primary.length - 1; i++) {
      const clip = primary[i];
      const next = primary[i + 1];
      const end = clipEnd(clip);
      if (next.start > end + 0.025) {
        const gap = document.createElement('div');
        gap.className = 'mtl-gap';
        gap.style.left = `${end * state.pixelsPerSecond}px`;
        gap.style.width = `${(next.start - end) * state.pixelsPerSecond}px`;
        mainTrack.appendChild(gap);
      }
    }
    for (const track of state.tracks.filter((item) => item.kind === 'video' || item.kind === 'photo')) {
      const content = trackContent(track.id);
      if (!content) continue;
      const clips = state.clips.filter((clip) => clip.track === track.id).sort((a, b) => a.start - b.start);
      for (let i = 0; i < clips.length - 1; i++) {
        const clip = clips[i], next = clips[i + 1];
        if (Math.abs(next.start - clipEnd(clip)) > 0.025) continue;
        const info = transitionInfo(clip);
        const transition = document.createElement('button');
        transition.type = 'button'; transition.className = `mtl-transition${info.type !== 'none' ? ' mtl-transition-active' : ''}`;
        transition.textContent = '◆';
        transition.title = `${info.type === 'none' ? 'Add transition' : info.type} · ${info.duration.toFixed(1)}s`;
        transition.setAttribute('aria-label', `Transition at cut after ${state.media.get(clip.mediaId)?.name || 'clip'}`);
        transition.style.left = `${next.start * state.pixelsPerSecond}px`;
        transition.dataset.transitionFor = clip.id;
        content.appendChild(transition);
        transition.addEventListener('click', (event) => {
          event.stopPropagation();
          state.selected = clip;
          renderSelection();
          showTransitionMenu(event, clip);
        });
      }
    }
  }
  function renderTrackClips(trackName, element) {
    element.querySelectorAll('.mtl-clip').forEach((node) => node.remove());
    for (const clip of state.clips.filter((item) => item.track === trackName)) {
      const media = state.media.get(clip.mediaId);
      if (!media) continue;
      const node = document.createElement('div');
      node.className = `mtl-clip${state.selected?.id === clip.id ? ' mtl-selected' : ''}`;
      node.dataset.clipId = clip.id;
      node.draggable = false;
      node.style.left = `${clip.start * state.pixelsPerSecond}px`;
      node.style.width = `${Math.max(18, clipDuration(clip) * state.pixelsPerSecond)}px`;
      node.title = `${media.name} · ${formatTime(clipDuration(clip))}`;
      if (media.thumbnail) {
        const thumb = document.createElement('img');
        thumb.alt = '';
        thumb.src = media.thumbnail;
        node.appendChild(thumb);
      }
      const label = document.createElement('span');
      label.className = 'mtl-clip-name';
      label.textContent = media.name;
      node.appendChild(label);
      if (state.selected?.id === clip.id) {
        // Diamonds on the clip: click jumps to the key, drag moves it, double-click removes it and
        // the selected key grows an easing pill (linear / hold / ease-in / ease-out / ease-in-out).
        const selection = selectedKeyframe();
        for (const time of (fx ? fx.keyframeTimes(clip.keyframes) : [])) {
          if (time > clipOutputDuration(clip) + 1e-6) continue;
          const marker = document.createElement('span');
          marker.className = 'mtl-keyframe-marker';
          marker.dataset.clipId = clip.id;
          marker.dataset.keyframeTime = String(time);
          marker.style.left = `${Math.max(2, time * state.pixelsPerSecond)}px`;
          marker.title = `Keyframe ${formatTime(time)} — click to jump, drag to move, double-click to remove`;
          marker.tabIndex = 0;
          marker.setAttribute('role', 'button');
          marker.setAttribute('aria-label', `Keyframe at ${formatTime(time)}`);
          if (selection && selection.clipId === clip.id && Math.abs(selection.time - time) <= 0.5 / 24) {
            marker.classList.add('mtl-keyframe-selected');
            const pill = document.createElement('select');
            pill.className = 'mtl-keyframe-easing';
            pill.setAttribute('aria-label', 'Keyframe easing');
            for (const easing of (fx ? fx.EASINGS : [])) {
              const option = document.createElement('option');
              option.value = easing;
              option.textContent = fx.EASING_LABELS?.[easing] || easing;
              pill.appendChild(option);
            }
            pill.value = keyframeEasingAt(clip, time);
            pill.addEventListener('pointerdown', (event) => event.stopPropagation());
            pill.addEventListener('click', (event) => event.stopPropagation());
            pill.addEventListener('change', (event) => {
              event.stopPropagation();
              setKeyframeEasing(clip.id, time, pill.value);
            });
            marker.appendChild(pill);
          }
          const dragOffset = () => {
            if (marker.dataset.dragStartX === undefined) return null;
            const from = Number(marker.dataset.dragFrom);
            const seconds = from + (Number(marker.dataset.lastX) - Number(marker.dataset.dragStartX)) / Math.max(1, state.pixelsPerSecond);
            return {from, seconds: Math.max(0, Math.min(clipOutputDuration(clip), seconds))};
          };
          marker.addEventListener('pointerdown', (event) => {
            if (event.target.closest('.mtl-keyframe-easing')) return;
            event.stopPropagation();
            // Pointer capture throws for an unknown pointer id, so a synthetic or already-lifted
            // pointer can never break the drag.
            try { marker.setPointerCapture?.(event.pointerId); } catch (error) {}
            marker.dataset.dragStartX = String(event.clientX);
            marker.dataset.lastX = String(event.clientX);
            marker.dataset.dragFrom = String(time);
            marker.dataset.dragged = '0';
          });
          marker.addEventListener('pointermove', (event) => {
            if (marker.dataset.dragStartX === undefined) return;
            event.stopPropagation();
            marker.dataset.lastX = String(event.clientX);
            const drag = dragOffset();
            if (!drag) return;
            marker.style.left = `${Math.max(2, drag.seconds * state.pixelsPerSecond)}px`;
            if (Math.abs(drag.seconds - drag.from) > 0.5 / 24) marker.dataset.dragged = '1';
          });
          const finishDrag = (event) => {
            if (marker.dataset.dragStartX === undefined) return;
            const dragged = marker.dataset.dragged === '1';
            const drag = dragOffset();
            delete marker.dataset.dragStartX; delete marker.dataset.dragFrom; delete marker.dataset.dragged; delete marker.dataset.lastX;
            if (!dragged || !drag) return;
            event.stopPropagation();
            moveKeyframeTo(clip.id, drag.from, drag.seconds);
          };
          marker.addEventListener('pointerup', (event) => finishDrag(event));
          marker.addEventListener('pointercancel', () => {
            delete marker.dataset.dragStartX; delete marker.dataset.dragFrom; delete marker.dataset.dragged; delete marker.dataset.lastX;
          });
          marker.addEventListener('click', (event) => {
            if (event.target.closest('.mtl-keyframe-easing')) return;
            event.stopPropagation();
            selectKeyframe(clip.id, time);
          });
          marker.addEventListener('dblclick', (event) => {
            event.stopPropagation();
            const result = fx ? fx.removeKeyframesAt(clip.keyframes, time) : null;
            if (!result?.removed) return;
            clip.keyframes = result.keyframes;
            clearKeyframeSelection();
            render();
            renderSelection();
            renderOverlayPreview();
            bridge().onEffectsChanged?.(clip, {action: 'removed', properties: ['selection']});
          });
          node.appendChild(marker);
        }
      }
      const left = document.createElement('button');
      left.type = 'button'; left.className = 'mtl-trim-handle mtl-trim-left'; left.setAttribute('aria-label', 'Trim clip start');
      const right = document.createElement('button');
      right.type = 'button'; right.className = 'mtl-trim-handle mtl-trim-right'; right.setAttribute('aria-label', 'Trim clip end');
      node.append(left, right);
      node.addEventListener('pointerdown', onClipPointerDown);
      node.addEventListener('pointermove', onClipHoverMove);
      node.addEventListener('contextmenu', onClipContextMenu);
      node.addEventListener('click', (event) => {
        if (event.target.closest('.mtl-trim-handle')) return;
        state.selected = clip;
        renderSelection();
      });
      element.appendChild(node);
    }
  }
  function renderSelection() {
    canvas.querySelectorAll('.mtl-clip').forEach((node) => node.classList.toggle('mtl-selected', node.dataset.clipId === state.selected?.id));
    updatePlayhead();
    // The video-effects panel listens for this, so every selection path (click, keyboard, undo)
    // keeps the sidebar in step with the timeline.
    if (state.selectedKeyframe && state.selectedKeyframe.clipId !== state.selected?.id) state.selectedKeyframe = null;
    window.dispatchEvent(new CustomEvent('film-lab-clip-selected', {detail: {id: state.selected?.id || null}}));
  }
  function renderAudio() {
    audioTrack.replaceChildren();
    const videos = mainClips().filter((clip) => state.media.get(clip.mediaId)?.type === 'video');
    if (!videos.length) return;
    const oldWave = byId('audioWaveform');
    const sourceBars = oldWave?.querySelectorAll('.audioWaveBar,.waveBar,.timeline-wave-bar,.audioBar') || [];
    for (const clip of videos) {
      const wave = document.createElement('div');
      wave.className = 'mtl-wave';
      wave.style.left = `${clip.start * state.pixelsPerSecond}px`;
      wave.style.width = `${clipDuration(clip) * state.pixelsPerSecond}px`;
      if (sourceBars.length) {
        for (const old of sourceBars) {
          const bar = document.createElement('i');
          bar.style.height = old.style.height || old.style.getPropertyValue('--wave-height') || '35%';
          wave.appendChild(bar);
        }
      } else {
        for (let i = 0; i < 90; i++) {
          const bar = document.createElement('i');
          const noise = Math.abs(Math.sin(i * 12.9898) * Math.cos(i * 78.233));
          bar.style.height = `${10 + noise * 78}%`;
          wave.appendChild(bar);
        }
      }
      audioTrack.appendChild(wave);
    }
  }
  function render() {
    refreshLayout();
    renderTrackClips('main', mainTrack);
    renderTrackClips('photo-1', overlayTrack);
    const photoRow = overlayTrack.closest('.mtl-track');
    photoRow.hidden = false;
    for (const track of state.tracks) {
      if (track.id === 'main' || track.id === 'photo-1') continue;
      const content = trackContent(track.id);
      if (content) renderTrackClips(track.id, content);
    }
    renderGaps();
    renderLayers();
    renderAudio();
    emptyHint.hidden = state.clips.length > 0;
    updateHistoryButtons();
    updateTransportButton();
    renderSelection();
    renderOverlayPreview();
  }

  function getMediaThumbnail(media, videoElement = null) {
    try {
      const source = videoElement;
      if (!source || source.readyState < 2 || !source.videoWidth) return '';
      const thumb = document.createElement('canvas');
      const scale = Math.min(1, 180 / Math.max(source.videoWidth, source.videoHeight));
      thumb.width = Math.max(1, Math.round(source.videoWidth * scale));
      thumb.height = Math.max(1, Math.round(source.videoHeight * scale));
      thumb.getContext('2d').drawImage(source, 0, 0, thumb.width, thumb.height);
      return thumb.toDataURL('image/jpeg', 0.72);
    } catch (error) { return ''; }
  }
  function scheduleMediaThumbnail(media, videoElement) {
    const schedule = () => {
      const renderThumbnail = () => {
        if (!state.media.has(media.id)) return;
        if (!videoElement || videoElement.readyState < 2 || !videoElement.videoWidth) {
          videoElement?.addEventListener('loadeddata', schedule, { once: true });
          return;
        }
        const thumbnail = getMediaThumbnail(media, videoElement);
        if (!thumbnail) return;
        media.thumbnail = thumbnail;
        const card = Array.from(pool.querySelectorAll('.mtl-media-card')).find((node) => node.dataset.mediaId === media.id);
        if (!card) return;
        let image = card.querySelector('img');
        if (!image) { image = document.createElement('img'); image.alt = ''; card.prepend(image); }
        image.src = thumbnail;
      };
      if (window.requestIdleCallback) window.requestIdleCallback(renderThumbnail, { timeout: 1200 });
      else setTimeout(renderThumbnail, 120);
    };
    schedule();
  }
  function addMediaCard(media) {
    const card = document.createElement('button');
    card.type = 'button'; card.className = 'mtl-media-card'; card.draggable = true;
    card.dataset.mediaId = media.id; card.setAttribute('aria-pressed', 'false');
    if (media.thumbnail) {
      const img = document.createElement('img'); img.alt = ''; img.src = media.thumbnail; card.appendChild(img);
    }
    const title = document.createElement('span'); title.textContent = media.name; card.appendChild(title);
    card.addEventListener('click', () => {
      pool.querySelectorAll('.mtl-media-card').forEach((node) => node.setAttribute('aria-pressed', String(node === card)));
    });
    card.addEventListener('dblclick', () => addClipFromMedia(media.id));
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('application/x-film-lab-media', media.id);
      event.dataTransfer.setData('text/plain', media.id);
      event.dataTransfer.effectAllowed = 'copy';
    });
    pool.appendChild(card);
  }
  function addFirstMedia(file, src, duration, videoElement) {
    const overlayVideoElement = document.createElement('video');
    overlayVideoElement.muted = true; overlayVideoElement.playsInline = true; overlayVideoElement.preload = 'auto';
    overlayVideoElement.src = src;
    overlayVideoElement.addEventListener('loadeddata', () => renderOverlayPreview());
    overlayVideoElement.addEventListener('seeked', () => renderOverlayPreview());
    overlayVideoElement.load();
    const media = {
      id: `first-${mediaSequence++}`, file, src, type: 'video', duration,
      name: file?.name || 'Main video', thumbnail: '', videoElement, overlayVideoElement,
      external: false,
    };
    state.media.set(media.id, media);
    state.firstMediaId = media.id;
    addMediaCard(media);
    scheduleMediaThumbnail(media, videoElement);
    const trim = bridge().trim || { start: 0, end: Math.min(duration, 60) };
    const end = Math.min(duration, Math.max(0.05, trim.end || duration));
    const firstClip = ensureClipEffects({ id: uid('clip'), mediaId: media.id, track: 'main', start: 0, trimStart: Math.max(0, trim.start || 0), trimEnd: end, transition: 'none', transitionOut: { type: 'none', duration: 0.5 } });
    state.clips.unshift(firstClip);
    filmLabState.clips = state.clips;
    state.selected = firstClip;
    root.hidden = false;
    state.initialized = true;
    state.timelineTime = firstClip.start;
    render();
  }
  // Video mode owns the timeline: opening it never depends on media being adopted, so a slow or
  // failing preview helper cannot leave the workspace without its timeline.
  function reveal() {
    if (!root.hidden) return;
    root.hidden = false;
    try { render(); } catch (error) { console.warn('Timeline layout unavailable', error); }
  }
  function adoptFirstVideo(file, videoElement, src, duration, trim) {
    root.hidden = false;
    const oldMain = mainClips();
    const oldFirst = oldMain.find((clip) => state.media.get(clip.mediaId)?.external === false);
    const mainBridge = bridge();
    if (state.firstMediaId && oldFirst && state.media.get(oldFirst.mediaId)?.src === src) {
      return;
    }
    // A newly uploaded primary video starts a fresh project; release any additional media from the prior one.
    for (const media of state.media.values()) if (media.external) URL.revokeObjectURL(media.src);
    state.clips.splice(0, state.clips.length);
    filmLabState.clips = state.clips;
    state.firstMediaId = null;
    state.tracks.splice(0, state.tracks.length,
      { id: 'main', kind: 'video', label: 'V1' }, { id: 'video-2', kind: 'video', label: 'V2' },
      { id: 'photo-1', kind: 'photo', label: 'PHOTO 1' }, { id: 'photo-2', kind: 'photo', label: 'PHOTO 2' },
      { id: 'text', kind: 'text', label: 'TEXT', editable: false },
      { id: 'audio', kind: 'audio', label: 'AUDIO', editable: false },
    );
    state.nextVideoTrack = 3; state.nextPhotoTrack = 3;
    extraVideoTracks.querySelectorAll('.mtl-dynamic-track').forEach((row) => row.remove());
    extraPhotoTracks.querySelectorAll('.mtl-dynamic-track').forEach((row) => row.remove());
    state.undo.length = 0; state.redo.length = 0;
    pool.querySelectorAll('.mtl-media-card').forEach((card) => card.remove());
    state.media.clear();
    const t = trim || mainBridge.trim || { start: 0, end: Math.min(duration, 60) };
    addFirstMedia(file, src, duration, videoElement);
    if (boundVideoElement !== videoElement) {
      if (boundVideoElement) {
        boundVideoElement.removeEventListener('timeupdate', handleVideoTimeUpdate, true);
        boundVideoElement.removeEventListener('play', handlePlay);
        boundVideoElement.removeEventListener('pause', handlePause);
        boundVideoElement.removeEventListener('ended', onVideoEnded);
      }
      boundVideoElement = videoElement;
      boundVideoElement.addEventListener('timeupdate', handleVideoTimeUpdate, true);
      boundVideoElement.addEventListener('play', handlePlay);
      boundVideoElement.addEventListener('pause', handlePause);
      boundVideoElement.addEventListener('ended', onVideoEnded);
    }
    state.clips[0].trimStart = Math.max(0, Math.min(duration - 0.05, Number(t.start) || 0));
    state.clips[0].trimEnd = Math.max(state.clips[0].trimStart + 0.05, Math.min(duration, Number(t.end) || duration));
    state.clips[0].start = 0;
    state.selected = state.clips[0];
    state.activeMain = state.clips[0];
    state.transportPlaying = !videoElement.paused;
    render();
    if (state.transportPlaying) ensureTick();
  }
  async function addExternalMedia(file) {
    if (!file || (!file.type.startsWith('image/') && !file.type.startsWith('video/'))) return null;
    const src = URL.createObjectURL(file);
    try {
      let media;
      if (file.type.startsWith('image/')) {
        const img = new Image();
        img.decoding = 'async'; img.src = src;
        await (img.decode ? img.decode() : new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; }));
        media = { id: `media-${mediaSequence++}`, file, src, type: 'image', duration: 5, name: file.name || 'Photo', thumbnail: src, imageElement: img, external: true };
      } else {
        const video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = src;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error('Video metadata timed out')), 20000);
          const finish = (error) => { clearTimeout(timer); video.removeEventListener('loadedmetadata', ready); video.removeEventListener('error', fail); error ? reject(error) : resolve(); };
          const ready = () => finish(); const fail = () => finish(new Error('Could not read this video'));
          video.addEventListener('loadedmetadata', ready, { once: true }); video.addEventListener('error', fail, { once: true }); video.load();
        });
        if (!(video.duration > 0 && video.videoWidth > 0)) throw new Error('This video has no readable frames');
        try { await new Promise((resolve) => { if (video.readyState >= 2) return resolve(); video.addEventListener('loadeddata', resolve, { once: true }); setTimeout(resolve, 5000); }); } catch (error) {}
        media = { id: `media-${mediaSequence++}`, file, src, type: 'video', duration: video.duration, name: file.name || 'Video', thumbnail: '', videoElement: video, external: true };
      }
      state.media.set(media.id, media);
      addMediaCard(media);
      if (media.type === 'video') scheduleMediaThumbnail(media, media.videoElement);
      return media;
    } catch (error) {
      URL.revokeObjectURL(src);
      console.warn('Multi-timeline media import failed', error);
      window.dispatchEvent(new CustomEvent('film-lab-toast', { detail: `${file.name || 'Media'} could not be opened` }));
      return null;
    }
  }
  // === Layers: text, stickers and captions ===================================================
  // Project-level overlay layers with their own start / end, so a title can sit across a cut and a
  // caption can land on a single spoken line. Both the preview canvas and the export draw them
  // through the same FilmVideo.drawScene call.
  const layers = Array.isArray(filmLabState.layers) ? filmLabState.layers : (filmLabState.layers = []);
  let layerSequence = 1;
  function normalizeLayers() {
    const normalized = layers.map((layer) => normalizeLayerInput(layer)).filter(Boolean);
    layers.splice(0, layers.length, ...normalized.sort((a, b) => a.start - b.start));
    filmLabState.layers = layers;
    return layers;
  }
  function addLayer(input) {
    const fallback = {id: `${input?.kind === 'sticker' ? 'sticker' : 'text'}-${layerSequence++}`};
    const layer = normalizeLayerInput(input, fallback);
    if (!layer) return null;
    if (!(layer.end > layer.start)) layer.end = layer.start + 2;
    layers.push(layer);
    normalizeLayers();
    remember();
    render();
    return layer;
  }
  function updateLayer(id, patch) {
    const index = layers.findIndex((layer) => layer.id === id);
    if (index < 0) return null;
    layers[index] = normalizeLayerInput({...layers[index], ...patch}, {id});
    normalizeLayers();
    renderLayers();
    renderOverlayPreview();
    return layers.find((layer) => layer.id === id);
  }
  function removeLayer(id) {
    const index = layers.findIndex((layer) => layer.id === id);
    if (index < 0) return false;
    layers.splice(index, 1);
    if (state.selectedLayerId === id) state.selectedLayerId = null;
    remember();
    render();
    return true;
  }
  function layersAt(time) {
    const at = Math.max(0, Number(time) || 0);
    return normalizeLayers().filter((layer) => at >= layer.start - 1e-6 && at < layer.end - 1e-6);
  }
  function addCaption(input) {
    const caption = fx ? fx.normalizeCaption(input) : null;
    if (!caption) return null;
    const existing = filmLabState.captions || (filmLabState.captions = []);
    existing.push(caption);
    filmLabState.captions = fx ? fx.normalizeCaptions(existing) : existing;
    remember();
    render();
    renderLayers();
    renderOverlayPreview();
    return caption;
  }
  // The caption editor writes through here: retiming a line, splitting it at the playhead and
  // merging it with its neighbour are all model edits, so the preview and the export follow.
  function updateCaption(id, patch) {
    const list = filmLabState.captions || [];
    const index = list.findIndex((line) => line.id === id);
    if (index < 0 || !fx) return null;
    const next = fx.normalizeCaption({...list[index], ...patch}, {id});
    filmLabState.captions = fx.normalizeCaptions(list.map((line, position) => (position === index ? next : line)));
    remember();
    render();
    renderLayers();
    renderOverlayPreview();
    return next;
  }
  function splitCaption(id, at) {
    const list = filmLabState.captions || [];
    const line = list.find((entry) => entry.id === id);
    if (!line || !fx) return null;
    const parts = fx.splitCaption(line, at);
    filmLabState.captions = fx.normalizeCaptions([...list.filter((entry) => entry.id !== id), ...parts]);
    remember();
    render();
    renderLayers();
    renderOverlayPreview();
    return parts;
  }
  function mergeCaption(id, direction = 1) {
    const sorted = (filmLabState.captions || []).slice().sort((a, b) => a.start - b.start);
    const index = sorted.findIndex((line) => line.id === id);
    const neighbour = index < 0 ? null : sorted[index + (direction > 0 ? 1 : -1)];
    if (!neighbour || !fx) return null;
    const merged = {...fx.mergeCaptions(sorted[index], neighbour), id: sorted[index].id};
    filmLabState.captions = fx.normalizeCaptions([...sorted.filter((line) => line.id !== id && line.id !== neighbour.id), merged]);
    remember();
    render();
    renderLayers();
    renderOverlayPreview();
    return merged;
  }
  // Local SRT / VTT import: the file never leaves the browser.
  function importCaptions(text) {
    if (!fx) return [];
    const parsed = fx.parseSubtitles(text);
    if (!parsed.length) return [];
    filmLabState.captions = fx.normalizeCaptions([...(filmLabState.captions || []), ...parsed]).slice(0, 600);
    remember();
    render();
    renderLayers();
    renderOverlayPreview();
    return parsed;
  }
  function removeCaption(id) {
    const existing = filmLabState.captions || [];
    const next = existing.filter((line) => line.id !== id);
    if (next.length === existing.length) return false;
    filmLabState.captions = next;
    remember();
    render();
    return true;
  }
  function resolveMainStart(desired, duration, excludedId = null) {
    const others = mainClips().filter((clip) => clip.id !== excludedId);
    const candidates = [safeTime(desired), 0, ...others.flatMap((clip) => [Math.max(0, clip.start - duration), clipEnd(clip)])];
    const valid = candidates.filter((candidate) => others.every((clip) => candidate + duration <= clip.start + 0.015 || candidate >= clipEnd(clip) - 0.015));
    return valid.sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired))[0] ?? Math.max(0, ...others.map(clipEnd));
  }
  function addClipFromMedia(mediaId, requestedTrack = null, at = null) {
    const media = state.media.get(mediaId);
    if (!media) return null;
    const trackName = availableTrack(media, requestedTrack);
    const duration = media.type === 'image' ? 5 : Math.max(0.05, Math.min(media.duration, 60));
    const desired = at === null ? (trackName === 'main' ? Math.max(0, ...mainClips().map(clipEnd)) : state.timelineTime) : safeTime(at);
    const start = snapFrame(resolveTrackStart(trackName, desired, duration));
    remember();
    const clip = ensureClipEffects({ id: uid('clip'), mediaId, track: trackName, start, trimStart: 0, trimEnd: duration, transition: 'none', transitionOut: { type: 'none', duration: 0.5 } });
    state.clips.push(clip);
    state.selected = clip;
    render();
    return clip;
  }
  async function addFilesToPool(files) {
    for (const file of Array.from(files || [])) {
      const media = await addExternalMedia(file);
      if (!media) continue;
      const target = media.type === 'video' ? (state.firstMediaId || mainClips().length ? 'video' : 'main') : 'photo';
      const at = media.type === 'video' && target === 'main' ? Math.max(0, ...mainClips().map(clipEnd)) : state.timelineTime;
      addClipFromMedia(media.id, target, at);
    }
    render();
  }

  function showTransitionMenu(event, clip) {
    if (!canTransition(clip)) return;
    transitionMenu.hidden = false;
    transitionMenu.dataset.clipId = clip.id;
    const info = transitionInfo(clip);
    transitionMenu.querySelectorAll('[data-mtl-transition]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mtlTransition === info.type)));
    transitionDurationSlider.value = String(info.duration);
    transitionDurationValue.textContent = `${info.duration.toFixed(1)}s`;
    const canvasRect = canvas.getBoundingClientRect();
    const anchorRect = event.currentTarget.getBoundingClientRect();
    const width = transitionMenu.offsetWidth || 270;
    const height = transitionMenu.offsetHeight || 150;
    const left = Math.max(4, Math.min(canvas.clientWidth - width - 4, anchorRect.left + anchorRect.width / 2 - canvasRect.left - width / 2));
    let top = anchorRect.top - canvasRect.top - height - 8;
    if (top < 4) top = anchorRect.bottom - canvasRect.top + 8;
    transitionMenu.style.left = `${left}px`;
    transitionMenu.style.top = `${top}px`;
  }
  function hideMenus() { transitionMenu.hidden = true; contextMenu.hidden = true; }
  function onClipContextMenu(event) {
    if (bridge().exporting) return;
    event.preventDefault();
    const node = event.currentTarget;
    const clip = state.clips.find((item) => item.id === node.dataset.clipId);
    if (!clip) return;
    state.selected = clip; state.contextClip = clip;
    state.contextTime = Math.max(clip.start, Math.min(clipEnd(clip), pointerTime(event.clientX)));
    contextMenu.hidden = false;
    contextMenu.style.left = `${Math.min(event.clientX - canvas.getBoundingClientRect().left, canvas.clientWidth - 160)}px`;
    contextMenu.style.top = `${Math.max(4, event.clientY - canvas.getBoundingClientRect().top)}px`;
    renderSelection();
  }
  function pointerTime(clientX, inRuler = false) {
    if (inRuler) {
      const rect = byId('mtl-ruler-scroll').getBoundingClientRect();
      return Math.max(0, (clientX - rect.left + byId('mtl-ruler-scroll').scrollLeft) / state.pixelsPerSecond);
    }
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - 58) / state.pixelsPerSecond);
  }
  // === TIMELINE DRAG MODULE ===
  function createTrackForClip(media, drag) {
    if (drag.generatedTrack && state.tracks.some((track) => track.id === drag.generatedTrack)) return drag.generatedTrack;
    if (media.type === 'image') {
      drag.generatedTrack = state.clips.some((clip) => clip.track === 'photo-1') ? ensureTrack('photo').id : 'photo-1';
      overlayTrack.closest('.mtl-track').hidden = false;
    } else {
      drag.generatedTrack = ensureTrack('video').id;
    }
    return drag.generatedTrack;
  }
  function trackAtPointerY(clientY, clip, drag) {
    const media = state.media.get(clip.mediaId);
    const kind = media?.type === 'image' ? 'photo' : 'video';
    const rows = trackRows().filter((row) => row.dataset.trackId !== 'audio' && !row.hidden && row.getClientRects().length);
    const row = rows.find((item) => {
      const rect = item.getBoundingClientRect();
      return clientY >= rect.top && clientY <= rect.bottom;
    });
    if (row) {
      const track = state.tracks.find((item) => item.id === row.dataset.trackId);
      if (track?.kind === kind) return track.id;
    }
    // A drop outside an existing compatible row is a request for a new lane,
    // including space above the current top lane.
    return createTrackForClip(media || { type: 'video' }, drag);
  }
  function pushTrackCollisions(clip, direction) {
    const peers = () => state.clips.filter((item) => item.track === clip.track && item.id !== clip.id).sort((a, b) => a.start - b.start);
    const before = peers().filter((item) => item.start < clip.start && clip.start < clipEnd(item)).sort((a, b) => b.start - a.start);
    if (before.length) {
      if (direction < 0) {
        let boundary = clip.start;
        for (const peer of before) {
          peer.start = snapFrame(Math.max(0, boundary - clipDuration(peer)));
          boundary = peer.start;
        }
      } else {
        clip.start = snapFrame(Math.max(clip.start, ...before.map(clipEnd)));
      }
    }
    let boundary = clipEnd(clip);
    for (const peer of peers()) {
      if (peer.start < boundary && clipEnd(peer) > clip.start) {
        peer.start = snapFrame(boundary);
        boundary = clipEnd(peer);
      } else if (peer.start >= boundary) {
        break;
      }
    }
    clip.start = snapFrame(resolveTrackStart(clip.track, clip.start, clipDuration(clip), clip.id));
    let lastEnd = -Infinity;
    for (const item of [...state.clips].filter((entry) => entry.track === clip.track).sort((a, b) => a.start - b.start)) {
      if (item.start < lastEnd - 0.001) item.start = snapFrame(lastEnd);
      lastEnd = clipEnd(item);
    }
  }
  function onClipHoverMove(event) {
    if (activePointer) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = Math.min(event.clientX - rect.left, rect.right - event.clientX);
    event.currentTarget.style.cursor = edge <= 8 ? 'col-resize' : 'grab';
  }
  function onClipPointerDown(event) {
    if (bridge().exporting || event.button !== 0 || event.target.closest('.mtl-transition')) return;
    const node = event.currentTarget;
    const clip = state.clips.find((item) => item.id === node.dataset.clipId);
    if (!clip) return;
    event.preventDefault(); event.stopPropagation();
    state.selected = clip; renderSelection();
    const edge = event.target.closest('.mtl-trim-left') ? 'left' : event.target.closest('.mtl-trim-right') ? 'right' : 'move';
    const ghost = node.cloneNode(true);
    ghost.classList.add('mtl-drag-ghost'); ghost.removeAttribute('data-clip-id'); ghost.setAttribute('aria-hidden', 'true');
    ghost.querySelectorAll('button').forEach((button) => button.remove());
    ghost.style.left = `${clip.start * state.pixelsPerSecond}px`;
    ghost.style.width = `${Math.max(18, clipDuration(clip) * state.pixelsPerSecond)}px`;
    node.parentElement.appendChild(ghost);
    node.classList.add('mtl-dragging');
    activePointer = { id: event.pointerId, clip, edge, node, ghost, startX: event.clientX, startY: event.clientY, initialStart: clip.start, initialTrack: clip.track, initialTrimStart: clip.trimStart, initialTrimEnd: clip.trimEnd, historySaved: false, generatedTrack: null };
    // A pointer that is already gone (or a synthesized event) must not abort the drag setup.
    try { node.setPointerCapture(event.pointerId); } catch (error) {}
    node.addEventListener('pointermove', onClipPointerMove);
    node.addEventListener('pointerup', onClipPointerEnd, { once: true });
    node.addEventListener('pointercancel', onClipPointerEnd, { once: true });
  }
  function onClipPointerMove(event) {
    if (bridge().exporting || !activePointer || event.pointerId !== activePointer.id) return;
    const drag = activePointer;
    const delta = Math.round(((event.clientX - drag.startX) / state.pixelsPerSecond) * FRAME_RATE) / FRAME_RATE;
    if (!drag.historySaved && (Math.abs(delta) > 0.02 || Math.abs(event.clientY - drag.startY) > 6)) { remember(); drag.historySaved = true; }
    if (drag.edge === 'move') {
      drag.clip.start = snapFrame(drag.initialStart + delta);
      const targetTrack = trackAtPointerY(event.clientY, drag.clip, drag);
      if (targetTrack) {
        drag.clip.track = targetTrack;
        if (targetTrack === 'photo-1') overlayTrack.closest('.mtl-track').hidden = false;
        const destination = trackContent(targetTrack);
        // Keep the captured pointer target mounted; reparenting the clip here cancels
        // pointer capture in browsers. Move only its ghost, then commit on pointerup.
        if (destination && drag.ghost.parentElement !== destination) destination.appendChild(drag.ghost);
      }
    } else if (drag.edge === 'left') {
      const bounded = Math.max(-Math.min(drag.initialTrimStart, drag.initialStart), Math.min(drag.initialTrimEnd - drag.initialTrimStart - MIN_CLIP_DURATION, delta));
      drag.clip.start = snapFrame(drag.initialStart + bounded);
      drag.clip.trimStart = snapFrame(drag.initialTrimStart + bounded);
    } else {
      const media = state.media.get(drag.clip.mediaId);
      const maxDuration = media?.type === 'image' ? drag.initialTrimStart + 60 : Math.min(media?.duration || Infinity, drag.initialTrimStart + 60);
      drag.clip.trimEnd = snapFrame(Math.max(drag.initialTrimStart + MIN_CLIP_DURATION, Math.min(maxDuration, drag.initialTrimEnd + delta)));
    }
    const media = state.media.get(drag.clip.mediaId);
    drag.node.style.left = `${drag.clip.start * state.pixelsPerSecond}px`;
    drag.node.style.width = `${Math.max(18, clipDuration(drag.clip) * state.pixelsPerSecond)}px`;
    drag.node.title = `${media?.name || 'Clip'} · ${formatTime(clipDuration(drag.clip))}`;
    refreshLayout(); renderGaps(); renderAudio(); renderSelection();
  }
  function onClipPointerEnd(event) {
    if (!activePointer || event.pointerId !== activePointer.id) return;
    const drag = activePointer; activePointer = null;
    if (drag.edge === 'move') {
      drag.clip.start = snapFrame(drag.clip.start);
      pushTrackCollisions(drag.clip, Math.sign(drag.clip.start - drag.initialStart));
    } else if (drag.edge === 'left') {
      drag.clip.start = snapFrame(resolveTrackStart(drag.clip.track, drag.clip.start, clipDuration(drag.clip), drag.clip.id));
    } else {
      const nextStart = Math.min(Infinity, ...state.clips.filter((clip) => clip.track === drag.clip.track && clip.id !== drag.clip.id && clip.start >= drag.clip.start).map((clip) => clip.start));
      if (Number.isFinite(nextStart)) drag.clip.trimEnd = Math.min(drag.clip.trimEnd, drag.clip.trimStart + Math.max(MIN_CLIP_DURATION, nextStart - drag.clip.start));
    }
    drag.clip.start = snapFrame(drag.clip.start);
    drag.clip.trimStart = snapFrame(drag.clip.trimStart);
    drag.clip.trimEnd = Math.max(drag.clip.trimStart + MIN_CLIP_DURATION, snapFrame(drag.clip.trimEnd));
    const wasPlaying = state.transportPlaying;
    drag.node.classList.remove('mtl-dragging');
    drag.ghost.remove();
    event.currentTarget.removeEventListener('pointermove', onClipPointerMove);
    render();
    // Re-resolve the active base clip after a lane/drop edit. Otherwise a clip
    // moved off V1 can remain active in the transport and blank or skip playback.
    if (state.initialized) seekTo(state.timelineTime, wasPlaying);
  }

  function deleteSelected() {
    if (!state.selected) return;
    const removed = state.selected;
    const index = state.clips.findIndex((clip) => clip.id === removed.id);
    if (index < 0) return;
    remember(); state.clips.splice(index, 1); state.selected = null; render();
    if (state.activeMain?.id === removed.id) {
      state.transportPlaying = false; state.activeMain = null; bridge().pause?.();
      if (mainClips().length) seekTo(removed.start, false);
    }
    if (!mainClips().length) { state.transportPlaying = false; state.activeMain = null; state.timelineTime = 0; bridge().pause?.(); render(); }
  }
  function duplicateSelected() {
    if (!state.selected) return;
    remember();
    const copy = { ...state.selected, id: uid('clip'), start: clipEnd(state.selected) };
    copy.start = snapFrame(resolveTrackStart(copy.track, copy.start, clipDuration(copy)));
    state.clips.push(copy); state.selected = copy; render();
  }
  function splitClip(clip, at) {
    const splitAt = snapFrame(at);
    if (!clip || splitAt <= clip.start + MIN_CLIP_DURATION || splitAt >= clipEnd(clip) - MIN_CLIP_DURATION) return;
    const media = state.media.get(clip.mediaId);
    remember();
    const sourceSplit = snapFrame(clip.trimStart + (splitAt - clip.start));
    const right = { ...clip, id: uid('clip'), start: splitAt, trimStart: sourceSplit, transition: 'none', transitionOut: { type: 'none', duration: clip.transitionOut?.duration || 0.5 } };
    clip.trimEnd = sourceSplit;
    clip.transitionOut = { type: 'none', duration: clip.transitionOut?.duration || 0.5 };
    clip.transition = 'none';
    state.clips.push(right); state.selected = right;
    render();
    if (media?.type === 'image') return;
  }
  function handleContextAction(action) {
    const clip = state.contextClip;
    hideMenus();
    if (!clip) return;
    state.selected = clip;
    if (action === 'delete') deleteSelected();
    else if (action === 'duplicate') duplicateSelected();
    else if (action === 'split') splitClip(clip, state.contextTime);
  }
  function snapPointerToTime(event) {
    const target = event.target.closest('.mtl-track-content');
    if (!target) return;
    const at = pointerTime(event.clientX);
    state.timelineTime = Math.min(state.projectDuration, at);
    updatePlayhead();
    if (event.type === 'click' && event.target.closest('.mtl-clip')) return;
    seekTo(state.timelineTime, false);
  }
  function addDropHandlers(track, trackName) {
    track.addEventListener('dragover', (event) => { if (!bridge().exporting) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
    track.addEventListener('drop', async (event) => {
      if (bridge().exporting) return;
      event.preventDefault(); event.stopPropagation();
      const at = pointerTime(event.clientX);
      const id = event.dataTransfer.getData('application/x-film-lab-media') || event.dataTransfer.getData('text/plain');
      const files = event.dataTransfer.files;
      if (files?.length) {
        for (const file of files) {
          const media = await addExternalMedia(file);
          if (media) addClipFromMedia(media.id, trackName, at);
        }
      } else if (id && state.media.has(id)) addClipFromMedia(id, trackName, at);
    });
  }
  addDropHandlers(mainTrack, 'main');
  addDropHandlers(overlayTrack, 'overlay');
  const initialSecondaryVideoTrack = trackContent('video-2');
  const initialSecondaryPhotoTrack = trackContent('photo-2');
  addDropHandlers(initialSecondaryVideoTrack, 'video-2');
  addDropHandlers(initialSecondaryPhotoTrack, 'photo-2');
  mainTrack.addEventListener('click', snapPointerToTime);
  overlayTrack.addEventListener('click', snapPointerToTime);
  initialSecondaryVideoTrack.addEventListener('click', snapPointerToTime);
  initialSecondaryPhotoTrack.addEventListener('click', snapPointerToTime);
  function beginScrub(event) {
    if (bridge().exporting || event.button !== 0 || event.target.closest('.mtl-clip,.mtl-transition,[data-mtl-action],.mtl-playhead')) return;
    const inRuler = !!event.target.closest('#mtl-ruler-scroll');
    if (!event.target.closest('.mtl-track-content') && !inRuler) return;
    event.preventDefault();
    scrubPointer = { id: event.pointerId, inRuler };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (error) {}
    state.transportPlaying = false;
    bridge().pause?.();
    seekTo(pointerTime(event.clientX, inRuler), false);
  }
  function beginPlayheadDrag(event) {
    if (bridge().exporting || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    scrubPointer = { id: event.pointerId, inRuler: event.currentTarget === rulerPlayhead };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (error) {}
    state.transportPlaying = false; bridge().pause?.();
    seekTo(pointerTime(event.clientX, scrubPointer.inRuler), false);
  }
  view.addEventListener('pointerdown', beginScrub);
  byId('mtl-ruler-scroll').addEventListener('pointerdown', beginScrub);
  playhead.addEventListener('pointerdown', beginPlayheadDrag);
  rulerPlayhead.addEventListener('pointerdown', beginPlayheadDrag);
  function nudgePlayhead(event) {
    const step = event.shiftKey ? 1 : 0.1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const time = event.key === 'Home' ? 0 : event.key === 'End' ? getProjectEnd() : state.timelineTime + (event.key === 'ArrowLeft' ? -step : step);
      seekTo(time, false);
    }
  }
  playhead.addEventListener('keydown', nudgePlayhead);
  rulerPlayhead.addEventListener('keydown', nudgePlayhead);
  document.addEventListener('pointermove', (event) => { if (scrubPointer?.id === event.pointerId) seekTo(pointerTime(event.clientX, scrubPointer.inRuler), false); });
  document.addEventListener('pointerup', (event) => { if (scrubPointer?.id === event.pointerId) scrubPointer = null; });
  document.addEventListener('pointercancel', (event) => { if (scrubPointer?.id === event.pointerId) scrubPointer = null; });
  view.addEventListener('scroll', () => {
    const rulerScroll = byId('mtl-ruler-scroll');
    if (rulerScroll.scrollLeft !== view.scrollLeft) rulerScroll.scrollLeft = view.scrollLeft;
  });
  byId('mtl-ruler-scroll').addEventListener('scroll', () => {
    if (view.scrollLeft !== byId('mtl-ruler-scroll').scrollLeft) view.scrollLeft = byId('mtl-ruler-scroll').scrollLeft;
  });
  byId('mtl-ruler-scroll').addEventListener('wheel', (event) => { view.scrollLeft += event.deltaX || event.deltaY; }, { passive: true });
  view.addEventListener('click', (event) => { if (event.target === view || event.target === canvas) { state.timelineTime = Math.min(state.projectDuration, pointerTime(event.clientX)); seekTo(state.timelineTime, false); } });

  byId('mtl-add-clip').addEventListener('click', () => byId('mtl-file-input').click());
  byId('mtl-file-input').addEventListener('change', async (event) => { await addFilesToPool(event.target.files); event.target.value = ''; });
  zoomSlider.addEventListener('input', () => {
    state.zoom = Math.max(25, Math.min(400, Number(zoomSlider.value) || 100));
    state.pixelsPerSecond = 18 * state.zoom / 100;
    render();
  });
  let transitionDurationHistorySaved = false;
  const saveTransitionDurationHistory = () => {
    if (transitionDurationHistorySaved) return;
    const clip = state.clips.find((item) => item.id === transitionMenu.dataset.clipId);
    if (clip) { remember(); transitionDurationHistorySaved = true; }
  };
  transitionDurationSlider.addEventListener('pointerdown', saveTransitionDurationHistory);
  transitionDurationSlider.addEventListener('keydown', saveTransitionDurationHistory);
  transitionDurationSlider.addEventListener('input', () => {
    const clip = state.clips.find((item) => item.id === transitionMenu.dataset.clipId);
    const duration = Number(transitionDurationSlider.value);
    transitionDurationValue.textContent = `${duration.toFixed(1)}s`;
    if (clip) { setTransition(clip, transitionInfo(clip).type, duration); renderGaps(); }
  });
  transitionDurationSlider.addEventListener('change', () => { transitionDurationHistorySaved = false; });
  root.querySelector('.mtl-media-heading').addEventListener('dragover', (event) => { event.preventDefault(); });
  root.querySelector('.mtl-media-heading').addEventListener('drop', async (event) => { event.preventDefault(); event.stopPropagation(); await addFilesToPool(event.dataTransfer.files); });
  root.addEventListener('click', (event) => {
    if (bridge().exporting) return;
    const action = event.target.closest('[data-mtl-action]')?.dataset.mtlAction;
    if (action) {
      if (action === 'undo') undo();
      else if (action === 'redo') redo();
      else if (action === 'delete') deleteSelected();
      else if (action === 'cut') splitClip(state.selected, state.timelineTime);
      else if (action === 'play-pause') state.transportPlaying ? pause() : play();
      else if (action === 'step-back') seekTo(Math.max(0, state.timelineTime - 5), false);
      else if (action === 'step-forward') seekTo(Math.min(getProjectEnd(), state.timelineTime + 5), false);
      else if (action === 'keyframe') toggleKeyframeAtPlayhead();
      else if (action === 'freeze') toggleFreezeFrame();
      else if (action === 'reverse') toggleReverse();
      else if (action === 'zoom-in' || action === 'zoom-out') {
        state.zoom = Math.max(25, Math.min(400, state.zoom + (action === 'zoom-in' ? 25 : -25)));
        state.pixelsPerSecond = 18 * state.zoom / 100; render();
      }
    }
    const transition = event.target.closest('[data-mtl-transition]');
    if (transition) {
      const clip = state.clips.find((item) => item.id === transitionMenu.dataset.clipId);
      if (clip) { remember(); setTransition(clip, transition.dataset.mtlTransition, Number(transitionDurationSlider.value)); render(); }
      transitionDurationHistorySaved = false;
      hideMenus();
    }
    const context = event.target.closest('[data-mtl-context]');
    if (context) handleContextAction(context.dataset.mtlContext);
    if (!event.target.closest('#mtl-context-menu,#mtl-transition-popover,.mtl-transition')) hideMenus();
  });
  document.addEventListener('pointerdown', (event) => { if (!root.contains(event.target)) hideMenus(); });

  // === Keyframe actions ======================================================================
  // The diamond button keyframes (or unkeys) position, scale, rotation and opacity of the selected
  // clip at the playhead, which is what a CapCut-style timeline expects from one tap.
  function clipValuesAtPlayhead(clip) {
    const transform = clipTransformAt(clip, state.timelineTime);
    return {position: transform.position, scale: transform.scale, rotation: transform.rotation, opacity: Math.min(normalizeOpacity(clip.opacity, 1), transform.opacity)};
  }
  function toggleKeyframeAtPlayhead(properties = null) {
    const clip = state.selected;
    if (!clip) { window.dispatchEvent(new CustomEvent('film-lab-toast', {detail: 'Select a clip to keyframe'})); return null; }
    ensureClipEffects(clip);
    const list = (properties && properties.length ? properties : (fx ? fx.KEYFRAME_PROPERTIES : ['position']));
    const values = clipValuesAtPlayhead(clip);
    const local = Math.max(0, Math.min(clipOutputDuration(clip), state.timelineTime - clip.start));
    let action = 'added';
    remember();
    for (const property of list) {
      const result = fx.toggleKeyframe(clip.keyframes, property, local, values[property]);
      clip.keyframes = result.keyframes;
      if (result.action === 'removed') action = 'removed';
    }
    render();
    renderOverlayPreview();
    bridge().onEffectsChanged?.(clip, {action, properties: list});
    return {clipId: clip.id, action, time: local, properties: list};
  }
  function toggleFreezeFrame() {
    const clip = state.selected;
    if (!clip) return null;
    ensureClipEffects(clip);
    remember();
    clip.speed = normalizeSpeed({...clip.speed, freeze: !clip.speed.freeze});
    if (clip.speed.freeze) {
      const video = bridge().videoElement;
      const frame = clipSourceTimeAt(clip, state.timelineTime);
      clip.freezeTime = frame;
      if (video) { try { video.pause(); video.currentTime = frame; } catch (error) {} }
    }
    render();
    renderOverlayPreview();
    bridge().onEffectsChanged?.(clip, {action: clip.speed.freeze ? 'freeze-on' : 'freeze-off'});
    return clip.speed.freeze;
  }
  function toggleReverse() {
    const clip = state.selected;
    if (!clip) return null;
    ensureClipEffects(clip);
    remember();
    clip.speed = normalizeSpeed({...clip.speed, reverse: !clip.speed.reverse});
    const video = bridge().videoElement;
    if (video && !video.paused) video.pause();
    state.timelineTime = clip.start;
    render();
    renderOverlayPreview();
    bridge().onEffectsChanged?.(clip, {action: clip.speed.reverse ? 'reverse-on' : 'reverse-off'});
    return clip.speed.reverse;
  }
  function getMainAt(time) {
    return mainClips().find((clip) => time >= clip.start - 0.0001 && time < clipEnd(clip) - 0.0001) || null;
  }
  async function switchToMain(clip, timelineTime, autoplay = false) {
    if (!clip) return;
    const media = state.media.get(clip.mediaId);
    if (!media || media.type !== 'video') return;
    const switchToken = ++state.switchToken;
    state.activeMain = clip;
    state.inGap = false; state.pendingMain = null; state.switchingSource = true;
    state.timelineTime = Math.max(clip.start, Math.min(clipEnd(clip) - 0.001, timelineTime));
    try {
      await bridge().ensureVideoSource?.(media.src);
      if (switchToken !== state.switchToken || state.activeMain?.id !== clip.id) return;
      state.switchingSource = false;
      bridge().setTimelineTrim?.(clip.trimStart, clip.trimEnd);
      const video = bridge().videoElement;
      if (!video) return;
      const sourceTime = clipSourceTimeAt(clip, state.timelineTime);
      if (Math.abs(video.currentTime - sourceTime) > 0.035) video.currentTime = sourceTime;
      const rate = clipRate(clip);
      if (Math.abs((video.playbackRate || 1) - rate) > 0.001) { try { video.playbackRate = Math.min(16, Math.max(0.0625, rate)); } catch (error) {} }
      if (autoplay && state.transportPlaying && !clipNeedsManualDrive(clip) && video.paused) bridge().play?.();
    } catch (error) {
      if (switchToken === state.switchToken) { state.switchingSource = false; state.transportPlaying = false; updateTransportButton(); }
      console.warn('Could not switch timeline clip', error);
    }
    updatePlayhead(); renderOverlayPreview();
  }
  // Where inside the trimmed range a timeline moment sits, after speed, reverse and freeze.
  function clipSourceTimeAt(clip, timelineTime) {
    const local = Math.max(0, (timelineTime ?? clip.start) - clip.start);
    const span = Math.max(MIN_CLIP_DURATION, clip.trimEnd - clip.trimStart);
    const offset = fx ? fx.sourceOffsetForLocal(local, span, clip.speed) : local;
    return Math.max(clip.trimStart, Math.min(clip.trimEnd - 0.001, clip.trimStart + offset));
  }
  // Reverse and freeze cannot be played by a media element, so those clips (and ramped clips) are
  // driven by the timeline clock exactly like a gap, with the element kept paused and seeked.
  function driveClipFromClock(clip, delta) {
    const span = Math.max(MIN_CLIP_DURATION, clip.trimEnd - clip.trimStart);
    const settings = normalizeSpeed(clip.speed);
    const localRate = settings.freeze ? 0 : settings.rate * (fx ? fx.rampRate(settings.ramp, clamp01((state.timelineTime - clip.start) / Math.max(1e-4, clipOutputDuration(clip)))) : 1);
    state.timelineTime = Math.min(clipEnd(clip), state.timelineTime + delta * Math.max(0, localRate));
    const video = bridge().videoElement;
    if (video && video.readyState >= 2) {
      const sourceTime = clipSourceTimeAt(clip, state.timelineTime);
      if (Math.abs(video.currentTime - sourceTime) > 0.05) { try { video.currentTime = sourceTime; } catch (error) {} }
    }
    if (localRate <= 0.0001 && span <= 0) return;
    if (state.timelineTime >= clipEnd(clip) - 0.02) advanceFrom(clip);
  }
  function setGapAt(time, autoplay) {
    state.switchToken++; state.switchingSource = false;
    state.timelineTime = Math.max(0, time);
    state.activeMain = null; state.inGap = true;
    const next = mainClips().find((clip) => clip.start > time + 0.001) || null;
    state.pendingMain = next;
    if (bridge().videoElement && !bridge().videoElement.paused) bridge().pause?.();
    if (!autoplay) state.transportPlaying = false;
    updateTransportButton(); updatePlayhead(); renderOverlayPreview();
  }
  function seekTo(time, autoplay = false) {
    const at = Math.max(0, Math.min(getProjectEnd(), time));
    state.timelineTime = at;
    const clip = getMainAt(at);
    // Guard the element's clock until the seek this triggers has landed (see handleVideoTimeUpdate).
    // A timed window self-heals, so a non-video target can never leave the clock stuck.
    state.seekGuardUntil = performance.now() + 260;
    if (clip) switchToMain(clip, at, autoplay);
    else setGapAt(at, autoplay);
    updatePlayhead(); renderOverlayPreview();
  }
  function advanceFrom(clip) {
    const next = mainClips().find((item) => item.start >= clipEnd(clip) - 0.025 && item.id !== clip.id);
    const end = clipEnd(clip);
    if (!next) {
      if (end < state.projectDuration - 0.025) {
        // Keep the transport moving through a V1 gap so V2+ overlays can finish.
        setGapAt(end, true);
        state.lastTick = performance.now();
        ensureTick();
      } else {
        state.transportPlaying = false;
        state.timelineTime = end;
        bridge().pause?.();
      }
      updateTransportButton(); updatePlayhead(); renderOverlayPreview();
      return;
    }
    if (next.start > end + 0.025) {
      state.timelineTime = end; state.pendingMain = next; state.inGap = true; state.activeMain = null;
      bridge().pause?.();
      state.lastTick = performance.now();
    } else {
      switchToMain(next, next.start, true);
    }
  }
  function handleVideoTimeUpdate() {
    const video = bridge().videoElement;
    if (!video || bridge().exporting || !state.initialized || !state.activeMain) return;
    const clip = state.activeMain;
    // Reverse, freeze and ramped clips run on the timeline clock instead of the element's clock.
    if (clipNeedsManualDrive(clip)) { state.lastTick = state.lastTick || performance.now(); ensureTick(); return; }
    // A clip switch or a seek in flight means the element still reports its *old* position. Letting it
    // own the clock here would drag the playhead backwards, which is how a keyframe ends up parked at
    // the wrong moment while the user scrubs. The timed guard covers the gap before the browser even
    // reports `seeking`.
    if (state.switchingSource || video.seeking || performance.now() < (state.seekGuardUntil || 0)) return;
    const rate = clipRate(clip);
    const time = clip.start + (video.currentTime - clip.trimStart) / Math.max(0.0001, rate);
    state.timelineTime = Math.max(clip.start, Math.min(clipEnd(clip), time));
    if (video.currentTime >= clip.trimEnd - 0.025) advanceFrom(clip);
    updatePlayhead(); renderOverlayPreview();
  }
  function ensureTick() { if (!state.raf) state.raf = requestAnimationFrame(tick); }
  function tick(now) {
    state.raf = 0;
    if (state.transportPlaying && state.inGap) {
      const delta = state.lastTick ? Math.max(0, Math.min(0.12, (now - state.lastTick) / 1000)) : 0;
      state.lastTick = now;
      state.timelineTime += delta * (bridge().videoElement?.playbackRate || 1);
      if (state.pendingMain && state.timelineTime >= state.pendingMain.start) switchToMain(state.pendingMain, state.pendingMain.start, true);
      else if (state.timelineTime >= state.projectDuration) {
        state.timelineTime = state.projectDuration;
        state.transportPlaying = false; state.inGap = false;
      }
    } else if (state.transportPlaying && state.activeMain && clipNeedsManualDrive(state.activeMain)) {
      const video = bridge().videoElement;
      if (video && !video.paused) video.pause();
      const delta = state.lastTick ? Math.max(0, Math.min(0.12, (now - state.lastTick) / 1000)) : 0;
      state.lastTick = now;
      driveClipFromClock(state.activeMain, delta);
    } else if (state.transportPlaying && state.activeMain) {
      const video = bridge().videoElement;
      if (!video || video.paused) state.transportPlaying = false;
      else {
        const clip = state.activeMain;
        const sourceTime = clipSourceTimeAt(clip, state.timelineTime);
        if (Math.abs(video.currentTime - sourceTime) > 0.14 && video.readyState >= 2) video.currentTime = Math.max(clip.trimStart, Math.min(clip.trimEnd - 0.001, sourceTime));
        state.timelineTime = clip.start + (video.currentTime - clip.trimStart);
        if (video.currentTime >= clip.trimEnd - 0.025) advanceFrom(clip);
      }
    }
    updateTransportButton(); updatePlayhead(); renderOverlayPreview();
    if (state.transportPlaying) ensureTick();
  }
  function updateTransportButton() {
    const button = byId('videoPlayBtn');
    const timelineButton = byId('mtl-play-pause');
    if (button && document.body.dataset.mode === 'video') {
      button.textContent = state.transportPlaying ? 'Ⅱ' : '▶';
      button.setAttribute('aria-label', state.transportPlaying ? 'Pause video' : 'Play video');
    }
    if (timelineButton) {
      timelineButton.textContent = state.transportPlaying ? 'Ⅱ' : '▶';
      timelineButton.setAttribute('aria-label', state.transportPlaying ? 'Pause timeline' : 'Play timeline');
    }
  }
  function handlePlay() { state.transportPlaying = true; state.inGap = false; state.lastTick = performance.now(); updateTransportButton(); ensureTick(); }
  function handlePause() {
    if (state.switchingSource) return;
    if (!state.inGap) state.transportPlaying = false;
    updateTransportButton();
  }
  function play() {
    if (state.timelineTime >= state.projectDuration - 0.02) state.timelineTime = 0;
    const at = state.timelineTime;
    state.transportPlaying = true;
    const clip = getMainAt(at);
    if (clip) seekTo(at, true);
    else if (state.clips.length) {
      // Play through timeline gaps so composited lanes remain time-aligned; do not
      // jump ahead to the next V1 clip and skip overlays inside the gap.
      setGapAt(at, true);
      state.lastTick = performance.now();
    } else {
      state.transportPlaying = false;
    }
    updateTransportButton();
    if (state.transportPlaying) ensureTick();
  }
  function pause() {
    state.switchToken++; state.switchingSource = false;
    state.transportPlaying = false; state.inGap = false;
    if (bridge().videoElement && !bridge().videoElement.paused) bridge().pause?.();
    updateTransportButton();
  }
  byId('videoPlayBtn')?.addEventListener('click', (event) => {
    if (!state.initialized || bridge().exporting || document.body.dataset.mode !== 'video') return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (state.transportPlaying) pause(); else play();
  }, { capture: true });

  function getOverlaysAt(time) {
    return overlayClips().filter((clip) => time >= clip.start && time < clipEnd(clip)).map((clip) => {
      const media = state.media.get(clip.mediaId);
      return media ? { clipId: clip.id, src: media.src, type: media.type, name: media.name, element: media.imageElement || media.overlayVideoElement || media.videoElement, time: clip.trimStart + (time - clip.start) } : null;
    }).filter(Boolean);
  }
  // === TIMELINE TRANSITION PREVIEW MODULE ===
  function transitionAt(time, trackName = 'main') {
    if (state.tracks.find((track) => track.id === trackName)?.kind === 'audio') return null;
    const clips = state.clips.filter((clip) => clip.track === trackName && canTransition(clip)).sort((a, b) => a.start - b.start);
    for (let index = 0; index < clips.length - 1; index++) {
      const outgoing = clips[index], incoming = clips[index + 1];
      if (Math.abs(incoming.start - clipEnd(outgoing)) > 0.025) continue;
      const info = transitionInfo(outgoing);
      if (info.type === 'none') continue;
      const duration = Math.min(info.duration, clipDuration(outgoing), clipDuration(incoming));
      const cut = incoming.start, dissolveStart = cut - duration, centeredStart = cut - duration / 2;
      const start = info.type === 'dissolve' ? dissolveStart : centeredStart;
      const end = info.type === 'dissolve' ? cut : cut + duration / 2;
      if (time < start || time > end) continue;
      return { outgoing, incoming, type: info.type, duration, cut, progress: Math.max(0, Math.min(1, (time - start) / duration)) };
    }
    return null;
  }
  function getTransitionSource(media, clipId, trackName = 'main') {
    if (!media) return null;
    const sourceKey = `${trackName}:${clipId || media.id}`;
    if (transitionPreviewElements.has(sourceKey)) return transitionPreviewElements.get(sourceKey);
    let element;
    if (media.type === 'image') {
      element = document.createElement('img'); element.src = media.src; element.alt = '';
      element.addEventListener('load', () => { renderTransitionPreview(); renderOverlayPreview(); });
    } else {
      element = document.createElement('video'); element.muted = true; element.playsInline = true; element.preload = 'auto'; element.src = media.src;
      element.addEventListener('loadeddata', () => { renderTransitionPreview(); renderOverlayPreview(); });
      element.addEventListener('seeked', () => { renderTransitionPreview(); renderOverlayPreview(); });
      element.load();
    }
    transitionPreviewElements.set(sourceKey, element);
    return element;
  }
  function setupTransitionPreviewLayer() {
    const stage = byId('canvasWrap');
    if (!stage || transitionLayer) return;
    transitionLayer = document.createElement('canvas');
    transitionLayer.className = 'mtl-transition-preview-layer'; transitionLayer.hidden = true;
    if (overlayLayer?.parentNode === stage) stage.insertBefore(transitionLayer, overlayLayer);
    else stage.appendChild(transitionLayer);
  }
  function drawTransitionFrame(ctx, element, x, width, height, alpha = 1) {
    const sourceWidth = element.videoWidth || element.naturalWidth;
    const sourceHeight = element.videoHeight || element.naturalHeight;
    if (!sourceWidth || !sourceHeight || element instanceof HTMLVideoElement && element.readyState < 2) return;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale, drawHeight = sourceHeight * scale;
    ctx.globalAlpha = alpha;
    ctx.drawImage(element, x + (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    ctx.globalAlpha = 1;
  }
  function drawTransitionComposition(ctx, transition, time, outgoing, incoming, width, height) {
    const beforeCut = time < transition.cut, progress = transition.progress;
    if (transition.type === 'dissolve') {
      drawTransitionFrame(ctx, outgoing, 0, width, height, 1);
      drawTransitionFrame(ctx, incoming, 0, width, height, progress);
    } else if (transition.type === 'slide-left') {
      if (beforeCut) {
        const phase = Math.max(0, Math.min(1, (time - (transition.cut - transition.duration / 2)) / (transition.duration / 2)));
        drawTransitionFrame(ctx, outgoing, -phase * width, width, height, 1);
        drawTransitionFrame(ctx, incoming, (1 - phase) * width, width, height, 1);
      } else drawTransitionFrame(ctx, incoming, 0, width, height, 1);
    } else if (transition.type === 'wipe') {
      if (beforeCut) {
        drawTransitionFrame(ctx, outgoing, 0, width, height, 1);
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width * Math.min(1, progress * 2), height); ctx.clip();
        drawTransitionFrame(ctx, incoming, 0, width, height, 1); ctx.restore();
      } else drawTransitionFrame(ctx, incoming, 0, width, height, 1);
    } else {
      drawTransitionFrame(ctx, beforeCut ? outgoing : incoming, 0, width, height, 1);
      const phase = beforeCut
        ? Math.min(1, (time - (transition.cut - transition.duration / 2)) / (transition.duration / 2))
        : Math.max(0, 1 - (time - transition.cut) / (transition.duration / 2));
      if (transition.type === 'fade-to-black' || transition.type === 'fade-from-white') {
        ctx.fillStyle = transition.type === 'fade-from-white' ? '#fff' : '#000';
        ctx.globalAlpha = Math.max(0, Math.min(1, phase)); ctx.fillRect(0, 0, width, height); ctx.globalAlpha = 1;
      }
    }
  }
  function drawTransitionEffect(layer, transition, trackName = 'main') {
    const outgoing = getTransitionSource(state.media.get(transition.outgoing.mediaId), transition.outgoing.id, trackName);
    const incoming = getTransitionSource(state.media.get(transition.incoming.mediaId), transition.incoming.id, trackName);
    if (!outgoing || !incoming) return;
    const base = byId('glCanvas');
    if (layer.width !== base.width || layer.height !== base.height) { layer.width = base.width; layer.height = base.height; }
    const time = state.timelineTime, beforeCut = time < transition.cut;
    const outTime = transitionSourceTime(transition, transition.outgoing, 'outgoing', time);
    const inTime = transitionSourceTime(transition, transition.incoming, 'incoming', time);
    for (const [element, sourceTime, sourceIsMoving] of [[outgoing, beforeCut ? outTime : transition.outgoing.trimEnd - 0.001, beforeCut], [incoming, inTime, transition.type === 'dissolve' ? true : !beforeCut]]) {
      if (!(element instanceof HTMLVideoElement)) continue;
      element.playbackRate = bridge().videoElement?.playbackRate || 1;
      if (Math.abs(element.currentTime - sourceTime) > 0.14) { try { element.currentTime = sourceTime; } catch (error) {} }
      const shouldPlay = state.transportPlaying && sourceIsMoving;
      if (shouldPlay && element.paused) element.play().catch(() => {});
      else if (!shouldPlay && !element.paused) element.pause();
    }
    const ctx = layer.getContext('2d');
    if (!ctx) return;
    const width = layer.width, height = layer.height;
    ctx.clearRect(0, 0, width, height); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    drawTransitionComposition(ctx, transition, time, outgoing, incoming, width, height);
  }
  function renderTransitionPreview() {
    setupTransitionPreviewLayer();
    if (!transitionLayer) return;
    const transition = transitionAt(state.timelineTime, 'main');
    if (!transition) {
      transitionLayer.hidden = true;
      transitionPreviewElements.forEach((element, key) => { if (key.startsWith('main:') && element instanceof HTMLVideoElement && !element.paused) element.pause(); });
      return;
    }
    transitionLayer.hidden = false;
    const stage = byId('canvasWrap'), base = byId('glCanvas');
    const stageRect = stage.getBoundingClientRect(), baseRect = base.getBoundingClientRect();
    transitionLayer.style.left = `${baseRect.left - stageRect.left}px`;
    transitionLayer.style.top = `${baseRect.top - stageRect.top}px`;
    transitionLayer.style.width = `${baseRect.width}px`; transitionLayer.style.height = `${baseRect.height}px`;
    drawTransitionEffect(transitionLayer, transition, 'main');
  }
  function setupPreviewLayer() {
    const stage = byId('canvasWrap');
    if (!stage || overlayLayer) return;
    overlayLayer = document.createElement('div');
    overlayLayer.className = 'mtl-preview-overlay'; overlayLayer.hidden = true;
    stage.appendChild(overlayLayer);
  }
  function renderOverlayPreview() {
    setupPreviewLayer();
    if (!overlayLayer) return;
    const time = state.timelineTime;
    const active = getOverlaysAt(time);
    const trackOrder = state.tracks.filter((track) => track.id !== 'main' && (track.kind === 'video' || track.kind === 'photo')).sort((a, b) => {
      const layerA = a.kind === 'photo' ? 1 : 0, layerB = b.kind === 'photo' ? 1 : 0;
      return layerA - layerB || state.tracks.indexOf(a) - state.tracks.indexOf(b);
    });
    const entries = [];
    const activeTransitionKeys = new Set();
    for (const track of trackOrder) {
      const transition = transitionAt(time, track.id);
      if (transition) {
        entries.push({ kind: 'transition', trackId: track.id, transition, key: `transition:${track.id}:${transition.outgoing.id}:${transition.incoming.id}` });
        activeTransitionKeys.add(`${track.id}:${transition.outgoing.id}`);
        activeTransitionKeys.add(`${track.id}:${transition.incoming.id}`);
      } else {
        for (const item of active.filter((activeClip) => state.clips.find((clip) => clip.id === activeClip.clipId)?.track === track.id)) {
          entries.push({ kind: 'clip', item, key: `clip:${track.id}:${item.clipId}` });
        }
      }
    }
    const inGap = state.initialized && !getMainAt(time) && time < state.projectDuration;
    const signature = `${inGap ? 'gap:' : ''}${entries.map((entry) => entry.key).join('|')}`;
    if (signature !== state.lastOverlaySignature) {
      state.lastOverlaySignature = signature;
      overlayLayer.querySelectorAll('video').forEach((video) => video.pause());
      overlayLayer.replaceChildren();
      overlayTransitionCanvases.clear();
      for (const entry of entries) {
        if (entry.kind === 'transition') {
          const layer = document.createElement('canvas');
          layer.className = 'mtl-transition-track-canvas'; layer.dataset.transitionTrack = entry.trackId;
          overlayLayer.appendChild(layer); overlayTransitionCanvases.set(entry.trackId, layer);
          continue;
        }
        const item = entry.item;
        const media = state.media.get(state.clips.find((clip) => clip.id === item.clipId)?.mediaId);
        if (item.type === 'image' && media?.imageElement) {
          const img = document.createElement('img'); img.src = item.src; img.alt = media.name; overlayLayer.appendChild(img);
        } else if (item.type === 'video' && item.element) {
          const vid = item.element; vid.classList.add('mtl-preview-media'); vid.muted = true; vid.playsInline = true; vid.hidden = false;
          overlayLayer.appendChild(vid);
        }
      }
    }
    // Sources stay mounted (they must keep decoding) but the pixels the user sees come from the
    // shared scene renderer, which is also what the export calls.
    let sceneCanvas = overlayLayer.querySelector('.mtl-scene-canvas');
    if (!sceneCanvas) {
      sceneCanvas = document.createElement('canvas');
      sceneCanvas.className = 'mtl-scene-canvas';
      sceneCanvas.setAttribute('aria-hidden', 'true');
      overlayLayer.appendChild(sceneCanvas);
    }
    renderSceneCanvas(sceneCanvas, time);
    renderLayerHandles(time);
    // Text, sticker and caption layers live on this canvas, so it must be visible for them even when
    // no V2+ clip is active. Nothing is shown while the project is untouched.
    const sceneHasLayers = layersAt(time).length > 0 || !!(fx && fx.captionAt(filmLabState.captions || [], time));
    overlayLayer.hidden = entries.length === 0 && !inGap && !sceneHasLayers && !byId('canvasWrap')?.classList.contains('mtl-scene-base');
    overlayLayer.style.backgroundColor = inGap ? '#000' : 'transparent';
    const stage = byId('canvasWrap'), base = byId('glCanvas');
    if (stage && base) {
      const stageRect = stage.getBoundingClientRect(), baseRect = base.getBoundingClientRect();
      overlayLayer.style.left = `${baseRect.left - stageRect.left}px`;
      overlayLayer.style.top = `${baseRect.top - stageRect.top}px`;
      overlayLayer.style.width = `${baseRect.width}px`;
      overlayLayer.style.height = `${baseRect.height}px`;
    }
    for (const item of active) {
      const clip = state.clips.find((entry) => entry.id === item.clipId);
      if (!clip || activeTransitionKeys.has(`${clip.track}:${clip.id}`) || item.type !== 'video') continue;
      const vid = item.element;
      if (!vid) continue;
      vid.playbackRate = bridge().videoElement?.playbackRate || 1;
      if (Math.abs(vid.currentTime - item.time) > 0.14) { try { vid.currentTime = item.time; } catch (error) {} }
      if (state.transportPlaying && vid.paused) vid.play().catch(() => {});
      else if (!state.transportPlaying && !vid.paused) vid.pause();
    }
    for (const entry of entries) {
      if (entry.kind === 'transition') {
        const layer = overlayTransitionCanvases.get(entry.trackId);
        if (layer) drawTransitionEffect(layer, entry.transition, entry.trackId);
      }
    }
    transitionPreviewElements.forEach((element, key) => {
      if (!key.startsWith('main:') && !activeTransitionKeys.has(key) && element instanceof HTMLVideoElement && !element.paused) element.pause();
    });
    renderTransitionPreview();
  }
  let exportTransitionCanvas = null;
  // === Scene = the single source of truth for both the preview and the export ================
  // Every layer carries its transform (keyframed), blend mode, opacity and source, so the canvas
  // the user watches and the frame ffmpeg receives are painted by the same code path.
  function overlayTrackOrder() {
    return state.tracks.filter((track) => track.id !== 'main' && (track.kind === 'video' || track.kind === 'photo'))
      .sort((a, b) => {
        const layerA = a.kind === 'photo' ? 1 : 0, layerB = b.kind === 'photo' ? 1 : 0;
        return layerA - layerB || state.tracks.indexOf(a) - state.tracks.indexOf(b);
      });
  }
  function mediaElementFor(media, clip) {
    if (!media) return null;
    const element = media.imageElement || media.overlayVideoElement || media.videoElement || null;
    if (!element || !clip?.chroma?.enabled) return element;
    // Chroma key runs in WebGL in the editor, which hands back a keyed canvas.
    return bridge().chromaKeyFrame?.(element, clip.chroma) || element;
  }
  // The active overlay layers at one moment, in draw order, before any resolution is known.
  function sceneAt(time, {sources = 'preview'} = {}) {
    const at = Math.max(0, Number(time) || 0);
    const layers = [];
    const order = overlayTrackOrder();
    for (const track of order) {
      if (transitionAt(at, track.id)) continue; // transitions keep their own dedicated renderer
      for (const clip of state.clips.filter((item) => item.track === track.id && at >= item.start - 1e-6 && at < clipEnd(item) - 1e-6)) {
        const media = state.media.get(clip.mediaId);
        const element = mediaElementFor(media, clip);
        if (!element) continue;
        const transform = clipTransformAt(clip, at);
        layers.push({
          kind: 'media', clipId: clip.id, track: track.id, source: media.src, element,
          image: element instanceof HTMLCanvasElement || element instanceof HTMLImageElement || element instanceof HTMLVideoElement ? element : null,
          visible: sources === 'export' ? true : true,
          chroma: clip.chroma,
          blend: clip.blend,
          opacity: transform.opacity,
          transform: {x: transform.position.x, y: transform.position.y, scale: transform.scale, rotation: transform.rotation},
        });
      }
    }
    for (const layer of layersAt(at)) {
      if (layer.kind === 'sticker') layers.push({...layer, image: fx ? fx.stickerImage(layer.sticker) : null});
      else layers.push(layer);
    }
    const captionSource = filmLabState.captions || [];
    const caption = fx ? fx.captionAt(captionSource, at) : null;
    if (caption) layers.push({kind: 'caption', line: caption});
    return layers;
  }
  // The selected keyframe: one diamond per moment, shared by every property keyed at that time.
  function selectedKeyframe() {
    const selection = state.selectedKeyframe;
    if (!selection) return null;
    const clip = state.clips.find((item) => item.id === selection.clipId);
    if (!clip) return null;
    const times = fx ? fx.keyframeTimes(clip.keyframes) : [];
    const time = times.find((candidate) => Math.abs(candidate - selection.time) <= 0.5 / 24);
    return time === undefined ? null : {clipId: clip.id, time, clip};
  }
  const keyframeEasingAt = (clip, time) => {
    if (!fx) return 'linear';
    for (const property of fx.KEYFRAME_PROPERTIES) {
      const key = fx.keyframeAt(clip.keyframes, property, time);
      if (key) return key.easing;
    }
    return 'linear';
  };
  function selectKeyframe(clipId, time, {seek = true} = {}) {
    const clip = state.clips.find((item) => item.id === clipId);
    state.selectedKeyframe = clip ? {clipId, time} : null;
    if (clip) {
      state.selected = clip;
      if (seek) seekTo(clip.start + time, false);
      else { updatePlayhead(); renderOverlayPreview(); }
    }
    render();
    renderSelection();
    bridge().onEffectsChanged?.(clip || null, {action: 'keyframe-selected', time});
    return state.selectedKeyframe;
  }
  function clearKeyframeSelection() {
    if (!state.selectedKeyframe) return;
    state.selectedKeyframe = null;
    render();
  }
  function moveKeyframeTo(clipId, from, to) {
    const clip = state.clips.find((item) => item.id === clipId);
    if (!clip || !fx) return null;
    const result = fx.moveKeyframe(clip.keyframes, from, Math.max(0, Math.min(clipOutputDuration(clip), to)));
    if (!result.properties) return null;
    clip.keyframes = result.keyframes;
    state.selectedKeyframe = {clipId, time: result.time};
    render();
    renderSelection();
    renderOverlayPreview();
    repaintScene();
    return result;
  }
  function setKeyframeEasing(clipId, time, easing) {
    const clip = state.clips.find((item) => item.id === clipId);
    if (!clip || !fx) return null;
    const result = fx.setKeyframeEasing(clip.keyframes, time, easing);
    clip.keyframes = result.keyframes;
    render();
    bridge().onEffectsChanged?.(clip, {action: 'keyframe-easing', easing: result.easing});
    return result;
  }
  // The selected layer is shared with the sidebar; the timeline draws its drag handles in the
  // preview so a sticker can be moved, resized and rotated where it actually sits.
  function selectLayer(id) {
    const layer = id ? layers.find((entry) => entry.id === id) : null;
    state.selectedLayerId = layer ? layer.id : null;
    renderLayers();
    renderOverlayPreview();
    window.dispatchEvent(new CustomEvent('film-lab-layer-selected', {detail: {id: state.selectedLayerId}}));
    return layer;
  }
  function setupLayerHandles() {
    const stage = byId('canvasWrap');
    if (!stage || layerHandles) return;
    layerHandles = document.createElement('div');
    layerHandles.className = 'mtl-layer-handles';
    layerHandles.hidden = true;
    stage.appendChild(layerHandles);
  }
  // Mirrors drawStickerLayer(): a square of width * 0.22 * scale centred on the transformed origin.
  function stickerHandleBox(layer, base) {
    const size = Math.max(8, base.width * 0.22 * Math.max(0.02, finiteNumber(layer.transform?.scale, 0.28)));
    return {size, centerX: base.left + (0.5 + finiteNumber(layer.transform?.x, 0)) * base.width,
      centerY: base.top + (0.5 + finiteNumber(layer.transform?.y, -0.45)) * base.height,
      rotation: finiteNumber(layer.transform?.rotation, 0)};
  }
  function renderLayerHandles(time) {
    setupLayerHandles();
    if (!layerHandles) return;
    const selected = state.selectedLayerId ? layers.find((layer) => layer.id === state.selectedLayerId) : null;
    const active = selected && time >= selected.start - 1e-6 && time < selected.end - 1e-6;
    if (!active || !byId('glCanvas')) { layerHandles.hidden = true; layerHandles.replaceChildren(); state.handleBox = null; return; }
    const stage = byId('canvasWrap'), base = byId('glCanvas');
    const stageRect = stage.getBoundingClientRect(), baseRect = base.getBoundingClientRect();
    const rect = {left: baseRect.left - stageRect.left, top: baseRect.top - stageRect.top, width: baseRect.width, height: baseRect.height};
    const box = stickerHandleBox(selected, rect);
    state.handleBox = {layerId: selected.id, ...box, rect};
    let node = layerHandles.querySelector('.mtl-layer-handle-box');
    if (!node) {
      node = document.createElement('div');
      node.className = 'mtl-layer-handle-box';
      const body = document.createElement('div');
      body.className = 'mtl-layer-handle-body';
      const rotate = document.createElement('button');
      rotate.type = 'button'; rotate.className = 'mtl-layer-handle-rotate'; rotate.setAttribute('aria-label', 'Rotate layer');
      const resize = document.createElement('button');
      resize.type = 'button'; resize.className = 'mtl-layer-handle-resize'; resize.setAttribute('aria-label', 'Resize layer');
      node.append(body, rotate, resize);
      node.addEventListener('pointerdown', onLayerHandleDown);
      node.addEventListener('pointermove', onLayerHandleMove);
      node.addEventListener('pointerup', onLayerHandleUp);
      node.addEventListener('pointercancel', onLayerHandleUp);
      layerHandles.appendChild(node);
    }
    layerHandles.hidden = false;
    node.style.left = `${box.centerX}px`;
    node.style.top = `${box.centerY}px`;
    node.style.width = `${box.size}px`;
    node.style.height = `${box.size}px`;
    node.style.transform = `translate(-50%,-50%) rotate(${box.rotation}deg)`;
    node.dataset.layerId = selected.id;
  }
  function onLayerHandleDown(event) {
    const node = event.currentTarget;
    const selected = state.selectedLayerId ? layers.find((layer) => layer.id === state.selectedLayerId) : null;
    if (!selected || !state.handleBox) return;
    event.preventDefault(); event.stopPropagation();
    try { node.setPointerCapture?.(event.pointerId); } catch (error) {}
    const tool = event.target.closest('.mtl-layer-handle-resize') ? 'scale'
      : event.target.closest('.mtl-layer-handle-rotate') ? 'rotate' : 'move';
    const box = state.handleBox;
    state.handleDrag = {tool, id: selected.id, startX: event.clientX, startY: event.clientY,
      start: {...selected.transform}, centerX: box.centerX, centerY: box.centerY,
      distance: Math.max(6, Math.hypot(event.clientX - box.centerX, event.clientY - box.centerY)),
      angle: Math.atan2(event.clientY - box.centerY, event.clientX - box.centerX)};
    bridge().onEffectsChanged?.(selected, {action: 'layer-drag-start'});
  }
  function onLayerHandleMove(event) {
    const drag = state.handleDrag;
    if (!drag) return;
    event.preventDefault(); event.stopPropagation();
    const box = state.handleBox;
    if (!box) return;
    if (drag.tool === 'move') {
      const x = drag.start.x + (event.clientX - drag.startX) / Math.max(1, box.rect.width);
      const y = drag.start.y + (event.clientY - drag.startY) / Math.max(1, box.rect.height);
      updateLayer(drag.id, {transform: {...drag.start, x, y}});
      return;
    }
    if (drag.tool === 'scale') {
      const distance = Math.hypot(event.clientX - box.centerX, event.clientY - box.centerY);
      const scale = drag.start.scale * (distance / drag.distance);
      updateLayer(drag.id, {transform: {...drag.start, scale}});
      return;
    }
    const angle = Math.atan2(event.clientY - box.centerY, event.clientX - box.centerX);
    const rotation = drag.start.rotation + (angle - drag.angle) * 180 / Math.PI;
    updateLayer(drag.id, {transform: {...drag.start, rotation}});
  }
  function onLayerHandleUp(event) {
    const drag = state.handleDrag;
    if (!drag) return;
    event.stopPropagation();
    state.handleDrag = null;
    const layer = layers.find((entry) => entry.id === drag.id) || null;
    bridge().onEffectsChanged?.(layer, {action: 'layer-drag-end'});
  }
  // Painting the scene canvas on demand: an edit made in the effects panel must be visible straight
  // away, without waiting for the transport to repaint the preview on its own.
  function repaintScene() {
    const canvas = overlayLayer?.querySelector('.mtl-scene-canvas');
    if (canvas && fx) renderSceneCanvas(canvas, state.timelineTime);
  }
  // Preview painter: the DOM media elements stay mounted (so they keep decoding) but the visible
  // pixels come from this canvas, which is the same renderer the export calls.
  function renderSceneCanvas(canvas, time) {
    const base = byId('glCanvas');
    if (!canvas || !base || !fx) return;
    const width = Math.max(1, base.width || 640), height = Math.max(1, base.height || 480);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const mainClip = getMainAt(time);
    // When the main clip is transformed / faded / keyed, the frame the app just rendered into
    // glCanvas becomes the base layer and the scene canvas takes over the visible pixels; the raw
    // glCanvas is hidden so the frame is never drawn twice.
    const baseLayer = mainClip && hasClipEffects(mainClip, time) ? clipFrameLayer(mainClip, time, base) : null;
    const layers = baseLayer ? [baseLayer, ...sceneAt(time)] : sceneAt(time);
    fx.drawScene(ctx, {width, height, time, layers, clear: true});
    const stage = byId('canvasWrap');
    if (stage) stage.classList.toggle('mtl-scene-base', !!baseLayer);
    return baseLayer;
  }
  // The composed main frame the export loop has just produced becomes the base layer of the scene,
  // so a keyframed / transformed / keyed main clip lands in the file exactly as previewed.
  function applyMainClipEffects(outputCanvas, outputTime, plan) {
    if (!fx || !outputCanvas || !plan?.segments) return;
    const segment = plan.segments.find((item) => !item.gap && !item.blackFrame && outputTime >= item.start - 1e-6 && outputTime <= item.end + 1e-6);
    const clip = segment?.clipId ? state.clips.find((item) => item.id === segment.clipId) : null;
    if (!clip) return;
    const local = Math.max(0, outputTime - segment.start);
    if (!hasClipEffects(clip, clip.start + local)) return;
    const width = outputCanvas.width, height = outputCanvas.height;
    const ctx = outputCanvas.getContext('2d');
    if (!ctx || !(width > 0 && height > 0)) return;
    const frame = document.createElement('canvas');
    frame.width = width; frame.height = height;
    const frameCtx = frame.getContext('2d');
    if (!frameCtx) return;
    frameCtx.drawImage(outputCanvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    fx.drawScene(ctx, {width, height, time: local, layers: [clipFrameLayer(clip, clip.start + local, frame)], clear: true});
  }
  async function renderOverlays(outputCanvas, time, plan = null) {
    if (plan?.multiClip) applyMainClipEffects(outputCanvas, Math.max(0, Math.min(plan.duration, time)), plan);
    const overlayTime = plan?.toOriginalTime ? plan.toOriginalTime(time) : time;
    const active = getOverlaysAt(overlayTime);
    // Text, stickers, captions and the overlay-clip transforms always have to be painted, even when
    // the project is a single V1 clip: they are part of the exported frame.
    const scene = fx ? sceneAt(overlayTime, {sources: 'export'}) : [];
    if (!active.length && !scene.length && !state.tracks.some((track) => track.id !== 'main' && track.id !== 'audio' && transitionAt(overlayTime, track.id))) return outputCanvas;
    const ctx = outputCanvas.getContext('2d');
    if (!ctx) return outputCanvas;
    const trackOrder = state.tracks.filter((track) => track.id !== 'main' && (track.kind === 'video' || track.kind === 'photo')).sort((a, b) => {
      const layerA = a.kind === 'photo' ? 1 : 0, layerB = b.kind === 'photo' ? 1 : 0;
      return layerA - layerB || state.tracks.indexOf(a) - state.tracks.indexOf(b);
    });
    const drawFit = (element, x = 0, alpha = 1) => {
      const sourceWidth = element?.videoWidth || element?.naturalWidth || outputCanvas.width;
      const sourceHeight = element?.videoHeight || element?.naturalHeight || outputCanvas.height;
      if (!(sourceWidth > 0 && sourceHeight > 0)) return;
      const scale = Math.min(outputCanvas.width / sourceWidth, outputCanvas.height / sourceHeight);
      const width = sourceWidth * scale, height = sourceHeight * scale;
      ctx.globalAlpha = alpha;
      ctx.drawImage(element, x + (outputCanvas.width - width) / 2, (outputCanvas.height - height) / 2, width, height);
      ctx.globalAlpha = 1;
    };
    for (const track of trackOrder) {
      const transition = transitionAt(overlayTime, track.id);
      if (transition) {
        if (!exportTransitionCanvas) exportTransitionCanvas = document.createElement('canvas');
        if (exportTransitionCanvas.width !== outputCanvas.width || exportTransitionCanvas.height !== outputCanvas.height) {
          exportTransitionCanvas.width = outputCanvas.width; exportTransitionCanvas.height = outputCanvas.height;
        }
        const layerContext = exportTransitionCanvas.getContext('2d');
        layerContext.clearRect(0, 0, exportTransitionCanvas.width, exportTransitionCanvas.height);
        const getElement = (clip) => {
          const media = state.media.get(clip.mediaId);
          if (!media) return null;
          const overlayVideo = media.overlayVideoElement || media.videoElement;
          return media.imageElement || overlayVideo || null;
        };
        const outgoing = getElement(transition.outgoing), incoming = getElement(transition.incoming);
        if (!outgoing || !incoming) continue;
        const beforeCut = overlayTime < transition.cut;
        const outTime = transitionSourceTime(transition, transition.outgoing, 'outgoing', overlayTime);
        const inTime = transitionSourceTime(transition, transition.incoming, 'incoming', overlayTime);
        for (const [element, sourceTime] of [[outgoing, beforeCut ? outTime : transition.outgoing.trimEnd - 0.001], [incoming, inTime]]) {
          if (element instanceof HTMLVideoElement && Math.abs(element.currentTime - sourceTime) > 0.02) await seekMediaElement(element, sourceTime);
        }
        const width = exportTransitionCanvas.width, height = exportTransitionCanvas.height;
        layerContext.globalAlpha = 1; layerContext.globalCompositeOperation = 'source-over';
        drawTransitionComposition(layerContext, transition, overlayTime, outgoing, incoming, width, height);
        ctx.drawImage(exportTransitionCanvas, 0, 0);
        continue;
      }
      for (const item of active.filter((entry) => state.clips.find((clip) => clip.id === entry.clipId)?.track === track.id)) {
        const clip = state.clips.find((entry) => entry.id === item.clipId);
        const media = state.media.get(clip?.mediaId);
        if (!media) continue;
        const element = media.imageElement || media.overlayVideoElement || media.videoElement;
        if (media.type === 'video' && element) {
          try { if (Math.abs(element.currentTime - item.time) > 0.02) await seekMediaElement(element, item.time); }
          catch (error) { continue; }
        }
        if (element?.readyState >= 2 || element instanceof HTMLImageElement && element.complete) {
          try { drawFit(element); } catch (error) {}
        }
      }
    }
    // Text, stickers, captions and the per-clip transforms / blends / chroma key ride on top of the
    // media pass, painted by the very same renderer the preview uses.
    if (fx && scene.length) {
      fx.drawScene(ctx, {width: outputCanvas.width, height: outputCanvas.height, time: overlayTime, layers: scene, clear: false});
    }
    return outputCanvas;
  }

  function seekMediaElement(element, time) {
    return new Promise((resolve, reject) => {
      if (Math.abs(element.currentTime - time) < 0.01 && element.readyState >= 2) return resolve();
      const timer = setTimeout(() => finish(new Error('Overlay frame seek timed out')), 8000);
      const finish = (error) => { clearTimeout(timer); element.removeEventListener('seeked', ready); error ? reject(error) : resolve(); };
      const ready = () => finish();
      element.addEventListener('seeked', ready, { once: true });
      element.pause(); element.currentTime = Math.max(0, Math.min(time, (element.duration || time + 0.05) - 0.001));
    });
  }

  function mapOutputTime(outputTime, plan) {
    const t = Math.max(0, Math.min(plan.duration, outputTime));
    const segments = plan.segments;
    const current = segments.find((segment) => t >= segment.start && t < segment.end) || segments[segments.length - 1];
    if (!current) return { sourceTime: 0, blackAlpha: 1, clipIndex: -1, gap: true };
    if (current.gap || current.blackFrame) return { sourceTime: 0, blackAlpha: 1, clipIndex: current.index, gap: true, blackFrame: true };
    const local = Math.max(0, Math.min(current.end - current.start, t - current.start));
    const clipLength = Math.max(0.05, current.end - current.start);
    const transitionSeconds = Math.min(Math.max(0.1, Number(current.transitionDuration ?? plan.transitionSeconds) || 0.5), clipLength, current.next ? Math.max(0.05, current.next.end - current.next.start) : clipLength);
    const index = segments.indexOf(current);
    const previousCandidate = segments[index - 1];
    const previous = previousCandidate && !previousCandidate.gap && !previousCandidate.blackFrame ? previousCandidate : null;
    const incomingTransitionSeconds = previous
      ? Math.min(Math.max(0.1, Number(previous.transitionDuration ?? plan.transitionSeconds) || 0.5), clipLength, Math.max(0.05, previous.end - previous.start))
      : transitionSeconds;
    const clipForSegment = state.clips.find((clip) => clip.id === current.clipId) || null;
    const clipSpan = Math.max(MIN_CLIP_DURATION, (current.trimEnd ?? 0) - (current.trimStart ?? 0));
    const clipSpeed = current.speed || clipForSegment?.speed;
    const sourceOffset = fx ? fx.sourceOffsetForLocal(local, clipSpan, clipSpeed) : local;
    const sourceTime = current.trimStart + Math.min(clipSpan - 0.0001, Math.max(0, sourceOffset));
    const effects = clipForSegment ? {
      speed: normalizeSpeed(clipForSegment.speed), blend: normalizeBlend(clipForSegment.blend),
      opacity: normalizeOpacity(clipForSegment.opacity, 1), chroma: normalizeChroma(clipForSegment.chroma),
      keyframes: normalizeKeyframes(clipForSegment.keyframes),
    } : null;
    let blackAlpha = 0, overlayAlpha = 0, overlayColor = '#000';
    if (current.transition === 'dissolve' && current.next && t >= current.end - transitionSeconds) {
      const amount = Math.max(0, Math.min(1, (t - (current.end - transitionSeconds)) / transitionSeconds));
      return { sourceTime, source: current.source, blendTime: current.next.trimStart + amount * Math.min(transitionSeconds, current.next.end - current.next.start), blendSource: current.next.source, blend: amount, clipIndex: current.index, blackAlpha: 0 };
    }
    if ((current.transition === 'slide-left' || current.transition === 'wipe') && current.next && t >= current.end - transitionSeconds / 2) {
      const amount = Math.max(0, Math.min(1, (t - (current.end - transitionSeconds / 2)) / (transitionSeconds / 2)));
      return { sourceTime, source: current.source, blendTime: current.next.trimStart + amount * Math.min(transitionSeconds / 2, current.next.end - current.next.start), blendSource: current.next.source, blend: amount, transitionType: current.transition, clipIndex: current.index, blackAlpha: 0 };
    }
    if (current.transition === 'fade-to-black' && current.next && t >= current.end - transitionSeconds / 2) {
      overlayAlpha = (t - (current.end - transitionSeconds / 2)) / (transitionSeconds / 2);
    }
    if (current.transition === 'fade-from-white' && current.next && t >= current.end - transitionSeconds / 2) {
      overlayAlpha = (t - (current.end - transitionSeconds / 2)) / (transitionSeconds / 2); overlayColor = '#fff';
    }
    if (previous?.next === current && previous.transition === 'fade-to-black' && t < current.start + incomingTransitionSeconds / 2) {
      overlayAlpha = Math.max(overlayAlpha, 1 - (t - current.start) / (incomingTransitionSeconds / 2));
    }
    if (previous?.next === current && previous.transition === 'fade-from-white' && t < current.start + incomingTransitionSeconds / 2) {
      overlayAlpha = Math.max(overlayAlpha, 1 - (t - current.start) / (incomingTransitionSeconds / 2)); overlayColor = '#fff';
    }
    if (previous?.next === current && previous.transition === 'fade-from-black' && t < current.start + incomingTransitionSeconds) {
      blackAlpha = 1 - (t - current.start) / incomingTransitionSeconds;
    }
    if (current.blackFrame || current.gap) blackAlpha = 1;
    return { sourceTime, source: current.source, clipId: current.clipId, effects, clipIndex: current.index, blackAlpha: Math.max(0, Math.min(1, blackAlpha)), overlayAlpha: Math.max(0, Math.min(1, overlayAlpha)), overlayColor, gap: false };
  }
  function getExportManifest(clips = state.clips) {
    return {
      schemaVersion: 2,
      baseTrack: 'main',
      effects: {keyframes: true, speed: true, layers: true, blend: true, chromaKey: true},
      tracks: state.tracks.map((track) => ({ ...track })),
      clips: clips.map((clip) => {
        const media = state.media.get(clip.mediaId);
        const transition = transitionInfo(clip);
        return { id: clip.id, mediaId: clip.mediaId, track: clip.track, start: clip.start, trimStart: clip.trimStart, trimEnd: clip.trimEnd, duration: clipDuration(clip), outputDuration: clipOutputDuration(clip), transition: transition.type, transitionDuration: transition.duration, type: media?.type || 'video', source: media?.src || null,
          speed: normalizeSpeed(clip.speed), blend: normalizeBlend(clip.blend), opacity: normalizeOpacity(clip.opacity, 1), chroma: normalizeChroma(clip.chroma), keyframes: normalizeKeyframes(clip.keyframes) };
      }),
      composite: { base: 'main', overlays: state.tracks.filter((track) => track.id !== 'main' && track.id !== 'audio').map((track) => track.id) },
    };
  }
  function getExportPlan(clips = state.clips) {
    const ordered = clips.filter((clip) => clip.track === 'main').slice().sort((a, b) => a.start - b.start);
    if (!ordered.length) return null;
    const originalEnd = Math.max(...ordered.map(clipEnd));
    const segments = [];
    let cumulativeDissolve = 0, previousClip = null, previousSegment = null;
    for (const clip of ordered) {
      const media = state.media.get(clip.mediaId);
      if (!media || media.type !== 'video') continue;
      const duration = clipOutputDuration(clip);
      const originalGap = previousClip ? clip.start - clipEnd(previousClip) : clip.start;
      const adjacent = previousClip && originalGap <= 0.025;
      const transition = transitionInfo(previousClip);
      const dissolve = adjacent && transition.type === 'dissolve'
        ? Math.min(transition.duration, clipDuration(previousClip), duration)
        : 0;
      if (dissolve) cumulativeDissolve += dissolve;
      const start = Math.max(0, clip.start - cumulativeDissolve);
      if (start > (previousSegment?.end || 0) + 0.025) {
        const gapStart = previousSegment?.end || 0;
        segments.push({ start: gapStart, end: start, originalStart: previousClip ? clipEnd(previousClip) : 0, gap: true, blackFrame: true, transition: 'none', index: segments.length });
      }
      const clipTransition = transitionInfo(clip);
      const segment = { id: clip.id, clipId: clip.id, mediaId: clip.mediaId, source: media.src, start, end: start + duration, originalStart: clip.start, trimStart: clip.trimStart, trimEnd: clip.trimEnd, transition: clipTransition.type, transitionDuration: clipTransition.duration, index: segments.length,
        speed: normalizeSpeed(clip.speed), blend: normalizeBlend(clip.blend), opacity: normalizeOpacity(clip.opacity, 1), chroma: normalizeChroma(clip.chroma), keyframes: normalizeKeyframes(clip.keyframes) };
      if (adjacent && previousSegment) previousSegment.next = segment;
      segments.push(segment);
      previousClip = clip; previousSegment = segment;
    }
    const duration = Math.max(0.05, originalEnd - cumulativeDissolve);
    if (duration > (previousSegment?.end || 0) + 0.025) {
      segments.push({ start: previousSegment?.end || 0, end: duration, originalStart: previousClip ? clipEnd(previousClip) : 0, gap: true, blackFrame: true, transition: 'none', index: segments.length });
    }
    segments.forEach((segment, index) => { segment.index = index; });
    const toOriginalTime = (outputTime) => {
      const time = Math.max(0, Math.min(duration, outputTime));
      const segment = segments.find((item) => time >= item.start && time < item.end) || segments[segments.length - 1];
      return segment ? segment.originalStart + Math.max(0, time - segment.start) : time;
    };
    return { multiClip: true, duration, transitionSeconds: 0.5, segments, manifest: getExportManifest(clips), toOriginalTime, overlaysAt: (time) => getOverlaysAt(toOriginalTime(time)) };
  }

  function onVideoEnded() {
    if (state.activeMain) advanceFrom(state.activeMain);
  }
  document.addEventListener('keydown', (event) => {
    if (!state.initialized || bridge().exporting || document.body.dataset.mode !== 'video') return;
    const target = event.target;
    if (event.key === 'Escape' && !target?.closest('[role="dialog"]') && (!transitionMenu.hidden || !contextMenu.hidden)) {
      event.preventDefault(); event.stopImmediatePropagation(); hideMenus();
      return;
    }
    if (target?.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
    if (target?.closest('#mtl-playhead,#mtl-ruler-playhead,#cropFrame,#trimStartHandle,#trimEndHandle') && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    if ((event.ctrlKey || event.metaKey) && ['z','y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key.toLowerCase() === 'y' || event.shiftKey) redo(); else undo();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.toLowerCase() === 's' && state.selected) {
      event.preventDefault(); event.stopImmediatePropagation(); splitClip(state.selected, state.timelineTime);
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && state.selected) {
      event.preventDefault(); event.stopImmediatePropagation(); deleteSelected();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); event.stopImmediatePropagation();
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const step = event.shiftKey ? 5 : 1 / FRAME_RATE;
      seekTo(Math.max(0, Math.min(getProjectEnd(), state.timelineTime + direction * step)), false);
      return;
    }
    if (event.code !== 'Space' || event.repeat) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (state.transportPlaying) pause(); else play();
  }, { capture: true });
  window.addEventListener('resize', () => { if (!root.hidden) render(); });
  function buildExportFrames(clips = state.clips) { return getExportPlan(clips); }
  window.multiTimeline = {
    adoptFirstVideo,
    reveal,
    keyframe: toggleKeyframeAtPlayhead,
    get selectedKeyframe() {
      const selection = selectedKeyframe();
      return selection ? {clipId: selection.clipId, time: selection.time, easing: keyframeEasingAt(selection.clip, selection.time)} : null;
    },
    selectKeyframe,
    clearKeyframeSelection,
    moveKeyframe: moveKeyframeTo,
    setKeyframeEasing,
    toggleFreezeFrame,
    toggleReverse,
    get clipEffects() { return state.selected ? {blend: normalizeBlend(state.selected.blend), opacity: normalizeOpacity(state.selected.opacity, 1), speed: normalizeSpeed(state.selected.speed), chroma: normalizeChroma(state.selected.chroma), keyframes: normalizeKeyframes(state.selected.keyframes)} : null; },
    updateClip(clipId, patch = {}) {
      const clip = state.clips.find((item) => item.id === clipId) || state.selected;
      if (!clip) return null;
      ensureClipEffects(clip);
      if (patch.speed) clip.speed = normalizeSpeed({...clip.speed, ...patch.speed});
      if (patch.chroma) clip.chroma = normalizeChroma({...clip.chroma, ...patch.chroma});
      if ('blend' in patch) clip.blend = normalizeBlend(patch.blend);
      if ('opacity' in patch) clip.opacity = normalizeOpacity(patch.opacity, 1);
      if (patch.keyframes) clip.keyframes = normalizeKeyframes({...clip.keyframes, ...patch.keyframes});
      if (patch.start !== undefined) clip.start = Math.max(0, Number(patch.start) || 0);
      if (patch.keyframeAt !== undefined && patch.property) {
        const local = Math.max(0, Number(patch.keyframeAt) || 0);
        const transform = clipTransformAt(clip, clip.start + local);
        const values = {position: transform.position, scale: transform.scale, rotation: transform.rotation, opacity: transform.opacity};
        clip.keyframes = fx.toggleKeyframe(clip.keyframes, patch.property, local, values[patch.property]).keyframes;
      }
      render();
      renderOverlayPreview();
      repaintScene();
      return clip;
    },
    get layers() { return normalizeLayers().map((layer) => ({...layer})); },
    get captions() { return (filmLabState.captions || []).map((line) => ({...line})); },
    addLayer,
    updateLayer,
    removeLayer,
    selectLayer,
    get selectedLayerId() { return state.selectedLayerId; },
    get layerHandleBox() { return state.handleBox ? {...state.handleBox} : null; },
    addCaption,
    updateCaption,
    splitCaption,
    mergeCaption,
    importCaptions,
    removeCaption,
    layersAt,
    sceneAt,
    clipOutputDuration: (clip) => clipOutputDuration(clip),
    clipSourceTimeAt,
    stickerImages: () => (fx ? fx.STICKERS.map((sticker) => sticker.id) : []),
    refreshLayers: () => { render(); renderOverlayPreview(); repaintScene(); },
    addMedia: addExternalMedia,
    addClip: addClipFromMedia,
    get clips() { return state.clips.map((clip) => ({ ...clip })); },
    getExportPlan,
    getExportManifest,
    buildExportFrames,
    mapOutputTime,
    renderOverlays,
    seekTo,
    play,
    pause,
    isReady: () => state.initialized,
    hasEdits: () => state.clips.length > 1 || overlayClips().length > 0 || state.clips.some((clip) => clip.start !== 0 || (canTransition(clip) && transitionInfo(clip).type !== 'none')),
  };
  // === ADDITIVE TL COMPATIBILITY FACADE ===
  const timelineFacade = window.TL || {};
  Object.defineProperties(timelineFacade, {
    tracks: { configurable: true, enumerable: true, get: () => state.tracks.map((track) => ({
      id: track.id, type: track.kind,
      clips: state.clips.filter((clip) => clip.track === track.id).map((clip) => ({
        id: clip.id, src: state.media.get(clip.mediaId)?.src || null, startTime: clip.start,
        duration: clipDuration(clip), trimIn: clip.trimStart, trimOut: clip.trimEnd,
        transitionOut: { ...transitionInfo(clip) },
      })),
    })) },
    playhead: { configurable: true, enumerable: true, get: () => state.timelineTime, set: (time) => { if (Number.isFinite(Number(time))) seekTo(Number(time), false); } },
    zoom: { configurable: true, enumerable: true, get: () => state.zoom, set: (value) => { state.zoom = Math.max(25, Math.min(400, Number(value) || 100)); state.pixelsPerSecond = 18 * state.zoom / 100; render(); } },
    duration: { configurable: true, enumerable: true, get: getProjectEnd },
    playing: { configurable: true, enumerable: true, get: () => state.transportPlaying, set: (playing) => playing ? play() : pause() },
    selectedClip: { configurable: true, enumerable: true, get: () => state.selected ? { ...state.selected } : null },
    history: { configurable: true, enumerable: true, get: () => state.undo.map((snapshot) => ({ ...snapshot, clips: snapshot.clips.map((clip) => ({ ...clip })) })) },
    historyIndex: { configurable: true, enumerable: true, get: () => state.undo.length - 1 },
  });
  window.TL = timelineFacade;
  window.addEventListener('beforeunload', () => {
    for (const media of state.media.values()) if (media.external) URL.revokeObjectURL(media.src);
  });
})();
