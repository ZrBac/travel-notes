// Synthetic offline fixtures, no production data. Verify arithmetic UI, drafts and mobile navigation.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 for(const width of [320,390,1440]){
  const context=await browser.newContext({viewport:{width,height:844},acceptDownloads:true}),page=await context.newPage(),errors=[];let releaseBootstrap;
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());assert.equal(url.origin,'http://split.test');assert.equal(req.method(),'GET','calculator must not write to any API');
   if(url.pathname==='/api/bootstrap'){
    if(!releaseBootstrap)await new Promise(resolve=>{releaseBootstrap=resolve;});
    return route.fulfill({json:{site:{site_name:'行笺',tagline:'旅行',footer:'旅程'},session:{authenticated:false,csrf:''},guides:[],records:[],record_count:0}});
   }
   assert.ok(!url.pathname.startsWith('/api/'),'unexpected API '+url.pathname);
   const file=path.join(root,url.pathname==='/'?'static/index.html':url.pathname);return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});
  });
  await page.goto('http://split.test/#split');await page.waitForSelector('#split-form');
  assert.equal(await page.locator('.split-member').count(),9);assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥0.00');
  await page.locator('[data-setting=conservativeClaim]').fill('6000');releaseBootstrap();
  await page.waitForFunction(()=>state.site?.tagline==='旅行');assert.equal(await page.locator('[data-setting=conservativeClaim]').inputValue(),'6000','late bootstrap preserves user input');
  page.once('dialog',d=>d.accept());await page.locator('[data-split=demo]').click();
  assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥1,200.00');
  await page.locator('[data-setting=conservativeClaim]').fill('6000');assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥1,533.34');
  await page.locator('[data-setting=conservativeClaim]').fill('10000');assert.equal(await page.locator('#split-error').isVisible(),true);assert.equal(await page.locator('.split-stat').count(),0,'invalid input must not show stale totals');
  await page.locator('[data-setting=conservativeClaim]').fill('6000');
  const download=page.waitForEvent('download');await page.locator('[data-split=export]').click();const report=fs.readFileSync(await (await download).path(),'utf8');assert.ok(report.includes('¥13,800.00'));assert.ok(report.includes('未扣除垫付款'));
  await page.reload();await page.waitForSelector('#split-form');assert.equal(await page.locator('[data-setting=conservativeClaim]').inputValue(),'6000');assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥1,533.34');
  await page.locator('[data-split=add-expense]').first().click();const last=page.locator('.split-expense').last();await last.locator('[data-expense-field=name]').fill('两人活动');await last.locator('[data-expense-field=upper]').fill('20');await last.locator('[data-expense-field=price]').fill('20');await last.locator('summary').click();
  for(let i=2;i<9;i++)await last.locator('[data-participant]').nth(i).uncheck();
  let data=await page.evaluate(()=>TravelSplitMath.calculate(JSON.parse(localStorage.getItem('travel-expense-split-v1'))));assert.equal(data.expenses.at(-1).indexes.length,2);assert.equal(data.expected.costs[0]-data.expected.costs[2],1000);
  await page.locator('#split-member-settings summary').click();await page.locator('.split-member').first().locator('[data-member-field=name]').fill('<img src=x onerror=alert(1)>');assert.equal(await page.locator('#split-output img').count(),0);
  await page.locator('[data-split=results]').click();assert.equal(new URL(page.url()).hash,'#split');
  await page.locator('#site-more summary').click();await page.locator('#site-more a[href="#tags"]').click();await page.waitForSelector('.tag-grid');await page.locator('#site-more summary').click();await page.locator('#site-more a[href="#split"]').click();await page.waitForSelector('#split-form');assert.equal(await page.locator('[data-setting=conservativeClaim]').inputValue(),'6000');
  await page.evaluate(()=>Object.defineProperty(navigator,'onLine',{get:()=>false,configurable:true}));await page.evaluate(()=>route());await page.waitForSelector('#split-form');assert.equal(new URL(page.url()).hash,'#split','offline calculator must remain usable');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page overflow at '+width);
  if(width===390)await page.screenshot({path:'/opt/travel-split-20261009/mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);await context.close();console.log('PASS '+width+': instant entry, calculator scenarios, invalid input, export, local draft, subset, escaping, navigation and offline route');
 }
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
