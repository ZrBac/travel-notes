// Offline: delayed APIs/images, anonymous credentials, route cancellation and timeout retry.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),root=path.resolve(__dirname,'..');
const guide={id:1,title:'测试攻略',destination:'泉州',country:'中国',days:4,summary:'测试',cover:'/media/'+'1'.repeat(32)+'.webp',tags:[],status:'public',updated_at:'2026-09-20',html:'<h2>行程</h2>'+Array.from({length:24},(_,i)=>'<img src="/media/'+String(i).padStart(32,'0')+'.webp?w=1280" width="640" height="480" alt="测试照片">').join('')};
(async()=>{const b=await chromium.launch({args:['--no-sandbox']});try{
 for(const preview of [false,true]){
 const ctx=await b.newContext({viewport:{width:390,height:900}}),p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{
  const fetch=window.fetch,timer=window.setTimeout;window.requests=[];window.holdGuide=false;
  window.setTimeout=(fn,ms,...args)=>timer(fn,ms===15000?900:ms,...args);
  window.fetch=(url,opts={})=>{
   const u=new URL(url,location.origin),r={path:u.pathname,credentials:opts.credentials,aborted:false};requests.push(r);
   if(u.pathname.startsWith('/media/')||(holdGuide&&u.pathname==='/api/guides/1'))return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>{r.aborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true}));
   return fetch(url,opts);
  };
 });
 await ctx.route('**/*',r=>{
  const u=new URL(r.request().url());assert.equal(u.origin,'http://public.test');assert.equal(r.request().method(),'GET');
  if(u.pathname==='/api/bootstrap')return r.fulfill({json:{site:{site_name:'测试',tagline:'旅行',footer:'存档'},session:{authenticated:preview,csrf:''},guides:[guide],records:[],record_count:0}});
  if(u.pathname==='/api/guides/1')return r.fulfill({json:{guide}});
  if(u.pathname==='/api/records')return r.fulfill({json:{records:[],total:0,pages:1,page:1,years:[],destinations:[]}});
  const f=path.join(root,u.pathname==='/'?'static/index.html':u.pathname);return r.fulfill({body:fs.readFileSync(f),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(f)]||'application/octet-stream'});
 });
 await p.goto('http://public.test/'+(preview?'?preview=1':''));await p.waitForSelector('.journal-lead');
 await p.waitForFunction(()=>requests.some(r=>r.path.startsWith('/media/')&&!r.aborted));
 await p.evaluate(()=>{holdGuide=true;location.hash='guide/1';});await p.waitForFunction(()=>requests.some(r=>r.path==='/api/guides/1'&&!r.aborted));
 await p.evaluate(()=>location.hash='tags');await p.waitForSelector('.tag-grid');assert.ok(await p.evaluate(()=>requests.filter(r=>r.path==='/api/guides/1').every(r=>r.aborted)));
 await p.evaluate(()=>location.hash='guide/1');await p.waitForSelector('[data-action=retry-page]');assert.ok((await p.locator('#app').innerText()).includes('加载超时'));
 await p.evaluate(()=>holdGuide=false);await p.locator('[data-action=retry-page]').click();await p.waitForSelector('.article-header');
 await p.waitForFunction(()=>requests.filter(r=>r.path.startsWith('/media/')&&!r.aborted).length===2);assert.equal(await p.evaluate(()=>requests.filter(r=>r.path.startsWith('/media/')&&!r.aborted).length),2);
 await p.evaluate(()=>location.hash='tags');await p.waitForSelector('.tag-grid');assert.equal(await p.evaluate(()=>requests.filter(r=>r.path.startsWith('/media/')&&!r.aborted).length),0);
 assert.ok(await p.evaluate(mode=>requests.every(r=>r.credentials===mode),preview?'same-origin':'omit'),'visitor API and images must omit administrator cookies');
 assert.ok(await p.evaluate(()=>!document.querySelector('#app').inert));assert.deepEqual(errors,[]);await ctx.close();
 }console.log('PASS: public and preview isolation, API/image cancellation, bounded detail images, timeout retry, no stale render');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exit(1)});
