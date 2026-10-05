/* Film Lab mask stack: Lightroom-style selection layers for the photo Mask tab.
 *
 * Everything here is a pure function over 8-bit alpha buffers (or RGBA pixels) so it
 * can run in a Web Worker or under Node in the unit tests. The browser binding lives
 * in index.html, which turns the composite alpha into the existing maskBgAutoCanvas
 * that rebuildMaskBackgroundCanvas() already understands.
 *
 * Layer types: subject, background, pick, brush, linear, radial, luminance, color.
 * Operations: add, subtract, intersect. Every layer can be inverted, hidden or deleted.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FilmMaskStack = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OPERATIONS = ['add', 'subtract', 'intersect'];
  const LAYER_TYPES = ['subject', 'background', 'pick', 'brush', 'linear', 'radial', 'luminance', 'color'];
  const TYPE_LABELS = {
    subject: 'Subject',
    background: 'Background',
    pick: 'Pick object',
    brush: 'Brush',
    linear: 'Linear gradient',
    radial: 'Radial gradient',
    luminance: 'Luminance range',
    color: 'Color range'
  };

  const clamp = (value, min, max) => value < min ? min : value > max ? max : value;
  const clamp255 = value => value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
  const lerp = (a, b, t) => a + (b - a) * t;
  /** Hermite falloff, so gradients and range masks never band. */
  const smoothStep = t => {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  };

  function createAlpha(width, height, value = 0) {
    const mask = new Uint8ClampedArray(Math.max(1, width) * Math.max(1, height));
    if (value) mask.fill(value);
    return mask;
  }

  function mergeAlpha(base, layer, operation) {
    const length = Math.min(base.length, layer.length);
    const output = new Uint8ClampedArray(base.length);
    for (let i = 0; i < length; i++) {
      const a = base[i] / 255, b = layer[i] / 255;
      let value;
      if (operation === 'subtract') value = a * (1 - b);
      else if (operation === 'intersect') value = a * b;
      else value = a + b - a * b; // add: union, kept in 0..1 so nothing clips to a hard edge
      output[i] = clamp255(value * 255);
    }
    return output;
  }

  function invertAlpha(mask) {
    const output = new Uint8ClampedArray(mask.length);
    for (let i = 0; i < mask.length; i++) output[i] = 255 - mask[i];
    return output;
  }

  /** Separable box blur on float data; radius 0 returns a copy. */
  function boxBlurFloat(source, width, height, radius) {
    const r = Math.max(0, Math.round(radius || 0));
    if (!r) return Float32Array.from(source);
    const horizontal = new Float32Array(source.length);
    const output = new Float32Array(source.length);
    const diameter = r * 2 + 1;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      for (let dx = -r; dx <= r; dx++) sum += source[row + clamp(dx, 0, width - 1)];
      for (let x = 0; x < width; x++) {
        horizontal[row + x] = sum / diameter;
        sum += source[row + clamp(x + r + 1, 0, width - 1)] - source[row + clamp(x - r, 0, width - 1)];
      }
    }
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -r; dy <= r; dy++) sum += horizontal[clamp(dy, 0, height - 1) * width + x];
      for (let y = 0; y < height; y++) {
        output[y * width + x] = sum / diameter;
        sum += horizontal[clamp(y + r + 1, 0, height - 1) * width + x] - horizontal[clamp(y - r, 0, height - 1) * width + x];
      }
    }
    return output;
  }

  /** 8-bit box blur (alpha masks): the float pass quantised back into 0..255. */
  function boxBlur(source, width, height, radius) {
    const floats = boxBlurFloat(source, width, height, radius);
    const output = new Uint8ClampedArray(floats.length);
    for (let i = 0; i < floats.length; i++) output[i] = floats[i];
    return output;
  }

  /** Soft, banding-free blur: three box passes approximate a Gaussian. */
  function blurMask(source, width, height, radius) {
    const r = Math.max(0, Math.round(radius || 0));
    if (!r) return new Uint8ClampedArray(source);
    let mask = boxBlur(source, width, height, Math.max(1, Math.round(r / 3)));
    mask = boxBlur(mask, width, height, Math.max(1, Math.round(r / 3)));
    return boxBlur(mask, width, height, Math.max(1, Math.round(r / 3)));
  }

  /** Smooth control: rounds the mask without moving the edge. */
  function smoothMask(source, width, height, radius) {
    return blurMask(source, width, height, radius);
  }

  /** Expand (positive px) or contract (negative px) using a round structuring element. */
  function expandContract(source, width, height, pixels) {
    const radius = Math.round(pixels || 0);
    if (!radius) return new Uint8ClampedArray(source);
    const output = new Uint8ClampedArray(source.length);
    const grow = radius > 0;
    const r = Math.abs(radius);
    const offsets = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r + r) offsets.push([dx, dy]);
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let value = grow ? 0 : 255;
        for (let i = 0; i < offsets.length; i++) {
          const nx = x + offsets[i][0], ny = y + offsets[i][1];
          const sample = nx < 0 || nx >= width || ny < 0 || ny >= height ? 0 : source[ny * width + nx];
          if (grow) { if (sample > value) value = sample; if (value === 255) break; }
          else { if (sample < value) value = sample; if (value === 0) break; }
        }
        output[y * width + x] = value;
      }
    }
    return output;
  }

  /**
   * Guided filter (He et al.) with the photo luminance as the guide: keeps edges crisp
   * while smoothing the mask, which is what "Edge refine" uses on AI masks.
   */
  function guidedFilter(mask, width, height, guide, radius, strength) {
    const r = Math.max(1, Math.round(radius || 8));
    const s = clamp(Number.isFinite(strength) ? strength : 0.5, 0, 1);
    const epsilon = (0.02 + (1 - s) * (1 - s) * 0.4) * 255 * 255;
    const count = width * height;
    const guideF = new Float32Array(count);
    const maskF = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const p = i * 4;
      guideF[i] = guide && guide.length >= count * 4
        ? (guide[p] * 0.299 + guide[p + 1] * 0.587 + guide[p + 2] * 0.114)
        : mask[i]; // no guide: fall back to filtering the mask by itself
      maskF[i] = mask[i];
    }
    const meanI = boxBlurFloat(guideF, width, height, r);
    const meanP = boxBlurFloat(maskF, width, height, r);
    const squareI = new Float32Array(count), productIp = new Float32Array(count);
    for (let i = 0; i < count; i++) { squareI[i] = guideF[i] * guideF[i]; productIp[i] = guideF[i] * maskF[i]; }
    const meanII = boxBlurFloat(squareI, width, height, r);
    const meanIp = boxBlurFloat(productIp, width, height, r);
    const a = new Float32Array(count), b = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const variance = meanII[i] - meanI[i] * meanI[i];
      const covariance = meanIp[i] - meanI[i] * meanP[i];
      a[i] = covariance / (variance + epsilon);
      b[i] = meanP[i] - a[i] * meanI[i];
    }
    const meanA = boxBlurFloat(a, width, height, r);
    const meanB = boxBlurFloat(b, width, height, r);
    const output = new Uint8ClampedArray(count);
    for (let i = 0; i < count; i++) output[i] = clamp255(meanA[i] * guideF[i] + meanB[i]);
    return output;
  }

  /** Linear gradient with draggable handles, in normalized photo coordinates. */
  function linearGradientMask(width, height, params) {
    const p = params || {};
    const x1 = Number(p.x1 ?? 0.5), y1 = Number(p.y1 ?? 0);
    const x2 = Number(p.x2 ?? 0.5), y2 = Number(p.y2 ?? 1);
    const dx = x2 - x1, dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy || 1e-6;
    const feather = clamp(Number(p.feather ?? 0.25), 0, 1);
    const soft = Math.max(1e-3, feather) * 0.5;
    const mask = new Uint8ClampedArray(Math.max(1, width) * Math.max(1, height));
    for (let y = 0; y < height; y++) {
      const ny = (y + 0.5) / height;
      for (let x = 0; x < width; x++) {
        const nx = (x + 0.5) / width;
        const t = ((nx - x1) * dx + (ny - y1) * dy) / lengthSquared;
        const ramp = smoothStep((t - (0.5 - soft)) / (2 * soft));
        mask[y * width + x] = clamp255((p.flip ? 1 - ramp : ramp) * 255);
      }
    }
    return mask;
  }

  /** Radial gradient with draggable centre, resizable radii and feather. */
  function radialGradientMask(width, height, params) {
    const p = params || {};
    const cx = Number(p.x ?? 0.5), cy = Number(p.y ?? 0.5);
    const rx = Math.max(1e-4, Number(p.rx ?? 0.35)), ry = Math.max(1e-4, Number(p.ry ?? 0.35));
    const rotation = (Number(p.rotation ?? 0) * Math.PI) / 180;
    const feather = clamp(Number(p.feather ?? 0.4), 0, 1);
    const includeOutside = !!p.outside;
    const cos = Math.cos(-rotation), sin = Math.sin(-rotation);
    const mask = new Uint8ClampedArray(Math.max(1, width) * Math.max(1, height));
    for (let y = 0; y < height; y++) {
      const ny = (y + 0.5) / height;
      for (let x = 0; x < width; x++) {
        const nx = (x + 0.5) / width;
        const ox = nx - cx, oy = ny - cy;
        const px = (ox * cos - oy * sin) / rx;
        const py = (ox * sin + oy * cos) / ry;
        const distance = Math.sqrt(px * px + py * py);
        const inner = 1 - feather;
        let value = 1 - smoothStep((distance - inner) / Math.max(1e-4, feather));
        if (includeOutside) value = 1 - value;
        mask[y * width + x] = clamp255(value * 255);
      }
    }
    return mask;
  }

  /** Luminance range: keeps pixels between min and max with a smooth shoulder. */
  function luminanceRangeMask(rgba, width, height, params) {
    const p = params || {};
    const min = clamp(Number(p.min ?? 0), 0, 255), max = clamp(Number(p.max ?? 255), 0, 255);
    const smoothness = clamp(Number(p.smoothness ?? 20), 0, 128);
    const low = min, high = max, order = low > high;
    const lo = order ? high : low, hi = order ? low : high;
    const shoulder = Math.max(1e-3, smoothness);
    const mask = new Uint8ClampedArray(Math.max(1, width) * Math.max(1, height));
    for (let i = 0; i < mask.length; i++) {
      const pixel = i * 4;
      if (!rgba || rgba.length < pixel + 3) { mask[i] = 0; continue; }
      const luma = rgba[pixel] * 0.299 + rgba[pixel + 1] * 0.587 + rgba[pixel + 2] * 0.114;
      const rising = smoothStep((luma - (lo - shoulder)) / (2 * shoulder));
      const falling = 1 - smoothStep((luma - (hi - shoulder)) / (2 * shoulder));
      mask[i] = clamp255(Math.min(rising, falling) * 255);
    }
    return mask;
  }

  /** Color range: everything within tolerance of a sampled color, with a soft shoulder. */
  function colorRangeMask(rgba, width, height, params) {
    const p = params || {};
    const red = Number(p.r ?? 0), green = Number(p.g ?? 0), blue = Number(p.b ?? 0);
    const tolerance = clamp(Number(p.tolerance ?? 32), 0, 255);
    const smoothness = clamp(Number(p.smoothness ?? 16), 0, 255);
    const shoulder = Math.max(1e-3, smoothness);
    const mask = new Uint8ClampedArray(Math.max(1, width) * Math.max(1, height));
    for (let i = 0; i < mask.length; i++) {
      const pixel = i * 4;
      if (!rgba || rgba.length < pixel + 3) { mask[i] = 0; continue; }
      const dr = rgba[pixel] - red, dg = rgba[pixel + 1] - green, db = rgba[pixel + 2] - blue;
      const distance = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
      mask[i] = clamp255((1 - smoothStep((distance - (tolerance - shoulder)) / (2 * shoulder))) * 255);
    }
    return mask;
  }

  /** Bilinear resize of an 8-bit alpha buffer. */
  function resizeMask(source, sourceWidth, sourceHeight, width, height) {
    if (sourceWidth === width && sourceHeight === height) return new Uint8ClampedArray(source);
    const output = new Uint8ClampedArray(Math.max(1, width) * Math.max(1, height));
    for (let y = 0; y < height; y++) {
      const sy = Math.max(0, Math.min(sourceHeight - 1, (y + 0.5) * sourceHeight / height - 0.5));
      const y0 = Math.floor(sy), y1 = Math.min(sourceHeight - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < width; x++) {
        const sx = Math.max(0, Math.min(sourceWidth - 1, (x + 0.5) * sourceWidth / width - 0.5));
        const x0 = Math.floor(sx), x1 = Math.min(sourceWidth - 1, x0 + 1), fx = sx - x0;
        const top = lerp(source[y0 * sourceWidth + x0], source[y0 * sourceWidth + x1], fx);
        const bottom = lerp(source[y1 * sourceWidth + x0], source[y1 * sourceWidth + x1], fx);
        output[y * width + x] = lerp(top, bottom, fy);
      }
    }
    return output;
  }

  function softmaxRow(values, offset, count) {
    let max = -Infinity;
    for (let i = 0; i < count; i++) if (values[offset + i] > max) max = values[offset + i];
    let sum = 0;
    for (let i = 0; i < count; i++) sum += Math.exp(values[offset + i] - max);
    const output = new Float32Array(count);
    for (let i = 0; i < count; i++) output[i] = Math.exp(values[offset + i] - max) / (sum || 1);
    return output;
  }

  /**
   * Multiclass segmentation output ([N, H, W, C] logits or probabilities) to a
   * foreground confidence map: 1 - P(background), the same convention the MediaPipe
   * ImageSegmenter path uses, so both engines feed postProcessMask identically.
   */
  function multiclassForeground(output, width, height, classCount, options) {
    const opts = options || {};
    const foregroundClasses = opts.foregroundClasses || null; // e.g. [1,2,3] keeps "person" classes only
    const confidence = new Float32Array(Math.max(1, width) * Math.max(1, height));
    const channels = Math.max(2, classCount || 6);
    const likelyProbabilities = opts.probabilities !== false;
    const row = new Float32Array(channels);
    for (let i = 0; i < confidence.length; i++) {
      const offset = i * channels;
      let total = 0;
      for (let c = 0; c < channels; c++) {
        const value = output[offset + c] || 0;
        row[c] = value;
        total += value;
      }
      let weights = row;
      if (!likelyProbabilities || Math.abs(total - 1) > 0.05) {
        // The vendored ONNX graph ends on a Transpose, so treat the tensor as logits.
        if (opts.alwaysSoftmax || Math.abs(total - 1) > 0.05) weights = softmaxRow(output, offset, channels);
      }
      let value = 0;
      if (foregroundClasses) {
        for (const index of foregroundClasses) value += weights[index] || 0;
      } else {
        value = 1 - (weights[0] || 0);
      }
      confidence[i] = clamp(value, 0, 1);
    }
    return confidence;
  }

  /**
   * Edge color cleanup for cutouts: estimates the clean foreground color of
   * semi-transparent edge pixels (a Blur-Fusion style weighted propagation from the
   * fully opaque neighbourhood) so transparent PNGs have no light or dark halo.
   */
  function edgeForegroundEstimate(rgba, width, height, alpha, radius) {
    const r = Math.max(1, Math.round(radius || 3));
    const count = width * height;
    const output = new Uint8ClampedArray(rgba.length);
    output.set(rgba);
    if (!alpha) return output;
    const weightR = new Float32Array(count), weightG = new Float32Array(count), weightB = new Float32Array(count), weightSum = new Float32Array(count);
    const opaque = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const a = alpha[i] / 255;
      if (a > 0.92) {
        opaque[i] = 1;
        const p = i * 4;
        weightR[i] = rgba[p] * a; weightG[i] = rgba[p + 1] * a; weightB[i] = rgba[p + 2] * a; weightSum[i] = a;
      }
    }
    // One blur pass over the confident pixels only: each semi-transparent pixel then
    // blends towards the average color of the nearest solid foreground.
    const spread = blurWeighted(weightR, weightG, weightB, weightSum, width, height, r);
    for (let i = 0; i < count; i++) {
      const a = alpha[i] / 255;
      const p = i * 4;
      if (a >= 0.999 || (!spread.sum[i] && a <= 0)) continue;
      if (a > 0.92 && opaque[i]) continue;
      if (spread.sum[i] > 0) {
        output[p] = clamp255(spread.r[i] / spread.sum[i]);
        output[p + 1] = clamp255(spread.g[i] / spread.sum[i]);
        output[p + 2] = clamp255(spread.b[i] / spread.sum[i]);
      }
    }
    return output;
  }

  function blurWeighted(r, g, b, sum, width, height, radius) {
    return {
      r: boxBlurFloat(r, width, height, radius),
      g: boxBlurFloat(g, width, height, radius),
      b: boxBlurFloat(b, width, height, radius),
      sum: boxBlurFloat(sum, width, height, radius)
    };
  }

  /** Alpha of one layer at the stack resolution, before its operation is applied. */
  function layerAlpha(layer, width, height, source) {
    const params = layer.params || {};
    switch (layer.type) {
      case 'linear':
        return linearGradientMask(width, height, params);
      case 'radial':
        return radialGradientMask(width, height, params);
      case 'luminance':
        return luminanceRangeMask(source ? source.rgba : null, width, height, params);
      case 'color':
        return colorRangeMask(source ? source.rgba : null, width, height, params);
      default: {
        const raster = layer.raster;
        if (!raster || !raster.data) return createAlpha(width, height, 0);
        let mask = raster.data instanceof Uint8ClampedArray ? raster.data : new Uint8ClampedArray(raster.data);
        if (layer.type === 'background') mask = invertAlpha(mask);
        if (raster.width !== width || raster.height !== height) mask = resizeMask(mask, raster.width, raster.height, width, height);
        return mask;
      }
    }
  }

  /** Composite every visible layer into a single alpha buffer. */
  function compositeLayers(layers, width, height, source) {
    let base = createAlpha(width, height, 0);
    for (const layer of layers || []) {
      if (!layer || layer.visible === false) continue;
      let alpha = layerAlpha(layer, width, height, source);
      if (layer.invert) alpha = invertAlpha(alpha);
      const operation = OPERATIONS.includes(layer.operation) ? layer.operation : 'add';
      if (operation === 'add') base = mergeAlpha(base, alpha, 'add');
      else if (operation === 'subtract') base = mergeAlpha(base, alpha, 'subtract');
      else base = mergeAlpha(base, alpha, 'intersect');
    }
    return base;
  }

  let nextLayerId = 1;

  function defaultParams(type) {
    switch (type) {
      case 'linear': return {x1: 0.5, y1: 0.05, x2: 0.5, y2: 0.75, feather: 0.35, flip: false};
      case 'radial': return {x: 0.5, y: 0.45, rx: 0.32, ry: 0.32, rotation: 0, feather: 0.45, outside: false};
      case 'luminance': return {min: 0, max: 160, smoothness: 24};
      case 'color': return {r: 128, g: 128, b: 128, tolerance: 40, smoothness: 18};
      case 'brush': return {size: 20, hardness: 65, autoMask: false, autoTolerance: 30};
      default: return {};
    }
  }

  function createStack(options) {
    const opts = options || {};
    let layers = [];
    const history = {past: [], future: []};
    const limit = Math.max(4, opts.historyLimit || 40);

    const snapshot = () => JSON.parse(JSON.stringify({
      layers: layers.map(layer => ({
        id: layer.id, type: layer.type, name: layer.name, operation: layer.operation,
        invert: !!layer.invert, visible: layer.visible !== false, params: layer.params || {},
        // rasters are canvases/data buffers and stay out of the JSON history
        hasRaster: !!layer.raster
      }))
    }));

    const restore = json => {
      const wanted = json && json.layers ? json.layers : [];
      layers = wanted.map(entry => {
        const existing = layers.find(layer => layer.id === entry.id);
        return {
          id: entry.id, type: entry.type, name: entry.name, operation: entry.operation,
          invert: !!entry.invert, visible: entry.visible !== false,
          params: {...(entry.params || {})},
          raster: existing ? existing.raster : entry.raster || null,
          canvas: existing ? existing.canvas : null
        };
      });
    };

    const commit = () => {
      history.past.push(snapshot());
      if (history.past.length > limit) history.past.shift();
      history.future.length = 0;
    };

    return {
      get layers() { return layers; },
      get canUndo() { return history.past.length > 0; },
      get canRedo() { return history.future.length > 0; },
      commit,
      addLayer(type, options) {
        const entry = options || {};
        if (!LAYER_TYPES.includes(type)) throw new Error(`Unknown mask layer type: ${type}`);
        commit();
        const layer = {
          id: `layer-${nextLayerId++}`,
          type,
          name: entry.name || TYPE_LABELS[type] || type,
          operation: OPERATIONS.includes(entry.operation) ? entry.operation : 'add',
          invert: !!entry.invert,
          visible: entry.visible !== false,
          params: {...defaultParams(type), ...(entry.params || {})},
          raster: entry.raster || null,
          canvas: entry.canvas || null
        };
        layers.push(layer);
        return layer;
      },
      removeLayer(id) {
        const index = layers.findIndex(layer => layer.id === id);
        if (index < 0) return false;
        commit();
        layers.splice(index, 1);
        return true;
      },
      updateLayer(id, updates) {
        const layer = layers.find(entry => entry.id === id);
        if (!layer) return null;
        const patch = updates || {};
        const touches = ['operation', 'invert', 'visible', 'name', 'params'].some(key => key in patch);
        const structural = ['operation', 'invert', 'visible', 'name'].some(key => key in patch);
        if (structural) commit();
        if (touches) {
          if (patch.params) layer.params = {...layer.params, ...patch.params};
          if (typeof patch.operation === 'string' && OPERATIONS.includes(patch.operation)) layer.operation = patch.operation;
          if (typeof patch.invert === 'boolean') layer.invert = patch.invert;
          if (typeof patch.visible === 'boolean') layer.visible = patch.visible;
          if (typeof patch.name === 'string' && patch.name) layer.name = patch.name;
        }
        return layer;
      },
      setLayerRaster(id, data, width, height) {
        const layer = layers.find(entry => entry.id === id);
        if (!layer) return false;
        layer.raster = {data, width, height};
        return true;
      },
      moveLayer(id, delta) {
        const index = layers.findIndex(layer => layer.id === id);
        const target = index + (delta || 0);
        if (index < 0 || target < 0 || target >= layers.length) return false;
        commit();
        const [layer] = layers.splice(index, 1);
        layers.splice(target, 0, layer);
        return true;
      },
      undo() {
        if (!history.past.length) return false;
        history.future.push(snapshot());
        restore(history.past.pop());
        return true;
      },
      redo() {
        if (!history.future.length) return false;
        history.past.push(snapshot());
        restore(history.future.pop());
        return true;
      },
      clear() {
        if (!layers.length) return false;
        commit();
        layers = [];
        return true;
      },
      serialize() {
        return {
          version: 1,
          layers: layers.map(layer => ({
            id: layer.id, type: layer.type, name: layer.name, operation: layer.operation,
            invert: !!layer.invert, visible: layer.visible !== false, params: {...(layer.params || {})}
          }))
        };
      },
      restore(json) { restore(json); return layers; },
      composite(width, height, source) { return compositeLayers(layers, width, height, source); }
    };
  }

  return {
    OPERATIONS, LAYER_TYPES, TYPE_LABELS,
    createAlpha, mergeAlpha, invertAlpha, boxBlur, boxBlurFloat, blurMask, smoothMask, expandContract,
    guidedFilter, linearGradientMask, radialGradientMask, luminanceRangeMask, colorRangeMask,
    resizeMask, softmaxRow, multiclassForeground, edgeForegroundEstimate,
    layerAlpha, compositeLayers, defaultParams, createStack
  };
});
