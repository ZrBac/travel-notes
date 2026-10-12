// Every request is intercepted; no real map tiles, models or production writes.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJpcAAAAASUVORK5CYII=','base64');
const data={destination:'南京',country:'中国',stops:['老门东','南京博物院','缺少坐标的地点'],waypoints:[{name:'老门东',lat:32.011,lng:118.787,source:'https://example.com/first'},{name:'南京博物院',lat:32.041,lng:118.825,source:'https://example.com/second'},{name:'缺少坐标的地点',lat:true,lng:118.8,source:'javascript:alert(1)'}]};
const escape=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/journey-view.css"><script src="/static/journey-view.js" defer></script><style>body{font-family:system-ui;margin:18px}button{padding:10px}#app{max-width:800px}</style><main id="app"><div class="trip-day"><div class="trip-route" data-journey="'+escape(JSON.stringify(data))+'">'+data.stops.map((name,i)=>'<span class="trip-stop">'+(i+1)+' · '+name+'</span>').join(' → ')+'</div><div class="trip-timeline">'+['上午','下午','晚上'].map(period=>'<article class="trip-timeline-item"><div class="trip-time-title"><span class="trip-time-period">'+period+'</span><span class="trip-time-clock">09:30–11:30</span></div><div class="trip-time-body"><p class="trip-time-plan">地点、体验和休息安排</p><p><strong>交通与耗时</strong><span class="trip-time-transport">步行约 20 分钟</span></p><p><strong>预约与提醒</strong><span class="trip-time-reservation">出发前复查</span></p></div></article>').join('')+'</div></div></main>';
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{for(const width of [320,390,1440]){
  const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage(),requests=[],errors=[];let failLibrary=true,failTiles=false,delayLibrary=false;
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());requests.push({url:request.url(),referer:request.headers().referer});assert.equal(request.method(),'GET');
   if(url.hostname==='tile.openstreetmap.org')return failTiles?route.abort():route.fulfill({body:pixel,contentType:'image/png',headers:{'Cache-Control':'public, max-age=604800'}});
   assert.equal(url.origin,'http://journey.test');
   if(url.pathname==='/')return route.fulfill({body:html,contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://tile.openstreetmap.org; connect-src 'self'",'Referrer-Policy':'same-origin'}});
   if(url.pathname.endsWith('/leaflet.js')&&failLibrary){failLibrary=false;return route.abort();}
   if(url.pathname.endsWith('/leaflet.js')&&delayLibrary)await new Promise(resolve=>setTimeout(resolve,250));
   const file=path.join(root,url.pathname);return route.fulfill({body:fs.readFileSync(file),contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('http://journey.test/');await page.waitForFunction(()=>typeof JourneyView!=='undefined');await page.evaluate(()=>JourneyView.mount(document.querySelector('#app')));
  assert.equal(await page.locator('.journey-stop-nav').count(),3);assert.equal(requests.filter(r=>r.url.includes('/leaflet.')).length,0,'map resources are absent before a click');
  await page.locator('.journey-map-toggle').click();await page.waitForFunction(()=>document.querySelector('.journey-map-toggle').textContent==='重试地图');
  delayLibrary=true;await page.locator('.journey-map-toggle').click();await page.evaluate(()=>JourneyView.dispose(document.querySelector('#app')));await page.waitForFunction(()=>!!globalThis.L);assert.equal(await page.locator('.journey-map-controls').count(),0);assert.equal(requests.filter(r=>r.url.startsWith('https://tile.openstreetmap.org')).length,0,'leaving while the library loads never starts a stale map');delayLibrary=false;await page.evaluate(()=>JourneyView.mount(document.querySelector('#app')));
  await page.locator('.journey-map-toggle').click();await page.waitForSelector('.journey-map-marker');await page.waitForFunction(()=>document.querySelector('.journey-map-note').textContent.includes('已定位 2 / 3'));
  assert.equal(await page.locator('.journey-map-marker').count(),2,'unverified or invalid points never render');
  assert.ok((await page.locator('.leaflet-control-attribution').innerText()).includes('OpenStreetMap'));
  assert.ok(requests.filter(r=>r.url.startsWith('https://tile.openstreetmap.org')).every(r=>r.referer==='http://journey.test/'),'tile requests retain an origin referer despite the document policy');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile map/timeline overflow '+width);
  await page.locator('.journey-map-marker').first().click();assert.ok((await page.locator('.journey-map-popup').innerText()).includes('老门东'));
  assert.ok((await page.locator('.journey-map-popup a').first().getAttribute('href')).startsWith('https://uri.amap.com/search?'));
  if(width===390)await page.screenshot({path:'/tmp/journey-map-phone.png',fullPage:true});
  await page.locator('.journey-map-toggle').click();assert.equal(await page.locator('.journey-map').isVisible(),false);assert.equal(await page.locator('.journey-map-marker').count(),0);
  const libraries=requests.filter(r=>r.url.includes('/leaflet.js')).length;failTiles=true;
  await page.evaluate(data=>{JourneyView.dispose(document.querySelector('#app'));const route=document.querySelector('[data-journey]');route.setAttribute('data-journey',JSON.stringify({...data,waypoints:data.waypoints.map(p=>({...p,lng:p.lng+1}))}));JourneyView.mount(document.querySelector('#app'));},data);
  await page.locator('.journey-map-toggle').click();await page.waitForFunction(()=>document.querySelector('.journey-map-note').textContent.includes('底图暂时无法加载'));
  assert.equal(requests.filter(r=>r.url.includes('/leaflet.js')).length,libraries,'reopening reuses the bundled map library');
  assert.equal(await page.locator('.journey-map-marker').count(),2);assert.equal(await page.locator('.trip-timeline-item').count(),3);
  await page.evaluate(()=>JourneyView.dispose(document.querySelector('#app')));assert.equal(await page.locator('.journey-map-controls').count(),0);
  await page.evaluate(()=>JourneyView.mount(document.querySelector('#app')));await context.setOffline(true);const beforeOffline=requests.length;
  await page.locator('.journey-map-toggle').click();assert.ok((await page.locator('.journey-map-note').innerText()).includes('当前离线'));assert.equal(requests.length,beforeOffline,'offline viewing requests no tiles');await context.setOffline(false);
  await page.evaluate(()=>{JourneyView.dispose(document.querySelector('#app'));document.querySelector('#app').replaceChildren();});
  assert.deepEqual(errors,[]);await context.close();console.log('PASS '+width+': lazy bundled maps, load retry, provenance filtering, origin referer, attribution, timeline, navigation, offline/failure fallback and disposal');
 }}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
