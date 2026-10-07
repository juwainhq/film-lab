const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const composite = script.slice(script.indexOf('const fsComposite='), script.indexOf('function compile('));
// The shader comments explain the old grain implementation by name, so the source checks below
// read the executable text only.
const compositeCode = composite.replace(/\/\*[\s\S]*?\*\//g, '');

test('grain exposes randomized, per-media particles with Lightroom-style amount, size and roughness', () => {
  assert.match(html, /Film Grain/);
  assert.match(html, /class="subLabel">Amount <span>grain strength<\/span>/);
  assert.match(html, /Size <span>fine → coarse<\/span>/);
  assert.match(html, /Roughness <span>uniform → irregular<\/span>/);
  assert.match(html, /id="randomizeGrainBtn"/);
  assert.match(script, /function randomGrainSeed\(\)/);
  assert.match(script, /rotation:0,grainSeed:randomGrainSeed\(\)/);
  assert.match(composite, /uniform float u_grainSeed/);
  // Grain is white noise from a 32-bit integer hash, never a float-multiply hash: the old
  // fract(p*vec2(123.34,345.45)) form lost precision at large coordinates and repeated in bands.
  assert.match(composite, /uint grainHash\(uint value\)/);
  assert.match(composite, /value=value\*747796405u\+2891336453u/);
  assert.doesNotMatch(compositeCode, /float grainHash\(vec2/);
  assert.doesNotMatch(compositeCode, /fract\(p\*vec2\(123\.34,345\.45\)/);
  // Grain is sampled on a jittered cell grid and blended with a Gaussian kernel, so grains are
  // round and soft and no lattice line can show.
  assert.match(composite, /vec3 grainFields\(vec2 point,float sigma,uint seed,bool chroma\)/);
  assert.match(composite, /vec2 centre=index\+vec2\(float\(word&0xffffu\),float\(\(word>>16u\)&0xffffu\)\)/);
  assert.match(composite, /float influence=exp\(-dot\(delta,delta\)\/\(2\.0\*sigma\*sigma\)\)/);
  assert.match(composite, /float grainClump\(vec2 point,float sigma,uint seed\)/);
  assert.match(composite, /float roughness=clamp\(u_grainRough,0\.0,1\.0\)/);
  assert.match(composite, /float envelope=mix\(1\.0,0\.62\+0\.76\*clump,roughness\)/);
  // Size is a cell size in output pixels, so the preview and the full-resolution export agree.
  assert.match(composite, /float cellPixels=1\.0\+clamp\(u_grainSize-0\.2,0\.0,1\.3\)\*6\.2/);
  assert.match(composite, /vec2 grainPoint=\(v_texCoord\*u_resolution\)\/cellPixels/);
  // Grain peaks in the midtones and fades smoothly into the shadows and the highlights.
  assert.match(composite, /float midTone=clamp\(4\.0\*grainLuma\*\(1\.0-grainLuma\),0\.0,1\.0\)/);
  assert.match(composite, /float tone=mix\(1\.0,0\.15\+0\.85\*midTone,clamp\(u_grainLuma,0\.0,1\.0\)\)/);
  assert.match(composite, /float frameIndex=max\(floor\(u_time\*grainSteps\),0\.0\)/);
  // Colour grain is a decorrelated chroma offset on top of the monochrome field.
  assert.match(composite, /if\(chroma\) grain\+=\(fields-vec3\(dot\(fields,vec3\(0\.2126,0\.7152,0\.0722\)\)\)\)/);
  assert.match(composite, /grainUniform\(key,seed,0x3u\)/);
  assert.match(composite, /grainUniform\(key,seed,0x5u\)/);
  assert.match(script, /'u_grainSeed'\),isVideo \? videoGrainSeed : \(currentPhoto\?\.grainSeed\?\?1\)/);
  assert.match(script, /if\(isVideo\) videoGrainSeed=seed;[\s\S]*?currentPhoto\.grainSeed=seed/);
});

test('rotation controls change photo pixels and video frame pixels, not just preview styling', () => {
  assert.match(html, /id="rotateMediaBtn" aria-label="Rotate media 90 degrees clockwise"/);
  assert.match(script, /function rotateCanvas\(source,width,height,degrees\)/);
  assert.match(script, /ctx\.drawImage\(source,-width\/2,-height\/2,width,height\)/);
  assert.match(script, /const straightened=applyStraightenToSource\(rotateCanvas\(baseSource,baseW,baseH,rotation\),w,h,item\.straighten\)/);
  assert.match(script, /const source=applyHealToSource\(straightened,w,h,item\.healStrokes\)/);
  assert.match(script, /function applyStraightenToSource\(source,width,height,angle\)/);
  assert.match(script, /videoFrameContext\.drawImage\(videoEl,-sourceW\/2,-sourceH\/2,sourceW,sourceH\)/);
  // Round 7 shares one rotate helper for the preview controls and the new geometry row, so both
  // directions go through the same quarter-turn value while the pixels are rebuilt the same way.
  assert.match(script, /function rotateActiveMedia\(direction=90\)/);
  assert.match(script, /videoRotation=\(videoRotation\+quarter\)%360/);
  assert.match(script, /item\.rotation=\(\(item\.rotation\|\|0\)\+quarter\)%360/);
  assert.match(script, /item\.mask && rotatePhotoMask\(item\.mask,quarter\)/);
  assert.match(script, /item\.healStrokes=photoHealStrokes\(item\)\.map\(point=>\(\{\.\.\.point,\.\.\.rotateNormalizedPoint\(point,quarter\)\}\)\)/);
  assert.match(script, /useWebCodecs=videoRotation===0/);
  assert.match(script, /else uploadVideoTexture\(\)/);
  assert.match(script, /function makeExportCanvas\([\s\S]*?social\.cropRect\(canvas\.width,canvas\.height/);
});

test('photo grain stays fixed at a nonzero Speed while video alone receives time motion', () => {
  assert.match(script, /'u_grainSpeed'\),isVideo \? params\.grainSpeed : 0/);
  // The grain's frame index comes from u_time, which a photo never advances, so a photo's grain is
  // one stable field however the Speed slider is set.
  assert.match(composite, /float frameIndex=max\(floor\(u_time\*grainSteps\),0\.0\)/);
  assert.match(script, /'u_time'\),isVideo \? \(timeMs\?\?performance\.now\(\)\)\*0\.001 : 0/);
  assert.match(script, /currentPhoto\?\.grainSeed/);
});
