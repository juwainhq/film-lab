const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const styles = html.split('<style>')[1].split('</style>')[0];
const config = script.match(/const advancedControls=\{[\s\S]*?\n\};/)[0];
const mapper = script.match(/function advancedValue\(name\)\{[\s\S]*?\n\}/)[0];
const update = script.match(/function updateFromSliders\(\)\{[\s\S]*?\n\}/)[0];
const converter = script.match(/function convertLegacyValues\(values\)\{[\s\S]*?\n\}/)[0];
const upgrade = script.match(/function upgradeV4Preset\(p\)\{[\s\S]*?\n\}/)[0];
const legacyPresets = script.match(/const legacyBuiltInPresets=\{[\s\S]*?\n\};/)[0];
const withoutSharpening = script.match(/const withoutSharpening=values=>[^\n]+;/)[0];
const presetFromNeutral = script.match(/const presetFromNeutral=values=>withoutSharpening\(\{[\s\S]*?\n\}\);/)[0];
const builtIns = script.match(/const builtInPresets=\{[\s\S]*?\n\};/)[0];
const igPack = script.match(/const igPresets=\{[\s\S]*?\n\};/)[0];
const sliders = {}, params = {};
const context = vm.createContext({sliders, params});
vm.runInContext(`${config}\n${mapper}\n${update}\n${converter}\n${upgrade}\n${legacyPresets}\n${withoutSharpening}\n${presetFromNeutral}\n${builtIns}\n${igPack}\nthis.igPresets=igPresets;this.controls=advancedControls;this.mapValue=advancedValue;this.update=updateFromSliders;this.convert=convertLegacyValues;this.upgrade=upgradeV4Preset;this.oldPresets=legacyBuiltInPresets;this.presets=builtInPresets;`, context);
const {controls, mapValue, update: updateFromSliders, convert, upgrade: upgradeV4Preset, oldPresets, presets} = context;
const advancedInputs = [...html.matchAll(/<input class="subSlider" type="range" id="slider(\w+)" min="(-?\d+)" max="(-?\d+)" value="(-?\d+)"/g)];
const intensityInputs = [...html.matchAll(/<input type="range" id="slider(Bloom|Hall|Grain|Dither|Sharp)" min="(-?\d+)" max="(-?\d+)" value="(-?\d+)"/g)];

for (const [, name] of [...advancedInputs, ...intensityInputs]) sliders[name] = {value: '0'};

test('the editor has an editorial monochrome layout with a restrained red accent', () => {
  assert.match(styles, /--bg:\s*#000/);
  assert.match(styles, /--text:\s*#fafafa/);
  assert.match(styles, /--accent:\s*#d62828/);
  assert.match(styles, /--negative:\s*#e8e8e8/);
  assert.match(styles, /#dropZone h2\s*\{[^}]*font-family:\s*var\(--display\);[^}]*text-transform:\s*uppercase/);
  assert.match(styles, /\.effectGroup\s*\{[^}]*border-top:\s*1px solid var\(--panel-border\);[^}]*border-radius:\s*0/);
  assert.match(styles, /\.hdrBtn\.primary\s*\{[^}]*background:\s*transparent;/);
  assert.doesNotMatch(styles, /#f5a623|#6aafff|#ff8c00/);
  assert.match(html, /white subtracts · red adds/);
});

test('the header uses Juwain Haque branding without changing the editor identity', () => {
  assert.match(html, /<div id="logo">Juwain Haque<\/div>/);
  assert.match(styles, /#logo \{[^}]*letter-spacing: \.15em;[^}]*text-transform: uppercase/);
  assert.doesNotMatch(html, /<div id="logo">[\s\S]*?CINEMATIC ENGINE<\/div>/);
  assert.match(html, /<title>FILM LAB — Cinematic Effects<\/title>/);
});

test('every effect has a separate accessible ON/OFF switch and a visible accordion arrow', () => {
  const groups = ['color', 'bloom', 'hallation', 'grain', 'dither', 'sharpen'];
  const switches = [...html.matchAll(/class="effectToggle" data-toggle="(\w+)" role="switch" aria-checked="true" aria-label="([^"]+)"/g)];
  assert.deepEqual(switches.map(m => m[1]), groups);
  for (const group of groups) assert.match(html, new RegExp(`aria-controls="${group}Controls"`));
  assert.match(styles, /\.effectTitle \.expand \{[^}]*width: 26px;[^}]*border: 1px solid var\(--border-strong\)/);
  assert.match(styles, /\.effectTitle \.expand::before \{[^}]*border-right: 2px solid currentColor;[^}]*border-bottom: 2px solid currentColor/);
  assert.match(script, /e\.stopPropagation\(\); \/\/ switching an effect must not collapse its controls/);
  assert.match(script, /setGroupOpen\(g,!!anyClosed\)/);
});

test('effect switches bypass rendering at neutral without changing slider values', () => {
  const code = script.match(/const effectEnabled=\{[^\n]+;\nlet ditherScope='full';\nfunction effectValue\(group,value,neutral=0\)\{[^\n]+\}/)[0];
  const state = vm.createContext({});
  vm.runInContext(`${code}\nthis.enabled=effectEnabled;this.value=effectValue;`, state);
  for (const group of ['color', 'bloom', 'hallation', 'grain', 'dither', 'sharpen']) {
    assert.equal(state.value(group, 0.75), 0.75);
    state.enabled[group] = false;
    assert.equal(state.value(group, 0.75), 0);
    state.enabled[group] = true;
    assert.equal(state.value(group, 0.75), 0.75);
  }
  state.enabled.color = false;
  assert.equal(state.value('color', 0.75, 1), 1); // neutral contrast and saturation
  for (const [uniform, group, param] of [
    ['u_strength', 'sharpen', 'sharpen'], ['u_bloomStrength', 'bloom', 'bloom'],
    ['u_hallationStrength', 'hallation', 'hallation'], ['u_grainStrength', 'grain', 'grain'],
    ['u_exposure', 'color', 'exposure'], ['u_temperature', 'color', 'temperature'],
    ['u_vignStrength', 'color', 'vignStrength'], ['u_vibrance', 'color', 'vibrance'],
    ['u_fade', 'color', 'fade'], ['u_shadowTone', 'color', 'shadowTone'],
    ['u_highlightTone', 'color', 'highlightTone'],
  ]) assert.ok(script.includes(`'${uniform}'),effectValue('${group}',params.${param})`), uniform);
  assert.match(script, /const ditherStrength=backgroundOnly && !subjectProtected\?0:effectValue\('dither',params\.dither\)/);
  assert.match(script, /gl\.uniform1f\(gl\.getUniformLocation\(progDither,'u_strength'\),appliedStrength\)/);
  for (const param of ['contrast', 'saturation']) {
    assert.ok(script.includes(`'u_${param}'),effectValue('color',params.${param},1)`), param);
  }
});

test('every numeric readout opens a bounded mini editor on click and applies the exact value', () => {
  assert.match(script,/readout\.addEventListener\('click',openNumericEditor\)/);
  assert.match(script,/readout\.addEventListener\('dblclick',openNumericEditor\)/);
  assert.match(script,/editor\.type='number'; editor\.className='numericEditor'/);
  assert.match(script,/editor\.min=slider\.min; editor\.max=slider\.max; editor\.step=slider\.step\|\|'1'; editor\.value=slider\.value/);
  assert.match(script,/slider\.dispatchEvent\(new Event\('input',\{bubbles:true\}\)\); slider\.dispatchEvent\(new Event\('change',\{bubbles:true\}\)\)/);
  assert.match(styles,/\.numericReadout \{ cursor: text; \}/);
});

test('all 44 controls start at 0 with centered -100 to +100 scales', () => {
  assert.equal(advancedInputs.length, 39);
  assert.equal(intensityInputs.length, 5);
  assert.deepEqual(advancedInputs.map(m => m[1]).sort(), Object.keys(controls).sort());
  for (const [, name, min, max, value] of [...advancedInputs, ...intensityInputs]) {
    assert.deepEqual([min, max, value], ['-100', '100', '0'], name);
    assert.match(html, new RegExp(`id="val${name}">0<`));
  }
  assert.match(script, /addScale\(slider\.parentNode\)/); // main intensities have labels too
  assert.match(script, /const fill=value<0\?'var\(--negative\)':'var\(--accent\)'/);
});

test('zero is neutral, details have two-sided ranges and intensities are signed', () => {
  for (const [name, {range}] of Object.entries(controls)) {
    for (const [position, expected] of [[-100, range[0]], [0, range[1]], [100, range[2]]]) {
      sliders[name].value = String(position);
      assert.ok(Math.abs(mapValue(name) - expected) < 1e-10, `${name} at ${position}`);
    }
    assert.ok(range[0] < range[1] && range[1] < range[2], `${name} needs both directions`);
    sliders[name].value = '0';
  }
  assert.deepEqual(Array.from(controls.DitherSteps.range), [4, 12, 32]);
  assert.deepEqual(Array.from(controls.DitherSize.range), [1, 2, 6]);
  assert.deepEqual(Array.from(controls.DitherBrush.range), [0.02, 0.06, 0.18]);
  assert.deepEqual(Array.from(controls.Exposure.range), [-2, 0, 2]);
  assert.deepEqual(Array.from(controls.Fade.range), [-0.6, 0, 0.25]);
  for (const name of ['Vibrance','ShadowTone','HighlightTone']) assert.deepEqual(Array.from(controls[name].range), [-1, 0, 1], name);
  assert.deepEqual(Array.from(controls.HallDir.range), [-180, 0, 180]);
  assert.equal(controls.BloomThresh.range[0], 0.3);
  assert.equal(controls.BloomThresh.range[2], 0.95);
  assert.equal(controls.VignStrength.range[1], 0); // no vignette at rest
  assert.equal(controls.Contrast.range[1], 1);
  assert.equal(controls.Saturation.range[1], 1);
  updateFromSliders();
  assert.equal(params.bloom, 0);
  for (const name of ['vibrance','fade','shadowTone','highlightTone']) assert.equal(params[name], 0, `${name} starts neutral`);
  assert.equal(params.hallation, 0);
  assert.equal(params.grain, 0);
  assert.equal(params.dither, 0);
  assert.equal(params.ditherSteps, 12);
  assert.equal(params.ditherSize, 2);
  assert.equal(params.sharpen, 0);
  for (const name of ['Bloom', 'Hall', 'Grain', 'Dither', 'Sharp']) {
    for (const sign of [-100, 100]) {
      sliders[name].value = String(sign);
      updateFromSliders();
      assert.equal(params[{Bloom:'bloom',Hall:'hallation',Grain:'grain',Dither:'dither',Sharp:'sharpen'}[name]], sign / 100);
    }
    sliders[name].value = '0';
  }
});

test('negative effects are rendered as subtraction, inverse grain, blur, or bright edges', () => {
  assert.match(script, /sign\(u_bloomStrength\)\*bloomFinal/);
  assert.match(script, /hall\.rgb \* u_hallationStrength/);
  assert.match(script, /if\(abs\(u_grainStrength\)>0\.001\)/);
  assert.match(script, /float intensity=u_grainStrength\*0\.22/);
  assert.match(script, /if\(u_strength<0\.0\)\{[\s\S]*?mix\(center\.rgb, blur\.rgb, amount\)/);
  assert.match(script, /dot\(uv2,uv2\)\*u_vignStrength/);
  assert.match(script, /Math\.abs\(params\.bloom\)/);
  assert.match(script, /Math\.abs\(params\.hallation\)/);
});

test('color grading is signed, GPU-backed, and neutral for older looks', () => {
  const shader = script.match(/const fsComposite=`([\s\S]*?)`;/)[1];
  for (const name of ['u_vibrance','u_fade','u_shadowTone','u_highlightTone','u_highlightTint']) {
    assert.match(shader, new RegExp(`uniform float ${name};`), `${name} declared`);
    assert.ok(script.includes(`'${name}'),effectValue('color',params.`), `${name} bypasses with Color & Light`);
  }
  assert.match(shader, /if\(abs\(u_vibrance\)>0\.001\)/);
  assert.match(shader, /if\(abs\(u_fade\)>0\.001 \|\| abs\(u_shadowTone\)>0\.001 \|\| abs\(u_highlightTone\)>0\.001 \|\| abs\(u_highlightTint\)>0\.001\)/);
  assert.match(shader, /u_shadowTone<0\.0[\s\S]*?u_shadowTone\*shadow/);
  assert.match(shader, /u_highlightTone<0\.0[\s\S]*?u_highlightTone\*highlight/);
  assert.match(shader, /if\(u_fade>0\.0\)[\s\S]*?col\+=col\*u_fade\*shadow/);
});

test('eighteen complete presets, legacy translations and v4 upgrades retain old looks', () => {
  const classic = ['Kodak Vision','Anamorphic','Matte Film','Clean Digital','Dream Glow','Noir Crunch'];
  const social = ['Golden Hour','Soft Portrait','Retro 2000','Cloudy Pastel','Moody Coffee','Neon Nights'];
  const stories = ['Teal & Ember','Rosé Haze','Chrome Flash','Instant Film','Coastal Fade','After Hours'];
  assert.deepEqual(Object.keys(presets).sort(), [...classic,...social,...stories].sort());
  assert.equal(Object.keys(presets['Noir Crunch']).length, 44);
  for (const name of [...classic,...social,...stories]) {
    for (const key of ['Dither','DitherSteps','DitherSize','DitherBrush']) assert.equal(presets[name][key], 0, `${name}: dithering stays opt-in`);
    if([...classic,...social].includes(name)) for (const key of ['Vibrance','Fade','ShadowTone','HighlightTone']) assert.equal(presets[name][key], 0, `${name}: legacy color unchanged`);
  }
  assert.ok(presets['Teal & Ember'].ShadowTone < 0 && presets['Teal & Ember'].HighlightTone > 0);
  assert.ok(presets['Rosé Haze'].ShadowTone > 0 && presets['Rosé Haze'].Fade > 0);
  assert.ok(presets['Chrome Flash'].HighlightTone < 0 && presets['Chrome Flash'].Fade < 0);
  assert.ok(presets['Instant Film'].Fade > 0 && presets['Instant Film'].Grain > 0);
  assert.ok(presets['Coastal Fade'].ShadowTone < 0 && presets['Coastal Fade'].HighlightTone < 0);
  assert.ok(presets['After Hours'].ShadowTone > 0 && presets['After Hours'].HighlightTone > 0);
  assert.equal(presets['Noir Crunch'].Saturation, -100);
  assert.ok(presets['Noir Crunch'].Bloom < 0);
  assert.ok(presets['Golden Hour'].Temperature > 0 && presets['Golden Hour'].Bloom > 0);
  assert.ok(presets['Soft Portrait'].Contrast < 0 && presets['Soft Portrait'].Bloom > 0);
  assert.ok(presets['Retro 2000'].Grain > 0 && presets['Retro 2000'].Saturation > 0);
  assert.ok(presets['Cloudy Pastel'].Temperature < 0 && presets['Cloudy Pastel'].Saturation < 0);
  assert.ok(presets['Moody Coffee'].Exposure < 0 && presets['Moody Coffee'].Bloom < 0);
  assert.ok(presets['Neon Nights'].BloomAnam > 50 && presets['Neon Nights'].Hall > 0);
  assert.equal(presets['Cloudy Pastel'].Hall, 0); // missing parameters reset to neutral
  assert.equal(presets['Soft Portrait'].Grain, 0);
  for (const name of [...social,...stories]) assert.equal(presets[name].GrainSpeed, presets[name].Grain ? -100 : 0, `${name}: static grain`);
  for (const [name, {range, legacyZero}] of Object.entries(controls)) {
    assert.equal(convert({[name]: legacyZero})[name], 0, `${name} neutral`);
  }
  assert.equal(convert({Exposure: 52}).Exposure, 2); // old +0.04 stops, new range is wider
  assert.equal(convert({BloomThresh: 55}).BloomThresh, -21);
  assert.equal(convert({HallDir: 5}).HallDir, 10); // old 18° => new +10
  for (const values of Object.values(oldPresets)) {
    const converted = convert(values);
    for (const [name, {range, legacyZero}] of Object.entries(controls)) {
      const old = values[name], signed = converted[name];
      if (old == null) { assert.equal(signed, undefined, `${name} was not in legacy presets`); continue; }
      assert.ok(signed >= -100 && signed <= 100, name);
      sliders[name].value = String(signed);
      if (name === 'HallDir') {
        const radians = Math.PI / 180;
        assert.ok(Math.abs(Math.cos(old * 3.6 * radians) - Math.cos(mapValue(name) * radians)) < 0.04);
        assert.ok(Math.abs(Math.sin(old * 3.6 * radians) - Math.sin(mapValue(name) * radians)) < 0.04);
      } else {
        const [min, neutral, max] = range;
        const previous = name === 'Exposure' ? (old - 50) / 50
          : old < legacyZero
            ? min + old / legacyZero * (neutral - min)
            : neutral + (old - legacyZero) / (100 - legacyZero) * (max - neutral);
        assert.ok(Math.abs(previous - mapValue(name)) <= (max - min) / 100 + 1e-10, name);
      }
    }
    for (const name of ['Bloom', 'Hall', 'Grain', 'Sharp']) assert.equal(converted[name], values[name]);
  }
  const oldCustom = {name:'Saved',values:{Exposure:40,HallDir:-60,Bloom:30}};
  const migrated = upgradeV4Preset(oldCustom);
  assert.equal(migrated.values.Exposure, 20);
  assert.equal(migrated.values.HallDir, -30);
  assert.equal(migrated.values.Bloom, 30);
  assert.equal(migrated.version, 2);
  assert.equal(upgradeV4Preset(migrated), migrated);
  assert.match(script, /const dur=340/);
  assert.match(script, /film_lab_presets_v4/);
});

test('older saved presets fade new sliders to zero while preserving custom sharpening', () => {
  const frames = [], scopeChanges=[], selections=[], inputs = {Fade:{value:70},ShadowTone:{value:-35},Sharp:{value:0},Exposure:{value:0}};
  const state = vm.createContext({
    ids:Object.keys(inputs), sliders:inputs, presetFrame:null, activePresetName:null, presetIntensity:100,
    performance:{now:()=>0}, requestAnimationFrame(fn){frames.push(fn);return frames.length;},
    cancelPresetAnimation(){}, syncPresetSelection(){ selections.push(state.activePresetName); }, presetDisplayName:name=>name, setEffectStates(){},
    setDitherScope(scope){ scopeChanges.push(scope); },
    updateFromSliders(){}, updateSliderUI(){}, render(){}, renderFrame(){}, showToast(){},
  });
  const getter = script.match(/function getCurrentValues\(\)\{[\s\S]*?\n\}/)[0];
  const setter = script.match(/function setValues\(o\)\{[\s\S]*?\n\}/)[0];
  const scaler = script.match(/function scalePresetValues\(values,intensity=presetIntensity\)\{[\s\S]*?\n\}/)[0];
  const applyStart=script.indexOf('function applyPreset('), applyEnd=script.indexOf('\nfunction deleteCustomPreset',applyStart);
  const apply=script.slice(applyStart,applyEnd);
  vm.runInContext(`${getter}\n${setter}\n${scaler}\n${apply}\nthis.apply=applyPreset;`,state);
  state.apply('Old custom',{Sharp:35,Exposure:20}); // saved before Fade and Dither existed
  assert.equal(selections.at(-1),'Old custom');
  assert.equal(scopeChanges.length,0); // scope and slider application wait for the next animation frame
  assert.equal(frames.length,1);
  frames.shift()(170);
  assert.equal(scopeChanges.at(-1),'full');
  assert.ok(inputs.Fade.value>0 && inputs.Fade.value<70);
  assert.ok(inputs.ShadowTone.value<0 && inputs.ShadowTone.value>-35);
  frames.shift()(340);
  assert.equal(inputs.Fade.value,0);
  assert.equal(inputs.ShadowTone.value,0);
  assert.equal(inputs.Sharp.value,35);
  assert.equal(inputs.Exposure.value,20);
  assert.equal(state.presetFrame,null);
});

test('all built-in looks leave sharpening neutral while preserving their other effects', () => {
  const sharpenControls = ['Sharp', 'SharpRadius', 'SharpEdge', 'SharpDetail', 'SharpLuma'];
  for (const [name, values] of Object.entries(presets)) {
    assert.deepEqual(Object.keys(values).sort(), [...Object.keys(controls),'Bloom','Hall','Grain','Dither','Sharp'].sort(), `${name} is complete`);
    for (const [key, value] of Object.entries(values)) assert.ok(Number.isInteger(value) && value >= -100 && value <= 100, `${name}: ${key}`);
    for (const key of sharpenControls) assert.equal(values[key], 0, `${name}: ${key}`);
    if (oldPresets[name]) {
      const previous = convert(oldPresets[name]);
      for (const key of Object.keys(previous)) {
        if (!sharpenControls.includes(key)) assert.equal(values[key], previous[key], `${name}: ${key}`);
      }
    }
  }
  assert.match(script, /if\(abs\(u_strength\)<0\.001\)\{ outColor=center; return; \}/);
  assert.equal(convert({Sharp:80}).Sharp, 80); // manual and saved custom settings remain available
});

test('six original presets stay visible; the rest are grouped in a keyboard-accessible dropdown', () => {
  const featured=[...Object.keys(oldPresets),'Noir Crunch'];
  assert.equal(featured.length,6);
  assert.match(html, /id="presetChips" role="group" aria-label="Featured presets"/);
  assert.match(html, /<label class="presetSelectLabel" for="presetSelect">More presets/);
  assert.match(html, /<select id="presetSelect">/); // native keyboard/touch behavior
  assert.match(script, /const featuredPresetNames=\[\.\.\.Object\.keys\(legacyBuiltInPresets\),'Noir Crunch'\]/);
  assert.match(script, /if\(name==='Golden Hour'\) addGroup\('For your feed'\)/);
  assert.match(script, /if\(name==='Teal & Ember'\) addGroup\('Color stories'\)/);
  assert.match(script, /addGroup\('Saved presets'\)/);
  assert.match(script, /const target=scalePresetValues\(values,presetIntensity\)/);
  assert.match(script, /const dur=340/);

  class Element {
    constructor(tag){
      this.tag=tag; this.children=[]; this.handlers={}; this.attributes={};
      this.classList={toggle:(key,on)=>{this[key]=on;}};
    }
    replaceChildren(){this.children=[];}
    appendChild(child){this.children.push(child); return child;}
    setAttribute(key,value){this.attributes[key]=value;}
    addEventListener(key,fn){this.handlers[key]=fn;}
  }
  const chips=new Element('div'),select=new Element('select'),count=new Element('span'),deleteBtn=new Element('button');
  const elements={presetChips:chips,presetSelect:select,presetCount:count,deletePresetBtn:deleteBtn};
  const state=vm.createContext({
    builtInPresets:presets, igPresets:context.igPresets, igPresetNotes:{}, presetDisplayName:name=>name.startsWith('ig:')?name.slice(3):name, legacyBuiltInPresets:oldPresets, featuredPresetNames:featured,
    customPresets:[], activePresetName:null, availablePresets:new Map(),
    $:id=>elements[id], document:{createElement:tag=>new Element(tag), querySelectorAll:selector=>selector==='#presetChips .chip'?chips.children:[]},
  });
  const notes=script.match(/const socialPresetNotes=\{[\s\S]*?\n\};/)[0];
  const sync=script.match(/function syncPresetSelection\(\)\{[\s\S]*?\n\}/)[0];
  const draw=script.match(/function renderChips\(\)\{[\s\S]*?\n\}/)[0];
  vm.runInContext(`${notes}\n${sync}\n${draw}\nthis.draw=renderChips;this.sync=syncPresetSelection;`,state);
  state.draw();
  assert.deepEqual(chips.children.map(chip=>chip.textContent),featured);
  assert.ok(chips.children.every(chip=>chip.type==='button' && chip.attributes['aria-pressed']==='false'));
  assert.equal(select.children[0].disabled,true);
  assert.equal(count.textContent,'26 looks');
  assert.deepEqual(select.children.slice(1).map(group=>[group.label,group.children.map(opt=>opt.value)]),[
    ['For your feed',['Golden Hour','Soft Portrait','Retro 2000','Cloudy Pastel','Moody Coffee','Neon Nights']],
    ['Color stories',['Teal & Ember','Rosé Haze','Chrome Flash','Instant Film','Coastal Fade','After Hours']],
    ['IG Looks',Object.keys(context.igPresets).map(name=>'ig:'+name)],
  ]);
  state.activePresetName='Golden Hour'; state.sync();
  assert.equal(select.value,'Golden Hour'); assert.equal(deleteBtn.hidden,true);
  state.activePresetName='Noir Crunch'; state.sync();
  assert.equal(select.value,''); assert.equal(chips.children.at(-1).attributes['aria-pressed'],'true');

  state.customPresets.push({name:'Weekend',values:{Exposure:23}}); state.draw();
  assert.equal(count.textContent,'27 looks');
  assert.deepEqual(select.children.at(-1).children.map(opt=>opt.value),['Weekend']);
  assert.equal(select.children.at(-1).label,'Saved presets');
  state.activePresetName='Weekend'; state.sync();
  assert.equal(select.value,'Weekend'); assert.equal(deleteBtn.hidden,false);
  state.customPresets=[]; state.draw();
  assert.equal(select.value,''); assert.equal(deleteBtn.hidden,true);
  assert.equal(count.textContent,'26 looks');
});

test('selecting, adjusting, saving, and deleting looks keeps both preset controls in sync', () => {
  assert.match(script, /\$\('presetSelect'\)\.addEventListener\('change',e=>\{[\s\S]*?if\(availablePresets\.has\(name\)\) schedulePresetApplication\(name,availablePresets\.get\(name\),customPresetDither\.get\(name\)\)/);
  assert.match(script, /activePresetName=name;selectedPresetName=name;syncPresetSelection\(\);[\s\S]*?const beginTransition=now=>\{[\s\S]*?if\(ditherOptions\)setDitherSettings\(ditherOptions\);[\s\S]*?setDitherScope/);
  assert.match(script, /activePresetName=null; syncPresetSelection\(\);\n  updateFromSliders/);
  assert.match(script, /customPresets\.push\(\{name,values,version:2,dither:getDitherSettings\(\)\}\); saveCustom\(\);\n  activePresetName=name; renderChips\(\)/);
  assert.match(script, /\$\('deletePresetBtn'\)\.addEventListener\('click',\(\)=>\{ if\(activePresetName\) deleteCustomPreset\(activePresetName\); \}\)/);
  assert.match(styles, /#deletePresetBtn\[hidden\] \{ display: none; \}/);
});

test('video processing retains a 60s cap, WebCodecs fallback and frame progress', () => {
  assert.match(script, /social\.trimRange\(videoEl\.duration,videoTrim\.start,videoTrim\.end\)/);
  assert.match(script, /framePlan=window\.filmLabTimeline\?\.mapOutputTime\?\.\(outputTime,editPlan\)/);
  assert.match(script, /trim\.start\+outputTime/);
  assert.match(script, /@ffmpeg\/ffmpeg@0\.12\.10\/dist\/umd\/ffmpeg\.js/);
  assert.match(script, /vendor\/ffmpeg\/ffmpeg\.js/);
  assert.match(script, /social\.videoArgs\(\{fps,duration:count\/fps,container,quality,audio:false,output:segment\}\)/);
  assert.match(script, /const range='trimmed';[\s\S]*?const trim=social\.trimRange\(videoEl\.duration,videoTrim\.start,videoTrim\.end\)/);
  assert.match(script, /videoOutputSize\(options,position,\$\('videoResolution'\)\.value\)/);
  assert.match(script, /exportRange|videoExportRange/);
  assert.match(html, /For best performance, trim to under 60s before exporting/);
  assert.match(script, /typeof window\.VideoFrame==='function'/);
  assert.match(script, /frame=new VideoFrame\(videoEl/);
  assert.match(script, /useWebCodecs=false; uploadVideoTexture\(\)/);
  assert.match(script, /else uploadVideoTexture\(\)/);
  assert.match(script, /Frame \$\{i\+1\}\/\$\{total\}/);
  assert.match(script, /cancelAnimationFrame\(animId\)/);
});


test('IG Looks adds fourteen complete signed presets without replacing any original look', () => {
  const ig=context.igPresets;
  assert.deepEqual(Object.keys(ig),['Moody Dark','Golden Hour','Clean Minimal','Dreamy Pastel','Punchy Vibrant','Film Fade','B&W Editorial','Neon Night','Soft Skin','Café Cream','Coastal Blue','Direct Flash','Terracotta','Sage Green']);
  assert.equal(Object.keys(presets).length,18);
  for(const [name,values] of Object.entries(ig)){
    assert.deepEqual(Object.keys(values).sort(),[...Object.keys(controls),'Bloom','Hall','Grain','Dither','Sharp'].sort(),name);
    for(const [id,value] of Object.entries(values)) assert.ok(Number.isInteger(value)&&value>=-100&&value<=100,`${name}: ${id}`);
    for(const id of ['Sharp','SharpRadius','SharpEdge','SharpDetail','SharpLuma','Dither','DitherSteps','DitherSize','DitherBrush']) assert.equal(values[id],0,`${name}: ${id} remains opt-in`);
  }
  assert.ok(ig['Moody Dark'].Fade<0&&ig['Moody Dark'].ShadowTone<0);
  assert.ok(ig['Golden Hour'].HighlightTone>0&&ig['Golden Hour'].Fade>0);
  assert.ok(ig['Clean Minimal'].Exposure>0&&ig['Clean Minimal'].Saturation<0&&ig['Clean Minimal'].Contrast<0);
  assert.ok(ig['Dreamy Pastel'].Fade>0&&ig['Dreamy Pastel'].Temperature<0&&ig['Dreamy Pastel'].Bloom>0);
  assert.ok(ig['Punchy Vibrant'].Saturation>0&&ig['Punchy Vibrant'].Fade<0);
  assert.ok(ig['Film Fade'].Fade>0&&ig['Film Fade'].Grain>0&&ig['Film Fade'].Saturation<0);
  assert.equal(ig['B&W Editorial'].Saturation,-100);
  assert.ok(ig['Neon Night'].ShadowTone<0&&ig['Neon Night'].HighlightTint>0);
  assert.notDeepEqual(ig['Golden Hour'],presets['Golden Hour']); // the original stays available separately
});

test('the top Export button runs Reel export for video and opens image options for photos', () => {
  assert.match(script, /function handleHeaderExport\(\)\{[\s\S]*?if\(isVideo\)\{ processVideo\(\); return; \}[\s\S]*?setCropPanelOpen\(true,true\)/);
  assert.match(script, /\$\('hdrDownloadBtn'\)\.addEventListener\('click',handleHeaderExport\)/);
  assert.match(script, /\$\('hdrDownloadBtn'\)\.textContent=isVideo\?'⤓ Export Reel':'⤓ Export'/);
  assert.match(script, /\$\('hdrDownloadBtn'\)\.disabled=!hasContent\|\|locked/);
  assert.equal((html.match(/id="processVideoBtn"/g)||[]).length,1);
  assert.match(html, /id="videoTrimPanel"[\s\S]*?id="processVideoBtn"/);
});

test('the calmer controls keep the original slider look with larger hit areas and an active-state thumb', () => {
  assert.match(html, /<div class="effectGroup open" data-group="color">/);
  assert.match(html, /<div class="effectGroup" data-group="bloom">[\s\S]*?aria-expanded="false" aria-controls="bloomControls"/);
  assert.match(html, /<details class="advancedColor">/);
  assert.match(html, /id="settingsToolsBody" hidden/);
  assert.match(html, /id="settingsToolsToggle" class="panelHeading" aria-expanded="false" aria-controls="settingsToolsBody"/);
  assert.match(styles, /input\[type=range\]\s*\{[^}]*height:\s*32px[^}]*2px no-repeat/);
  assert.match(styles, /input\[type=range\]::-webkit-slider-runnable-track\s*\{\s*height:\s*2px/);
  assert.match(styles, /input\[type=range\]::-webkit-slider-thumb\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px/);
  assert.match(styles, /input\[type=range\]:active::-webkit-slider-thumb[^}]*transform: scale\(1\.55\)/);
  assert.match(styles, /input\[type=range\]\.subSlider:active::-webkit-slider-thumb[^}]*transform: scale\(1\.7\)/);
  assert.match(script, /s\.style\.backgroundSize='100% 2px'/);
  assert.match(styles, /\.toolBtn\s*\{[^}]*min-height:\s*42px/);
  assert.match(script, /settingsToolsToggle'[\s\S]*?body\.hidden=!open/);
});

test('header Export runs only when media is loaded and routes to the active workspace', () => {
  const handler=script.match(/function handleHeaderExport\(\)\{[\s\S]*?\n\}/)[0];
  const calls={video:0,photo:0};
  const state=vm.createContext({exportBusy:false,mediaBusy:false,hasContent:true,isVideo:true,calls,
    processVideo(){calls.video++;},setCropPanelOpen(open,scroll){if(open&&scroll)calls.photo++;}});
  vm.runInContext(`${handler}\nthis.run=handleHeaderExport;`,state);
  state.run(); assert.equal(calls.video,1); assert.equal(calls.photo,0);
  state.isVideo=false; state.run(); assert.equal(calls.video,1); assert.equal(calls.photo,1);
  state.hasContent=false; state.run(); assert.equal(calls.photo,1);
  state.hasContent=true; state.exportBusy=true; state.run(); assert.equal(calls.photo,1);
});
