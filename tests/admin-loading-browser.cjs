// Synthetic, offline checks: never reads credentials or writes to a real website.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const media=Array.from({length:80},(_,i)=>({url:'/media/'+(i+1).toString(16).padStart(32,'0')+'.webp',filename:(i+1).toString(16).padStart(32,'0')+'.webp',name:'照片 '+String(i+1).padStart(3,'0'),width:2400,height:1800,bytes:300000,references:[],deleted_at:null}));
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL8AAAAASUVORK5CYII=','base64');
(async()=>{const b=await chromium.launch({args:['--no-sandbox']});try{
 for(const width of [1440,390,320]){
  const context=await b.newContext({viewport:{width,height:900}}),p=await context.newPage();
  let siteDelay=0,mediaDelay=0,taxDelay=0,taxPending=false,guidesParallel=false,detailCalls=0,mediaCalls=0,taxCalls=0;const errors=[],writes=[];
  p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(()=>{
   const now=Date.now;window.clockOffset=0;Date.now=()=>now()+window.clockOffset;
   const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,ms===15000?1200:ms,...args);
   const fetch=window.fetch;window.abortedReads=[];
   window.fetch=(url,options={})=>{
    options.signal?.addEventListener('abort',()=>window.abortedReads.push(String(url)),{once:true});
    if(window.slowBody&&String(url)==='/api/site')return Promise.resolve({ok:true,status:200,json:()=>new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});})});
    return fetch(url,options);
   };
  });
  await context.route('**/*',async r=>{
   const u=new URL(r.request().url());assert.equal(u.origin,'http://admin.test');
   if(u.pathname.startsWith('/api/')){
    const method=r.request().method();let data,status=200,delay=0;
    if(method!=='GET'){assert.equal(u.pathname,'/api/test-write');writes.push({method,body:r.request().postDataJSON(),csrf:r.request().headers()['x-csrf-token']});delay=1600;data={ok:true};}
    else if(u.pathname==='/api/session')data={csrf:'test-csrf',user:{username:'tester',display_name:'测试管理员'}};
    else if(u.pathname==='/api/admin/media'){mediaCalls++;delay=mediaDelay;data={media,defaults:[]};}
    else if(u.pathname==='/api/admin/taxonomy'){taxCalls++;delay=taxDelay;taxPending=!!delay;data={categories:[],tags:[]};}
    else if(u.pathname==='/api/admin/guides'){if(taxPending||taxCalls===0)guidesParallel=true;data={guides:[],total:0,page:1,pages:1};}
    else if(u.pathname==='/api/guides/1'){detailCalls++;data={guide:{id:1,body:'编辑正文'}};}
    else if(u.pathname==='/api/site'){delay=siteDelay;data={site_name:'测试',tagline:'测试简介',footer:'测试页脚',show_samples:false};}
    else if(u.pathname==='/api/test-expired'){status=401;data={error:'请登录管理后台'};}
    else throw Error('Unexpected API '+u.pathname);
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    if(u.pathname==='/api/admin/taxonomy')taxPending=false;
    try{await r.fulfill({status,json:data});}catch(e){if(!r.request().failure())throw e;}return;
   }
   if(u.pathname.startsWith('/media/'))return r.fulfill({contentType:'image/png',body:image});
   const file=path.join(root,u.pathname==='/admin'?'static/admin.html':u.pathname);
   return r.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});
  });
  await p.goto('http://admin.test/admin#media');await p.waitForSelector('.media-card');
  assert.equal(taxCalls,0,'media must not wait for taxonomy');assert.equal(await p.locator('.media-card').count(),24);
  assert.ok(await p.locator('.media-card img').evaluateAll(nodes=>nodes.every(n=>n.getAttribute('src').endsWith('?w=640')&&n.loading==='lazy')));
  const calls=mediaCalls;await p.locator('[data-action=media-page][data-page="2"]').click();assert.equal(mediaCalls,calls,'paging reuses already loaded metadata');
  assert.ok((await p.locator('.media-card').first().innerText()).includes('025'));
  await p.locator('#media-search').fill('080');assert.equal(await p.locator('.media-card').count(),1);await p.locator('#media-search').fill('');assert.ok((await p.locator('.media-card').first().innerText()).includes('001'));
  await p.evaluate(()=>picker('cover'));await p.waitForSelector('.picker-grid');
  assert.ok(await p.locator('.picker-card img').evaluateAll(nodes=>nodes.every(n=>n.getAttribute('src').endsWith('?w=640')&&n.loading==='lazy')));
  await p.locator('[data-action=close-dialog]').click();
  const warmCalls=mediaCalls;
  await p.evaluate(()=>location.hash='account');await p.waitForSelector('#account-form');
  await p.evaluate(()=>{window.loadingFlashes=0;window.loadingObserver=new MutationObserver(()=>{if(document.querySelector('#main .initial-loading'))loadingFlashes++;});loadingObserver.observe(document.querySelector('#main'),{childList:true});location.hash='media';});await p.waitForSelector('.media-card');
  assert.equal(mediaCalls,warmCalls,'returning to a fresh list makes no network request');assert.equal(await p.evaluate(()=>loadingFlashes),0,'fresh lists do not flash the loading screen');
  const original=await p.evaluate(async()=>{const a=await api('/admin/media');a.media[0].name='local edit';return (await api('/admin/media')).media[0].name;});assert.equal(original,'照片 001','cached metadata cannot be mutated by a caller');
  await p.evaluate(()=>{clockOffset+=11000;location.hash='account';});await p.waitForSelector('#account-form');
  const coldCalls=mediaCalls;if(width<900)await p.locator('#admin-menu-toggle').click();await p.hover('#navigation [href="#media"]');await p.waitForFunction(()=>adminDataCache.get('/admin/media')?.expires>Date.now());assert.equal(mediaCalls,coldCalls+1,'menu intent prefetches only the requested page');
  await p.locator('#navigation [href="#media"]').click();await p.waitForSelector('.media-card');assert.equal(mediaCalls,coldCalls+1,'navigation consumes the prefetched result');
  await p.locator('#admin-page-refresh').click();await p.waitForFunction(()=>!document.querySelector('#main').hasAttribute('aria-busy'));assert.equal(mediaCalls,coldCalls+2,'manual refresh bypasses cached data');
  await p.evaluate(async()=>{await api('/guides/1');await api('/guides/1');});assert.equal(detailCalls,2,'editor bodies are always read fresh');
  await p.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'hidden',{configurable:true,value:false});});assert.equal(await p.evaluate(()=>adminDataCache.size),0,'hiding the tab clears memory data');
  await p.evaluate(()=>loadingObserver.disconnect());
  mediaDelay=2500;await p.evaluate(()=>{void route();});await p.waitForSelector('#main .initial-loading');
  await p.evaluate(()=>location.hash='account');await p.waitForSelector('#account-form');
  assert.ok(await p.evaluate(()=>abortedReads.includes('/api/admin/media')),'old read must abort on navigation');assert.equal(taxCalls,0,'account has no taxonomy dependency');
  mediaDelay=0;taxDelay=100;await p.evaluate(()=>location.hash='guides');await p.waitForSelector('#filter-form');assert.equal(taxCalls,1,'guides still need current taxonomy');assert.ok(guidesParallel,'guides and taxonomy must load in parallel');taxDelay=0;
  siteDelay=2500;await p.evaluate(()=>location.hash='settings');await p.waitForSelector('[data-action=retry-page]');assert.ok((await p.locator('#main').innerText()).includes('加载超时'));
  siteDelay=0;await p.locator('[data-action=retry-page]').click();await p.waitForSelector('#settings-form');
  await p.evaluate(()=>{window.slowBody=true;void route();});await p.waitForSelector('[data-action=retry-page]');assert.ok((await p.locator('#main').innerText()).includes('加载超时'),'timeout also covers reading the response body');
  await p.evaluate(()=>{window.slowBody=false;});await p.locator('[data-action=retry-page]').click();await p.waitForSelector('#settings-form');
  await p.evaluate(()=>{window.writeResult=null;api('/test-write',{method:'POST',body:{title:'保留写入'}}).then(v=>window.writeResult=v).catch(e=>window.writeResult={error:e.message});location.hash='account';});
  await p.waitForSelector('#account-form');await p.waitForFunction(()=>window.writeResult!==null);assert.deepEqual(await p.evaluate(()=>writeResult),{ok:true});assert.deepEqual(writes,[{method:'POST',body:{title:'保留写入'},csrf:'test-csrf'}]);
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile overflow');
  await p.evaluate(()=>api('/test-expired').catch(()=>{}));await p.waitForSelector('#login-page:not([hidden])');assert.equal(await p.locator('#admin-shell').isVisible(),false);assert.equal(await p.locator('#main').innerText(),'');assert.equal(await p.evaluate(()=>adminDataCache.size),0);
  assert.deepEqual(errors,[]);await context.close();
 }
 console.log('PASS: pagination/search, lazy thumbnails, no unrelated taxonomy requests, cancelled reads, header/body timeout+retry, uncancelled writes, session expiry, responsive');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exit(1)});
