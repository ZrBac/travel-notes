// Offline media management interactions; no real account, files or server mutations.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL8AAAAASUVORK5CYII=','base64');
(async()=>{const b=await chromium.launch({args:['--no-sandbox']});try{for(const width of [1440,768,390,320]){
 const context=await b.newContext({viewport:{width,height:1000}}),p=await context.newPage(),errors=[],operations=[];let accept=true;
 p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>accept?d.accept():d.dismiss());
 const media=Array.from({length:30},(_,i)=>({filename:String(i).padStart(32,'0')+'.webp',url:'/media/'+String(i).padStart(32,'0')+'.webp',name:'照片 '+i,width:2000,height:1500,bytes:300000,deleted_at:null,references:i===0?[{id:1,title:'城市攻略',kind:'guide'},{id:2,title:'旅途记录',kind:'record'},{id:3,title:'秋游计划',kind:'travel-agent'}]:[]}));
 await context.route('**/*',async r=>{const u=new URL(r.request().url());assert.equal(u.origin,'http://media.test');
 if(u.pathname.startsWith('/api/')){
  if(u.pathname==='/api/session')return r.fulfill({json:{csrf:'fixture',user:{username:'tester',display_name:'测试'}}});
  if(u.pathname==='/api/admin/media')return r.fulfill({json:{media,defaults:[{url:'/static/assets/lake.jpg',name:'湖畔'}]}});
  if(u.pathname==='/api/admin/taxonomy')return r.fulfill({json:{categories:[],tags:[]}});
  if(u.pathname==='/api/admin/guides')return r.fulfill({json:{guides:[],total:0,page:1,pages:1}});
  if(u.pathname==='/api/records')return r.fulfill({json:{records:[],total:0,page:1,pages:1}});
  if(u.pathname.startsWith('/api/admin/media/')){
   const d=r.request().postDataJSON();if(!d.filenames)d.filenames=[u.pathname.split('/').pop()];operations.push(d);assert.equal(r.request().method(),'POST');assert.equal(r.request().headers()['x-csrf-token'],'fixture');
   for(const filename of d.filenames){const row=media.find(m=>m.filename===filename);assert.ok(row);if(d.action==='trash')assert.equal(row.references.length,0);if(d.action==='purge'){assert.ok(row.deleted_at);assert.equal(row.references.length,0);media.splice(media.indexOf(row),1);}else row.deleted_at=d.action==='trash'?'2026-09-23':null;}
   return r.fulfill({json:{ok:true,count:d.filenames.length}});
  }
  throw Error('Unexpected API '+u.pathname);
 }
 if(u.pathname.startsWith('/media/')||u.pathname.endsWith('.jpg'))return r.fulfill({body:pixel,contentType:'image/png'});
 const file=path.join(root,u.pathname==='/admin'?'static/admin.html':u.pathname);return r.fulfill({body:fs.readFileSync(file),contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});
 });
 await p.goto('http://media.test/admin#media');await p.waitForSelector('.media-card');
 assert.equal(await p.locator('#admin-page-refresh').count(),0);assert.equal(await p.locator('.topbar button').count(),0);
 assert.ok(!(await p.locator('#main').innerText()).includes('收起'));assert.equal(await p.locator('.media-check:disabled').count(),1);
 assert.equal(await p.locator('[data-action=media-update][data-value=trash]:disabled').count(),1);
 await p.locator('[data-action=media-refs]').click();await p.waitForSelector('#dialog[open]');const info=await p.locator('#dialog').innerText();for(const label of ['使用位置','攻略 · 城市攻略','旅行足迹 · 旅途记录','旅游助手 · 秋游计划'])assert.ok(info.includes(label));await p.locator('button[data-action=close-dialog]').click();
 await p.locator('#media-select-page').check();assert.equal(await p.locator('.media-check:checked').count(),23);assert.equal(await p.locator('#media-selected-count').innerText(),'已选 23 张');
 accept=false;await p.locator('[data-action=media-bulk]').click();assert.equal(operations.length,0);accept=true;
 await p.locator('[data-action=media-clear]').click();assert.equal(await p.locator('.media-check:checked').count(),0);
 await p.locator('.media-check:not(:disabled)').nth(0).check();await p.locator('.media-check:not(:disabled)').nth(1).check();assert.ok(await p.locator('#media-select-page').evaluate(n=>n.indeterminate));
 await p.locator('[data-action=media-bulk]').click();await p.waitForFunction(()=>document.querySelector('#toast').textContent==='已将 2 张图片移入回收站'&&!state.mediaBusy);await p.waitForFunction(()=>!document.querySelector('#main').hasAttribute('aria-busy'));
 assert.equal(operations[0].action,'trash');assert.equal(operations[0].filenames.length,2);assert.equal(await p.locator('.media-check:checked').count(),0);
 await p.locator('[data-action=media-tab][data-value=trash]').click();await p.waitForFunction(()=>document.querySelectorAll('.media-card').length===2);await p.locator('#media-select-page').check();await p.locator('[data-action=media-bulk][data-value=restore]').click();await p.waitForFunction(()=>document.querySelector('#toast').textContent==='已恢复 2 张图片'&&!state.mediaBusy);await p.waitForSelector('#media-grid .empty');assert.equal(operations[1].action,'restore');
 await p.locator('[data-action=media-tab][data-value=active]').click();await p.waitForSelector('.media-card');await p.locator('.media-check:not(:disabled)').first().check();await p.locator('[data-action=media-page][data-page="2"]').click();assert.equal(await p.locator('.media-check:checked').count(),0,'selection cannot silently spill into another page');
 await p.locator('[data-action=media-tab][data-value=defaults]').click();await p.waitForFunction(()=>document.querySelector('#media-selection')?.hidden===true);assert.equal(await p.locator('.media-check').count(),0);
 await p.locator('[data-action=media-tab][data-value=active]').click();await p.waitForSelector('.media-card');
 const checkbox=await p.locator('.media-check:not(:disabled)').first().boundingBox(),target=await p.locator('.media-select').first().boundingBox();assert.equal(checkbox.width,21);assert.equal(target.width,44);assert.equal((await p.locator('.media-select').first().innerText()).trim(),'');
 await p.locator('.media-check:not(:disabled)').nth(0).check();await p.locator('.media-check:not(:disabled)').nth(1).check();
 await p.locator('[data-action=media-bulk][data-value=trash]').click();await p.waitForFunction(()=>!state.mediaBusy&&state.mediaSelected.size===0);
 await p.locator('[data-action=media-tab][data-value=trash]').click();await p.waitForFunction(()=>document.querySelectorAll('.media-card').length===2);
 assert.equal(await p.locator('[data-action=media-update][data-value=purge]').count(),2);
 const before=operations.length;accept=false;await p.locator('[data-action=media-update][data-value=purge]').first().click();assert.equal(operations.length,before);accept=true;
 await p.locator('[data-action=media-update][data-value=purge]').first().click();await p.waitForFunction(()=>document.querySelectorAll('.media-card').length===1);assert.equal(operations.at(-1).action,'purge');
 await p.locator('#media-select-page').check();await p.locator('[data-action=media-bulk][data-value=purge]').click();await p.waitForSelector('#media-grid .empty');assert.equal(operations.at(-1).action,'purge');
 for(const [route,label,active]of [['guides','攻略列表切换','攻略列表'],['trash','攻略列表切换','回收站'],['records','足迹列表切换','足迹列表'],['record-trash','足迹列表切换','回收站']]){
  await p.evaluate(h=>location.hash=h,route);await p.waitForSelector('.tabs[aria-label="'+label+'"]');await p.waitForFunction(t=>document.querySelector('.tabs .active')?.textContent===t,active);
  assert.equal(await p.locator('.sidebar a[href="#trash"]').count(),0);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'tabs overflow '+width);
 }
 await p.evaluate(()=>location.hash='media');await p.waitForSelector('[data-action=media-tab][data-value=active]');await p.locator('[data-action=media-tab][data-value=active]').click();await p.waitForSelector('.media-card');
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overflow '+width);
 if(process.env.MEDIA_SCREENSHOT_DIR)await p.screenshot({path:process.env.MEDIA_SCREENSHOT_DIR+'/media-'+width+'.png',fullPage:false});
 assert.deepEqual(errors,[]);await context.close();
}console.log('PASS: clear labels, no header refresh, usage links, protected used images, selection/cancel/delete/restore/purge/page reset, unified trash tabs, desktop and mobile');}finally{await b.close();}})().catch(e=>{console.error(e);process.exit(1)});
