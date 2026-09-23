// Offline regression: hold image/prefetch transfers open while navigating. No server writes.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),p=await context.newPage(),errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{
  const fetch=window.fetch;window.transfers=[];window.maximumImages=0;window.slowPrefetch=false;
  window.fetch=(url,options={})=>{
   const u=new URL(url,location.origin),image=u.pathname.startsWith('/media/'),prefetch=window.slowPrefetch&&u.pathname==='/api/admin/taxonomy'&&options.priority==='low';
   if(image||prefetch){
    const transfer={image,prefetch,aborted:false,priority:options.priority};transfers.push(transfer);
    maximumImages=Math.max(maximumImages,transfers.filter(t=>t.image&&!t.aborted).length);
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{transfer.aborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true}));
   }
   return fetch(url,options);
  };
 });
 await context.route('**/*',r=>{
  const u=new URL(r.request().url());assert.equal(u.origin,'http://network.test');assert.equal(r.request().method(),'GET');
  if(u.pathname==='/api/session')return r.fulfill({json:{csrf:'fixture',user:{username:'test',display_name:'测试'}}});
  if(u.pathname==='/api/admin/media')return r.fulfill({json:{media:Array.from({length:48},(_,i)=>({url:'/media/'+String(i).padStart(32,'0')+'.webp',filename:String(i).padStart(32,'0')+'.webp',name:'图片 '+i,width:2000,height:1500,bytes:300000,deleted_at:null,references:[]})),defaults:[]}});
  if(u.pathname==='/api/admin/taxonomy')return r.fulfill({json:{categories:[],tags:[]}});
  if(u.pathname==='/api/admin/guides')return r.fulfill({json:{guides:[],total:0,page:1,pages:1}});
  if(u.pathname==='/api/records')return r.fulfill({json:{records:[],total:0,page:1,pages:1}});
  assert.ok(!u.pathname.startsWith('/api/'),'unexpected API '+u.pathname);
  const file=path.join(root,u.pathname==='/admin'?'static/admin.html':u.pathname);
  return r.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});
 });
 await p.goto('http://network.test/admin#media');await p.waitForSelector('.media-card');
 await p.waitForFunction(()=>transfers.filter(t=>t.image&&!t.aborted).length===2);
 assert.equal(await p.evaluate(()=>maximumImages),2,'only two image transfers may compete for bandwidth');
 await p.evaluate(()=>location.hash='records');await p.waitForSelector('#record-filter-form');
 assert.equal(await p.evaluate(()=>transfers.filter(t=>t.image&&!t.aborted).length),0,'switching cancels old images');
 for(const route of ['media','guides','media','account','media','records']){
  await p.evaluate(h=>location.hash=h,route);
  await p.waitForFunction(h=>state.route===h&&!document.querySelector('#main').hasAttribute('aria-busy'),route);
 }
 assert.equal(await p.evaluate(()=>transfers.filter(t=>t.image&&!t.aborted).length),0);
 await p.evaluate(()=>{clearAdminData();slowPrefetch=true;prefetchAdminView('taxonomy');});
 await p.waitForFunction(()=>transfers.some(t=>t.prefetch&&!t.aborted));
 await p.evaluate(()=>location.hash='taxonomy');await p.waitForSelector('[data-action=taxonomy-form]');
 assert.equal(await p.evaluate(()=>transfers.filter(t=>t.prefetch&&!t.aborted).length),0,'navigation aborts low priority prefetch and retries foreground data');
 await p.evaluate(()=>location.hash='media');await p.waitForFunction(()=>transfers.filter(t=>t.image&&!t.aborted).length===2);
 await p.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 assert.equal(await p.evaluate(()=>transfers.filter(t=>t.image&&!t.aborted).length),0,'hidden tabs stop downloads');
 assert.ok(await p.evaluate(()=>transfers.filter(t=>t.image).every(t=>t.priority==='low')));
 assert.deepEqual(errors,[]);await context.close();
 console.log('PASS: bounded image downloads, cancellation on rapid navigation/hide, prefetch priority promotion, no production requests');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
