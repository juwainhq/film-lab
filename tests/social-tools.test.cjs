const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');
const social = require('../social-tools.js');
const html = readFileSync(resolve(__dirname,'../index.html'),'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
// `ids` mirrors every slider the app exposes outside the Color Grade tab: the 44 legacy effect
// sliders plus the round-7 photo tools (perspective, heal, lens blur, film-look fine tuning). The
// Color Grade sliders and the standalone Straighten control ride in the fuller snapshot payload
// instead.
const ids = [...html.matchAll(/id="slider(\w+)"/g)].map(m=>m[1]).filter(id=>!/^(?:Grade|Hsl|Straighten)/.test(id));
const effects = ['color','bloom','hallation','grain','dither','sharpen'];
const snapshot = () => ({version:1,values:Object.fromEntries(ids.map(id=>[id,0])),effects:Object.fromEntries(effects.map(id=>[id,true])),scope:'full',preset:'Café / রঙ',export:{format:'portrait',type:'jpeg',quality:94},dither:{algorithm:'halftone',downscale:4,colorMode:'custom',paletteSize:8,threshold:0.62,spread:1.4,angle:27,paletteShadow:'#221122',paletteHighlight:'#f0e0c0'}});

test('Dither settings sanitize every selectable mode and preserve settings-link compatibility', () => {
  assert.deepEqual(social.normalizeDitherSettings(snapshot().dither),snapshot().dither);
  for(const algorithm of ['floyd-steinberg','floyd-steinberg-serpentine','stucki','burkes','atkinson','jarvis-judice-ninke','sierra','two-row-sierra','bayer4','bayer8','halftone4','halftone8','halftone','none']) assert.equal(social.normalizeDitherSettings({algorithm}).algorithm,algorithm);
  assert.deepEqual(social.normalizeDitherSettings({algorithm:'unsafe',downscale:80,colorMode:'other',paletteSize:3,threshold:4,spread:-3,angle:540,paletteShadow:'red'}),{...social.DEFAULT_DITHER,downscale:8,threshold:1,spread:0,angle:180});
  const old=social.sanitizeSettings({version:1,values:{Exposure:2}},['Exposure'],effects);
  assert.deepEqual(old.dither,social.DEFAULT_DITHER); // older links keep their prior behavior
  assert.match(html,/id="ditherAlgorithm"[\s\S]*?value="floyd-steinberg"[\s\S]*?value="bayer4"[\s\S]*?value="bayer8"[\s\S]*?value="halftone"[\s\S]*?value="none"/);
});

test('Instagram export formats have the exact requested pixel sizes', () => {
  for (const [key,width,height] of [['square',1080,1080],['portrait',1080,1350],['story',1080,1920],['landscape',1080,566]]) {
    assert.deepEqual(social.outputSize({format:key},4000,3000),{width,height});
    assert.equal(social.cropRatio({format:key}),width/height);
    assert.match(html,new RegExp(`data-format="${key}"`));
  }
  assert.deepEqual(social.outputSize({format:'original'},4000,3000),{width:4000,height:3000});
  assert.equal(social.cropRatio({format:'original'}),null);
});
test('crop rectangles fill the target aspect ratio without stretching or leaving the source', () => {
  for (const [w,h] of [[4000,3000],[3000,4000],[1,1],[1080,1920]]) {
    for (const format of Object.keys(social.FORMATS)) {
      for (const pos of [{x:0,y:0},{x:0.5,y:0.5},{x:1,y:1},{x:-5,y:100}]) {
        const ratio=social.cropRatio({format}), r=social.cropRect(w,h,ratio,pos);
        assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=w+1e-8&&r.y+r.height<=h+1e-8,`${w}/${h}: ${format}`);
        assert.ok(Math.abs(r.width/r.height-(ratio||w/h))<1e-8);
      }
    }
  }
  assert.deepEqual(social.cropRect(4000,3000,1,{x:1,y:0}),{x:1000,y:0,width:3000,height:3000});
  assert.throws(()=>social.cropRect(0,20,1),/dimensions/);
});
test('dragging and keyboard nudges retain normalized per-photo framing and clamp at image edges', () => {
  assert.deepEqual(social.moveCrop(4000,3000,1,{x:0.5,y:0.5},250,200),{x:0.75,y:0.5});
  assert.deepEqual(social.moveCrop(3000,4000,1,{x:0.5,y:0.5},200,-250),{x:0.5,y:0.25});
  assert.deepEqual(social.moveCrop(4000,3000,1,{x:0.5,y:0.5},100000,-100000),{x:1,y:0.5});
  assert.match(script,/cropFrame\.setPointerCapture\(e\.pointerId\)/);
  assert.match(script,/cropFrame\.addEventListener\('keydown'/);
  assert.match(script,/cropDrag\.box\.width/); // convert displayed movement back to source pixels
  assert.match(script,/currentPhoto \? currentPhoto\.crop : videoCrop/);
});
test('JPG quality is strictly 80–100%, PNG is lossless, and untrusted export options normalize safely', () => {
  assert.match(html,/id="exportQuality" min="80" max="100" value="92"/);
  assert.equal(social.normalizeExport({quality:0}).quality,80);
  assert.equal(social.normalizeExport({quality:101}).quality,100);
  assert.equal(social.normalizeExport({quality:NaN}).quality,92);
  assert.equal(social.normalizeExport({type:'png'}).type,'png');
  assert.equal(social.normalizeExport({format:'__proto__'}).format,'original');
  assert.equal(social.normalizeExport({comparisonFormat:'constructor'}).comparisonFormat,'landscape');
  assert.equal(social.normalizeExport({comparison:'true'}).comparison,false);
  assert.deepEqual(social.normalizeExport(null),{...social.DEFAULT_EXPORT});
});
test('before/after pairs use the same crop on both halves of each requested layout', () => {
  for (const [comparisonFormat,width,height] of [['square',1080,1080],['landscape',2160,1080],['story',1080,1920]]) {
    const options={comparison:true,comparisonFormat};
    assert.deepEqual(social.outputSize(options,6000,4000),{width,height});
    assert.equal(social.cropRatio(options),(width/2)/height);
  }
  const drawCalls=[], renderModes=[], output={getContext:()=>ctx}, ctx={fillRect(){},drawImage(...args){drawCalls.push(args);}};
  const state=vm.createContext({
    social, canvas:{width:640,height:400}, exportOptions:{}, getCropPosition:()=>({x:0.8,y:0.5}),
    document:{createElement:()=>output}, showOriginal:false, splitPreview:true, isVideo:false,
    render(){renderModes.push(state.showOriginal);},
  });
  const make=script.match(/function makeExportCanvas\([\s\S]*?\n\}/)[0];
  vm.runInContext(`${make}\nthis.make=makeExportCanvas;`,state);
  state.make({comparison:true,comparisonFormat:'landscape',type:'png',labels:false},{x:0.8,y:0.5});
  assert.equal(output.width,2160); assert.equal(output.height,1080);
  assert.deepEqual(renderModes,[true,false]); assert.equal(drawCalls.length,2);
  assert.deepEqual(drawCalls[0].slice(1,5),drawCalls[1].slice(1,5));
  assert.deepEqual(drawCalls[0].slice(5),[0,0,1080,1080]); assert.deepEqual(drawCalls[1].slice(5),[1080,0,1080,1080]);
  assert.equal(state.showOriginal,false); assert.equal(state.splitPreview,true); // no transient preview state leaks
});
test('video export ignores photo comparisons, crops normally, and pads odd source sizes for H.264', () => {
  const options={format:'story',comparison:true,comparisonFormat:'landscape'};
  assert.deepEqual(social.outputSize(options,4000,3000,true),{width:1080,height:1920});
  assert.equal(social.cropRatio(options,true),9/16);
  assert.deepEqual(social.outputSize({format:'original'},641,399,true),{width:642,height:400});
});
test('video trim points stay valid, allow arbitrary source segments, and cap exports at 60 seconds', () => {
  assert.deepEqual(social.trimRange(180,0,180),{start:120,end:180});
  assert.deepEqual(social.trimRange(180,80,180,'start'),{start:80,end:140});
  assert.deepEqual(social.trimRange(180,90,110),{start:90,end:110});
  assert.deepEqual(social.trimRange(120,10,5),{start:4.9,end:5});
  assert.deepEqual(social.trimRange(120,10,5,'start'),{start:10,end:10.1});
  const tiny=social.trimRange(0.05,0,0.05); assert.equal(tiny.start,0); assert.equal(tiny.end,0.05);
  assert.throws(()=>social.trimRange(Infinity,0,60),/duration/);
  assert.equal(social.timeLabel(75.25),'1:15.3');
});
test('one-click 15, 30, and 60 second trims use the current in point or the last available segment', () => {
  for (const seconds of [15,30,60]) {
    assert.deepEqual(social.autoTrim(180,40,seconds),{start:40,end:40+seconds});
    assert.match(html,new RegExp(`data-trim="${seconds}"`));
  }
  assert.deepEqual(social.autoTrim(12,0,60),{start:0,end:12});
  assert.deepEqual(social.autoTrim(80,75,15),{start:65,end:80});
});
test('MP4 and WebM commands encode the rendered frames and trim the matching source audio', () => {
  const mp4=social.videoArgs({start:22,duration:15,container:'mp4',audio:true});
  assert.deepEqual(mp4.slice(0,5),['-y','-framerate','24','-i','frame_%04d.jpg']);
  assert.deepEqual(mp4.slice(5,11),['-ss','22','-t','15','-i','source-video']);
  assert.ok(mp4.includes('1:a:0?')); assert.ok(mp4.includes('libx264')); assert.ok(mp4.includes('aac')); assert.equal(mp4.at(-1),'output.mp4');
  const webm=social.videoArgs({start:5,duration:30,container:'webm',audio:true});
  assert.ok(webm.includes('libvpx')); assert.ok(webm.includes('libopus')); assert.equal(webm.at(-1),'output.webm');
  const silent=social.videoArgs({duration:15,container:'webm',audio:false,codec:'libvpx'});
  assert.ok(silent.includes('-an')); assert.ok(!silent.includes('source-video')); assert.ok(silent.includes('libvpx'));
  const low=social.videoArgs({duration:2,container:'mp4',quality:'low',audio:false});
  const high=social.videoArgs({duration:2,container:'webm',quality:'high',audio:false});
  assert.deepEqual(low.slice(low.indexOf('-crf'),low.indexOf('-crf')+2),['-crf','28']);
  assert.deepEqual(high.slice(high.indexOf('-b:v'),high.indexOf('-b:v')+2),['-b:v','8M']);
});
test('version 1 settings and look links migrate the vignette direction instead of changing the look', () => {
  // Version 2 is Lightroom's direction: negative darkens, positive lightens. Old payloads stored
  // the opposite sign, so loading one has to negate the value (and save it back as version 2).
  const legacy=social.sanitizeSettings({version:1,values:{VignStrength:60,Exposure:12}},ids,effects);
  assert.equal(social.SETTINGS_VERSION,2);
  assert.equal(legacy.version,2);
  assert.equal(legacy.values.VignStrength,-60);
  assert.equal(legacy.values.Exposure,12);
  const current=social.sanitizeSettings({version:2,values:{VignStrength:-60,Exposure:12}},ids,effects);
  assert.equal(current.values.VignStrength,-60, 'version 2 values are never re-negated');
  const roundTrip=social.sanitizeSettings(social.sanitizeSettings({version:1,values:{VignStrength:-25}},ids,effects),ids,effects);
  assert.equal(roundTrip.values.VignStrength,25);
  assert.deepEqual(social.decodeSettings(social.encodeSettings(legacy),ids,effects),legacy);
  assert.equal(social.encodeSettings(legacy).slice(0,7),'#look=v');
});

test('settings and look links round-trip all effect sliders, switches, scope, export options, and Unicode names', () => {
  const input=snapshot(); input.values.Dither=-78; input.values.HighlightTint=68; input.effects.grain=false; input.scope='background';
  const clean=social.sanitizeSettings(input,ids,effects), hash=social.encodeSettings(clean);
  assert.match(hash,/^#look=v2\.[A-Za-z0-9_-]+$/); assert.deepEqual(social.decodeSettings(hash,ids,effects),clean);
  assert.equal(clean.values.HighlightTint,68); assert.equal(clean.effects.grain,false); assert.equal(clean.preset,'Café / রঙ');
  // 44 effect sliders + the 8 round-7 perspective / heal / lens / film-look controls + the 8
  // round-8 video controls (clip speed, layer opacity, text size / stroke / box, chroma
  // tolerance / softness / spill).
  assert.ok(!hash.includes(' ')); assert.equal(ids.length,60);
});
test('settings imports clamp signed values, ignore unknown keys, and reject malformed or oversized links', () => {
  const input=snapshot(); input.values.Exposure=400; input.values.Grain=-400; input.values.Hall=NaN;
  input.values.Sharp='100'; input.values.unknown=22;
  const clean=social.sanitizeSettings(input,ids,effects);
  assert.equal(clean.values.Exposure,100); assert.equal(clean.values.Grain,-100); assert.equal(clean.values.Hall,0); assert.equal(clean.values.Sharp,0); assert.equal(clean.values.unknown,undefined);
  assert.throws(()=>social.sanitizeSettings({version:1,values:{unknown:2}},ids,effects),/compatible/);
  for (const hash of ['#look=v3.abc','#look=v2.abc','#look=v1.not%valid','#look=v1.YQ','#look=v1.'+'a'.repeat(20000)]) assert.throws(()=>social.decodeSettings(hash,ids,effects));
  assert.throws(()=>social.sanitizeSettings({version:1,values:[]},ids,effects));
});
test('copy/paste has a persistent browser fallback and shared links restore without uploading photos', () => {
  assert.match(script,/film_lab_settings_clipboard_v1/);
  assert.match(script,/navigator\.clipboard\.writeText\(text\)/);
  assert.match(script,/navigator\.clipboard\.readText\(\)/);
  assert.match(script,/window\.addEventListener\('hashchange'/);
  assert.match(script,/updateSocialUI\(\); restoreSharedLook\(\)/);
  assert.match(script,/if\(e\.key\.toLowerCase\(\)==='c' && !\['INPUT','TEXTAREA','SELECT'\]/);
});
test('ZIP entries are valid stored files with UTF-8 names, correct checksums, offsets, and directory counts', async () => {
  assert.equal(social.crc32(new TextEncoder().encode('123456789')),0xcbf43926);
  const entries=[{name:'01-café.jpg',blob:new Blob(['first picture'])},{name:'02-photo.png',blob:new Blob(['second picture'])}];
  const zip=await social.createZip(entries,new Date(2026,9,1,12,0,0)), data=Buffer.from(await zip.arrayBuffer());
  assert.equal(zip.type,'application/zip'); let offset=0;
  for (const entry of entries) {
    assert.equal(data.readUInt32LE(offset),0x04034b50); assert.equal(data.readUInt16LE(offset+6),0x800); assert.equal(data.readUInt16LE(offset+8),0);
    const size=data.readUInt32LE(offset+18), nameLength=data.readUInt16LE(offset+26), start=offset+30+nameLength;
    assert.equal(data.subarray(offset+30,start).toString('utf8'),entry.name);
    assert.equal(data.subarray(start,start+size).toString(),await entry.blob.text());
    assert.equal(data.readUInt32LE(offset+14),social.crc32(data.subarray(start,start+size))); offset=start+size;
  }
  const directoryOffset=offset; assert.equal(data.readUInt32LE(offset),0x02014b50);
  const end=data.length-22; assert.equal(data.readUInt32LE(end),0x06054b50); assert.equal(data.readUInt16LE(end+8),2); assert.equal(data.readUInt16LE(end+10),2);
  assert.equal(data.readUInt32LE(end+16),directoryOffset); assert.equal(data.readUInt32LE(end+12),end-directoryOffset);
});
test('ZIP and download filenames are safe, unique by photo order, and require no CDN', async () => {
  assert.equal(social.safeFilename('../../A photo!.HEIC'),'A-photo');
  assert.equal(social.safeFilename('Café.jpg'),'Cafe'); assert.equal(social.safeFilename('🎞.png'),'photo');
  assert.match(script,/String\(i\+1\)\.padStart\(2,'0'\)/);
  assert.match(script,/social\.createZip\(entries\)/);
  await assert.rejects(social.createZip([]));
  await assert.rejects(social.createZip([{name:'../unsafe.jpg',blob:new Blob(['a'])}]),/Unsafe/);
  await assert.rejects(social.createZip([{name:'photo.jpg',blob:'not a blob'}]),/Blob/);
});
test('batch exports preserve per-photo masks and crops, lock edits, and restore the selected preview even on cancellation', () => {
  assert.match(script,/saveActivePhotoMask\(\)/); assert.match(script,/restorePhotoMask\(item,img,w,h\)/);
  assert.match(script,/makeExportCanvas\(options,item\.crop\)/);
  assert.match(script,/const selected=activePhotoIndex/);
  assert.match(script,/finally\{[\s\S]*?const item=photos\[selected\]/);
  assert.match(script,/disabledBeforeExport\.set\(control,control\.disabled\); control\.disabled=true/);
  assert.match(script,/if\(maskUploadFrame\) uploadSubjectMask\(\)/);
  assert.match(script,/if\(ditherScope==='background' && maskDetectionPending\) await maskQueue/);
  assert.match(html,/id="cancelExportBtn"/);
});


test('video sections are joined without re-encoding, with audio trimmed only once at the matching source offset', () => {
  const args=social.muxVideoArgs({start:25,duration:60,container:'mp4',audio:true,source:'/source/source-video'});
  assert.deepEqual(args.slice(0,7),['-y','-f','concat','-safe','0','-i','segments.txt']);
  assert.ok(args.includes('copy')); assert.ok(args.includes('/source/source-video')); assert.ok(args.includes('aac')); assert.ok(args.includes('+faststart'));
  assert.ok(!args.includes('libx264')); assert.equal(args.at(-1),'output.mp4');
  const chunk=social.videoArgs({duration:2,container:'mp4',audio:false,output:'part_0000.mp4'});
  assert.equal(chunk.at(-1),'part_0000.mp4'); assert.ok(chunk.includes('-an'));
  const silent=social.muxVideoArgs({duration:15,container:'webm',audio:false});
  assert.ok(!silent.includes('source-video')); assert.ok(silent.includes('-an'));
  assert.match(script,/const CHUNK_FRAMES=48/);
  assert.match(script,/await deleteFile\(`frame_\$\{String\(j\)\.padStart\(4,'0'\)\}\.jpg`\)/);
  assert.match(script,/ff\.mount\('WORKERFS'/);
  assert.match(script,/ff\.unmount\('\/source'\)/);
});

test('full-before and split-view labels stay synchronized without changing export options', () => {
  const states=[],label={classList:{toggle(){}}};
  const context=vm.createContext({hasContent:true,showOriginal:false,beforeLabel:label,performance:{now:()=>0},render(){},updateSplitDivider(){states.push(context.showOriginal);}});
  const toggle=script.match(/function toggleBeforeAfter\(\)\{[\s\S]*?\n\}/)[0];
  vm.runInContext(toggle,context); context.toggleBeforeAfter(); context.toggleBeforeAfter();
  assert.deepEqual(states,[true,false]); assert.equal(context.showOriginal,false);
});
