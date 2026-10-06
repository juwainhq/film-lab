const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync, statSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const styles = html.split('<style>')[1].split('</style>')[0];
const script = html.split('<script>')[1].split('</script>')[0];
const composite = script.match(/const fsComposite=`([\s\S]*?)`;/)[1];
const ditherShader = script.match(/const fsDither=`([\s\S]*?)`;/)[1];
const diffusionHelper = script.slice(script.indexOf('function errorDiffusionPixels('),script.indexOf('\nfunction floydStateKey'));

test('Dither has signed intensity, two explicit photo scopes, on/off, and advanced controls', () => {
  assert.match(html, /data-group="dither"[\s\S]*?aria-controls="ditherControls"/);
  assert.match(html, /class="effectToggle" data-toggle="dither" role="switch" aria-checked="true"/);
  for (const name of ['Dither','DitherSteps','DitherSize','DitherBrush']) {
    assert.match(html,new RegExp(`id="slider${name}" min="-100" max="100" value="0"`));
    assert.match(html,new RegExp(`id="val${name}">0<`));
  }
  assert.match(html, /role="radiogroup" aria-label="Dither area"/);
  assert.match(html, /name="ditherScope" value="full" checked/);
  assert.match(html, /name="ditherScope" value="background"/);
  assert.match(html, /id="ditherMaskTools" hidden/);
  assert.match(styles, /\.ditherMaskTools\[hidden\] \{ display: none; \}/);
  assert.match(script, /\['Bloom','Hall','Grain','Dither','Sharp'\]\.forEach/);
  assert.match(script, /params\.dither=Number\(sliders\.Dither\.value\)\/100/);
});

test('Dither uses an independent post-composite pass with all requested modes and mask-aware output', () => {
  assert.doesNotMatch(composite,/u_dither|orderedDither/); // dither is no longer folded into color grading
  assert.match(script,/const progDither=createProgram\(vsSrc, fsDither\)/);
  assert.match(script,/gl\.bindFramebuffer\(gl\.FRAMEBUFFER,fboComposite\.fbo\);[\s\S]*?const backgroundOnly=ditherScope/);
  assert.match(script,/renderDitherPass\(timeMs,ditherStrength,backgroundOnly\)/);
  assert.match(script,/function renderDitherPass\(timeMs,strength,backgroundOnly\)\{\s*if\(typeof isVideo!==\x27undefined\x27&&isVideo\)strength=0;/);
  for (const uniform of ['u_image','u_original','u_subjectMask','u_floydResult','u_strength','u_algorithm','u_colorMode','u_paletteSize','u_downscale','u_threshold','u_dotSize','u_angle']) {
    assert.match(ditherShader,new RegExp(`uniform [^;]*\\b${uniform}\\b`),`${uniform} declared`);
  }
  assert.match(ditherShader,/float bayerRank\(ivec2 pixel,int side\)/);
  assert.match(ditherShader,/int bits=side==4\?2:3/);
  assert.match(ditherShader,/float rank=u_algorithm==1\?bayerRank\(ivec2\(lowPixel\),4\):u_algorithm==2\?bayerRank\(ivec2\(lowPixel\),8\):0\.0/);
  assert.match(ditherShader,/vec2 sampleUV=clamp\(\(lowPixel\+vec2\(0\.5\)\)\*factor\/u_resolution/);
  assert.match(ditherShader,/float area=u_backgroundOnly==1\?1\.0-smoothstep\(0\.05,0\.95,texture\(u_subjectMask,sampleUV\)\.r\):1\.0/);
  assert.match(ditherShader,/if\(u_splitPreview==1 && v_texCoord\.x<u_splitPosition\)\{ outColor=texture\(u_original,v_texCoord\); return; \}/);
  assert.match(ditherShader,/outColor=vec4\(mix\(source,printed,amount\*area\),fullSource\.a\)/);
  assert.match(script,/gl\.activeTexture\(gl\.TEXTURE2\); gl\.bindTexture\(gl\.TEXTURE_2D,subjectMaskTexture\)/);
  assert.match(script,/const subjectProtected=!!autoSubjectMask \|\| maskStrokes\.some\(s=>s\.mode==='protect'\)/);
  assert.match(script,/const backgroundOnly=ditherScope==='background' && !isVideo/);
  assert.match(script,/if\(showOriginal\)\{[\s\S]*?progPassthrough/);
});

test('Error-diffusion variants use their kernels and preserve Floyd–Steinberg diffusion at the selected lower resolution', () => {
  const state=vm.createContext({});
  vm.runInContext(`${diffusionHelper}\nthis.diffuse=errorDiffusionPixels;`,state);
  const source=new Uint8Array([128,128,128,255,128,128,128,255]);
  const normal=state.diffuse(source,2,1,{downscale:1,paletteSize:2,steps:12,spread:1,colorMode:'monochrome'});
  assert.equal(normal.width,2); assert.equal(normal.height,1);
  assert.deepEqual(Array.from(normal.pixels),[255,255,255,255,0,0,0,255]); // 7/16 error changes the next pixel
  const noSpread=state.diffuse(source,2,1,{downscale:1,paletteSize:2,steps:12,spread:0,colorMode:'monochrome'});
  assert.deepEqual(Array.from(noSpread.pixels),[255,255,255,255,255,255,255,255]);
  const coarse=state.diffuse(new Uint8Array(4*4*4).fill(128),4,4,{downscale:2,paletteSize:4,steps:12,spread:1,colorMode:'color'});
  assert.equal(coarse.width,2); assert.equal(coarse.height,2); assert.equal(coarse.pixels.length,16);
  assert.match(diffusionHelper,/'floyd-steinberg':\{denominator:16,taps:\[\[1,0,7\],\[-1,1,3\],\[0,1,5\],\[1,1,1\]\]\}/);
  for(const [name,denominator] of [['stucki',42],['burkes',32],['atkinson',8],['jarvis-judice-ninke',48],['sierra',32],['two-row-sierra',16]]){
    const key=`${name.includes('-')?`'${name}'`:name}:{denominator:${denominator},taps:`;
    assert.ok(diffusionHelper.includes(key),name);
  }
  assert.match(diffusionHelper,/const serpentine=algorithm==='floyd-steinberg-serpentine'/);
  assert.match(diffusionHelper,/const direction=serpentine && y%2===1\?-1:1/);
  assert.match(diffusionHelper,/thresholdShift=/);
  const fixture=new Uint8Array(11*7*4);
  for(let i=0;i<77;i++){const value=(i*37+i*i*13)%256;fixture.set([value,value,value,255],i*4);}
  const algorithms=['floyd-steinberg','floyd-steinberg-serpentine','stucki','burkes','atkinson','jarvis-judice-ninke','sierra','two-row-sierra'];
  const results=algorithms.map(algorithm=>Array.from(state.diffuse(fixture,11,7,{algorithm,paletteSize:2,steps:12,spread:1,colorMode:'monochrome'}).pixels).join(','));
  assert.ok(new Set(results).size>=6,'each selectable diffusion family should produce its own characteristic texture');
});

test('ordered, halftone and quantize-only modes honor palette and downscale controls', () => {
  assert.match(html,/optgroup label="Error diffusion"/);
  for(const name of ['floyd-steinberg','floyd-steinberg-serpentine','stucki','burkes','atkinson','jarvis-judice-ninke','sierra','two-row-sierra']) assert.match(html,new RegExp(`option value="${name}"`));
  assert.match(html,/optgroup label="Ordered \/ Bayer"/);
  assert.match(html,/optgroup label="Halftone"/);
  assert.match(html,/option value="halftone4">Halftone 4×4/);
  assert.match(html,/option value="halftone8">Halftone 8×8/);
  assert.match(html,/option value="bayer4" selected>Bayer 4×4/);
  assert.match(html,/option value="bayer8">Bayer 8×8/);
  assert.match(html,/option value="halftone">Halftone/);
  assert.match(html,/option value="none">None · quantize only/);
  assert.match(html,/id="ditherDownscale"[\s\S]*?option value="8">8×/);
  for(const mode of ['monochrome','duotone','color','custom']) assert.match(html,new RegExp(`option value="${mode}"`));
  for(const size of [2,4,8,16,32]) assert.match(html,new RegExp(`option value="${size}"(?: selected)?>${size} colors`));
  assert.match(html,/id="sliderDitherThreshold" min="-100" max="100" value="0"/);
  assert.match(html,/id="sliderDitherSpread" min="-100" max="100" value="0"/);
  assert.match(html,/id="sliderDitherSize" min="-100" max="100" value="0"/);
  assert.match(html,/id="sliderDitherAngle" min="-100" max="100" value="0"/);
  assert.match(ditherShader,/float pitch=u_algorithm==5\?4\.0:u_algorithm==6\?8\.0:max\(4\.0,u_dotSize\*4\.0\)/);
  assert.match(ditherShader,/float radius=0\.5\*pitch\*sqrt\(1\.0-luma\)/);
  assert.match(ditherShader,/float coverage=1\.0-smoothstep\(radius-edge,radius\+edge,length\(local\)\)/);
  assert.match(ditherShader,/vec3 paper=colorMode==1\?u_duotoneHighlight:colorMode==3\?u_customHighlight:vec3\(1\.0\)/);
  assert.match(ditherShader,/float rank=u_algorithm==1\?bayerRank[\s\S]*?:0\.0/); // None has a zero threshold rank
  assert.match(script,/algorithms=\{'floyd-steinberg':0,'floyd-steinberg-serpentine':0,stucki:0,burkes:0,atkinson:0,'jarvis-judice-ninke':0,sierra:0,'two-row-sierra':0,bayer4:1,bayer8:2,halftone:3,none:4,halftone4:5,halftone8:6\}/);
  assert.match(script,/updateDitherControlVisibility\(\)/);
  assert.match(script,/floydSpreadRow'\)\.hidden=!\['floyd-steinberg','floyd-steinberg-serpentine','stucki','burkes','atkinson','jarvis-judice-ninke','sierra','two-row-sierra'\]\.includes\(algorithm\)/);
  assert.match(script,/ditherThresholdRow'\)\.hidden=algorithm==='none'/);
  assert.match(script,/halftoneControls'\)\.hidden=!\['halftone','halftone4','halftone8'\]\.includes\(algorithm\)/);
});

test('Dither settings and normalized mask edits invalidate cached diffusion results', () => {
  assert.match(script,/subjectMaskRevision\+\+/);
  assert.match(script,/ditherScope,subjectMaskRevision/);
  assert.match(script,/const key=floydStateKey\(timeMs,dither,backgroundOnly,strength\)/);
  assert.match(script,/if\(key===floydLastKey\) return/);
  assert.match(script,/function ditherOptionsChanged\(\)[\s\S]*?floydLastKey=null/);
  assert.match(script,/function userChangedSliders\(\)[\s\S]*?floydLastKey=null/);
  assert.match(script,/if\(maskUploadFrame\) uploadSubjectMask\(\)/);
  assert.match(script,/setDitherSettings\(data\.dither\)/);
  assert.match(script,/dither:getDitherSettings\(\)/);
  assert.match(script,/dither:getDitherSettings\(\)\}\); saveCustom\(\)/);
});

test('automatic person protection is local, lazy, and stale inference cannot overwrite a new photo', () => {
  const dir=resolve(__dirname, '../vendor/mediapipe-selfie');
  for(const file of ['selfie_segmentation.js','selfie_segmentation.tflite','selfie_segmentation.binarypb','selfie_segmentation_solution_simd_wasm_bin.js','selfie_segmentation_solution_simd_wasm_bin.wasm','selfie_segmentation_solution_wasm_bin.js','selfie_segmentation_solution_wasm_bin.wasm']) {
    assert.ok(statSync(resolve(dir,file)).size>0,file);
  }
  assert.match(readFileSync(resolve(dir,'LICENSE'),'utf8'),/Apache License[\s\S]*?Version 2\.0/);
  assert.match(script, /script\.src='vendor\/mediapipe-selfie\/selfie_segmentation\.js'/);
  assert.match(script, /new window\.SelfieSegmentation\(\{locateFile:file=>base\+file\}\)/);
  assert.match(script, /if\(activeMaskRequest!==maskRequestId \|\| !maskCanvas \|\| !results\.segmentationMask\) return/);
  assert.match(script, /if\(token!==maskRequestId \|\| photo!==photoForMask\) return/);
  assert.match(script, /maskStrokes=\[\]; maskStroke=null; maskPaintMode=null; autoSubjectMask=null;/);
  assert.match(script, /if\(autoSubjectMask\) maskCtx\.drawImage\(autoSubjectMask/);
  assert.match(script, /if\(forVideo\)\{ maskCanvas=null; maskCtx=null; photoForMask=null; backgroundScope\.disabled=true; \}/);
  assert.match(script, /else if\(maskCanvas\)\{ maskCtx\.fillStyle='#000'; maskCtx\.fillRect/);
});

test('protect and erase brushes track image coordinates through zoom, including touch', () => {
  const bounds={left:100,top:50,width:600,height:400}; // scaled-and-panned preview
  const fn=script.match(/function subjectPoint\(e\)\{[\s\S]*?\n\}/)[0];
  const context=vm.createContext({canvas:{getBoundingClientRect:()=>bounds}});
  vm.runInContext(`${fn}\nthis.point=subjectPoint;`,context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.point({clientX:250,clientY:150}))),{x:.25,y:.25});
  assert.deepEqual(JSON.parse(JSON.stringify(context.point({clientX:1300,clientY:-20}))),{x:1,y:0});
  assert.match(script, /canvas\.setPointerCapture\(e\.pointerId\)/);
  assert.match(script, /if\(maskStroke\)\{ paintSubject\(e\); return; \}/);
  assert.match(script, /function scheduleSubjectMaskUpload\(\)\{[\s\S]*?requestAnimationFrame\(\(\)=>\{ maskUploadFrame=0; uploadSubjectMask\(\); \}\)/);
  assert.match(script, /if\(maskUploadFrame\) uploadSubjectMask\(\); \/\/ export must see the final brush stroke immediately/);
  assert.match(styles, /#canvasWrap\.maskPainting #glCanvas \{ cursor: crosshair; touch-action: none; \}/);
  assert.match(script, /performance\.now\(\)>=suppressTouchPickerUntil && !maskPaintMode && !e\.target\.closest\('#cropOverlay,#captionOverlay'\)\) fileInput\.click\(\)/);
  assert.match(html, /id="protectSubjectBtn" aria-pressed="false"/);
  assert.match(html, /id="eraseSubjectBtn" aria-pressed="false"/);
  assert.match(html, /id="maskStatus" role="status" aria-live="polite"/);
  assert.match(html, /id="maskDoneBtn" aria-label="Finish painting subject mask"/);
  assert.match(styles, /#canvasWrap\.maskPainting #maskDoneBtn \{ display: block; \}/);
  assert.match(script, /maskDoneBtn\.addEventListener\('click',\(\)=>setMaskPaintMode\(null\)\)/);
  assert.match(script, /canvas\.scrollIntoView\(\{block:'center',behavior:reduced\?'auto':'smooth'\}\)/);
});

test('still-photo grain remains frozen despite Speed; video grain can still animate', () => {
  assert.match(script, /'u_grainSpeed'\),isVideo \? params\.grainSpeed : 0/);
  assert.match(script, /'u_time'\),isVideo \? \(timeMs\?\?performance\.now\(\)\)\*0\.001 : 0/);
  assert.match(composite, /float frameIndex=floor\(u_time\*240\.0\)/);
  assert.match(composite, /float frameSeed=u_grainSeed\+frameIndex\*\(71\.731\+u_grainSpeed\*13\.0\)/);
  assert.doesNotMatch(composite, /pixel\+vec2\(t\*7\.3,t\*5\.9\)/);
  assert.match(html, /id="grainSpeedRow" hidden[\s\S]*?<div class="subLabel">Speed<\/div>/);
  assert.ok(script.includes("$('grainSpeedRow').hidden=!isVideo || !hasContent"));
});

test('presets and resets return new sliders to neutral and remember scope for saved looks', () => {
  assert.match(script, /Bloom:0,Hall:0,Grain:0,Dither:0,Sharp:0/);
  assert.match(script, /setDitherScope\(values\.DitherScope==='background'\?'background':'full'\)/);
  assert.match(script, /const activePresetBase=activePresetName===selectedPresetName&&presetIntensity>0\?availablePresets\.get\(activePresetName\):null/);
  assert.match(script, /const values=\{\.\.\.\(activePresetBase\|\|getCurrentValues\(\)\),DitherScope:ditherScope,Effects:\{\.\.\.effectEnabled\}\}/);
  assert.match(script, /if\(sectionId==='dither'\)\{setDitherSettings\(social\.DEFAULT_DITHER\);setDitherScope\('full'\);\}/);
  assert.match(script, /document\.querySelectorAll\('\.groupReset'\)\.forEach\(btn=>btn\.addEventListener\('click',[\s\S]*?resetSection\(btn\.dataset\.reset\)/);
  assert.match(script, /\$\('resetOriginalBtn'\)\.click\(\)/);
  assert.match(script, /\$\('resetOriginalBtn'\)\.addEventListener\('click',[\s\S]*?setDitherScope\('full'\)[\s\S]*?updateSocialUI\(\)/);
  assert.match(script, /const dur=340/);
});
