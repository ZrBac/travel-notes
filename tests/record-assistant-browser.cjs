// Isolated synthetic APIs; real local editor and responsive styles, no production writes.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),clone=value=>JSON.parse(JSON.stringify(value));
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL8AAAAASUVORK5CYII=','base64');
const esc=s=>String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{for(const width of [320,390,1440]){
 const ctx=await browser.newContext({viewport:{width,height:844}}),page=await ctx.newPage(),errors=[],calls=[],tasks=[],records=[];let uploads=0,stamp=0,previewFail=true;
 const now=()=>new Date(1900000000000+(++stamp)*1000).toISOString();
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 await page.addInitScript(()=>{const timeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timeout(fn,ms===5000?250:ms,...args);});
 const proposal=snapshot=>{const figures=snapshot.photos.map(p=>`<figure><img src="${p.url}" alt="旅行照片"><figcaption>${esc(p.caption)}</figcaption></figure>`).join('');return {title:'南京老街，和家人慢慢走',summary:'逛街、吃小吃，走累了就歇歇。',body:'<h2>古城慢游</h2><p>逛了老街，吃了鸭血粉丝汤。</p>'+figures,html:'<h2>古城慢游</h2><p>逛了老街，吃了鸭血粉丝汤。</p>'+figures,warnings:[]};};
 const meta=t=>({id:t.id,status:t.status,updated_at:t.updated_at,action:t.action,record_id:t.record_id,reason:'',progress:[]});
 await ctx.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url()),method=req.method(),data=method==='GET'||u.pathname==='/api/upload'?null:req.postDataJSON();calls.push({path:u.pathname,search:u.search,method,data});assert.equal(u.origin,'http://footprint.test');
  if(u.pathname.startsWith('/api/')){
   if(method!=='GET')assert.equal(req.headers()['x-csrf-token'],'fixture');
   if(u.pathname==='/api/session')return route.fulfill({json:{csrf:'fixture',user:{id:1,username:'fixture',display_name:'家庭管理员'}}});
   if(u.pathname==='/api/guides')return route.fulfill({json:{guides:[{id:1,title:'南京参考攻略'}]}});
   if(u.pathname==='/api/upload'){uploads++;return route.fulfill({status:201,json:{url:'/media/'+String(uploads).padStart(32,'0')+'.webp'}});}
   if(u.pathname==='/api/admin/preview')return route.fulfill({json:{html:data.body.startsWith('<')?data.body:'<p>'+esc(data.body)+'</p>'}});
   if(u.pathname==='/api/admin/record-assistant/tasks'&&method==='POST'){
    assert.match(data.request_key,/^[a-f0-9]{32}$/);assert.ok(['record_generate','record_polish'].includes(data.action));
    const t={id:100+tasks.length,action:data.action,prompt:data.prompt,status:'queued',snapshot:clone(data.record),record_id:data.record.id,updated_at:now(),proposal:null};tasks.push(t);return route.fulfill({status:201,json:{id:t.id}});
   }
   if(u.pathname==='/api/admin/record-assistant/tasks'&&method==='GET'){
    const rid=u.searchParams.get('record_id');return route.fulfill({json:{tasks:tasks.filter(t=>String(t.record_id||'new')===rid).map(t=>({...meta(t),prompt:t.prompt,created_at:now()}))}});
   }
   if(/^\/api\/admin\/record-assistant\/tasks\/\d+$/.test(u.pathname)){
    const t=tasks.find(t=>t.id===Number(u.pathname.split('/').at(-1)));assert.ok(t);return route.fulfill({json:{task:u.searchParams.get('view')==='status'?meta(t):clone(t)}});
   }
   if(/^\/api\/admin\/record-assistant\/tasks\/\d+\/preview$/.test(u.pathname)){
    const t=tasks.find(t=>t.id===Number(u.pathname.split('/').at(-2)));assert.deepEqual(data.record,t.snapshot);
    if(previewFail){previewFail=false;return route.fulfill({status:409,json:{error:'模拟其他页面更新，当前内容保留'}});}
    return route.fulfill({json:{proposal:clone(t.proposal)}});
   }
   if(u.pathname==='/api/records'&&method==='POST'){
    assert.equal(data.status,'private');assert.equal(data.record_assistant_task,100);const record={...clone(data),id:20,revision:1,html:data.body,deleted_at:null};records.push(record);tasks[0].record_id=20;return route.fulfill({status:201,json:{id:20}});
   }
   if(u.pathname==='/api/records/20')return route.fulfill({json:{record:clone(records[0]),guide:null}});
   if(u.pathname==='/api/admin/travel-agent')return route.fulfill({json:{tasks:tasks.map(t=>({id:t.id,prompt:t.prompt,status:t.status,workflow:t.action,record_id:t.record_id,trip:{destination:t.snapshot.destination},created_at:now(),updated_at:t.updated_at})),next_before:null,service:{online:true,authenticated:true,concurrency:2},family_preferences:{preferences:{}}}});
   if(/^\/api\/admin\/travel-agent\/tasks\/\d+$/.test(u.pathname)){
    const t=tasks.find(t=>t.id===Number(u.pathname.split('/').at(-1)));return route.fulfill({json:{task:{id:t.id,status:t.status,workflow:t.action,record_id:t.record_id,trip:{destination:t.snapshot.destination},updated_at:t.updated_at,result:'真实足迹整理',workflow_result:t.proposal,guide:null,progress:[]}}});
   }
   throw Error('Unexpected API '+method+' '+u.pathname);
  }
  if(u.pathname.startsWith('/media/'))return route.fulfill({body:image,contentType:'image/png'});
  const file=path.join(root,u.pathname==='/admin'?'static/admin.html':u.pathname.slice(1));assert.ok(file.startsWith(root+'/'));assert.ok(fs.existsSync(file),'Missing '+file);
  return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream'});
 });
 const fit=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow '+width);
 const syncBody=()=>page.evaluate(()=>{TravelEditor.sync();return document.querySelector('#record-body').value;});
 const ready=()=>page.waitForFunction(()=>typeof TravelEditor!=='undefined'&&!TravelEditor.busy&&!!document.querySelector('#record-ai'));
 await page.goto('http://footprint.test/admin#record-new');await ready();await fit();
 assert.equal(await page.locator('#record-ai').getAttribute('open'),null);assert.equal(await page.locator('.record-manual-template').getAttribute('open'),null);
 assert.equal(calls.filter(c=>c.path.startsWith('/api/admin/record-assistant')).length,0,'normal editor does not fetch AI tasks');
 await page.locator('[name=destination]').fill('南京');await page.locator('[name=start_date]').fill('2026-11-06');await page.locator('[name=end_date]').fill('2026-11-07');await page.locator('[name=actual_cost]').fill('餐饮实际花了 180 元');await page.locator('[name=guide_id]').selectOption('1');
 await page.locator('#record-photos-input').setInputFiles([{name:'old-street.jpeg',mimeType:'image/jpeg',buffer:image},{name:'food.jpg',mimeType:'image/jpeg',buffer:image}]);await page.waitForFunction(()=>document.querySelectorAll('[data-record-caption]').length===2&&!document.querySelector('#record-photos-input').disabled);
 await page.locator('[data-record-caption="0"]').fill('家人一起逛老街');await page.locator('[data-record-caption="1"]').fill('午餐的鸭血粉丝汤');await page.locator('[data-record-action=cover][data-index="1"]').click();
 await page.locator('#record-ai>summary').click();await page.locator('#record-ai-prompt').fill('逛了老街，吃了鸭血粉丝汤，下午走累了回酒店休息。');await page.locator('[data-record-ai=generate]').click();await page.waitForSelector('[data-record-ai=cancel]');assert.equal(tasks.length,1);assert.equal(tasks[0].snapshot.title,'');assert.equal(tasks[0].snapshot.photos.length,2);assert.equal(records.length,0);
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(300);const hiddenReads=calls.filter(c=>c.path.startsWith('/api/admin/record-assistant')).length;await page.waitForTimeout(500);assert.equal(calls.filter(c=>c.path.startsWith('/api/admin/record-assistant')).length,hiddenReads,'hidden page stops polling');
 tasks[0].status='done';tasks[0].proposal=proposal(tasks[0].snapshot);tasks[0].updated_at=now();await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForSelector('.record-ai-preview');
 assert.equal(await page.locator('.record-ai-preview img').count(),2);assert.equal(await page.locator('[name=title]').inputValue(),'');assert.equal((await syncBody()).trim(),'');await fit();
 await page.locator('[name=title]').fill('刚刚自己补充的标题');assert.equal(await page.locator('[data-record-ai=apply]').isDisabled(),true);await page.locator('[name=title]').fill('');assert.equal(await page.locator('[data-record-ai=apply]').isDisabled(),false);
 await page.locator('[data-record-ai=apply]').click();await page.waitForFunction(()=>document.querySelector('#record-ai-status').textContent.includes('模拟其他页面'));assert.equal((await syncBody()).trim(),'');assert.equal(await page.locator('[name=title]').inputValue(),'');
 const previewCalls=calls.filter(c=>c.path==='/api/admin/preview').length;await page.locator('[data-record-ai=apply]').click();await page.waitForSelector('[data-record-ai=undo]');assert.equal(calls.filter(c=>c.path==='/api/admin/preview').length,previewCalls,'apply reuses safely rendered preview without another render request');assert.equal(await page.locator('[name=title]').inputValue(),tasks[0].proposal.title);assert.equal(await page.locator('[name=actual_cost]').inputValue(),'餐饮实际花了 180 元');assert.equal(await page.locator('[name=status]').inputValue(),'private');assert.equal(await page.locator('[name=guide_id]').inputValue(),'1');assert.equal(await page.locator('.record-photo-editor.is-cover [data-record-caption]').inputValue(),'午餐的鸭血粉丝汤');assert.equal(records.length,0);
 await page.locator('[data-record-ai=undo]').click();await page.waitForFunction(()=>!TravelEditor.busy&&!document.querySelector('[data-record-ai=undo]'));assert.equal(await page.locator('[name=title]').inputValue(),'');assert.equal((await syncBody()).trim(),'');
 await page.locator('[data-record-ai=apply]').click();await page.waitForSelector('[data-record-ai=undo]');await page.locator('[data-writing=source]').click();await page.locator('#record-body').fill('<p>自己补充的真实感受</p>'+tasks[0].proposal.body);assert.equal(await page.locator('[data-record-ai=undo]').isDisabled(),true);
 if(process.env.TRAVEL_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.TRAVEL_SCREENSHOT_DIR,'footprint-ai-'+width+'.png'),fullPage:true});
 await page.locator('#record-editor-form button[type=submit]').click();await page.waitForFunction(()=>location.hash==='#record-edit/20');await ready();assert.equal(records.length,1);assert.ok(records[0].body.includes('自己补充的真实感受'));assert.equal(records[0].record_assistant_task,100);
 await page.locator('#record-ai>summary').click();await page.locator('.record-ai-history>summary').click();await page.waitForSelector('[data-record-ai=select]');await page.locator('[data-record-ai=select]').click();await page.waitForSelector('.record-ai-preview');assert.equal(await page.locator('[data-record-ai=apply]').isDisabled(),true,'saved edited record cannot be overwritten by old unsaved snapshot');
 const recover={id:200,action:'record_generate',prompt:'恢复那次真实经历',status:'done',record_id:null,snapshot:clone(tasks[0].snapshot),updated_at:now()};recover.proposal=proposal(recover.snapshot);tasks.push(recover);
 await page.goto('http://footprint.test/admin#record-new?ai=200');await ready();await page.waitForSelector('.record-ai-preview');assert.equal(await page.locator('[name=destination]').inputValue(),'南京');assert.equal(await page.locator('[data-record-caption]').count(),2);assert.equal(await page.locator('[name=status]').inputValue(),'private');assert.equal(await page.locator('[data-record-ai=apply]').isDisabled(),false);await fit();
 await page.locator('[data-record-ai=apply]').click();await page.waitForSelector('[data-record-ai=undo]');await page.locator('#record-ai-prompt').fill('保留当前口吻，简洁一点。');await page.locator('[data-record-ai=polish]').click();await page.waitForSelector('[data-record-ai=cancel]');const polish=tasks.at(-1);assert.equal(polish.action,'record_polish');polish.status='done';polish.proposal=proposal(polish.snapshot);polish.updated_at=now();await page.waitForSelector('.record-ai-preview');assert.equal(await page.locator('#record-ai-meta').isChecked(),false,'polish defaults to preserving original title and summary');
 await page.goto('http://footprint.test/admin#travel-agent');await page.waitForSelector('[data-planner=select][data-id="100"]');await page.locator('[data-planner=select][data-id="100"]').click();await page.waitForSelector('#planner-detail a[href="#record-edit/20?ai=100"]');assert.ok((await page.locator('[data-planner=select][data-id="100"]').innerText()).includes('生成足迹'));assert.ok(!(await page.locator('[data-planner=select][data-id="100"]').innerText()).includes('undefined'));
 await page.locator('#planner-detail a').click();await ready();await page.waitForSelector('.record-ai-preview');assert.equal(await page.locator('[data-record-ai=apply]').isDisabled(),true);
 const end=calls.filter(c=>c.path.startsWith('/api/admin/record-assistant')).length;await page.waitForTimeout(600);assert.equal(calls.filter(c=>c.path.startsWith('/api/admin/record-assistant')).length,end,'finished tasks do not poll');assert.deepEqual(errors,[]);
 await ctx.close();console.log('PASS '+width+': lazy inline AI, JPEG album, background/hidden pause, preview/conflict/undo, preserve cover/cost/privacy/guide, explicit save, task recovery, polish metadata default, travel history links and responsive editor');
 }}finally{await browser.close();}})().catch(error=>{console.error(error);process.exit(1)});
