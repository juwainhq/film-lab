'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const workerSource = fs.readFileSync(path.join(root, 'mask-segmentation-worker.js'), 'utf8');
const visionBundle = fs.readFileSync(path.join(root, 'vendor/mediapipe-tasks/vision_bundle.js'), 'utf8');

function createWorkerContext({importScripts} = {}) {
  const sandbox = {
    URL,
    TextEncoder,
    TextDecoder,
    console,
    location: {href: 'https://film-lab.test/film-lab/mask-segmentation-worker.js'},
    fetch: async () => ({ok: false}),
    addEventListener() {},
    postMessage() {},
    importScripts: importScripts || (() => { throw new Error('Unexpected importScripts call'); })
  };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(workerSource, context, {filename: 'mask-segmentation-worker.js'});
  return {context, sandbox};
}

test('the pinned MediaPipe Vision IIFE exposes the APIs resolved by the segmentation worker', () => {
  const loaded = [];
  let context;
  const {sandbox, context: workerContext} = createWorkerContext({
    importScripts(url) {
      loaded.push(url);
      assert.equal(url, 'https://film-lab.test/film-lab/vendor/mediapipe-tasks/vision_bundle.js');
      vm.runInContext(visionBundle, context, {filename: 'vision_bundle.js'});
    }
  });
  context = workerContext;

  // Evaluate exactly the worker's import path, then the worker's API lookup.
  vm.runInContext("importScripts(BASE + 'vision_bundle.js')", context);
  const api = vm.runInContext('resolveVisionApi()', context);

  assert.deepEqual(loaded, ['https://film-lab.test/film-lab/vendor/mediapipe-tasks/vision_bundle.js']);
  assert.equal(sandbox.self, sandbox);
  assert.equal(typeof api.FilesetResolver.forVisionTasks, 'function');
  assert.equal(typeof api.ImageSegmenter.createFromOptions, 'function');
});

test('worker API lookup checks available namespaces and names missing exports clearly', () => {
  const {context} = createWorkerContext();
  vm.runInContext(`
    self.Vision = {};
    self.vision = {
      FilesetResolver: {forVisionTasks() {}},
      ImageSegmenter: {createFromOptions() {}}
    };
  `, context);
  const api = vm.runInContext('resolveVisionApi()', context);
  assert.equal(typeof api.FilesetResolver.forVisionTasks, 'function');
  assert.equal(typeof api.ImageSegmenter.createFromOptions, 'function');

  vm.runInContext('self.vision = {}; self.Vision = {}', context);
  assert.throws(
    () => vm.runInContext('resolveVisionApi()', context),
    /MediaPipe Vision API is missing FilesetResolver\.forVisionTasks and ImageSegmenter\.createFromOptions/
  );
});

test('segmenter creation prefers an available local model and retries the remote model on failure', async () => {
  const modelPaths = [], wasmPaths = [], imports = [];
  const {context, sandbox} = createWorkerContext({importScripts(url) { imports.push(url); }});
  sandbox.fetch = async (url, options) => {
    assert.equal(options.method, 'HEAD');
    assert.equal(url, vm.runInContext('LOCAL_SELFIE_MULTICLASS_MODEL_URL', context));
    return {ok: true};
  };
  sandbox.Vision = {
    FilesetResolver: {async forVisionTasks(url) { wasmPaths.push(url); return {url}; }},
    ImageSegmenter: {async createFromOptions(fileset, options) {
      modelPaths.push(options.baseOptions.modelAssetPath);
      if (modelPaths.length === 1) throw new Error('local model could not initialize');
      return {fileset, modelAssetPath: options.baseOptions.modelAssetPath};
    }}
  };

  const segmenter = await vm.runInContext('getImageSegmenter()', context);
  assert.equal(segmenter.modelAssetPath, vm.runInContext('REMOTE_SELFIE_MULTICLASS_MODEL_URL', context));
  assert.deepEqual(modelPaths, [
    vm.runInContext('LOCAL_SELFIE_MULTICLASS_MODEL_URL', context),
    vm.runInContext('REMOTE_SELFIE_MULTICLASS_MODEL_URL', context)
  ]);
  assert.deepEqual(wasmPaths, ['https://film-lab.test/film-lab/vendor/mediapipe-tasks/wasm']);
  assert.deepEqual(imports, ['https://film-lab.test/film-lab/vendor/mediapipe-tasks/vision_bundle.js']);
});

test('the worker falls back to the pinned CDN WASM directory when local fileset resolution fails', async () => {
  const wasmPaths = [];
  const {context, sandbox} = createWorkerContext({importScripts() {}});
  sandbox.Vision = {
    FilesetResolver: {async forVisionTasks(url) {
      wasmPaths.push(url);
      if (url === vm.runInContext("BASE + 'wasm'", context)) throw new Error('local WASM unavailable');
      return {url};
    }},
    ImageSegmenter: {async createFromOptions(fileset, options) { return {fileset, modelAssetPath: options.baseOptions.modelAssetPath}; }}
  };

  const segmenter = await vm.runInContext('getImageSegmenter()', context);
  assert.equal(segmenter.fileset.url, 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm');
  assert.deepEqual(wasmPaths, [
    'https://film-lab.test/film-lab/vendor/mediapipe-tasks/wasm',
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
  ]);
});

test('MediaPipe assets use the pinned local package first, have CDN fallbacks, and stay out of the app-shell precache', () => {
  const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const precache = serviceWorker.match(/const PRECACHE = \[([\s\S]*?)\]\.map/)[1];
  const electronMain = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');

  assert.match(workerSource, /const BASE = new URL\('vendor\/mediapipe-tasks\/', self\.location\.href\)\.href/);
  assert.match(workerSource, /@mediapipe\/tasks-vision@1\.0\.1/);
  assert.match(workerSource, /importScripts\(BASE \+ 'vision_bundle\.js'\)/);
  assert.match(workerSource, /importScripts\(TASKS_VISION_CDN_BUNDLE_URL\)/);
  assert.match(workerSource, /FilesetResolver\.forVisionTasks\(BASE \+ 'wasm'\)/);
  assert.match(workerSource, /FilesetResolver\.forVisionTasks\(TASKS_VISION_CDN_WASM_URL\)/);
  assert.match(workerSource, /REMOTE_SELFIE_MULTICLASS_MODEL_URL/);
  assert.match(workerSource, /LOCAL_SELFIE_MULTICLASS_MODEL_URL/);
  assert.match(electronMain, /'\.wasm': 'application\/wasm'/);
  assert.match(electronMain, /'\.tflite': 'application\/octet-stream'/);
  assert.match(serviceWorker, /const CACHE = 'filmlab-v7'/);
  assert.doesNotMatch(precache, /\.wasm|\.tflite/i);
});
