/* Photo-only segmentation worker. Inference stays in-browser; image bytes are never uploaded.
 *
 * Engines:
 *  - Fast (people): MediaPipe Tasks ImageSegmenter with the selfie multiclass model, which is
 *    resolved relative to this worker (vendor/mediapipe-tasks/) before the pinned Google URL.
 *    When neither the vendored file nor the network is available the identical model is served
 *    from the vendored ONNX export through onnxruntime-web, so Fast keeps working offline.
 *  - Pick object: MediaPipe Interactive Segmenter with a click keypoint (APIs are read from
 *    vendor/mediapipe-tasks/vision.d.ts: the 1.0.1 build exposes both the keypoint-based
 *    InteractiveSegmenterLegacy.segment(image, {keypoint}, callback) and the newer
 *    InteractiveSegmenter.setImage/segment(strokes) stroke API).
 *  - Refine: guided filter / smoothing for the mask stack, run here so the UI stays responsive.
 */
'use strict';

const BASE = new URL('vendor/mediapipe-tasks/', self.location.href).href;
const APP_BASE = new URL('./', self.location.href).href;
const TASKS_VISION_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/';
const TASKS_VISION_CDN_BUNDLE_URL = TASKS_VISION_CDN_BASE + 'vision_bundle.js';
const TASKS_VISION_CDN_WASM_URL = TASKS_VISION_CDN_BASE + 'wasm';
const LOCAL_SELFIE_MULTICLASS_MODEL_URL = BASE + 'selfie_multiclass_256x256.tflite';
const REMOTE_SELFIE_MULTICLASS_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
const LOCAL_MAGIC_TOUCH_MODEL_URL = BASE + 'models/interactive_segmentation_magic_touch.tflite';
const REMOTE_MAGIC_TOUCH_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/latest/interactive_segmentation.task';
const LOCAL_ONNX_MODEL_URL = 'vendor/models/selfie_multiclass_256x256.onnx';
const ORT_BASE = 'vendor/onnxruntime-web/';
let segmenterPromise = null;
let onnxSessionPromise = null;
let pickerPromise = null;
let sourceRaster = null; // {rgba, width, height} of the photo currently being masked
let fastBackend = 'auto'; // 'auto' | 'mediapipe' | 'onnx'

function stackApi() {
  if (!self.FilmMaskStack) importScripts('mask-stack.js');
  return self.FilmMaskStack;
}

function importVisionBundle() {
  try {
    importScripts(BASE + 'vision_bundle.js');
  } catch (localError) {
    try {
      importScripts(TASKS_VISION_CDN_BUNDLE_URL);
    } catch (cdnError) {
      throw new Error(`Could not load MediaPipe Vision bundle locally or from the pinned jsDelivr CDN. Local: ${localError?.message || localError}; CDN: ${cdnError?.message || cdnError}`);
    }
  }
}

function resolveVisionApi() {
  // The bundle defines a global called Vision (capital V); the lowercase name and the
  // worker scope itself are probed too so a future rename cannot break the engine.
  const api = self.Vision || self.vision || self;
  const candidates = [api, self.Vision, self.vision, self].filter(Boolean);
  const FilesetResolver = candidates.map(candidate => candidate.FilesetResolver)
    .find(value => typeof value?.forVisionTasks === 'function');
  const ImageSegmenter = candidates.map(candidate => candidate.ImageSegmenter)
    .find(value => typeof value?.createFromOptions === 'function');
  const InteractiveSegmenterLegacy = candidates.map(candidate => candidate.InteractiveSegmenterLegacy)
    .find(value => typeof value?.createFromOptions === 'function');
  const InteractiveSegmenter = candidates.map(candidate => candidate.InteractiveSegmenter)
    .find(value => typeof value?.createFromOptions === 'function');
  const missing = [];
  if (!FilesetResolver) missing.push('FilesetResolver.forVisionTasks');
  if (!ImageSegmenter) missing.push('ImageSegmenter.createFromOptions');
  if (missing.length) throw new Error(`MediaPipe Vision API is missing ${missing.join(' and ')}`);
  return {FilesetResolver, ImageSegmenter, InteractiveSegmenterLegacy, InteractiveSegmenter};
}

async function hasLocalAsset(url) {
  try {
    const response = await fetch(url, {method: 'HEAD', cache: 'no-store'});
    return response.ok;
  } catch (_) {
    return false;
  }
}

async function getVisionFileset() {
  const {FilesetResolver} = resolveVisionApi();
  const failures = [];
  try {
    return await FilesetResolver.forVisionTasks(BASE + 'wasm');
  } catch (error) {
    failures.push(`local WASM fileset: ${error?.message || error}`);
  }
  try {
    return await FilesetResolver.forVisionTasks(TASKS_VISION_CDN_WASM_URL);
  } catch (error) {
    failures.push(`pinned jsDelivr WASM fileset: ${error?.message || error}`);
  }
  throw new Error(`MediaPipe WASM could not be initialized. ${failures.join('; ')}`);
}

async function modelPathCandidates(localUrl, remoteUrl) {
  const local = await hasLocalAsset(localUrl);
  return local ? [localUrl, remoteUrl] : [remoteUrl, localUrl];
}

/** Fast engine, MediaPipe Tasks ImageSegmenter (selfie multiclass). */
function getImageSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      importVisionBundle();
      const {ImageSegmenter} = resolveVisionApi();
      const fileset = await getVisionFileset();
      const failures = [];
      for (const modelAssetPath of await modelPathCandidates(LOCAL_SELFIE_MULTICLASS_MODEL_URL, REMOTE_SELFIE_MULTICLASS_MODEL_URL)) {
        try {
          return await ImageSegmenter.createFromOptions(fileset, {
            baseOptions: {modelAssetPath},
            runningMode: 'IMAGE',
            outputCategoryMask: true,
            outputConfidenceMasks: true
          });
        } catch (error) {
          failures.push(`${modelAssetPath}: ${error?.message || error}`);
        }
      }
      throw new Error(`MediaPipe ImageSegmenter could not be initialized. ${failures.join('; ') || 'No model asset was available.'}`);
    })().catch(error => {
      segmenterPromise = null;
      throw error;
    });
  }
  return segmenterPromise;
}

/** Offline Fast fallback: the same multiclass model as an ONNX export through ORT. */
function getOnnxSession() {
  if (!onnxSessionPromise) {
    onnxSessionPromise = (async () => {
      try {
        importScripts(APP_BASE + ORT_BASE + 'ort.min.js');
      } catch (error) {
        throw new Error(`onnxruntime-web could not be loaded from ${ORT_BASE}: ${error?.message || error}`);
      }
      const ort = self.ort;
      if (!ort?.InferenceSession) throw new Error('onnxruntime-web did not register an InferenceSession');
      ort.env.wasm.wasmPaths = APP_BASE + ORT_BASE;
      ort.env.wasm.numThreads = 1; // no SharedArrayBuffer requirement, works on every host
      ort.env.logLevel = 'error';
      const url = APP_BASE + LOCAL_ONNX_MODEL_URL;
      if (!(await hasLocalAsset(url))) throw new Error(`The bundled model ${LOCAL_ONNX_MODEL_URL} is missing`);
      return await ort.InferenceSession.create(url, {executionProviders: ['wasm'], graphOptimizationLevel: 'all'});
    })().catch(error => {
      onnxSessionPromise = null;
      throw error;
    });
  }
  return onnxSessionPromise;
}

async function runOnnxFast(image, targetWidth, targetHeight) {
  const ort = self.ort;
  const session = await getOnnxSession();
  const size = 256;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d', {willReadFrequently: true});
  context.drawImage(image, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data;
  const input = new Float32Array(size * size * 3);
  for (let i = 0, p = 0; i < input.length; i += 3, p += 4) {
    input[i] = pixels[p] / 255;
    input[i + 1] = pixels[p + 1] / 255;
    input[i + 2] = pixels[p + 2] / 255;
  }
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const feeds = {};
  feeds[inputName] = new ort.Tensor('float32', input, [1, size, size, 3]);
  const results = await session.run(feeds);
  const output = results[outputName];
  const raw = output.data;
  if (!raw || raw.length < size * size * 2) throw new Error('The bundled model returned an unusable tensor');
  const classCount = Math.max(2, Math.round(raw.length / (size * size)));
  const confidence = stackApi().multiclassForeground(raw, size, size, classCount, {});
  if (output.dispose) output.dispose();
  return {width: targetWidth, height: targetHeight, mask: postProcessMask(confidence, size, size, targetWidth, targetHeight)};
}

function smoothThreshold(value) {
  if (value <= 0.3) return 0;
  if (value >= 0.7) return 255;
  const t = (value - 0.3) / 0.4;
  return Math.round((t * t * (3 - 2 * t)) * 255);
}

function erodeMask(source, width, height, radius = 2) {
  const horizontal = new Uint8Array(source.length);
  const output = new Uint8Array(source.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let value = 255;
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx;
        value = Math.min(value, nx < 0 || nx >= width ? 0 : source[row + nx]);
      }
      horizontal[row + x] = value;
    }
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let value = 255;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        value = Math.min(value, ny < 0 || ny >= height ? 0 : horizontal[ny * width + x]);
      }
      output[row + x] = value;
    }
  }
  return output;
}

function boxBlurPass(source, width, height, radius = 2) {
  const horizontal = new Uint8Array(source.length);
  const output = new Uint8Array(source.length);
  const diameter = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let dx = -radius; dx <= radius; dx++) sum += source[row + Math.max(0, Math.min(width - 1, dx))];
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = Math.round(sum / diameter);
      const removeX = Math.max(0, x - radius);
      const addX = Math.min(width - 1, x + radius + 1);
      sum += source[row + addX] - source[row + removeX];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let dy = -radius; dy <= radius; dy++) sum += horizontal[Math.max(0, Math.min(height - 1, dy)) * width + x];
    for (let y = 0; y < height; y++) {
      output[y * width + x] = Math.round(sum / diameter);
      const removeY = Math.max(0, y - radius);
      const addY = Math.min(height - 1, y + radius + 1);
      sum += horizontal[addY * width + x] - horizontal[removeY * width + x];
    }
  }
  return output;
}

function postProcessMask(confidence, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const width = Math.max(1, targetWidth * 2), height = Math.max(1, targetHeight * 2);
  const highResolution = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, Math.min(sourceHeight - 1, (y + 0.5) * sourceHeight / height - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(sourceHeight - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, Math.min(sourceWidth - 1, (x + 0.5) * sourceWidth / width - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(sourceWidth - 1, x0 + 1), fx = sx - x0;
      const top = confidence[y0 * sourceWidth + x0] * (1 - fx) + confidence[y0 * sourceWidth + x1] * fx;
      const bottom = confidence[y1 * sourceWidth + x0] * (1 - fx) + confidence[y1 * sourceWidth + x1] * fx;
      highResolution[y * width + x] = smoothThreshold(top * (1 - fy) + bottom * fy);
    }
  }
  // A 1px output erosion is 2px while working at 2x resolution; soften that edge with two radius-2 box passes.
  let refined = erodeMask(highResolution, width, height, 2);
  refined = boxBlurPass(refined, width, height, 2);
  refined = boxBlurPass(refined, width, height, 2);
  const output = new Uint8Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y++) {
    const highY = y * 2;
    for (let x = 0; x < targetWidth; x++) {
      const highX = x * 2, index = highY * width + highX;
      output[y * targetWidth + x] = Math.round((refined[index] + refined[index + 1] + refined[index + width] + refined[index + width + 1]) / 4);
    }
  }
  return output;
}

function isForegroundLabel(label) {
  const value = String(label || '').toLowerCase().replace(/[_\s]+/g, '-');
  return value !== 'background' && value !== 'bg' && value !== 'background-region';
}

function segmentImage(segmenter, image, targetWidth, targetHeight, onRefine = () => {}) {
  const result = segmenter.segment(image);
  try {
    const labels = (segmenter.getLabels?.() || []).map(label => String(label).toLowerCase());
    const masks = result.confidenceMasks || [];
    let confidence = null, width = 0, height = 0;
    if (masks.length) {
      width = masks[0].width; height = masks[0].height;
      const indices = labels.length
        ? labels.map((label, index) => isForegroundLabel(label) ? index : -1).filter(index => index >= 0)
        : masks.map((_, index) => index).filter(index => masks.length === 1 || index > 0);
      const chosen = indices.length ? indices : (masks.length === 1 ? [0] : masks.map((_, index) => index).filter(index => index > 0));
      confidence = new Float32Array(width * height);
      for (const index of chosen) {
        const values = masks[index]?.getAsFloat32Array?.();
        if (!values) continue;
        for (let i = 0; i < confidence.length; i++) confidence[i] = Math.min(1, confidence[i] + values[i]);
      }
    } else if (result.categoryMask) {
      const categoryMask = result.categoryMask;
      width = categoryMask.width; height = categoryMask.height;
      const categories = categoryMask.getAsUint8Array();
      const backgroundIndex = labels.findIndex(label => !isForegroundLabel(label));
      confidence = new Float32Array(categories.length);
      for (let i = 0; i < categories.length; i++) {
        const category = categories[i];
        confidence[i] = (backgroundIndex >= 0 ? category !== backgroundIndex : category > 0) ? 1 : 0;
      }
    }
    if (!confidence || !width || !height) throw new Error('The model returned no usable confidence mask');
    onRefine();
    const mask = postProcessMask(confidence, width, height, targetWidth, targetHeight);
    return {width: targetWidth, height: targetHeight, mask};
  } finally {
    for (const mask of result.confidenceMasks || []) mask.close?.();
    result.categoryMask?.close?.();
  }
}

/** Confidence masks from the interactive (pick) segmenter to an 8-bit alpha mask. */
function pickResultToMask(result, targetWidth, targetHeight, onRefine = () => {}) {
  try {
    const masks = result?.confidenceMasks || [];
    if (!masks.length) throw new Error('The interactive segmenter returned no mask');
    const width = masks[0].width, height = masks[0].height;
    const confidence = new Float32Array(width * height);
    for (const mask of masks) {
      const values = mask.getAsFloat32Array?.();
      if (!values) continue;
      for (let i = 0; i < confidence.length; i++) confidence[i] = Math.max(confidence[i], values[i]);
    }
    onRefine();
    return {width: targetWidth, height: targetHeight, mask: postProcessMask(confidence, width, height, targetWidth, targetHeight)};
  } finally {
    for (const mask of result?.confidenceMasks || []) mask.close?.();
    result?.categoryMask?.close?.();
  }
}

/** Pick engine: keypoint click. Uses the 1.0.1 keypoint API and the stroke API as a fallback. */
function getObjectPicker() {
  if (!pickerPromise) {
    pickerPromise = (async () => {
      importVisionBundle();
      const {InteractiveSegmenterLegacy, InteractiveSegmenter} = resolveVisionApi();
      const fileset = await getVisionFileset();
      const paths = await modelPathCandidates(LOCAL_MAGIC_TOUCH_MODEL_URL, REMOTE_MAGIC_TOUCH_MODEL_URL);
      const failures = [];
      if (InteractiveSegmenterLegacy) {
        for (const modelAssetPath of paths) {
          try {
            const segmenter = await InteractiveSegmenterLegacy.createFromOptions(fileset, {
              baseOptions: {modelAssetPath},
              outputConfidenceMasks: true,
              outputCategoryMask: true
            });
            return {mode: 'keypoint', segmenter};
          } catch (error) {
            failures.push(`keypoint API with ${modelAssetPath}: ${error?.message || error}`);
          }
        }
      }
      if (InteractiveSegmenter) {
        for (const modelAssetPath of paths) {
          try {
            const segmenter = await InteractiveSegmenter.createFromOptions(fileset, {baseOptions: {modelAssetPath}});
            return {mode: 'stroke', segmenter};
          } catch (error) {
            failures.push(`stroke API with ${modelAssetPath}: ${error?.message || error}`);
          }
        }
      }
      throw new Error(`The MediaPipe Interactive Segmenter could not be initialized. ${failures.join('; ') || 'No interactive model asset was available.'}`);
    })().catch(error => {
      pickerPromise = null;
      throw error;
    });
  }
  return pickerPromise;
}

const KEYPOINT_PICK_HALF_WINDOW = 0.02;

function runPick(image, point, targetWidth, targetHeight, onRefine) {
  return getObjectPicker().then(({mode, segmenter}) => {
    if (mode === 'keypoint') {
      return new Promise((resolve, reject) => {
        try {
          segmenter.segment(image, {keypoint: {x: point.x, y: point.y}}, result => {
            try { resolve(pickResultToMask(result, targetWidth, targetHeight, onRefine)); }
            catch (error) { reject(error); }
          });
        } catch (error) {
          reject(error);
        }
      });
    }
    // 1.0.1 stroke API: encode the click as a short positive stroke around the point.
    segmenter.setImage(image);
    const positive = self.Vision?.BrushMode?.POSITIVE ?? 1;
    const stroke = {
      brushMode: positive,
      point: [
        {x: Math.max(0, point.x - KEYPOINT_PICK_HALF_WINDOW), y: point.y},
        {x: point.x, y: point.y},
        {x: Math.min(1, point.x + KEYPOINT_PICK_HALF_WINDOW), y: point.y}
      ],
      isCompleted: true
    };
    const mask = segmenter.segment([stroke]);
    const data = mask?.getAsUint8Array?.() || mask?.getAsFloat32Array?.();
    if (!data) throw new Error('The interactive segmenter returned no mask data');
    const confidence = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) confidence[i] = data[i] > 1 ? data[i] / 255 : data[i];
    mask.close?.();
    onRefine?.();
    return {width: targetWidth, height: targetHeight, mask: postProcessMask(confidence, mask.width, mask.height, targetWidth, targetHeight)};
  });
}

/** Refine: smooth / edge-aware guided filter / feather / expand, on the worker thread. */
function refineMask(message) {
  const api = stackApi();
  const width = Math.max(1, message.width | 0), height = Math.max(1, message.height | 0);
  let mask = new Uint8ClampedArray(message.mask);
  if (mask.length !== width * height) throw new Error('The mask buffer does not match its size');
  const options = message.options || {};
  if (options.edgeRefine) {
    const guide = sourceRaster && sourceRaster.width === width && sourceRaster.height === height ? sourceRaster.rgba : null;
    mask = api.guidedFilter(mask, width, height, guide, options.radius ?? 12, options.strength ?? 0.6);
  }
  if (options.smooth > 0) mask = api.smoothMask(mask, width, height, options.smooth);
  if (options.expand) mask = api.expandContract(mask, width, height, options.expand);
  if (options.feather > 0) mask = api.blurMask(mask, width, height, options.feather);
  if (options.invert) mask = api.invertAlpha(mask);
  return mask;
}

function compositeRequest(message) {
  const api = stackApi();
  const width = Math.max(1, message.width | 0), height = Math.max(1, message.height | 0);
  const source = sourceRaster && sourceRaster.width === width && sourceRaster.height === height
    ? sourceRaster
    : (message.source ? {rgba: new Uint8ClampedArray(message.source), width, height} : null);
  if (message.source) sourceRaster = source;
  const layers = (message.layers || []).map(layer => ({
    ...layer,
    raster: layer.raster ? {data: new Uint8ClampedArray(layer.raster), width: layer.rasterWidth, height: layer.rasterHeight} : null
  }));
  return api.compositeLayers(layers, width, height, source);
}

/** Fast segmentation with automatic backend fallback. */
async function runFast(image, targetWidth, targetHeight, report) {
  const failures = [];
  if (fastBackend !== 'onnx') {
    try {
      const segmenter = await getImageSegmenter();
      return segmentImage(segmenter, image, targetWidth, targetHeight, () => report('Refining mask edges…'));
    } catch (error) {
      failures.push(`MediaPipe selfie model: ${error?.message || error}`);
      self.console?.warn?.('MediaPipe selfie segmentation unavailable; falling back to the bundled ONNX model.', error);
      fastBackend = 'onnx';
    }
  }
  try {
    report('Analyzing image with the bundled model…');
    return await runOnnxFast(image, targetWidth, targetHeight);
  } catch (error) {
    failures.push(`bundled ONNX model: ${error?.message || error}`);
    throw new Error(`Fast segmentation failed. ${failures.join('; ')}`);
  }
}

async function ensureFastModel(report) {
  const failures = [];
  try {
    await getImageSegmenter();
    fastBackend = 'mediapipe';
    return 'mediapipe';
  } catch (error) {
    failures.push(`MediaPipe selfie model: ${error?.message || error}`);
  }
  try {
    await getOnnxSession();
    fastBackend = 'onnx';
    report?.('Using the bundled segmentation model (offline).');
    return 'onnx';
  } catch (error) {
    failures.push(`bundled ONNX model: ${error?.message || error}`);
  }
  throw new Error(`No fast segmentation engine is available. ${failures.join('; ')}`);
}

async function ensurePickModel() {
  await getObjectPicker();
  return 'pick';
}

self.addEventListener('message', async event => {
  const message = event.data || {};
  const requestId = message.requestId;
  const report = text => self.postMessage({type: 'progress', requestId, message: text});
  const image = message.image;
  try {
    switch (message.type) {
      case 'init': {
        report('Loading AI model… this may take a moment.');
        const backend = await ensureFastModel(report);
        self.postMessage({type: 'ready', requestId, backend});
        return;
      }
      case 'init-pick': {
        report('Loading the object picker… this may take a moment.');
        await ensurePickModel();
        self.postMessage({type: 'ready', requestId});
        return;
      }
      case 'segment': {
        report('Analyzing image…');
        const result = await runFast(image, message.width, message.height, report);
        self.postMessage({type: 'result', requestId, ...result, mask: result.mask.buffer}, [result.mask.buffer]);
        return;
      }
      case 'pick': {
        report('Finding the object under the click…');
        const point = message.point || {x: 0.5, y: 0.5};
        const result = await runPick(image, point, message.width, message.height, () => report('Refining mask edges…'));
        self.postMessage({type: 'result', requestId, ...result, mask: result.mask.buffer}, [result.mask.buffer]);
        return;
      }
      case 'source': {
        if (image) {
          const canvas = new OffscreenCanvas(Math.max(1, message.width | 0), Math.max(1, message.height | 0));
          const context = canvas.getContext('2d', {willReadFrequently: true});
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          sourceRaster = {rgba: new Uint8ClampedArray(context.getImageData(0, 0, canvas.width, canvas.height).data), width: canvas.width, height: canvas.height};
        } else {
          sourceRaster = null;
        }
        self.postMessage({type: 'source-ready', requestId, width: sourceRaster?.width || 0, height: sourceRaster?.height || 0});
        return;
      }
      case 'foreground': {
        // Blur-Fusion style decontamination of the semi-transparent edge band.
        const api=stackApi();
        if(!sourceRaster) throw new Error('The photo has not been shared with the mask worker yet');
        const width=Math.max(1,message.width|0),height=Math.max(1,message.height|0);
        const alpha=message.mask instanceof Uint8ClampedArray?message.mask:new Uint8ClampedArray(message.mask);
        const pixels=api.edgeForegroundEstimate(sourceRaster.rgba,width,height,alpha,message.radius??6);
        self.postMessage({type:'result',requestId,width,height,pixels:pixels.buffer},[pixels.buffer]);
        return;
      }
      case 'refine': {
        const mask = refineMask(message);
        self.postMessage({type: 'result', requestId, width: message.width, height: message.height, mask: mask.buffer}, [mask.buffer]);
        return;
      }
      case 'composite': {
        const mask = compositeRequest(message);
        const buffer = mask.buffer || new Uint8ClampedArray(mask).buffer;
        self.postMessage({type: 'result', requestId, width: message.width, height: message.height, mask: buffer}, [buffer]);
        return;
      }
      default:
        return;
    }
  } catch (error) {
    self.postMessage({type: 'error', requestId, error: error?.message || 'Image segmentation failed'});
  } finally {
    image?.close?.();
  }
});
