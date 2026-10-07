'use strict';

(function attachColorGrading(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FilmLabColorGrading = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createColorGradingCore() {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const sign = value => value < 0 ? -1 : value > 0 ? 1 : 0;

  // Fritsch–Carlson/PCHIP tangents make each spline interval monotone between
  // its control points, so a curve never creates a new overshoot or halo.
  function monotoneCurveSamples(inputPoints, sampleCount = 256) {
    const count = Math.max(2, Math.round(Number(sampleCount) || 256));
    const points = (Array.isArray(inputPoints) ? inputPoints : [])
      .map(point => ({
        x: clamp(Number.isFinite(Number(point?.x)) ? Number(point.x) : 0, 0, 1),
        y: clamp(Number.isFinite(Number(point?.y)) ? Number(point.y) : 0, 0, 1)
      }))
      .sort((a, b) => a.x - b.x);

    const unique = [];
    for (const point of points) {
      if (unique.length && point.x - unique[unique.length - 1].x < 1e-6) unique[unique.length - 1] = point;
      else unique.push(point);
    }
    if (!unique.length) unique.push({ x: 0, y: 0 }, { x: 1, y: 1 });
    if (unique[0].x > 0) unique.unshift({ x: 0, y: unique[0].y });
    if (unique[unique.length - 1].x < 1) unique.push({ x: 1, y: unique[unique.length - 1].y });
    if (unique.length === 1) unique.push({ x: 1, y: unique[0].y });

    const n = unique.length;
    const h = new Float64Array(n - 1);
    const delta = new Float64Array(n - 1);
    const slopes = new Float64Array(n);
    for (let i = 0; i < n - 1; i++) {
      h[i] = Math.max(1e-9, unique[i + 1].x - unique[i].x);
      delta[i] = (unique[i + 1].y - unique[i].y) / h[i];
    }

    if (n === 2) {
      slopes[0] = delta[0];
      slopes[1] = delta[0];
    } else {
      const first = ((2 * h[0] + h[1]) * delta[0] - h[0] * delta[1]) / (h[0] + h[1]);
      slopes[0] = sign(first) !== sign(delta[0]) ? 0 :
        sign(delta[0]) !== sign(delta[1]) && Math.abs(first) > Math.abs(3 * delta[0]) ? 3 * delta[0] : first;
      for (let i = 1; i < n - 1; i++) {
        if (sign(delta[i - 1]) === 0 || sign(delta[i]) === 0 || sign(delta[i - 1]) !== sign(delta[i])) {
          slopes[i] = 0;
        } else {
          const w1 = 2 * h[i] + h[i - 1];
          const w2 = h[i] + 2 * h[i - 1];
          slopes[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
        }
      }
      const last = ((2 * h[n - 2] + h[n - 3]) * delta[n - 2] - h[n - 2] * delta[n - 3]) / (h[n - 2] + h[n - 3]);
      slopes[n - 1] = sign(last) !== sign(delta[n - 2]) ? 0 :
        sign(delta[n - 2]) !== sign(delta[n - 3]) && Math.abs(last) > Math.abs(3 * delta[n - 2]) ? 3 * delta[n - 2] : last;
    }

    const result = new Uint8Array(count);
    let interval = 0;
    for (let index = 0; index < count; index++) {
      const x = index / (count - 1);
      while (interval < n - 2 && x > unique[interval + 1].x) interval++;
      const a = unique[interval], b = unique[interval + 1], width = h[interval];
      const t = clamp((x - a.x) / width, 0, 1), t2 = t * t, t3 = t2 * t;
      const value = (2 * t3 - 3 * t2 + 1) * a.y +
        (t3 - 2 * t2 + t) * width * slopes[interval] +
        (-2 * t3 + 3 * t2) * b.y +
        (t3 - t2) * width * slopes[interval + 1];
      const bounded = clamp(value, Math.min(a.y, b.y), Math.max(a.y, b.y));
      result[index] = Math.round(clamp(bounded, 0, 1) * 255);
    }
    return result;
  }

  function isIdentityCurve(inputPoints) {
    if (!Array.isArray(inputPoints) || inputPoints.length !== 2) return false;
    const first = inputPoints[0], last = inputPoints[1];
    return Math.abs(Number(first?.x)) < 1e-6 && Math.abs(Number(first?.y)) < 1e-6 &&
      Math.abs(Number(last?.x) - 1) < 1e-6 && Math.abs(Number(last?.y) - 1) < 1e-6;
  }

  function percentile(histogram, total, fraction) {
    if (!total) return 0;
    const target = Math.max(0, Math.min(total - 1, Math.floor((total - 1) * fraction)));
    let count = 0;
    for (let value = 0; value < histogram.length; value++) {
      count += histogram[value];
      if (count > target) return value / Math.max(1, histogram.length - 1);
    }
    return 1;
  }

  // Produces conservative Lightroom-style auto targets from a small RGBA
  // readback. The caller supplies a downscaled preview, never the full image.
  function autoAdjustFromPixels(pixels) {
    const histogram = new Uint32Array(256);
    const source = pixels && (pixels.data || pixels);
    if (!source || typeof source.length !== 'number') {
      return { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, percentiles: [0, 0, 0, 0] };
    }
    let total = 0;
    for (let offset = 0; offset + 3 < source.length; offset += 4) {
      if (source[offset + 3] === 0) continue;
      const luminance = Math.round(clamp(
        (0.2126 * source[offset] + 0.7152 * source[offset + 1] + 0.0722 * source[offset + 2]) / 255,
        0, 1
      ) * 255);
      histogram[luminance]++;
      total++;
    }
    if (!total) return { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, percentiles: [0, 0, 0, 0] };

    const p02 = percentile(histogram, total, 0.02);
    const p50 = percentile(histogram, total, 0.50);
    const p98 = percentile(histogram, total, 0.98);
    const p99 = percentile(histogram, total, 0.99);
    const exposure = clamp(Math.log2(0.46 / Math.max(0.035, p50)), -1.5, 1.5);
    const spread = Math.max(0.12, p98 - p02);
    const contrast = clamp((0.82 / spread - 1) * 55, -35, 35);
    const whites = clamp((0.95 - p99) * 150, -30, 30);
    const blacks = clamp((0.025 - p02) * 150, -30, 30);
    // Highlights and shadows reuse the same percentiles: bright pixels above 0.90 get recovered
    // (negative) and shadows below 0.10 get opened up (positive). Flat images therefore gain a
    // little shape instead of staying lifeless, exactly like the whites / blacks pair.
    const highlights = clamp((0.90 - p98) * 70, -20, 20);
    const shadows = clamp((0.10 - p02) * 70, -20, 20);
    return {
      exposure: Math.round(exposure / 0.05) * 0.05,
      contrast: Math.round(contrast),
      highlights: Math.round(highlights),
      shadows: Math.round(shadows),
      whites: Math.round(whites),
      blacks: Math.round(blacks),
      percentiles: [p02, p50, p98, p99]
    };
  }

  // === White balance =======================================================================
  // The shader multiplies linear light by exp2() channel gains:
  //   R = exp2( 0.38·t + 0.12·ti)   G = exp2(-0.40·ti)   B = exp2(-0.38·t + 0.12·ti)
  // where t = temperature/100 and ti = tint/100. Solving "make this sample neutral" therefore
  // means matching the R−G and B−G gain differences, which form a 2×2 linear system:
  //   R−G = 0.38t + 0.52ti      B−G = -0.38t + 0.52ti
  // Inverting it gives the temperature / tint pair below, in the same units as the sliders.
  const WB_R = 0.38, WB_TINT_SHARED = 0.12, WB_G = -0.40;
  function srgbToLinear(channel) {
    const value = clamp(Number(channel) || 0, 0, 1);
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }
  function whiteBalanceGains(temperature, tint) {
    const t = clamp(Number(temperature) || 0, -100, 100) / 100;
    const ti = clamp(Number(tint) || 0, -100, 100) / 100;
    return [
      Math.pow(2, WB_R * t + WB_TINT_SHARED * ti),
      Math.pow(2, WB_G * ti),
      Math.pow(2, -WB_R * t + WB_TINT_SHARED * ti)
    ];
  }
  const whiteBalanceExponents = (temperature, tint) => {
    const t = clamp(Number(temperature) || 0, -100, 100) / 100;
    const ti = clamp(Number(tint) || 0, -100, 100) / 100;
    return [WB_R * t + WB_TINT_SHARED * ti, WB_G * ti, -WB_R * t + WB_TINT_SHARED * ti];
  };
  // `sample` is the pixel that should read as neutral, in sRGB 0–255. `options.legacyTemperature`
  // is the Adjust-tab Temperature slider, which also applies neutral channel gains; its share is
  // subtracted so the Grade pair finishes the job instead of doubling it.
  function whiteBalanceFromSample(sample, options = {}) {
    const red = Number(sample?.r), green = Number(sample?.g), blue = Number(sample?.b);
    if (![red, green, blue].every(Number.isFinite)) {
      return {temperature: 0, tint: 0, usable: false, reason: 'no-sample', linear: [0, 0, 0]};
    }
    const linear = [srgbToLinear(red / 255), srgbToLinear(green / 255), srgbToLinear(blue / 255)];
    const clipped = linear.some(value => value < 0.0015) || linear.some(value => value > 0.97);
    if (clipped) return {temperature: 0, tint: 0, usable: false, reason: 'clipped', linear};
    // Channels are compared as log2 ratios, so a common exposure factor cancels out.
    const log = linear.map(value => Math.log2(value));
    const legacy = clamp(Number(options.legacyTemperature) || 0, -100, 100) / 100;
    const dRG = (log[1] - log[0]) - WB_R * legacy;
    const dBG = (log[1] - log[2]) + WB_R * legacy;
    const wantedTemperature = (dRG - dBG) / (2 * WB_R) * 100;
    const wantedTint = (dRG + dBG) / (2 * (WB_TINT_SHARED - WB_G)) * 100;
    const temperature = clamp(wantedTemperature, -100, 100);
    const tint = clamp(wantedTint, -100, 100);
    const saturated = Math.abs(wantedTemperature) > 100.5 || Math.abs(wantedTint) > 100.5;
    return {
      temperature: Math.round(temperature) + 0,
      tint: Math.round(tint) + 0,
      usable: true,
      saturated,
      reason: saturated ? 'clamped' : 'ok',
      linear,
    };
  }
  function isWhiteBalanced(sample, temperature, tint, tolerance = 0.02) {
    const linear = [srgbToLinear(Number(sample?.r) / 255), srgbToLinear(Number(sample?.g) / 255), srgbToLinear(Number(sample?.b) / 255)];
    const gains = whiteBalanceGains(temperature, tint);
    const balanced = linear.map((value, index) => value * gains[index]);
    const mean = balanced.reduce((sum, value) => sum + value, 0) / 3 || 1;
    return balanced.every(value => Math.abs(value - mean) / mean <= tolerance);
  }

  function parseCubeLut(sourceText) {
    if (typeof sourceText !== 'string' || sourceText.length > 8 * 1024 * 1024) throw new Error('LUT file is empty or too large');
    let size = 0;
    const domainMin = [0, 0, 0], domainMax = [1, 1, 1], values = [];
    const text = sourceText.replace(/^\uFEFF/, '');
    for (const lineMatch of text.matchAll(/[^\r\n]+/g)) {
      const line = lineMatch[0].split('#', 1)[0].trim();
      if (!line) continue;
      if (/^TITLE\b/i.test(line)) continue;
      if (/^LUT_1D_SIZE\b/i.test(line)) throw new Error('1D .cube LUTs are not supported; choose a 3D LUT');
      let match = line.match(/^LUT_3D_SIZE\s+(\d+)$/i);
      if (match) {
        if (size) throw new Error('The .cube file has more than one LUT_3D_SIZE declaration');
        size = Number(match[1]);
        continue;
      }
      match = line.match(/^DOMAIN_(MIN|MAX)\s+(.+)$/i);
      if (match) {
        const components = match[2].trim().split(/\s+/).map(Number);
        if (components.length !== 3 || components.some(value => !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))) throw new Error(`Invalid DOMAIN_${match[1].toUpperCase()} values`);
        (match[1].toUpperCase() === 'MIN' ? domainMin : domainMax).splice(0, 3, ...components);
        continue;
      }
      const components = line.split(/\s+/).map(Number);
      if (components.length < 3 || components.length > 4 || components.some(value => !Number.isFinite(value))) {
        throw new Error(`Unrecognized or non-finite .cube data: ${line.slice(0, 80)}`);
      }
      for (let channel = 0; channel < 3; channel++) values.push(Math.round(clamp(components[channel], 0, 1) * 255));
    }
    if (![17, 33, 64].includes(size)) throw new Error('Only 17³, 33³, or 64³ 3D LUTs are supported');
    if (domainMin.some((value, index) => !(domainMax[index] > value) || !Number.isFinite(Math.fround(domainMax[index] - value)))) throw new Error('DOMAIN_MAX must be greater than DOMAIN_MIN for every channel and stay within the supported numeric range');
    const expected = size * size * size;
    if (values.length !== expected * 3) throw new Error(`Expected ${expected} RGB entries for a ${size}³ LUT, found ${values.length / 3}`);
    const data = new Uint8Array(expected * 4);
    for (let index = 0; index < expected; index++) {
      const valueOffset = index * 3, dataOffset = index * 4;
      data[dataOffset] = values[valueOffset];
      data[dataOffset + 1] = values[valueOffset + 1];
      data[dataOffset + 2] = values[valueOffset + 2];
      data[dataOffset + 3] = 255;
    }
    return {size, data, domainMin: new Float32Array(domainMin), domainMax: new Float32Array(domainMax)};
  }

  return Object.freeze({ monotoneCurveSamples, isIdentityCurve, autoAdjustFromPixels, whiteBalanceGains, whiteBalanceFromSample, isWhiteBalanced, parseCubeLut });
});
