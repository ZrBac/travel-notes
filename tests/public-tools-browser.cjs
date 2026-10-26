// Public readers never execute the retired editor. All traffic is synthetic.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const guide={id:1,title:'家人的参考攻略',destination:'南京',country:'中国',days:4,tags:[],status:'private',cover:'/static/assets/lake.jpg',html:'<p>仅供管理员预览</p>',updated_at:'2026-10-26'};
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 for(const width of [390,1440]){
  const ctx=await browser.newContext({viewport:{width,height:900}}),page=await ctx.newPage(),errors=[],requests=[];
  let fail=true,hold=false,release;
  page.on('pageerror',e=>errors.push(e.message));
  await ctx.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());assert.equal(u.origin,'http://tools.test');assert.equal(req.method(),'GET');requests.push(u.pathname);
   if(u.pathname==='/api/bootstrap')return route.fulfill({json:{site:{site_name:'行笺',tagline:'旅行',footer:'旅行'},session:{authenticated:true},guides:[guide],records:[],record_count:0}});
   if(u.pathname==='/api/guides/1')return route.fulfill({json:{guide}});
   if(u.pathname==='/api/records')return route.fulfill({json:{records:[],total:0,page:1,pages:1,years:[],destinations:[]}});
   if(u.pathname==='/admin')return route.fulfill({contentType:'text/html',body:'<h1>管理后台</h1>'});
   if(u.pathname==='/static/travel-split.js'&&fail){fail=false;return route.abort();}
   if(u.pathname==='/static/travel-split.js'&&hold){hold=false;await new Promise(resolve=>release=resolve);}
   const file=path.join(root,u.pathname==='/'?'static/index.html':u.pathname);
   return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});
  });
  await page.goto('http://tools.test/?preview=1');await page.waitForSelector('.journal-lead');
  assert.equal(requests.filter(p=>p.includes('travel-split')).length,0,'reading does not load the calculator');
  assert.equal(await page.locator('#login-dialog,#confirm-dialog').count(),0);
  await page.evaluate(()=>location.hash='guide/1');await page.waitForSelector('.article-header');
  assert.equal(await page.locator('.detail-actions a').getAttribute('href'),'/admin#edit/1');
  assert.equal(await page.locator('[data-action=delete],[data-action=restore]').count(),0,'management actions stay in the admin workspace');
  await page.evaluate(()=>location.hash='split');await page.waitForSelector('[data-action=retry-page]');
  hold=true;await page.locator('[data-action=retry-page]').click();
  await page.waitForFunction(()=>document.querySelectorAll('script[src*="travel-split.js"]').length===1);
  while(!release)await new Promise(resolve=>setTimeout(resolve,10));
  await page.evaluate(()=>location.hash='guides');await page.waitForSelector('#guide-grid');release();
  await page.waitForFunction(()=>typeof TravelSplit==='object');assert.equal(await page.locator('#split-form').count(),0,'late script delivery cannot replace the next page');
  await page.evaluate(()=>location.hash='split');await page.waitForSelector('#split-form');
  await page.locator('[data-expense-field=name]').fill('家人聚餐');await page.locator('[data-expense-field=price]').fill('500');
  const loaded=requests.filter(p=>p.includes('travel-split')).length;
  await page.evaluate(()=>location.hash='home');await page.waitForSelector('.journal-lead');
  await page.evaluate(()=>location.hash='split');await page.waitForSelector('#split-form');
  assert.equal(await page.locator('[data-expense-field=name]').inputValue(),'家人聚餐');
  assert.equal(requests.filter(p=>p.includes('travel-split')).length,loaded,'reuse successful assets');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  for(const route of ['new','edit/1','trash']){
   await page.goto('http://tools.test/#'+route);await page.waitForURL('http://tools.test/admin#'+route);
  }
  assert.deepEqual(errors,[]);await ctx.close();console.log('PASS '+width+': lazy calculator, retry, navigation during loading, saved local input, admin-only edits and legacy links');
 }
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
