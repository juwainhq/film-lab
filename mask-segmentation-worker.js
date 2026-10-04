/* Photo-only selfie segmentation worker. Inference stays in-browser; image bytes are never uploaded. */
const BASE = new URL('vendor/mediapipe-tasks/', self.location.href).href;
const TASKS_VISION_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/';
const TASKS_VISION_CDN_BUNDLE_URL = TASKS_VISION_CDN_BASE + 'vision_bundle.js';
const TASKS_VISION_CDN_WASM_URL = TASKS_VISION_CDN_BASE + 'wasm';
const LOCAL_SELFIE_MULTICLASS_MODEL_URL = BASE + 'selfie_multiclass_256x256.tflite';
const REMOTE_SELFIE_MULTICLASS_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
let segmenterPromise = null;

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
  const api = self.Vision || self.vision || self;
  const candidates = [api, self.Vision, self.vision, self].filter(Boolean);
  const FilesetResolver = candidates.map(candidate => candidate.FilesetResolver)
    .find(value => typeof value?.forVisionTasks === 'function');
  const ImageSegmenter = candidates.map(candidate => candidate.ImageSegmenter)
    .find(value => typeof value?.createFromOptions === 'function');
  const missing = [];
  if (!FilesetResolver) missing.push('FilesetResolver.forVisionTasks');
  if (!ImageSegmenter) missing.push('ImageSegmenter.createFromOptions');
  if (missing.length) throw new Error(`MediaPipe Vision API is missing ${missing.join(' and ')}`);
  return {FilesetResolver, ImageSegmenter};
}

async function hasLocalModelAsset() {
  try {
    const response = await fetch(LOCAL_SELFIE_MULTICLASS_MODEL_URL, {method: 'HEAD', cache: 'no-store'});
    return response.ok;
  } catch (_) {
    return false;
  }
}

async function getImageSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      importVisionBundle();
      const {FilesetResolver, ImageSegmenter} = resolveVisionApi();
      const filesets = [], failures = [];
      try {
        filesets.push({url: BASE + 'wasm', label: 'local', fileset: await FilesetResolver.forVisionTasks(BASE + 'wasm')});
      } catch (error) {
        failures.push(`local WASM fileset: ${error?.message || error}`);
      }

      const localModelAvailable = await hasLocalModelAsset();
      const modelPaths = localModelAvailable
        ? [LOCAL_SELFIE_MULTICLASS_MODEL_URL, REMOTE_SELFIE_MULTICLASS_MODEL_URL]
        : [REMOTE_SELFIE_MULTICLASS_MODEL_URL, LOCAL_SELFIE_MULTICLASS_MODEL_URL];
      const createWithFileset = async entry => {
        for (const modelAssetPath of modelPaths) {
          try {
            return await ImageSegmenter.createFromOptions(entry.fileset, {
              baseOptions: {modelAssetPath},
              runningMode: 'IMAGE',
              outputCategoryMask: true,
              outputConfidenceMasks: true
            });
          } catch (error) {
            failures.push(`${entry.label} WASM with ${modelAssetPath}: ${error?.message || error}`);
          }
        }
        return null;
      };

      for (const entry of filesets) {
        const segmenter = await createWithFileset(entry);
        if (segmenter) return segmenter;
      }
      if (!filesets.some(entry => entry.url === TASKS_VISION_CDN_WASM_URL)) {
        try {
          filesets.push({url: TASKS_VISION_CDN_WASM_URL, label: 'pinned jsDelivr', fileset: await FilesetResolver.forVisionTasks(TASKS_VISION_CDN_WASM_URL)});
        } catch (error) {
          failures.push(`pinned jsDelivr WASM fileset: ${error?.message || error}`);
        }
        for (const entry of filesets.filter(entry => entry.url === TASKS_VISION_CDN_WASM_URL)) {
          const segmenter = await createWithFileset(entry);
          if (segmenter) return segmenter;
        }
      }
      throw new Error(`MediaPipe ImageSegmenter could not be initialized. ${failures.join('; ') || 'No WASM fileset was available.'}`);
    })().catch(error => {
      segmenterPromise = null;
      throw error;
    });
  }
  return segmenterPromise;
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

self.addEventListener('message', async event => {
  const message = event.data || {};
  const requestId = message.requestId;
  if (message.type === 'init') {
    try {
      self.postMessage({type: 'progress', requestId, message: 'Loading AI model… this may take a moment.'});
      await getImageSegmenter();
      self.postMessage({type: 'ready', requestId});
    } catch (error) {
      self.postMessage({type: 'error', requestId, error: error?.message || 'Could not load the local segmentation model'});
    }
    return;
  }
  if (message.type !== 'segment') return;
  const image = message.image;
  try {
    self.postMessage({type: 'progress', requestId, message: 'Analyzing image…'});
    const segmenter = await getImageSegmenter();
    const result = segmentImage(segmenter, image, message.width, message.height, () => {
      self.postMessage({type: 'progress', requestId, message: 'Refining mask edges…'});
    });
    self.postMessage({type: 'result', requestId, ...result, mask: result.mask.buffer}, [result.mask.buffer]);
  } catch (error) {
    self.postMessage({type: 'error', requestId, error: error?.message || 'Image segmentation failed'});
  } finally {
    image?.close?.();
  }
});
