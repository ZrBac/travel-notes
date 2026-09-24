// Real HTTP + real Service Worker + offline network, with synthetic public/private data only.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),staticRoot=path.join(root,'static');
let visible=true,failImages=false,apiUnavailable=false,version='fixture1',delayImages=false;const requests=[];
const img1='/media/'+'a'.repeat(32)+'.webp',img2='/media/'+'b'.repeat(32)+'.webp';
const guide={id:1,title:'四天三晚 · 离线旅行测试',destination:'泉州',country:'中国',days:4,summary:'古城与闽南风味',cover:img1,tags:[],status:'public',updated_at:'2026-09-24T00:00:00Z',html:'<h2>第一天 · 古城</h2><p>步行路线：开元寺 → 西街 → 钟楼。</p><img src="'+img1+'?w=1280" alt="古城实景"><h2>当地风味</h2><img src="'+img2+'" alt="面线糊"><table><tr><th>交通</th><th>预算</th></tr><tr><td>'+('交通路线'.repeat(25))+'</td><td>200 元</td></tr></table>',sources:'模拟公开资料'};
function html(){return fs.readFileSync(path.join(staticRoot,'index.html'),'utf8').replace(/((?:src|href)="\/static\/([^"?]+\.(?:js|css)))(?=")/g,(_,a,b)=>a+'?v='+crypto.createHash('sha256').update(fs.readFileSync(path.join(staticRoot,b))).digest('hex').slice(0,16));}
function worker(){const h=html(),assets=[...h.matchAll(/(?:src|href)="(\/static\/[^"<>]+)"/g)].map(m=>m[1]);for(const i of JSON.parse(fs.readFileSync(path.join(staticRoot,'manifest.webmanifest'))).icons)assets.push(i.src);return fs.readFileSync(path.join(staticRoot,'pwa-worker.js'),'utf8').replace('__BUILD__',version).replace('__ASSETS__',JSON.stringify([...new Set(assets)]));}
(async()=>{
 const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');requests.push({path:u.pathname,cookie:req.headers.cookie||'',method:req.method});
  const send=(type,body,status=200)=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);};
  if(u.pathname==='/sw.js')return send('application/javascript',worker());
  if(u.pathname==='/manifest.webmanifest')return send('application/manifest+json',fs.readFileSync(path.join(staticRoot,'manifest.webmanifest')));
  if(u.pathname==='/api/bootstrap')return send('application/json',JSON.stringify({site:{site_name:'行笺',tagline:'测试旅行手记',footer:'记录旅程'},session:{authenticated:false,csrf:'NEVER-CACHE-SESSION'},guides:[guide],records:[],record_count:0}));
  if(u.pathname==='/api/guides/1')return send('application/json',JSON.stringify(visible&&!apiUnavailable?{guide}:{error:'这篇攻略暂未公开'}),apiUnavailable?503:visible?200:404);
  if(u.pathname==='/api/records')return send('application/json',JSON.stringify({records:[],total:0,pages:1,page:1,years:[],destinations:[]}));
  if(u.pathname.startsWith('/media/')){const reply=()=>send('image/png',fs.readFileSync(path.join(staticRoot,'assets/pwa-icon-192.png')),failImages?503:200);if(delayImages)setTimeout(reply,1500);else reply();return;}
  if(u.pathname==='/admin')return send('text/html','<p>PRIVATE ADMIN FIXTURE</p>');
  if(u.pathname==='/')return send('text/html',html());
  const file=path.resolve(root,'.'+u.pathname);if(!file.startsWith(root+'/')||!fs.existsSync(file))return send('text/plain','missing',404);
  send(({'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream',fs.readFileSync(file));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{
  const ctx=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2}),p=await ctx.newPage(),errors=[];
  p.on('pageerror',e=>errors.push(e.message));await ctx.addCookies([{name:'admin_fixture',value:'must-not-leak',url:base}]);
  await p.goto(base);await p.waitForSelector('.journal-lead');await p.evaluate(()=>navigator.serviceWorker.ready);await p.waitForFunction(()=>!!navigator.serviceWorker.controller);
  assert.equal(await p.locator('#mobile-navigation a').count(),3);
  assert.equal(await p.locator('#navigation a').count(),3);
  assert.equal(await p.locator('#navigation a[href="#offline"],#mobile-navigation a[href="#offline"]').count(),0);
  assert.equal(await p.locator('.footer [data-pwa=install]').count(),0);
  await p.locator('#site-more summary').click();await p.keyboard.press('Escape');assert.equal(await p.locator('#site-more').evaluate(n=>n.open),false);
  await p.locator('#site-more summary').click();await p.locator('.brand').click();assert.equal(await p.locator('#site-more').evaluate(n=>n.open),false);
  await p.locator('#site-more summary').click();await p.locator('#site-more a[href="#offline"]').click();await p.waitForSelector('.pwa-library-intro');assert.equal(await p.locator('#site-more').evaluate(n=>n.open),false);
  await p.locator('#site-more summary').click();await p.locator('#site-more [data-pwa=install]').click();await p.waitForSelector('#pwa-install[open]');await p.locator('[data-pwa=close-install]').last().click();
  await p.evaluate(()=>location.hash='guide/1');await p.waitForSelector('[data-pwa=save]');await p.locator('[data-pwa=save]').click();
  await p.waitForFunction(async()=>await TravelPWA.has(1));await p.waitForFunction(()=>document.querySelector('#pwa-progress').hidden);
  assert.ok(requests.filter(r=>r.path.startsWith('/api/')||r.path.startsWith('/media/')).every(r=>!r.cookie),'public downloads must not send admin cookies');
  const cached=await p.evaluate(async()=>{const result=[];for(const k of await caches.keys())for(const r of await (await caches.open(k)).keys())result.push(new URL(r.url).pathname);return result;});
  assert.ok(cached.includes('/'));assert.ok(cached.every(u=>u==='/'||u.startsWith('/static/')));assert.ok(!cached.some(u=>u.startsWith('/api/')||u.startsWith('/media/')||u.startsWith('/admin')));
  await ctx.setOffline(true);await p.reload();await p.waitForSelector('.pwa-snapshot');
  await p.waitForFunction(()=>[...document.querySelectorAll('.prose img,.detail-cover')].every(img=>img.complete&&img.naturalWidth>0));
  assert.equal(await p.locator('.prose img').count(),2);assert.ok((await p.locator('.prose').innerText()).includes('开元寺'));
  for(const width of [320,390,768,1440]){await p.setViewportSize({width,height:900});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal page overflow '+width);}
  await p.setViewportSize({width:390,height:844});await p.screenshot({path:process.env.PWA_TEST_SCREENSHOT||'/tmp/travel-pwa-offline-phone.png',fullPage:true});
  await p.evaluate(()=>location.hash='offline');await p.waitForSelector('.pwa-saved-card');await p.reload();await p.waitForSelector('.pwa-saved-card');
  await p.locator('.pwa-saved-actions .primary').click();await p.waitForSelector('.pwa-snapshot');
  for(const route of ['/admin','/?preview=1']){const blocked=await ctx.newPage();let failed=false;try{await blocked.goto(base+route,{timeout:5000});}catch{failed=true;}assert.ok(failed,'no offline admin/preview fallback');await blocked.close();}
  await ctx.setOffline(false);await p.waitForFunction(()=>state.guides.length===1&&!state.bootstrapOffline);await p.evaluate(()=>location.hash='guide/1');await p.waitForSelector('[data-pwa=save]');apiUnavailable=true;
  await p.locator('[data-pwa=save]').click();await p.waitForFunction(()=>document.querySelector('#pwa-progress').hidden);assert.equal(await p.evaluate(()=>TravelPWA.has(1)),true);apiUnavailable=false;
  failImages=true;await p.locator('[data-pwa=save]').click();await p.waitForFunction(()=>document.querySelector('#pwa-progress').hidden);await p.evaluate(()=>location.hash='offline/1');await p.waitForSelector('.pwa-image-missing');assert.ok((await p.locator('.pwa-snapshot').innerText()).includes('部分图片未保存'));failImages=false;
  await p.evaluate(()=>location.hash='guide/1');await p.waitForSelector('[data-pwa=save]');await p.locator('[data-pwa=save]').click();await p.waitForFunction(()=>document.querySelector('#pwa-progress').hidden);
  // Quota failure must leave the old snapshot intact (metadata fixture avoids allocating 100 MB).
  await p.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('travel-offline',1);r.onsuccess=()=>{const db=r.result,tx=db.transaction('catalog','readwrite');tx.objectStore('catalog').put({id:99,title:'Space fixture',bytes:100*1024*1024,savedAt:'2026-01-01'});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=reject;};}));
  await p.locator('[data-pwa=save]').click();await p.waitForFunction(()=>document.querySelector('#pwa-progress').hidden);assert.ok((await p.locator('#toast').innerText()).includes('空间已满'));assert.equal(await p.evaluate(()=>TravelPWA.has(1)),true);
  await p.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('travel-offline',1);r.onsuccess=()=>{const db=r.result,tx=db.transaction('catalog','readwrite');tx.objectStore('catalog').delete(99);tx.oncomplete=()=>{db.close();resolve();};};}));
  delayImages=true;await p.locator('[data-pwa=save]').click();await p.locator('[data-pwa=cancel]').click();await p.waitForFunction(()=>document.querySelector('#pwa-progress').hidden);assert.equal(await p.evaluate(()=>TravelPWA.has(1)),true);assert.ok((await p.locator('#toast').innerText()).includes('已取消'));delayImages=false;
  version='fixture2';await p.evaluate(async()=>{const reg=await navigator.serviceWorker.getRegistration();await reg.update();});await p.waitForSelector('[data-pwa=update-app]');await p.locator('[data-pwa=update-app]').click();await p.waitForSelector('.article-header');assert.equal(await p.evaluate(()=>TravelPWA.has(1)),true);
  visible=false;await p.evaluate(()=>location.hash='offline/1');await p.waitForFunction(()=>document.querySelector('#app').textContent.includes('不再公开'));assert.equal(await p.evaluate(()=>TravelPWA.has(1)),false);
  await p.evaluate(()=>location.hash='offline');await p.waitForFunction(()=>document.querySelector('#app').textContent.includes('行囊还是空的'));
  visible=true;await p.evaluate(()=>location.hash='guide/1');await p.waitForSelector('[data-pwa=save]');await p.locator('[data-pwa=save]').click();await p.waitForFunction(()=>document.querySelector('#pwa-progress').hidden);await p.evaluate(()=>location.hash='offline');await p.waitForSelector('[data-pwa=remove]');p.once('dialog',d=>d.accept());await p.locator('[data-pwa=remove]').click();await p.waitForFunction(async()=>!await TravelPWA.has(1));
  const preview=await ctx.newPage();await preview.goto(base+'/?preview=1#guide/1');await preview.waitForSelector('.article-header');assert.equal(await preview.locator('[data-pwa=save]').count(),0);
  assert.deepEqual(errors,[]);await ctx.close();
  for(const mode of ['browser','ios','display-mode']){
   const context=await browser.newContext({viewport:{width:390,height:844}});
   await context.addInitScript(mode=>{
    window.fixtureInstalled=mode!=='browser';
    Object.defineProperty(navigator,'standalone',{configurable:true,get:()=>mode==='ios'&&window.fixtureInstalled});
    const original=window.matchMedia.bind(window),display=new EventTarget();
    Object.defineProperty(display,'matches',{get:()=>mode!=='ios'&&window.fixtureInstalled});display.media='(display-mode: standalone)';
    window.matchMedia=q=>q===display.media?display:original(q);
    window.changeDisplayMode=value=>{window.fixtureInstalled=value;display.dispatchEvent(new Event('change'));};
   },mode);
   const page=await context.newPage(),issues=[];page.on('pageerror',e=>issues.push(e.message));
   await page.goto(base);await page.waitForSelector('.journal-lead');
   const installed=mode!=='browser',labels=installed?['首页','攻略','足迹','离线']:['首页','攻略','足迹'];
   for(const width of [320,390,768,844,1440]){
    await page.setViewportSize({width,height:844});
    const nav=width<=640?'#mobile-navigation':'#navigation';
    assert.deepEqual(await page.locator(nav+' a > span:first-of-type').allInnerTexts(),labels,mode+' '+width);
    assert.ok(await page.locator(nav).isVisible());
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(width<=640){const boxes=await page.locator(nav+' a').evaluateAll(ns=>ns.map(n=>n.getBoundingClientRect().width));assert.ok(Math.max(...boxes)-Math.min(...boxes)<1,'equal tab widths');}
    await page.locator('#site-more summary').click();
    assert.equal(await page.locator('#browser-tools').isVisible(),!installed);
    assert.equal(await page.locator('#site-more summary span').innerText(),installed?'浏览':'更多');
    assert.ok(await page.locator('.site-more-panel').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
    await page.keyboard.press('Escape');
    if(width===390)await page.screenshot({path:'/tmp/travel-context-nav-'+mode+'.png',fullPage:true});
   }
   await page.setViewportSize({width:390,height:844});
   if(installed){await page.locator('#mobile-navigation [href="#offline"]').click();await page.waitForSelector('.pwa-library-intro');assert.equal(await page.locator('#mobile-navigation [aria-current=page]').innerText(),'离线');assert.equal(await page.locator('#site-more').evaluate(n=>n.classList.contains('has-current')),false);}
   else{await page.locator('#mobile-navigation [href="#guides"]').click();await page.waitForSelector('#search');await page.locator('#search').fill('泉州');await page.evaluate(()=>{window.previousContent=document.querySelector('#app').firstChild;changeDisplayMode(true);});assert.equal(await page.locator('#mobile-navigation a').count(),4);assert.equal(await page.locator('#search').inputValue(),'泉州');assert.ok(await page.evaluate(()=>previousContent===document.querySelector('#app').firstChild),'mode switch preserves page and form');await page.evaluate(()=>changeDisplayMode(false));assert.equal(await page.locator('#mobile-navigation a').count(),3);}
   assert.deepEqual(issues,[]);await context.close();
  }
  console.log('PASS: browser / iOS home-screen / standalone navigation, 320–1440px and landscape, offline selection, hidden redundant tools, live mode changes preserve content');
  console.log('PASS: real SW installation/update; anonymous downloads; offline cold reload, text and images; responsive widths; no API/admin/preview caching; failed update/quota/cancel preservation; reconnect refresh; missing-image labels; visibility revocation; deletion; preview exclusion');
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
