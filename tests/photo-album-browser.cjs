// Synthetic fixtures exercise actual editor/album code at phone and desktop widths.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');const root=path.resolve(__dirname,'..');
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const clone=v=>JSON.parse(JSON.stringify(v));
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{for(const width of [320,390,1440]){
 const ctx=await browser.newContext({viewport:{width,height:900}}),p=await ctx.newPage();p.setDefaultTimeout(20000);const errors=[],calls=[],tasks=[];let uploads=0,saved=null;
 p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());
 await ctx.route('**/*',async r=>{const u=new URL(r.request().url()),method=r.request().method();assert.equal(u.origin,'http://album.test');
  if(u.pathname.startsWith('/api/')){const data=r.request().headers()['content-type']?.includes('application/json')?r.request().postDataJSON():null;calls.push(u.pathname);
   if(u.pathname==='/api/session')return r.fulfill({json:{csrf:'test',user:{username:'admin',display_name:'管理员'}}});
   if(u.pathname==='/api/guides')return r.fulfill({json:{guides:[]}});
   if(u.pathname==='/api/upload'){uploads++;return r.fulfill({status:201,json:{url:'/media/'+String(uploads).padStart(32,'0')+'.webp'}});}
   if(u.pathname==='/api/admin/preview')return r.fulfill({json:{html:'<p>'+data.body+'</p>'}});
   if(u.pathname==='/api/admin/photo-album/preview'){
    const info=(i,date,extra={})=>({index:i,...data.record.photos[i],taken_at:date+'T10:30:00',day:date,suggested:true,quality_note:'',...extra});
    return r.fulfill({json:{album:{items:[info(2,'2026-11-06',{gps:{lat:31.2,lng:121.5}}),info(0,'2026-11-07',{similar_group:1,recommended:true}),info(1,'2026-11-07',{similar_group:1,recommended:false,suggested:false})],dates:{start_date:'2026-11-06',end_date:'2026-11-07'},similar_groups:1,missing_dates:0}}});
   }
   if(u.pathname==='/api/admin/record-assistant/tasks'&&method==='POST'){
    assert.equal(data.action,'record_photos');assert.equal(data.record.destination,'');assert.equal(data.record.photos.length,3);
    const t={id:10+tasks.length,action:data.action,prompt:data.prompt,snapshot:clone(data.record),record_id:null,status:'done',updated_at:new Date().toISOString(),proposal:{photos:data.record.photos.map((photo,i)=>({index:i,url:photo.url,marker:'[[相册0'+(i+1)+']]',original_caption:photo.caption,caption:['湖边的木船','石板街边的建筑','午餐的一碗面条'][i],subject:['风景','人文','美食'][i],highlight:i!==1,confidence:'high',place_hint:'',quality_note:''})),warnings:[]}};tasks.push(t);return r.fulfill({status:201,json:{id:t.id}});
   }
   if(/^\/api\/admin\/record-assistant\/tasks\/\d+$/.test(u.pathname)){const t=tasks.find(t=>t.id===Number(u.pathname.split('/').at(-1)));return r.fulfill({json:{task:clone(t)}});}
   if(/^\/api\/admin\/record-assistant\/tasks\/\d+\/preview$/.test(u.pathname)){const t=tasks.find(t=>t.id===Number(u.pathname.split('/').at(-2)));assert.deepEqual(data.record,t.snapshot);return r.fulfill({json:{proposal:clone(t.proposal)}});}
   if(u.pathname==='/api/records'&&method==='POST'){saved={...clone(data),id:20,revision:1,html:data.body};return r.fulfill({status:201,json:{id:20}});}
   if(u.pathname==='/api/records/20')return r.fulfill({json:{record:saved,guide:null}});
   throw Error('Unexpected '+method+' '+u.pathname);
  }
  if(u.pathname.startsWith('/media/'))return r.fulfill({body:image,contentType:'image/png'});
  const file=path.join(root,u.pathname==='/admin'?'static/admin.html':u.pathname.slice(1));assert.ok(file.startsWith(root+'/'));assert.ok(fs.existsSync(file),file);return r.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream'});
 });
 const ready=()=>p.waitForFunction(()=>typeof TravelEditor!=='undefined'&&!TravelEditor.busy&&!!document.querySelector('#record-album'));
 const fit=async()=>assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow '+width);
 await p.goto('http://album.test/admin#record-new');await ready();await fit();assert.equal(calls.filter(x=>x.includes('photo-album')||x.includes('record-assistant')).length,0,'no album or model request on normal editor open');
 await p.locator('[name=start_date]').fill('2026-11-05');await p.locator('[name=end_date]').fill('2026-11-09');await p.locator('[name=actual_cost]').fill('实际花费 120 元');
 await p.locator('#record-photos-input').setInputFiles(['a','b','c'].map(x=>({name:x+'.jpeg',mimeType:'image/jpeg',buffer:image})));await p.waitForFunction(()=>document.querySelectorAll('[data-record-caption]').length===3&&!document.querySelector('#record-photos-input').disabled);
 await p.locator('[data-record-caption="0"]').fill('自己写的湖边回忆');await p.locator('[data-record-action=cover][data-index="2"]').click();
 await p.locator('#record-album>summary').click();await p.locator('[data-record-album=preview]').click();await p.waitForSelector('[data-record-album=apply]');assert.equal(await p.locator('[data-album-select]:checked').count(),3,'all retained by default');await fit();
 await p.locator('[name=summary]').fill('刚补充的经历');assert.equal(await p.locator('[data-record-album=apply]').isDisabled(),true);await p.locator('[name=summary]').fill('');assert.equal(await p.locator('[data-record-album=apply]').isDisabled(),false);
 await p.locator('[data-record-album=suggest]').click();assert.equal(await p.locator('[data-album-select]:checked').count(),2);await p.locator('#record-album-dates').check();await p.locator('[data-record-album=apply]').click();assert.equal(await p.locator('[data-record-caption]').count(),2);assert.equal(await p.locator('[name=start_date]').inputValue(),'2026-11-06');assert.equal(await p.locator('.is-cover [data-record-caption]').inputValue(),'');assert.equal(saved,null);await p.locator('[data-record-action=cover][data-index="1"]').click();assert.equal(await p.locator('[data-record-album=undo]').isDisabled(),true,'manual cover change is protected');await p.locator('[data-record-action=cover][data-index="0"]').click();assert.equal(await p.locator('[data-record-album=undo]').isDisabled(),false);
 await p.locator('[data-record-album=undo]').click();assert.equal(await p.locator('[data-record-caption]').count(),3);assert.equal(await p.locator('[name=start_date]').inputValue(),'2026-11-05');assert.equal(await p.locator('[name=end_date]').inputValue(),'2026-11-09');assert.equal(await p.locator('[data-record-caption="0"]').inputValue(),'自己写的湖边回忆');
 await p.locator('[data-record-album=recognize]').click();await p.waitForSelector('.record-photo-suggestion');assert.equal(tasks.length,1);assert.equal(await p.locator('.record-photo-suggestion').count(),3);assert.equal(await p.locator('[data-record-caption="1"]').inputValue(),'','preview does not auto-fill');assert.equal(await p.locator('#record-ai-overwrite').isChecked(),false);await fit();
 await p.locator('[data-photo-ai-caption="1"]').fill('修正后的街边建筑');await p.locator('[data-record-ai=apply]').click();await p.waitForSelector('[data-record-ai=undo]');assert.equal(await p.locator('[data-record-caption="0"]').inputValue(),'自己写的湖边回忆');assert.equal(await p.locator('[data-record-caption="1"]').inputValue(),'修正后的街边建筑');assert.equal(await p.locator('.is-cover [data-record-caption]').inputValue(),'午餐的一碗面条');assert.equal(await p.locator('[name=status]').inputValue(),'private');assert.equal(await p.locator('[name=actual_cost]').inputValue(),'实际花费 120 元');assert.equal(saved,null);await p.locator('[data-record-action=cover][data-index="1"]').click();assert.equal(await p.locator('[data-record-ai=undo]').isDisabled(),true,'caption undo protects changed cover');await p.locator('[data-record-action=cover][data-index="2"]').click();
 await p.locator('[data-record-ai=undo]').click();assert.equal(await p.locator('[data-record-caption="1"]').inputValue(),'');await p.locator('#record-ai-overwrite').check();await p.locator('[data-record-ai=apply]').click();await p.waitForSelector('[data-record-ai=undo]');assert.equal(await p.locator('[data-record-caption="0"]').inputValue(),'湖边的木船');
 await p.locator('[data-record-caption="2"]').fill('自己后来补充的面条');assert.equal(await p.locator('[data-record-ai=undo]').isDisabled(),true);
 if(process.env.TRAVEL_SCREENSHOT_DIR)await p.screenshot({path:path.join(process.env.TRAVEL_SCREENSHOT_DIR,'photo-album-'+width+'.png'),fullPage:true});
 await p.locator('[name=destination]').fill('南京');await p.locator('[name=title]').fill('家人出游');await p.locator('#record-editor-form button[type=submit]').click();await p.waitForFunction(()=>location.hash==='#record-edit/20');await ready();assert.equal(saved.photos.length,3);assert.equal(saved.status,'private');assert.equal(saved.record_assistant_task,10);assert.equal(saved.photos[2].caption,'自己后来补充的面条');assert.equal(saved.cover,saved.photos[2].url);await fit();assert.deepEqual(errors,[]);
 await ctx.close();console.log('PASS '+width+': lazy album facts, day grouping/selection preview, stale guard, opt-in dates, cover/undo, real-image captions preview, preserve manual captions, corrected captions, private explicit save');
 }}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
