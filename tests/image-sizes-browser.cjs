// Offline: display size/DPR selection, bundled covers, credentials and original URLs.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),root=path.resolve(__dirname,'..');
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 for(const [viewport,dpr,display,expected]of [[1440,1,140,320],[390,3,150,480],[390,2,260,640],[390,3,360,1280]]){
  const ctx=await browser.newContext({viewport:{width:viewport,height:900},deviceScaleFactor:dpr}),p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await ctx.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><main id="app"></main></body></html>'}));
  await p.goto('http://images.test/');
  await p.addScriptTag({content:fs.readFileSync(path.join(root,'static/image-utils.js'),'utf8')});
  await p.addScriptTag({content:fs.readFileSync(path.join(root,'static/travel-images.js'),'utf8')});
  const original='/media/'+'1'.repeat(32)+'.webp?w=1280';
  await p.evaluate(({display,original})=>{
   window.requests=[];window.fetch=async(url,opts)=>{requests.push({url:new URL(url,location.origin).href,credentials:opts.credentials});return {ok:true,blob:async()=>new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>'],{type:'image/svg+xml'})};};
   document.querySelector('#app').innerHTML=[original,'/static/assets/alps.jpg','/static/assets/custom.svg'].map(src=>`<img style="display:block;width:${display}px;height:${display/2}px" data-travel-src="${src}">`).join('');
   window.images=createTravelImages({roots:['#app'],credentials:'omit',attribute:'data-travel-src'});images.resume();
  },{display,original});
  await p.waitForFunction(()=>requests.length===3);
  const requests=await p.evaluate(()=>window.requests);
  assert.equal(new URL(requests[0].url).searchParams.get('w'),String(expected));
  assert.ok(requests[1].url.endsWith('-'+expected+'.webp'));assert.ok(requests[2].url.endsWith('/custom.svg'));
  assert.ok(requests.every(r=>r.credentials==='omit'));
  assert.equal(await p.locator('#app img').first().getAttribute('data-travel-src'),original);
  const capped=await p.evaluate(()=>{const img={getBoundingClientRect:()=>({width:1400,height:900})};return [travelDisplayImageUrl('/media/'+'2'.repeat(32)+'.webp?w=640',img),travelDisplayImageUrl(travelImageCatalog['/static/assets/alps.jpg'][640],img)];});
  assert.equal(new URL(capped[0]).searchParams.get('w'),'640');assert.ok(capped[1].endsWith('-640.webp'));
  assert.deepEqual(errors,[]);await ctx.close();
 }
 console.log('PASS: 320/480/640/1280 selected by rendered size and DPR; SVG and source URLs preserved; visitor credentials omitted');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
