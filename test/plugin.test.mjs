import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream, StandardFonts, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from 'pdf-lib';
import { mergeFrames } from '../src/engine.js';
import { fixture, signedFixture, duplicateFixture } from './fixtures.mjs';

let browser, page, server, url; const files=new Map(); let externalRequests=[];
before(async()=>{
  await mkdir('work/qa',{recursive:true});
  const harness=await build({entryPoints:['src/engine.js'],bundle:true,write:false,format:'iife',globalName:'Crisp',platform:'browser',target:'chrome110'});
  files.set('/engine.js',Buffer.from(harness.outputFiles[0].text));
  files.set('/ui.html',await readFile('dist/ui.html'));
  files.set('/host.html',Buffer.from(`<!doctype html><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style><iframe name="plugin" id="plugin" src="/ui.html"></iframe><script>
  const send=m=>document.getElementById('plugin').contentWindow.postMessage({pluginMessage:m},'*');
  window.addEventListener('message',async e=>{const m=e.data.pluginMessage;if(!m)return;
  if(m.type==='ready')send({type:'selection',frames:[{id:'1:1',name:'Frame A',width:900,height:700,x:0,y:0},{id:'1:2',name:'Frame B',width:900,height:700,x:950,y:0}],ignored:0});
  if(m.type==='export'){const bytes=new Uint8Array(await(await fetch(m.ids[0]==='1:1'?'/stack-ab.pdf':'/stack-ba.pdf')).arrayBuffer());send({type:'frame-pdf',requestId:m.requestId,index:0,count:1,bytes});send({type:'export-complete',requestId:m.requestId});}}
  );</script>`));
  files.set('/blocked-host.html',Buffer.from(files.get('/host.html').toString().replace('src="/ui.html"','src="/blocked-ui.html"')));
  files.set('/blocked-ui.html',files.get('/ui.html'));
  files.set('/relay-host.html',Buffer.from(files.get('/host.html').toString().replace('name="plugin" id="plugin" src="/ui.html"','name="bridge" id="plugin" src="/relay-bridge.html"').replace("document.getElementById('plugin').contentWindow.postMessage", "document.getElementById('plugin').contentWindow.frames[0].postMessage")));
  files.set('/relay-bridge.html',Buffer.from(`<!doctype html><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style><iframe name="plugin" src="/ui.html"></iframe><script>window.addEventListener('message',e=>{if(e.data.pluginMessage)parent.postMessage(e.data,'*');});</script>`));
  files.set('/live-host.html',Buffer.from(files.get('/host.html').toString().replace("if(m.type==='export'){const bytes", "if(m.type==='export'){window.lastExportIds=m.ids;await new Promise(r=>window.finishExport=r);const bytes")));
  files.set('/sample.pdf',await fixture({transparent:true,predictor:true,cmyk:true}));
  files.set('/duplicates.pdf',await duplicateFixture());
  files.set('/signed.pdf',await signedFixture());
  files.set('/frame-a.pdf',await fixture({pages:1,dimension:256,name:'Frame A'}));
  files.set('/frame-b.pdf',await fixture({pages:1,dimension:256,name:'Frame B'}));
  files.set('/stack-ab.pdf',await mergeFrames([files.get('/frame-a.pdf'),files.get('/frame-b.pdf')]));
  files.set('/stack-ba.pdf',await mergeFrames([files.get('/frame-b.pdf'),files.get('/frame-a.pdf')]));
  server=createServer(async(req,res)=>{
    if(req.url.startsWith('/save/')&&req.method==='POST') { const chunks=[];for await(const c of req)chunks.push(c);const name=req.url.slice(6);if(!/^[a-z0-9-]+\.pdf$/.test(name)){res.writeHead(400);res.end();return;} await writeFile('work/qa/'+name,Buffer.concat(chunks));res.end('ok');return; }
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<script src="/engine.js"></script>');return;}
    const file=files.get(req.url);if(!file){res.writeHead(404);res.end();return;}
    if(req.url==='/blocked-ui.html')res.setHeader('Content-Security-Policy',"worker-src 'none'");
    res.setHeader('Content-Type',req.url.endsWith('.pdf')?'application/pdf':req.url.endsWith('.js')?'text/javascript':'text/html');res.end(file);
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({...(process.env.CRISP_TEST_BROWSER?{executablePath:process.env.CRISP_TEST_BROWSER}:{channel:'chrome'}),headless:true});
  const context=await browser.newContext({viewport:{width:440,height:900}});
  await context.route('**/*',route=>{if(route.request().url().startsWith(url)||route.request().url().startsWith('blob:')||route.request().url().startsWith('data:'))route.continue();else{externalRequests.push(route.request().url());route.abort();}});
  page=await context.newPage();await page.goto(url);
});
after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise(r=>server?.close(r));});

test('balanced compression preserves page sizes, text, URLs, transparency and CMYK',async()=>{
  const result=await page.evaluate(async()=>{
    const original=new Uint8Array(await(await fetch('/sample.pdf')).arrayBuffer());
    const result=await Crisp.compressPdf(original,{preset:'balanced'});
    await fetch('/save/balanced.pdf',{method:'POST',body:result.bytes});await fetch('/save/original.pdf',{method:'POST',body:original});
    return {pages:result.pages,savedPercent:result.savedPercent,optimized:result.optimized,outputBytes:result.outputBytes};
  });assert.equal(result.pages,2);assert.ok(result.optimized>=2);assert.ok(result.savedPercent>20);
  const original=await PDFDocument.load(files.get('/sample.pdf')),optimized=await PDFDocument.load(await readFile('work/qa/balanced.pdf'));
  assert.deepEqual(optimized.getPages().map(p=>p.getSize()),original.getPages().map(p=>p.getSize()));
  function content(doc){return doc.context.enumerateIndirectObjects().filter(([,o])=>o instanceof PDFRawStream&&o.dict.get(PDFName.of('Subtype'))?.toString()!=='/Image'&&!o.dict.has(PDFName.of('Type'))).map(([,o])=>{try{return Buffer.from(decodePDFRawStream(o).decode()).toString('latin1');}catch{return'';}}).sort();}
  assert.deepEqual(content(optimized),content(original),'Text and vector instructions must be unchanged');
  for(const p of optimized.getPages()){const annotations=p.node.lookup(PDFName.of('Annots'));const link=annotations.lookup(0);assert.equal(link.lookup(PDFName.of('A')).lookup(PDFName.of('URI')).decodeText(),'https://example.com');}
  const images=optimized.context.enumerateIndirectObjects().map(([,o])=>o).filter(o=>o instanceof PDFRawStream&&o.dict.get(PDFName.of('Subtype'))?.toString()==='/Image');
  assert.ok(images.some(o=>o.dict.has(PDFName.of('SMask'))),'Transparency must remain present');
  assert.ok(images.some(o=>o.dict.get(PDFName.of('ColorSpace'))?.toString()==='/DeviceCMYK'&&o.dict.lookup(PDFName.of('Width')).asNumber()===64),'CMYK must be left intact');
});

test('lossless compression keeps decoded RGB pixels unchanged',async()=>{
  await page.evaluate(async()=>{const b=new Uint8Array(await(await fetch('/sample.pdf')).arrayBuffer());const r=await Crisp.compressPdf(b,{preset:'lossless'});await fetch('/save/lossless.pdf',{method:'POST',body:r.bytes});});
  const doc=await PDFDocument.load(await readFile('work/qa/lossless.pdf')),original=await PDFDocument.load(files.get('/sample.pdf'));
  function pixels(document) {
    const image=document.context.enumerateIndirectObjects().map(([,o])=>o).find(o=>o instanceof PDFRawStream&&o.dict.get(PDFName.of('ColorSpace'))?.toString()==='/DeviceRGB');
    assert.equal(image.dict.lookup(PDFName.of('Width')).asNumber(),1024);
    const data=decodePDFRawStream(image).decode();const parms=image.dict.lookup(PDFName.of('DecodeParms'));
    if(!parms) return data;
    const row=1024*3,out=new Uint8Array(row*1024);
    for(let y=0;y<1024;y++){assert.equal(data[y*(row+1)],1);for(let x=0;x<row;x++)out[y*row+x]=(data[y*(row+1)+x+1]+(x>=3?out[y*row+x-3]:0))&255;}
    return out;
  }
  assert.deepEqual(pixels(doc),pixels(original),'Every decoded RGB pixel must match');
});

test('soft masks remain grayscale, share resources and resize with their parent images',async()=>{
  const source=await fixture({pages:1,dimension:1024,transparent:true});
  files.set('/masked.pdf',source);
  const result=await page.evaluate(async()=>{const r=await Crisp.compressPdf(new Uint8Array(await(await fetch('/masked.pdf')).arrayBuffer()),{preset:'smallest'});await fetch('/save/masked.pdf',{method:'POST',body:r.bytes});return {optimized:r.optimized,output:r.outputBytes};});
  assert.ok(result.optimized>0);assert.ok(result.output<source.length);
  const doc=await PDFDocument.load(await readFile('work/qa/masked.pdf'));
  const parents=doc.context.enumerateIndirectObjects().filter(([,o])=>o instanceof PDFRawStream&&o.dict.has(PDFName.of('SMask')));
  assert.equal(parents.length,1);
  for(const [,image] of parents){const mask=image.dict.lookup(PDFName.of('SMask'));assert.equal(mask.dict.lookup(PDFName.of('ColorSpace')).toString(),'/DeviceGray');assert.equal(mask.dict.lookup(PDFName.of('Width')).asNumber(),image.dict.lookup(PDFName.of('Width')).asNumber());assert.equal(mask.dict.lookup(PDFName.of('Height')).asNumber(),image.dict.lookup(PDFName.of('Height')).asNumber());assert.equal(decodePDFRawStream(mask).decode().length,mask.dict.lookup(PDFName.of('Width')).asNumber()*mask.dict.lookup(PDFName.of('Height')).asNumber());}
});

test('vector Type 3 fonts permit downsampling; duplicate masks and profiles do not duplicate photos',async()=>{
  const source=await PDFDocument.load(await fixture({pages:1,dimension:1024,transparent:true}));
  const p=source.getPage(0),n=PDFName.of;
  const glyph=source.context.register(source.context.flateStream('600 0 d0 0 0 600 600 re f'));
  const font=source.context.register(source.context.obj({Type:'Font',Subtype:'Type3',FontBBox:[0,0,600,600],FontMatrix:[.001,0,0,.001,0,0],CharProcs:{A:glyph},Encoding:{Type:'Encoding',Differences:[65,'A']},FirstChar:65,LastChar:65,Widths:[600],Resources:{}}));
  p.node.Resources().lookup(n('Font')).set(n('VectorGlyph'),font);
  const image=p.node.Resources().lookup(n('XObject')).lookup(n('Photo'));
  const mask=image.dict.lookup(n('SMask'));
  const profile=source.context.register(source.context.flateStream(new Uint8Array(await readFile(new URL('./srgb.icc',import.meta.url))),{N:3,Alternate:'DeviceRGB'}));
  image.dict.set(n('ColorSpace'),source.context.obj(['ICCBased',profile]));
  const copiedMask=source.context.register(PDFRawStream.of(mask.dict.clone(source.context),mask.getContents().slice()));
  const copiedProfile=source.context.register(PDFRawStream.of(source.context.lookup(profile).dict.clone(source.context),source.context.lookup(profile).getContents().slice()));
  const copiedImage=PDFRawStream.of(image.dict.clone(source.context),image.getContents().slice());
  copiedImage.dict.set(n('SMask'),copiedMask);copiedImage.dict.set(n('ColorSpace'),source.context.obj(['ICCBased',copiedProfile]));
  const copied=source.context.register(copiedImage);p.node.setXObject(n('RepeatedPhoto'),copied);
  p.pushOperators(pushGraphicsState(),concatTransformationMatrix(480,0,0,280,54,245),drawObject('RepeatedPhoto'),popGraphicsState());
  files.set('/composite.pdf',await source.save());
  const r=await page.evaluate(async()=>{const r=await Crisp.compressPdf(new Uint8Array(await(await fetch('/composite.pdf')).arrayBuffer()),{preset:'smallest'});await fetch('/save/composite.pdf',{method:'POST',body:r.bytes});return{duplicates:r.duplicates,optimized:r.optimized};});
  assert.ok(r.duplicates>=3);assert.equal(r.optimized,1);
  const output=await PDFDocument.load(await readFile('work/qa/composite.pdf'));
  const photos=output.context.enumerateIndirectObjects().filter(([,o])=>o instanceof PDFRawStream&&o.dict.has(n('SMask')));assert.equal(photos.length,1);
  assert.ok(photos[0][1].dict.lookup(n('Width')).asNumber()<1024,'Vector glyph fonts must not disable unrelated image downsampling');
});

test('identical image resources are deduplicated',async()=>{
  const result=await page.evaluate(async()=>{const b=new Uint8Array(await(await fetch('/duplicates.pdf')).arrayBuffer());const r=await Crisp.compressPdf(b,{preset:'lossless'});return{duplicates:r.duplicates,percent:r.savedPercent,pages:r.pages};});
  assert.equal(result.pages,3);assert.ok(result.duplicates>=2);assert.ok(result.percent>90);
});

test('an already compact native PDF is retained byte-for-byte rather than enlarged',async()=>{
  const native=await PDFDocument.create();native.addPage([600,700]);const bytes=await native.save({useObjectStreams:true});files.set('/compact-native.pdf',bytes);
  const results=await page.evaluate(async()=>{const input=new Uint8Array(await(await fetch('/compact-native.pdf')).arrayBuffer()),results=[];for(const preset of ['balanced','lossless']){const r=await Crisp.compressPdf(input,{preset});results.push({retained:r.originalRetained,input:r.originalBytes,output:r.outputBytes,same:r.bytes.length===input.length&&r.bytes.every((v,i)=>v===input[i])});}return results;});
  for(const result of results){assert.equal(result.retained,true);assert.equal(result.output,result.input);assert.equal(result.same,true);}
});

test('an unattainable target is reported; print settings do not drop below 300 DPI',async()=>{
  const result=await page.evaluate(async()=>{const b=new Uint8Array(await(await fetch('/sample.pdf')).arrayBuffer());const r=await Crisp.compressPdf(b,{preset:'print',targetMB:.001});return {targetMet:r.targetMet,settings:r.settings};});
  assert.equal(result.targetMet,false);assert.equal(result.settings.dpi,300);
});

test('signed, malformed and invalid-option inputs fail with useful errors',async()=>{
  const results=await page.evaluate(async()=>{
    const signed=new Uint8Array(await(await fetch('/signed.pdf')).arrayBuffer()),sample=new Uint8Array(await(await fetch('/sample.pdf')).arrayBuffer());
    const cases=[()=>Crisp.compressPdf(signed,{preset:'lossless'}),()=>Crisp.compressPdf(new Uint8Array([0,1,2]),{preset:'lossless'}),()=>Crisp.compressPdf(sample,{dpi:4}),()=>Crisp.compressPdf(sample,{quality:0}),()=>Crisp.compressPdf(sample,{targetMB:-1}),()=>Crisp.compressPdf({length:Crisp.LIMITS.bytes+1},{preset:'lossless'})];const messages=[];
    for(const c of cases){try{await c();messages.push('NO ERROR');}catch(e){messages.push(e.message);}}return messages;
  });assert.match(results[0],/signed/i);assert.match(results[1],/read this PDF/i);assert.match(results[2],/resolution/i);assert.match(results[3],/quality/i);assert.match(results[4],/Target/);assert.match(results[5],/200 MiB/);
});

test('frames stack on one PDF page in the requested order with text, vectors and links intact',async()=>{
  await page.evaluate(async()=>{const a=new Uint8Array(await(await fetch('/frame-a.pdf')).arrayBuffer()),b=new Uint8Array(await(await fetch('/frame-b.pdf')).arrayBuffer());const merged=await Crisp.mergeFrames([b,a]);await fetch('/save/merged.pdf',{method:'POST',body:merged});});
  const doc=await PDFDocument.load(await readFile('work/qa/merged.pdf')),combined=doc.getPage(0);assert.equal(doc.getPageCount(),1);assert.deepEqual(combined.getSize(),{width:900,height:1400});
  const objects=combined.node.Resources().lookup(PDFName.of('XObject'));
  const forms=objects.entries().map(([,ref])=>doc.context.lookup(ref));assert.equal(forms.length,2);
  for(const [i,name] of ['Frame B','Frame A'].entries()) {
    assert.equal(forms[i].dict.lookup(PDFName.of('Subtype')).toString(),'/Form');
    const text=Buffer.from(decodePDFRawStream(forms[i]).decode()).toString('latin1');assert.ok(text.includes(Buffer.from(name+' / page 1').toString('hex').toUpperCase()));assert.match(text,/\bl\b/,'Vector paths must remain drawing instructions');
  }
  const links=combined.node.Annots().asArray().map(ref=>doc.context.lookup(ref));assert.equal(links.length,2);
  assert.deepEqual(links.map(link=>link.lookup(PDFName.of('Rect')).asArray().map(n=>n.asNumber())),[[54,855,210,877],[54,155,210,177]]);
  assert.ok(links.every(link=>link.lookup(PDFName.of('A')).lookup(PDFName.of('URI')).decodeText()==='https://example.com'));
});

test('tall stacks retain physical dimensions and empty frames; cropped rotated frames fit',async()=>{
  const tall=await PDFDocument.create();tall.addPage([600,9000]);const bytes=await tall.save();
  const combined=await PDFDocument.load(await mergeFrames([bytes,bytes,bytes])),p=combined.getPage(0),unit=p.node.lookup(PDFName.of('UserUnit')).asNumber();
  assert.equal(combined.getPageCount(),1);assert.ok(p.getHeight()<=14400);assert.equal(p.getWidth()*unit,600);assert.equal(p.getHeight()*unit,27000);
  const rotated=await PDFDocument.create(),source=rotated.addPage([600,900]),font=await rotated.embedFont(StandardFonts.Helvetica);source.drawText('Rotated vector text',{x:70,y:100,size:18,font});source.setCropBox(50,80,300,500);source.setRotation(degrees(90));source.node.set(PDFName.of('UserUnit'),PDFNumber.of(2));
  const result=await mergeFrames([await rotated.save(),bytes]);await writeFile('work/qa/rotated-stack.pdf',result);const doc=await PDFDocument.load(result);assert.equal(doc.getPageCount(),1);assert.deepEqual(doc.getPage(0).getSize(),{width:1000,height:9600});
});

test('100 MB image-heavy PDF benchmark',async()=>{
  const bytes=await fixture({pages:8,dimension:2048,name:'100 MB benchmark'});files.set('/large.pdf',bytes);
  const result=await page.evaluate(async()=>{const b=new Uint8Array(await(await fetch('/large.pdf')).arrayBuffer());const started=performance.now();const r=await Crisp.compressPdf(b,{preset:'balanced'});await fetch('/save/benchmark.pdf',{method:'POST',body:r.bytes});return{originalMB:b.length/1e6,outputMB:r.outputBytes/1e6,savedPercent:r.savedPercent,pages:r.pages,seconds:(performance.now()-started)/1000};});
  assert.ok(result.originalMB>100&&result.originalMB<102);assert.equal(result.pages,8);assert.ok(result.savedPercent>70);
  await writeFile('work/qa/benchmark.json',JSON.stringify(result,null,2));console.log('Synthetic benchmark:',JSON.stringify(result));files.delete('/large.pdf');
});

test('Figma frame export, worker compression, download, cancellation and themes',async()=>{
  const ui=await browser.newPage({viewport:{width:440,height:900},acceptDownloads:true});let errors=[];ui.on('pageerror',e=>errors.push(e.message));
  await ui.route('**/*',route=>{if(route.request().url().startsWith(url)||route.request().url().startsWith('blob:')||route.request().url().startsWith('data:'))route.continue();else{externalRequests.push(route.request().url());route.abort();}});
  await ui.goto(url+'/live-host.html');const panel=ui.frame({name:'plugin'});await panel.locator('.frame').first().waitFor();await panel.locator('#filename').fill('test-export.pdf');
  await panel.locator('#run').click();await ui.waitForFunction(()=>typeof window.finishExport==='function');await ui.evaluate(()=>window.finishExport());await panel.locator('#result-section').waitFor({state:'visible'});assert.match(await panel.locator('#savings').textContent(),/smaller/);
  await ui.screenshot({path:'work/qa/ui-light.png',fullPage:true});
  const downloadPromise=ui.waitForEvent('download');await panel.locator('#download').click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'test-export.pdf');
  assert.equal(await panel.locator('#preview').count(),0);assert.equal(await panel.locator('canvas').count(),0);assert.equal(await panel.getByRole('button',{name:'Preview',exact:true}).count(),0);
  await panel.locator('#run').click();await panel.locator('#cancel').click();assert.match(await panel.locator('#status').textContent(),/Cancelled/);
  await panel.addStyleTag({content:':root {--figma-color-bg:#2c2c2c;--figma-color-text:#fff;--figma-color-text-secondary:#b7b7b7;--figma-color-border:#444;--figma-color-bg-hover:#383838;--figma-color-bg-selected:#16354b;--figma-color-bg-brand:#0d99ff;}'});
  await ui.screenshot({path:'work/qa/ui-dark.png',fullPage:true});assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);await ui.close();
});

test('frame panel drags names, retains manual order on automatic selection updates and exports one page',async()=>{
  const ui=await browser.newPage({viewport:{width:440,height:740},acceptDownloads:true});await ui.goto(url+'/host.html');const panel=ui.frame({name:'plugin'});
  await panel.locator('.frame').first().waitFor();assert.equal(await panel.locator('.frame button').first().isDisabled(),true);
  const lastBox=await panel.locator('.frame').last().boundingBox();await panel.locator('.frame').first().dragTo(panel.locator('.frame').last(),{targetPosition:{x:35,y:lastBox.height-4}});assert.match(await panel.locator('.frame-name').first().textContent(),/Frame B/);
  await ui.evaluate(()=>document.getElementById('plugin').contentWindow.postMessage({pluginMessage:{type:'selection',frames:[{id:'1:1',name:'Frame A'},{id:'1:2',name:'Frame B'}],ignored:0}},'*'));assert.match(await panel.locator('.frame-name').first().textContent(),/Frame B/);
  await panel.getByRole('button',{name:'Move frame up: Frame A'}).click();assert.match(await panel.locator('.frame-name').first().textContent(),/Frame A/);
  await panel.getByRole('button',{name:'Move frame down: Frame A'}).click();assert.match(await panel.locator('.frame-name').first().textContent(),/Frame B/);
  await ui.screenshot({path:'work/qa/ui-frames.png'});await panel.locator('#run').click();await panel.locator('#result-section').waitFor({state:'visible'});
  assert.match(await panel.locator('#details').textContent(),/1 page/);const promise=ui.waitForEvent('download');await panel.locator('#download').click();await(await promise).saveAs('work/qa/frames-download.pdf');
  const downloaded=await readFile('work/qa/frames-download.pdf');assert.ok(downloaded.length<=files.get('/stack-ba.pdf').length,'The delivered PDF must not exceed its native export baseline');
  const doc=await PDFDocument.load(downloaded);assert.equal(doc.getPageCount(),1);assert.deepEqual(doc.getPage(0).getSize(),{width:900,height:1400});await ui.close();
});

test('selection names arrive through a nested Figma bridge and null-source messages',async()=>{
  const ui=await browser.newPage({viewport:{width:440,height:740}}),errors=[];ui.on('pageerror',e=>errors.push(e.message));await ui.goto(url+'/relay-host.html');const panel=ui.frame({name:'plugin'});
  await panel.locator('.frame').first().waitFor();assert.deepEqual(await panel.locator('.frame-name').allTextContents(),['1. Frame A','2. Frame B']);assert.equal(await panel.locator('#run').isDisabled(),false);
  assert.equal(await panel.locator('#refresh').count(),0);assert.equal(await panel.locator('#sort').count(),0);assert.equal(await panel.locator('#target').count(),0);assert.equal(await panel.locator('header').count(),0);assert.equal(await panel.title(),'Compress PDF');assert.equal(await panel.getByText('Runs locally',{exact:true}).count(),0);
  assert.equal(await panel.locator('#upload-panel').count(),0);assert.equal(await panel.locator('#upload-tab').count(),0);assert.equal(await panel.locator('input[type=file]').count(),0);assert.equal(await panel.locator('[role=tablist]').count(),0);assert.equal(await panel.locator('#frame-list img').count(),0);assert.equal(await panel.locator('#frame-list .small').count(),0);
  await panel.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{source:null,data:{pluginMessage:{type:'selection',frames:[{id:'1:3',name:'Selected frame from desktop relay',width:375,height:900}],ignored:0}}})));
  assert.equal(await panel.locator('.frame-name').textContent(),'1. Selected frame from desktop relay');assert.equal(await panel.locator('#frame-count').textContent(),'1');assert.deepEqual(errors,[]);await ui.close();
});

test('new selected frames appear during an active export and join the next export',async()=>{
  const ui=await browser.newPage({viewport:{width:440,height:740}});await ui.goto(url+'/live-host.html');const panel=ui.frame({name:'plugin'});await panel.locator('.frame').first().waitFor();
  await panel.getByRole('button',{name:'Move frame up: Frame B'}).click();await panel.locator('#run').click();await ui.waitForFunction(()=>typeof window.finishExport==='function');
  await panel.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{source:null,data:{pluginMessage:{type:'selection',frames:[{id:'1:1',name:'Frame A'},{id:'1:2',name:'Frame B'},{id:'1:3',name:'Newly selected frame'}],ignored:0}}})));
  assert.deepEqual(await panel.locator('.frame-name').allTextContents(),['1. Frame B','2. Frame A','3. Newly selected frame']);assert.equal(await panel.locator('#frame-count').textContent(),'3');assert.equal(await panel.locator('#refresh').count(),0);assert.equal(await panel.locator('#cancel').isVisible(),true);assert.match(await panel.locator('#status').textContent(),/Exporting/);
  assert.deepEqual(await ui.evaluate(()=>window.lastExportIds),['1:2','1:1']);await ui.evaluate(()=>window.finishExport());await panel.locator('#result-section').waitFor({state:'visible'});assert.match(await panel.locator('#details').textContent(),/2 frames stacked · 1 page/);assert.equal(await panel.locator('#frame-count').textContent(),'3');
  await panel.locator('#run').click();await ui.waitForFunction(()=>window.lastExportIds.length===3);assert.deepEqual(await ui.evaluate(()=>window.lastExportIds),['1:2','1:1','1:3']);await panel.locator('#cancel').click();await ui.close();
});

test('hosts blocking blob workers still compress locally',async()=>{
  const ui=await browser.newPage({viewport:{width:440,height:740}});await ui.goto(url+'/blocked-host.html');const panel=ui.frame({name:'plugin'});await panel.locator('.frame').first().waitFor();await panel.locator('#run').click();await panel.locator('#result-section').waitFor({state:'visible'});assert.match(await panel.locator('#savings').textContent(),/smaller/);await ui.close();
});

test('ID-less Figma sandbox starts, loads selection and exports without ID-dependent APIs',async()=>{
  const posted=[],calls=[],source=await readFile('dist/code.js','utf8');let onmessage;
  const node=(id,name)=>({id,name,type:'FRAME',width:900,height:700,absoluteTransform:[[1,0,0],[0,1,0]],parent:null,exportAsync:async(settings)=>{calls.push({id,format:settings.format});return new Uint8Array([1,2,3]);}});
  const a=node('1:1','A'),b=node('1:2','B'),pageNode={type:'PAGE',selection:[a,b],parent:null};a.parent=b.parent=pageNode;
  const requiresId=()=>{throw new Error('Cannot use this API in a plugin without an ID');};
  const figma={currentPage:pageNode,root:{setRelaunchData:requiresId},showUI(){},on(){},clientStorage:{getAsync:requiresId,setAsync:requiresId},getNodeByIdAsync:async id=>[a,b].find(n=>n.id===id),ui:{postMessage(msg){posted.push(msg);if(msg.type==='frame-pdf')queueMicrotask(()=>onmessage({type:'ack',requestId:msg.requestId,index:msg.index}));},set onmessage(fn){onmessage=fn;}}};
  vm.runInNewContext(source,{figma,__html__:'',setTimeout,clearTimeout,console});
  await onmessage({type:'ready'});assert.equal(posted.find(m=>m.type==='selection').frames.length,2);
  await onmessage({type:'preferences',preferences:{preset:'print',filename:'Session export'}});
  await onmessage({type:'ready'});const preferences=posted.filter(m=>m.type==='preferences').at(-1).preferences;assert.equal(preferences.preset,'print');assert.equal(preferences.filename,'Session export');
  calls.length=0;await onmessage({type:'export',ids:['1:2'],requestId:1});
  assert.deepEqual(calls.map(c=>c.id),['1:2']);assert.equal(posted.at(-1).type,'export-complete');assert.equal(a.parent,pageNode);assert.equal(b.parent,pageNode);
  calls.length=0;await onmessage({type:'export',ids:['missing'],requestId:2});assert.equal(posted.at(-1).type,'export-error');assert.equal(calls.length,0);
});

test('a Figma plugin ID enables relaunch registration and persistent preferences',async()=>{
  const source=await readFile('dist/code.js','utf8'),posted=[],relaunch=[],writes=[],stored={preset:'smallest',filename:'Saved export'};let onmessage;
  const figma={pluginId:'1234567890123456789',currentPage:{selection:[]},root:{setRelaunchData:data=>relaunch.push(data)},showUI(){},on(){},clientStorage:{getAsync:async key=>{assert.equal(key,'crisp-pdf-v1');return stored;},setAsync:async(key,value)=>writes.push({key,value})},ui:{postMessage:msg=>posted.push(msg),set onmessage(fn){onmessage=fn;}}};
  vm.runInNewContext(source,{figma,__html__:'',setTimeout,clearTimeout,console});
  assert.equal(relaunch.length,1);assert.equal(relaunch[0].open,'Export selected frames as a compressed PDF');
  await onmessage({type:'ready'});assert.equal(posted.find(m=>m.type==='preferences').preferences,stored);assert.equal(posted.at(-1).type,'selection');
  await onmessage({type:'preferences',preferences:{preset:'balanced',filename:'x'.repeat(120)}});assert.equal(writes.length,1);assert.equal(writes[0].key,'crisp-pdf-v1');assert.equal(writes[0].value.preset,'balanced');assert.equal(writes[0].value.filename.length,100);
});

function nativeStackMock({fail=false,hold=false}={}) {
  const posted=[],calls=[],pageNode={type:'PAGE',children:[],selection:[]};let onmessage,release,sequence=0;
  function frame(id,width=600,height=700,x=0,y=0) {
    const node={id,name:id,type:'FRAME',width,height,x,y,parent:pageNode,removed:false,children:[],absoluteBoundingBox:{x,y,width,height},absoluteTransform:[[1,0,x],[0,1,y]],resolvedVariableModes:{collection:'mode'},
      resizeWithoutConstraints(w,h){this.width=w;this.height=h;},
      appendChild(child){if(child.parent?.children){const i=child.parent.children.indexOf(child);if(i>=0)child.parent.children.splice(i,1);}child.parent=this;this.children.push(child);},
      clone(){const copy=frame('copy:'+id,width,height,x,y);copy.sourceId=id;copy.resolvedVariableModes={};return copy;},
      setExplicitVariableModeForCollection(collection,mode){assert.equal(typeof collection,'object','Incremental mode requires the collection node');this.explicitModes??={};this.explicitModes[collection.id]=mode;},
      remove(){for(const child of [...this.children])child.remove();const i=this.parent?.children?.indexOf(this);if(i>=0)this.parent.children.splice(i,1);this.removed=true;},
      async exportAsync(settings){calls.push({id:this.id,width:this.width,height:this.height,settings,frames:this.children.map(v=>({x:v.x,y:v.y,width:v.width,height:v.height,source:v.children[0].sourceId,transform:v.children[0].relativeTransform,modes:v.children[0].explicitModes}))});if(hold)await new Promise(r=>release=r);if(fail)throw new Error('Native export failed');return new Uint8Array([1,2,3]);}
    };pageNode.children.push(node);return node;
  }
  const a=frame('a',600,700,120,80),b=frame('b',375,900,1000,40);pageNode.selection=[a,b];
  const figma={currentPage:pageNode,root:{},showUI(){},on(){},createFrame:()=>frame('temporary:'+ ++sequence),variables:{getVariableCollectionByIdAsync:async id=>({id})},getNodeByIdAsync:async id=>[a,b].find(n=>n.id===id),ui:{postMessage(msg){posted.push(msg);if(msg.type==='frame-pdf')queueMicrotask(()=>onmessage({type:'ack',requestId:msg.requestId,index:msg.index}));},set onmessage(fn){onmessage=fn;}}};
  return{figma,posted,calls,pageNode,a,b,message:m=>onmessage(m),release:()=>release?.(),waiting:()=>!!release};
}

test('a frame stack is exported once in native Figma with manual order and original nodes intact',async()=>{
  const mock=nativeStackMock();vm.runInNewContext(await readFile('dist/code.js','utf8'),{figma:mock.figma,__html__:'',setTimeout,clearTimeout,console});
  await mock.message({type:'export',ids:['b','a'],requestId:3});assert.equal(mock.calls.length,1);
  const native=mock.calls[0];assert.equal(native.settings.format,'PDF');assert.equal(native.width,600);assert.equal(native.height,1600);
  assert.deepEqual(native.frames.map(f=>f.source),['b','a']);assert.deepEqual(native.frames.map(f=>f.y),[0,900]);assert.deepEqual(native.frames.map(f=>f.x),[0,0]);assert.deepEqual(native.frames.map(f=>f.modes.collection),['mode','mode']);
  assert.deepEqual(JSON.parse(JSON.stringify(native.frames.map(f=>f.transform))),[[[1,0,0],[0,1,0]],[[1,0,0],[0,1,0]]]);
  assert.deepEqual(mock.pageNode.children,[mock.a,mock.b]);assert.equal(mock.a.x,120);assert.equal(mock.b.x,1000);assert.deepEqual(mock.pageNode.selection,[mock.a,mock.b]);
  assert.equal(mock.posted.filter(m=>m.type==='frame-pdf').length,1);assert.equal(mock.posted.at(-1).type,'export-complete');
});

test('native export errors and cancellation always remove temporary copies',async()=>{
  for(const options of [{fail:true},{hold:true}]){
    const mock=nativeStackMock(options);vm.runInNewContext(await readFile('dist/code.js','utf8'),{figma:mock.figma,__html__:'',setTimeout,clearTimeout,console});
    const job=mock.message({type:'export',ids:['a','b'],requestId:4});
    if(options.hold){while(!mock.waiting())await new Promise(r=>setImmediate(r));await mock.message({type:'cancel'});mock.release();}
    await job;assert.equal(mock.posted.at(-1).type,'export-error');assert.match(mock.posted.at(-1).message,options.hold?/Cancelled/:/Native export failed/);
    assert.deepEqual(mock.pageNode.children,[mock.a,mock.b]);assert.equal(mock.a.removed,false);assert.equal(mock.b.removed,false);assert.equal(mock.posted.filter(m=>m.type==='frame-pdf').length,0);
  }
});

test('unavailable preference storage cannot block Figma selection or session settings',async()=>{
  const source=await readFile('dist/code.js','utf8'),posted=[];let onmessage;
  const unavailable=async()=>{throw new Error('Storage unavailable');};
  const figma={pluginId:'1234567890123456789',currentPage:{selection:[]},root:{setRelaunchData(){}},showUI(){},on(){},clientStorage:{getAsync:unavailable,setAsync:unavailable},ui:{postMessage:msg=>posted.push(msg),set onmessage(fn){onmessage=fn;}}};
  vm.runInNewContext(source,{figma,__html__:'',setTimeout,clearTimeout,console});
  await onmessage({type:'ready'});assert.equal(posted.at(-1).type,'selection');
  await onmessage({type:'preferences',preferences:{preset:'lossless',filename:'Local export'}});await onmessage({type:'ready'});
  const preferences=posted.filter(m=>m.type==='preferences').at(-1).preferences;assert.equal(preferences.preset,'lossless');assert.equal(preferences.filename,'Local export');assert.equal(posted.at(-1).type,'selection');
});

test('Figma selection changes are delivered during export without generating thumbnails',async()=>{
  const source=await readFile('dist/code.js','utf8'),posted=[],exports=[],events=new Map();let onmessage,release;
  const pageNode={type:'PAGE',selection:[]},node=(id,name)=>({id,name,type:'FRAME',parent:pageNode,exportAsync:async settings=>{assert.equal(settings.format,'PDF');exports.push(id);if(id==='1:1')await new Promise(r=>release=r);return new Uint8Array([1,2,3]);}});
  const a=node('1:1','A'),b=node('1:2','B'),c=node('1:3','New frame');pageNode.selection=[a,b];
  const figma={currentPage:pageNode,root:{setRelaunchData(){throw new Error('No plugin ID');}},showUI(){},on:(name,fn)=>events.set(name,fn),getNodeByIdAsync:async id=>[a,b,c].find(n=>n.id===id),ui:{postMessage(msg){posted.push(msg);if(msg.type==='frame-pdf')queueMicrotask(()=>onmessage({type:'ack',requestId:msg.requestId,index:msg.index}));},set onmessage(fn){onmessage=fn;}}};
  vm.runInNewContext(source,{figma,__html__:'',setTimeout,clearTimeout,console});assert.equal(exports.length,0);
  const exporting=onmessage({type:'export',ids:['1:1'],requestId:1});while(!release)await new Promise(r=>setImmediate(r));
  pageNode.selection=[a,b,c];events.get('selectionchange')();const selected=posted.filter(m=>m.type==='selection').at(-1);assert.equal(selected.frames.length,3);assert.equal(selected.frames[2].name,'New frame');assert.deepEqual(Object.keys(selected.frames[2]).sort(),['id','name']);
  release();await exporting;assert.deepEqual(exports,['1:1']);assert.equal(posted.at(-1).type,'export-complete');assert.ok(posted.every(m=>m.type!=='thumbnail'));
});
