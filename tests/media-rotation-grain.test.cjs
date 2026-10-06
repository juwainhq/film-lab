const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const composite = script.slice(script.indexOf('const fsComposite='), script.indexOf('function compile('));

test('grain exposes randomized, per-media particles with Lightroom-style amount, size and roughness', () => {
  assert.match(html, /Film Grain/);
  assert.match(html, /class="subLabel">Amount <span>grain strength<\/span>/);
  assert.match(html, /Size <span>fine → coarse<\/span>/);
  assert.match(html, /Roughness <span>uniform → irregular<\/span>/);
  assert.match(html, /id="randomizeGrainBtn"/);
  assert.match(script, /function randomGrainSeed\(\)/);
  assert.match(script, /rotation:0,grainSeed:randomGrainSeed\(\)/);
  assert.match(composite, /uniform float u_grainSeed/);
  assert.match(composite, /float grainHash\(vec2 p,float seed\)/);
  assert.match(composite, /float grainValueNoise\(vec2 p,float seed\)/);
  assert.match(composite, /grainValueNoise\(grainCoord\*0\.5\+vec2\(13\.7,31\.9\)/);
  assert.match(composite, /grainValueNoise\(grainCoord\*0\.25\+vec2\(47\.2,7\.3\)/);
  assert.match(composite, /float roughness=clamp\(u_grainRough,0\.0,1\.0\)/);
  assert.match(composite, /grainCoord=\(v_texCoord\*u_resolution\)\/size/);
  assert.match(composite, /float lumaMask=1\.0-abs\(grainLuma\*2\.0-1\.0\)\*lumaCurve/);
  assert.match(composite, /frameIndex=floor\(u_time\*240\.0\)/);
  assert.match(composite, /redGrain[\s\S]*?greenGrain[\s\S]*?blueGrain/);
  assert.match(composite, /frameSeed\+109\.7/);
  assert.match(composite, /frameSeed\+233\.9/);
  assert.match(composite, /frameSeed\+419\.3/);
  assert.match(composite, /vec3\(redGrain\*0\.88,greenGrain,blueGrain\*1\.28\)/);
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
  assert.match(composite, /frameIndex=floor\(u_time\*240\.0\)/);
  assert.match(script, /currentPhoto\?\.grainSeed/);
});
