/* Film Lab "Pro" mask engine: BiRefNet_lite (onnx-community, MIT) through @huggingface/transformers.
 *
 * Runs as a module worker (WebGPU when available, WASM otherwise), downloads the model
 * once, caches it in Cache Storage, reports progress in megabytes and never blocks the UI.
 * The main thread can cancel the download by terminating this worker, and can purge the
 * cached files with the "Remove downloaded model" button (message type 'purge').
 */
'use strict';

const MODEL_ID = 'onnx-community/BiRefNet_lite'; // MIT licensed
const TRANSFORMERS_VERSION = '4.3.0';            // pinned; vendored copy is preferred
const CACHE_NAME = 'filmlab-birefnet-lite-v1';
const MODEL_URL_HINT = 'BiRefNet_lite';

let transformersPromise = null;
let modelPromise = null;
let processorPromise = null;
let stackApiPromise = null;
let cancelled = false;

function post(message) {
  self.postMessage(message);
}

function stackApi() {
  if (!stackApiPromise) {
    stackApiPromise = import(new URL('mask-stack.js', self.location.href).href)
      .then(() => self.FilmMaskStack)
      .catch(() => null);
  }
  return stackApiPromise;
}

async function loadTransformers() {
  if (!transformersPromise) {
    transformersPromise = (async () => {
      // A local copy wins when one is present (vendor/transformers/README.md explains why the
      // upstream bundle is not committed); otherwise the pinned exact version comes from jsDelivr.
      const local = new URL('vendor/transformers/transformers.web.min.js', self.location.href).href;
      const cdn = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/transformers.web.min.js`;
      let module = null;
      const failures = [];
      try {
        module = await import(local);
      } catch (error) {
        failures.push(`vendored copy: ${error?.message || error}`);
        module = await import(/* @vite-ignore */ cdn).catch(cdnError => {
          failures.push(`pinned jsDelivr ${TRANSFORMERS_VERSION}: ${cdnError?.message || cdnError}`);
          throw new Error(`@huggingface/transformers could not be loaded. ${failures.join('; ')}`);
        });
      }
      const env = module.env;
      if (env) {
        env.allowLocalModels = false;
        env.useBrowserCache = true; // Cache Storage, so the model is only downloaded once
        env.backends = env.backends || {};
        if (env.backends.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = new URL('vendor/onnxruntime-web/', self.location.href).href;
        env.progress_callback = data => {
          if (cancelled) return;
          if (data?.status === 'progress') {
            post({type: 'progress', phase: 'download', file: data.file, loaded: data.loaded, total: data.total});
          } else if (data?.status === 'done') {
            post({type: 'progress', phase: 'download', file: data.file, loaded: data.loaded, total: data.total, done: true});
          } else if (data?.status === 'initiate') {
            post({type: 'progress', phase: 'download', file: data.file, loaded: 0, total: 0, started: true});
          }
        };
      }
      return module;
    })();
  }
  return transformersPromise;
}

async function hasWebGpu() {
  try {
    if (!navigator.gpu) return false;
    return !!(await navigator.gpu.requestAdapter());
  } catch (_) {
    return false;
  }
}

async function getModel(useWebGpu) {
  if (!modelPromise) {
    modelPromise = (async () => {
      const {AutoModel, AutoProcessor} = await loadTransformers();
      const device = useWebGpu ? 'webgpu' : 'wasm';
      const dtype = useWebGpu ? 'fp16' : 'fp32'; // about 115 MB on WebGPU, 224 MB on WASM
      post({type: 'progress', phase: 'load', message: `Loading BiRefNet_lite (${dtype}) on ${device}…`});
      processorPromise = AutoProcessor.from_pretrained(MODEL_ID);
      const [model, processor] = await Promise.all([
        AutoModel.from_pretrained(MODEL_ID, {device, dtype}),
        processorPromise
      ]);
      return {model, processor, device, dtype};
    })().catch(error => {
      modelPromise = null;
      processorPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

async function bitmapToRawImage(bitmap) {
  const {RawImage} = await loadTransformers();
  const canvas = new OffscreenCanvas(Math.max(1, bitmap.width), Math.max(1, bitmap.height));
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({type: 'image/png'});
  return RawImage.fromBlob(blob);
}

async function segmentWithPro(bitmap, width, height, useWebGpu) {
  const {model, processor} = await getModel(useWebGpu);
  if (cancelled) throw new Error('Cancelled');
  post({type: 'progress', phase: 'infer', message: 'Segmenting with BiRefNet_lite…'});
  const image = await bitmapToRawImage(bitmap);
  const inputs = await processor(image, {size: {width: 1024, height: 1024}});
  const output = await model(inputs);
  const outputImage = output?.output_image || output?.[0];
  if (!outputImage) throw new Error('BiRefNet_lite returned no output_image');
  // output_image[0] is the flat foreground map: sigmoid for 0..1 confidence.
  const sigmoid = outputImage[0].sigmoid();
  const [maskHeight, maskWidth] = sigmoid.dims;
  const data = sigmoid.mul(255).to('uint8').data;
  const api = await stackApi();
  let alpha = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
  if (api) alpha = api.resizeMask(alpha, maskWidth, maskHeight, width, height);
  for (const tensor of Object.values(inputs || {})) tensor?.dispose?.();
  for (const tensor of Object.values(output || {})) tensor?.dispose?.();
  return alpha;
}

async function purgeCache() {
  const removed = [];
  const names = [CACHE_NAME, 'transformers-cache'];
  for (const name of names) {
    try {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      for (const request of keys) {
        if (String(request.url).includes(MODEL_URL_HINT)) {
          await cache.delete(request);
          removed.push(request.url);
        }
      }
    } catch (_) {}
  }
  return removed;
}

self.addEventListener('message', async event => {
  const message = event.data || {};
  const requestId = message.requestId;
  try {
    switch (message.type) {
      case 'probe': {
        const webgpu = await hasWebGpu();
        post({type: 'ready', requestId, webgpu, device: webgpu ? 'webgpu' : 'wasm', dtype: webgpu ? 'fp16' : 'fp32'});
        return;
      }
      case 'load': {
        cancelled = false;
        const webgpu = message.webgpu === true && (await hasWebGpu());
        const {device, dtype} = await getModel(webgpu);
        post({type: 'ready', requestId, device, dtype});
        return;
      }
      case 'segment': {
        cancelled = false;
        const webgpu = message.webgpu === true && (await hasWebGpu());
        const mask = await segmentWithPro(message.image, message.width, message.height, webgpu);
        const buffer = mask.buffer.byteLength === mask.byteLength ? mask.buffer : mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
        post({type: 'result', requestId, width: message.width, height: message.height, mask: buffer}, [buffer]);
        return;
      }
      case 'cancel': {
        cancelled = true;
        post({type: 'cancelled', requestId});
        return;
      }
      case 'purge': {
        const removed = await purgeCache();
        modelPromise = null;
        processorPromise = null;
        post({type: 'purged', requestId, removed: removed.length});
        return;
      }
      default:
        return;
    }
  } catch (error) {
    post({type: 'error', requestId, error: cancelled ? 'Cancelled' : (error?.message || 'BiRefNet_lite failed')});
  } finally {
    message.image?.close?.();
  }
});
