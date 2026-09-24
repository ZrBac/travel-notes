// Synthetic fixtures only: versioned task results and cancellable record album images.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');const root=path.resolve(__dirname,'..');
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}}),page=await ctx.newPage(),errors=[];
 let stamp='2026-09-24T01:00:00Z',status='done',details=0,lists=0;
 const photos=Array.from({length:30},(_,i)=>({url:'/media/'+String(i+1).padStart(32,'0')+'.webp',caption:''}));
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL8AAAAASUVORK5CYII=','base64');
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{const fetch=window.fetch;window.imageStats={active:0,max:0,aborted:0,loaded:0};window.fetch=async(url,opts={})=>{
  if(!String(url).includes('/media/'))return fetch(url,opts);
  imageStats.active++;imageStats.max=Math.max(imageStats.max,imageStats.active);
  try{await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,500);opts.signal?.addEventListener('abort',()=>{clearTimeout(timer);imageStats.aborted++;reject(new DOMException('Aborted','AbortError'));},{once:true});});const r=await fetch(url,opts);imageStats.loaded++;return r;}finally{imageStats.active--;}
 };});
 await ctx.route('**/*',async r=>{const u=new URL(r.request().url());assert.equal(u.origin,'http://cache.test');const task={id:1,prompt:'四天旅行',status,created_at:stamp,updated_at:stamp,trip:{destination:'泉州',days:4,people:1},result:'完成',progress:[],guide:{title:'泉州旅行',summary:'城市与美食',destination:'泉州',days:4},html:'<p>攻略正文</p>'};
  if(u.pathname==='/api/session')return r.fulfill({json:{csrf:'fixture',user:{username:'test',display_name:'测试'}}});
  if(u.pathname==='/api/admin/travel-agent'){lists++;return r.fulfill({json:{tasks:[task],service:{online:true,authenticated:true},next_before:null}});}
  if(u.pathname==='/api/admin/travel-agent/tasks/1'){details++;assert.equal(u.searchParams.has('updated'),status==='done');return r.fulfill({json:{task}});}
  if(u.pathname==='/api/admin/travel-agent/tasks/1/publication')return r.fulfill({json:{guides:[{title:'泉州',days:4,summary:'预览',html:'<img src="'+photos[0].url+'">'}]}});
  if(u.pathname==='/api/test-write'){assert.equal(r.request().method(),'POST');return r.fulfill({json:{ok:true}});}
  assert.equal(r.request().method(),'GET');
  if(u.pathname==='/api/records/1')return r.fulfill({json:{record:{id:1,title:'相册测试',destination:'泉州',status:'private',start_date:'2026-09-24',body:'手记',html:'<p>手记</p>',photos,cover:photos[0].url}}});
  if(u.pathname==='/api/guides')return r.fulfill({json:{guides:[]}});
  if(u.pathname.startsWith('/media/')){assert.ok(['320','480','640'].includes(u.searchParams.get('w')));return r.fulfill({contentType:'image/png',body:image});}
  const f=path.join(root,u.pathname==='/admin'?'static/admin.html':u.pathname);return r.fulfill({body:fs.readFileSync(f),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(f)]||'application/octet-stream'});
 });
 await page.goto('http://cache.test/admin#travel-agent');await page.waitForSelector('.planner-prose');assert.equal(details,1);
 const visit=hash=>page.evaluate(async h=>{history.replaceState(null,'','#'+h);await route();},hash);
 const revisit=async()=>{await visit('account');await visit('travel-agent');};
 await revisit();assert.equal(lists,2);assert.equal(details,1,'fresh task list can reuse same completed result');
 stamp='2026-09-24T02:00:00Z';await revisit();assert.equal(details,2,'changed task version reloads body');
 status='running';await revisit();await revisit();assert.equal(details,4,'running tasks always fetch current state');
 status='done';stamp='2026-09-24T03:00:00Z';await revisit();assert.equal(details,5);
 await page.evaluate(()=>api('/test-write',{method:'POST',body:{}}));await revisit();assert.equal(details,6,'mutations invalidate task cache');
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await revisit();assert.equal(details,7,'hidden tab drops task results');
 await page.locator('[data-planner=publication-preview]').click();await page.waitForSelector('#planner-publication img[data-admin-src]',{state:'attached'});await page.locator('[data-planner=close-publication]').click();
 await visit('record-edit/1');assert.equal(await page.locator('#record-photo-grid img[data-admin-src]').count(),30);
 await page.locator('#record-photo-grid').scrollIntoViewIfNeeded();await page.waitForFunction(()=>imageStats.active>0);
 await page.waitForFunction(()=>imageStats.loaded>=2);assert.ok(await page.evaluate(()=>imageStats.max<=2),'album concurrency limited to two');
 await page.locator('#record-photo-grid').evaluate(el=>el.lastElementChild.scrollIntoView());await page.waitForFunction(()=>imageStats.active>0);
 await visit('account');await page.waitForFunction(()=>imageStats.active===0);assert.ok(await page.evaluate(()=>imageStats.aborted>0),'leaving album aborts outstanding images');
 assert.deepEqual(errors,[]);await ctx.close();console.log('PASS: completed task cache/version/active task/write/visibility boundaries; album thumbnails, two-image concurrency and navigation cancellation');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
