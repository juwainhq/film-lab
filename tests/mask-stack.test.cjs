const {test} = require('node:test');
const assert = require('node:assert/strict');

const stack = require('../mask-stack.js');

const flat = (value, width, height) => {
  const mask = new Uint8ClampedArray(width * height);
  if (value) mask.fill(value);
  return mask;
};

test('layer operations add, subtract and intersect stay in 0..255', () => {
  const base = new Uint8ClampedArray([0, 64, 128, 255]);
  const layer = new Uint8ClampedArray([255, 64, 0, 128]);

  const added = stack.mergeAlpha(base, layer, 'add');
  assert.deepEqual([...added], [255, 112, 128, 255]); // union, never clipping past 255
  for (const value of added) assert.ok(value >= 0 && value <= 255);

  const subtracted = stack.mergeAlpha(base, layer, 'subtract');
  assert.deepEqual([...subtracted], [0, 48, 128, 127]);

  const intersected = stack.mergeAlpha(base, layer, 'intersect');
  assert.deepEqual([...intersected], [0, 16, 0, 128]);

  const inverted = stack.invertAlpha(new Uint8ClampedArray([0, 128, 255]));
  assert.deepEqual([...inverted], [255, 127, 0]);
});

test('the stack honours visibility, invert and the layer order', () => {
  const instance = stack.createStack();
  const subject = instance.addLayer('subject', {raster: {data: flat(255, 4, 4), width: 4, height: 4}});
  assert.ok(subject.id.startsWith('layer-'));
  assert.equal(instance.layers.length, 1);

  let composite = instance.composite(4, 4);
  assert.deepEqual([...composite], new Array(16).fill(255));

  instance.updateLayer(subject.id, {visible: false});
  assert.deepEqual([...instance.composite(4, 4)], new Array(16).fill(0));

  instance.updateLayer(subject.id, {visible: true, invert: true});
  assert.deepEqual([...instance.composite(4, 4)], new Array(16).fill(0));
  instance.updateLayer(subject.id, {invert: false});

  const hole = instance.addLayer('brush', {operation: 'subtract', raster: {data: flat(255, 4, 4), width: 4, height: 4}});
  assert.deepEqual([...instance.composite(4, 4)], new Array(16).fill(0));
  assert.equal(hole.operation, 'subtract');

  instance.updateLayer(hole.id, {operation: 'intersect'});
  assert.deepEqual([...instance.composite(4, 4)], new Array(16).fill(255));

  // A background layer is the inverted subject raster.
  instance.clear();
  instance.addLayer('background', {raster: {data: flat(255, 4, 4), width: 4, height: 4}});
  assert.deepEqual([...instance.composite(4, 4)], new Array(16).fill(0));
  instance.addLayer('brush', {raster: {data: flat(255, 4, 4), width: 4, height: 4}});
  assert.deepEqual([...instance.composite(4, 4)], new Array(16).fill(255));
});

test('undo and redo cover layer actions, including delete and reorder', () => {
  const instance = stack.createStack();
  const first = instance.addLayer('subject', {raster: {data: flat(200, 4, 4), width: 4, height: 4}});
  const second = instance.addLayer('linear', {operation: 'subtract'});
  assert.equal(instance.layers.length, 2);

  assert.equal(instance.undo(), true); // undo the second layer
  assert.equal(instance.layers.length, 1);
  assert.equal(instance.redo(), true);
  assert.equal(instance.layers.length, 2);
  assert.equal(instance.layers[1].type, 'linear');

  instance.updateLayer(first.id, {operation: 'intersect'});
  assert.equal(instance.layers[0].operation, 'intersect');
  instance.undo();
  assert.equal(instance.layers[0].operation, 'add');
  instance.redo();
  assert.equal(instance.layers[0].operation, 'intersect');
  instance.updateLayer(first.id, {operation: 'add'});

  instance.moveLayer(first.id, 1);
  assert.equal(instance.layers[1].id, first.id);
  instance.undo();
  assert.equal(instance.layers[0].id, first.id);

  instance.removeLayer(second.id);
  assert.equal(instance.layers.length, 1);
  instance.undo();
  assert.equal(instance.layers.length, 2);
  assert.equal(instance.canRedo, true);

  // Undo keeps working after a raster is attached (rasters never enter the JSON history).
  instance.setLayerRaster(first.id, flat(128, 4, 4), 4, 4); // attaching a raster is not a history step
  instance.undo(); // one more step back: the reorder is reverted
  assert.equal(instance.layers.length, 2);
  assert.equal(instance.layers[0].id, first.id, 'undo walks back through the reorder');
  instance.redo();
  assert.equal(instance.layers.length, 2);
  assert.equal(instance.layers[0].id, first.id, 'redo returns to the state the undo left');
  instance.redo(); // replay the delete
  assert.equal(instance.layers.length, 1);
  assert.equal(instance.layers[0].id, first.id, 'redo replays the delete');
  const restored = instance.layers.find(layer => layer.id === first.id);
  assert.ok(restored.raster, 'the raster survives undo/redo');
  assert.equal(restored.raster.width, 4);
  assert.equal(instance.updateLayer('missing-layer', {invert: true}), null, 'unknown layers are ignored');
});

test('linear gradient masks ramp between the two handles with a smooth feather', () => {
  const width = 64, height = 64;
  const mask = stack.linearGradientMask(width, height, {x1: 0.5, y1: 0, x2: 0.5, y2: 1, feather: 0.4});
  assert.equal(mask.length, width * height);
  const top = mask[0], bottom = mask[(height - 1) * width];
  assert.ok(top < 12, `top row stays near 0, got ${top}`);
  assert.ok(bottom > 243, `bottom row reaches 255, got ${bottom}`);
  // Monotonic down the middle column, and the ramp really is gradual.
  let previous = -1, midValues = 0;
  for (let y = 0; y < height; y++) {
    const value = mask[y * width + 32];
    assert.ok(value >= previous, 'the gradient never goes backwards');
    if (value > 20 && value < 235) midValues++;
    previous = value;
  }
  assert.ok(midValues >= 8, `expected a soft ramp, got ${midValues} mid values`);
  const flipped = stack.linearGradientMask(width, height, {x1: 0.5, y1: 0, x2: 0.5, y2: 1, feather: 0.4, flip: true});
  assert.ok(flipped[0] > 243 && flipped[(height - 1) * width] < 12, 'flip reverses the ramp');
  for (const value of mask) assert.ok(value >= 0 && value <= 255);
});

test('radial gradient masks are centred, feathered and keep their handles', () => {
  const width = 80, height = 80;
  const mask = stack.radialGradientMask(width, height, {x: 0.5, y: 0.5, rx: 0.25, ry: 0.25, feather: 0.5});
  const centre = mask[40 * width + 40];
  const corner = mask[0];
  const edgeInside = mask[40 * width + Math.round((0.5 + 0.25 * 0.75) * width)]; // 75% out along rx
  assert.ok(centre > 245, `centre is selected, got ${centre}`);
  assert.ok(corner < 10, `corners stay out, got ${corner}`);
  assert.ok(edgeInside > 10 && edgeInside < 245, `the edge is feathered, got ${edgeInside}`);
  // An elongated, rotated ellipse must be wider than it is tall.
  const ellipse = stack.radialGradientMask(width, height, {x: 0.5, y: 0.5, rx: 0.4, ry: 0.12, feather: 0.3});
  assert.ok(ellipse[40 * width + 70] > ellipse[8 * width + 40], 'rx and ry are independent');
  const outside = stack.radialGradientMask(width, height, {x: 0.5, y: 0.5, rx: 0.25, ry: 0.25, feather: 0.5, outside: true});
  assert.ok(outside[0] > 245 && outside[40 * width + 40] < 10, 'outside inverts the selection');
});

test('luminance and colour range masks follow the photo pixels', () => {
  const width = 4, height = 1;
  const rgba = new Uint8ClampedArray([
    0, 0, 0, 255,       // black
    64, 64, 64, 255,    // dark grey
    200, 200, 200, 255, // light grey
    250, 10, 10, 255    // saturated red
  ]);
  const luminance = stack.luminanceRangeMask(rgba, width, height, {min: 120, max: 255, smoothness: 10});
  assert.ok(luminance[0] < 8 && luminance[1] < 8, 'dark pixels are excluded');
  assert.ok(luminance[2] > 247, 'light pixels are kept');
  assert.ok(luminance[3] < 8, 'a saturated mid-dark red reads as dark luma');
  const swapped = stack.luminanceRangeMask(rgba, width, height, {min: 255, max: 120, smoothness: 10});
  assert.deepEqual([...swapped], [...luminance], 'min above max is the same range, swapped');

  const color = stack.colorRangeMask(rgba, width, height, {r: 250, g: 10, b: 10, tolerance: 40, smoothness: 8});
  assert.ok(color[3] > 247, 'the sampled colour is selected');
  assert.ok(color[0] < 8 && color[1] < 8 && color[2] < 8, 'other colours stay out');
  const soft = stack.colorRangeMask(rgba, width, height, {r: 250, g: 10, b: 10, tolerance: 120, smoothness: 60});
  assert.ok(soft[2] > 0 && soft[2] < 255, 'a wide tolerance feathers the shoulder');
  for (const value of [...luminance, ...color, ...soft]) assert.ok(value >= 0 && value <= 255);
});

test('the guided filter keeps 0..255 and preserves a hard edge', () => {
  const width = 64, height = 64;
  const guide = new Uint8ClampedArray(width * height * 4);
  const mask = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x, pixel = index * 4;
      const left = x < width / 2;
      const value = left ? 20 : 235;
      guide[pixel] = guide[pixel + 1] = guide[pixel + 2] = value;
      guide[pixel + 3] = 255;
      // The mask is deliberately noisy around the same edge the photo has.
      mask[index] = left ? 20 + ((x + y) % 5) : 235 - ((x + y) % 5);
    }
  }
  const refined = stack.guidedFilter(mask, width, height, guide, 4, 0.7);
  assert.equal(refined.length, mask.length);
  for (const value of refined) assert.ok(value >= 0 && value <= 255, 'output stays in range');
  for (let i = 0; i < refined.length; i++) assert.ok(Number.isFinite(refined[i]), 'no NaN in the output');
  const leftMean = (() => {
    let sum = 0, count = 0;
    for (let y = 8; y < height - 8; y++) for (let x = 8; x < width / 2 - 6; x++) { sum += refined[y * width + x]; count++; }
    return sum / count;
  })();
  const rightMean = (() => {
    let sum = 0, count = 0;
    for (let y = 8; y < height - 8; y++) for (let x = width / 2 + 6; x < width - 8; x++) { sum += refined[y * width + x]; count++; }
    return sum / count;
  })();
  assert.ok(Math.abs(leftMean - 20) < 12, `flat regions stay flat on the left, got ${leftMean.toFixed(1)}`);
  assert.ok(Math.abs(rightMean - 235) < 12, `flat regions stay flat on the right, got ${rightMean.toFixed(1)}`);
  // The hard edge survives: the middle rows still jump across more than 180 levels in a few pixels.
  const row = 32;
  const leftEdge = refined[row * width + Math.floor(width / 2) - 3];
  const rightEdge = refined[row * width + Math.ceil(width / 2) + 3];
  assert.ok(rightEdge - leftEdge > 180, `the edge is preserved (${leftEdge} -> ${rightEdge})`);
});

test('smooth, expand and contract behave predictably', () => {
  const width = 32, height = 32;
  const mask = flat(0, width, height);
  for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) mask[y * width + x] = 255;

  const smoothed = stack.smoothMask(mask, width, height, 6);
  assert.ok(smoothed[12 * width + 1] < 8, 'far pixels stay empty');
  assert.ok(smoothed[16 * width + 6] > 0 && smoothed[16 * width + 6] < 255, 'the boundary is softened');

  const grown = stack.expandContract(mask, width, height, 4);
  assert.equal(grown[16 * width + 5], 255, 'expand grows the selection');
  assert.equal(grown[16 * width + 2], 0, 'expand stays local');
  const shrunk = stack.expandContract(mask, width, height, -4);
  assert.equal(shrunk[16 * width + 9], 0, 'contract trims the selection');
  assert.equal(shrunk[16 * width + 13], 255, 'the core survives');
  assert.deepEqual([...stack.expandContract(mask, width, height, 0)], [...mask]);
});

test('multiclass logits become a foreground confidence map', () => {
  // One pixel of background logits and one of hair: no softmax in the graph, so this
  // has to be handled here (that is how the vendored ONNX export ends).
  const output = new Float32Array([9, 1, 1, 1, 1, 1, 1, 9, 1, 1, 1, 1]);
  const confidence = stack.multiclassForeground(output, 2, 1, 6);
  assert.ok(confidence[0] < 0.01, `background pixel stays out, got ${confidence[0]}`);
  assert.ok(confidence[1] > 0.99, `hair pixel is selected, got ${confidence[1]}`);
  const probabilities = new Float32Array([0.9, 0.02, 0.02, 0.02, 0.02, 0.02, 0.2, 0.5, 0.1, 0.1, 0.1, 0]);
  const direct = stack.multiclassForeground(probabilities, 2, 1, 6, {probabilities: true});
  assert.ok(Math.abs(direct[0] - 0.1) < 0.02, `1 - P(background) is used as-is, got ${direct[0]}`);
  assert.ok(Math.abs(direct[1] - 0.8) < 0.02, `1 - P(background) for the second pixel, got ${direct[1]}`);
  const personOnly = stack.multiclassForeground(probabilities, 2, 1, 6, {probabilities: true, foregroundClasses: [1, 2, 3, 4, 5]});
  assert.ok(Math.abs(personOnly[1] - 0.8) < 0.02 && Math.abs(personOnly[0] - 0.1) < 0.02, 'person classes can be summed explicitly');
});

test('edge colour estimation removes a dark halo from semi-transparent pixels', () => {
  const width = 16, height = 4;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const alpha = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x, pixel = index * 4;
      // Subject colour is light grey; the "photo" pixels near the cutout are letterboxed
      // against a black background, which is exactly what produces a dark halo.
      const solid = x >= 8;
      rgba[pixel] = rgba[pixel + 1] = rgba[pixel + 2] = solid ? 200 : 10;
      rgba[pixel + 3] = 255;
      alpha[index] = solid ? 255 : x === 7 ? 128 : 0;
    }
  }
  const cleaned = stack.edgeForegroundEstimate(rgba, width, height, alpha, 2);
  const edge = (1 * width + 7) * 4;
  assert.ok(cleaned[edge] > 150, `the halo is replaced with foreground colour, got ${cleaned[edge]}`);
  assert.equal(cleaned[0], rgba[0], 'fully transparent pixels are untouched');
  assert.equal(cleaned[(1 * width + 12) * 4], rgba[(1 * width + 12) * 4], 'solid pixels are untouched');
  for (const value of cleaned) assert.ok(value >= 0 && value <= 255);
});

test('resizeMask keeps the mask resolution-independent', () => {
  const source = flat(0, 4, 4);
  source[0] = 255; source[1] = 255; source[4] = 255; source[5] = 255;
  const scaled = stack.resizeMask(source, 4, 4, 8, 8);
  assert.equal(scaled.length, 64);
  assert.ok(scaled[0] > 200, 'the top-left block survives');
  assert.ok(scaled[63] < 40, 'the empty corner stays empty');
  assert.deepEqual([...stack.resizeMask(source, 4, 4, 4, 4)], [...source]);
});
