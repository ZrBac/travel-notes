// Synthetic data only: bootstrap reuse, filter/page cache boundaries, cancellation and TTL.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 for(const preview of [false,true]){
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];
  let calls=0,delay=0;page.on('pageerror',e=>errors.push(e.message));
  const records=Array.from({length:13},(_,i)=>({id:i+1,title:'足迹 '+(i+1),destination:'泉州',start_date:'2026-09-24',end_date:'',summary:'路线与照片',cover:'/static/assets/lake.jpg',photo_count:1,status:preview?'private':'public'}));
  function listing(u){const q=u.searchParams.get('q')||'',n=Number(u.searchParams.get('page')||1),filtered=records.filter(r=>r.title.includes(q));return {records:filtered.slice((n-1)*12,n*12),total:filtered.length,page:n,pages:Math.max(1,Math.ceil(filtered.length/12)),destinations:['泉州'],years:[2026]};}
  await page.addInitScript(()=>{const fetch=window.fetch,now=Date.now;window.offset=0;window.calls=[];Date.now=()=>now()+offset;window.fetch=(url,options={})=>{if(String(url).startsWith('/api/'))calls.push({url,credentials:options.credentials});return fetch(url,options);};});
  await context.route('**/*',async r=>{
   const u=new URL(r.request().url());assert.equal(u.origin,'http://footprints.test');assert.equal(r.request().method(),'GET');
   if(u.pathname==='/api/bootstrap')return r.fulfill({json:{site:{site_name:'行笺',tagline:'测试',footer:'旅行手记'},session:{authenticated:preview,csrf:''},guides:[],records:records.slice(0,3),record_count:records.length,record_page:listing(new URL('http://footprints.test/'))}});
   if(u.pathname==='/api/records'){calls++;const data=listing(u);if(delay)await new Promise(resolve=>setTimeout(resolve,delay));return r.fulfill({json:data}).catch(()=>{});}
   const file=path.join(root,u.pathname==='/'?'static/index.html':u.pathname);return r.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream'});
  });
  await page.goto('http://footprints.test/'+(preview?'?preview=1':''));await page.waitForSelector('.journal-lead');
  const visit=async hash=>{await page.evaluate(async h=>{history.replaceState(null,'','#'+h);await route();},hash);};
  await visit('footprints');assert.equal(await page.locator('.memory-grid .memory-card').count(),12);assert.equal(calls,preview?1:0,'first public page must reuse bootstrap; preview must verify');
  await visit('home');await visit('footprints');assert.equal(calls,preview?2:0);
  await page.locator('[name=q]').fill('13');await page.locator('#memory-filter button[type=submit]').click();await page.waitForFunction(()=>!document.querySelector('#app').inert);assert.equal(await page.locator('.memory-grid .memory-card').count(),1);
  const previous=calls;await page.locator('#memory-filter button[type=submit]').click();await page.waitForFunction(()=>!document.querySelector('#app').inert);assert.equal(calls,previous+1,'explicit filter submit forces refresh');
  await page.locator('[data-fp=reset]').click();await page.waitForFunction(()=>!document.querySelector('#app').inert);
  delay=650;await page.locator('[data-fp=page][data-page="2"]').click();await page.waitForSelector('.memory-loading');await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,180)));assert.equal(await page.locator('#app>.loading').count(),0,'route timer must not replace an already rendered list frame');
  await visit('home');await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,700)));assert.equal(await page.locator('.journal-lead').count(),1,'late response cannot replace new route');
  delay=0;await visit('footprints');assert.equal(await page.locator('.memory-grid .memory-card').count(),1);assert.ok((await page.locator('.memory-grid').innerText()).includes('足迹 13'));
  await page.locator('[data-fp=reset]').click();await page.waitForFunction(()=>!document.querySelector('#app').inert);
  const beforeTTL=calls;records.pop();await page.evaluate(()=>offset+=16000);await visit('home');await visit('footprints');assert.equal(calls,beforeTTL+1);assert.ok((await page.locator('.memory-total').innerText()).includes('12 篇'));
  const beforeHide=calls;await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await visit('home');await visit('footprints');assert.equal(calls,beforeHide+1);
  assert.ok(await page.evaluate(mode=>calls.every(c=>c.credentials===mode),preview?'same-origin':'omit'));assert.deepEqual(errors,[]);await context.close();
 }
 console.log('PASS: first-page preload; bounded public reuse; preview isolation; filter refresh; pagination; TTL and hidden-tab invalidation; immediate list frame; late-response cancellation');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
