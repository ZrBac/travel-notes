// Synthetic fixtures only. Checks the short entry form and preserved older budgets.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const M=require('../static/travel-split-math.js'),root=path.resolve(__dirname,'..');
const stored=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('travel-expense-split-v1')));
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 for(const width of [320,390,1440]){
  const context=await browser.newContext({viewport:{width,height:844},acceptDownloads:true}),page=await context.newPage(),errors=[];let releaseBootstrap;
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());assert.equal(url.origin,'http://split.test');assert.equal(req.method(),'GET','calculator must never write to an API');
   if(url.pathname==='/api/bootstrap'){
    if(!releaseBootstrap)await new Promise(resolve=>{releaseBootstrap=resolve;});
    return route.fulfill({json:{site:{site_name:'行笺',tagline:'旅行',footer:'旅程'},session:{authenticated:false,csrf:''},guides:[],records:[],record_count:0}});
   }
   assert.ok(!url.pathname.startsWith('/api/'),'unexpected API '+url.pathname);
   const file=path.join(root,url.pathname==='/'?'static/index.html':url.pathname);
   return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});
  });
  await page.goto('http://split.test/#split');await page.waitForSelector('#split-form');
  assert.equal(await page.locator('.split-expense').count(),4);assert.equal(await page.locator('.split-empty').isVisible(),true);
  assert.equal(await page.locator('[data-expense-field=upper]').first().isVisible(),false);
  assert.equal(await page.locator('[data-setting=expectedClaim]').isVisible(),false);
  assert.equal(await page.locator('[data-group=people]').isVisible(),false);
  const rows=page.locator('.split-expense');await rows.nth(0).locator('[data-expense-field=price]').fill('400');
  releaseBootstrap();await page.waitForFunction(()=>state.site?.tagline==='旅行');
  assert.equal(await rows.nth(0).locator('[data-expense-field=price]').inputValue(),'400','late bootstrap preserves input');
  await rows.nth(1).locator('[data-expense-field=price]').fill('2700');await rows.nth(2).locator('[data-expense-field=price]').fill('1800');
  assert.equal(await page.locator('.split-stat').first().locator('strong').innerText(),'¥700.00');
  assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥1,700.00');
  let data=await stored(page);assert.equal(data.expenses[0].upper,'400','upper defaults to entered amount');assert.equal(data.expenses[1].upper,'2700');
  await page.locator('[data-setting=conservativeClaim]').fill('9000');assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥700.00');
  await rows.nth(0).locator('.split-expense-details summary').click();await rows.nth(0).locator('[data-expense-field=upper]').fill('500');
  assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥1,000.00');
  await rows.nth(0).locator('[data-expense-field=price]').fill('420');assert.equal((await stored(page)).expenses[0].upper,'500','explicit ceiling is preserved');
  await rows.nth(0).locator('[data-expense-field=upper]').fill('');assert.equal((await stored(page)).expenses[0].upper,'420','empty ceiling restores automatic upper');
  await page.locator('[data-setting=conservativeClaim]').fill('10000');assert.equal(await page.locator('#split-error').isVisible(),true);assert.equal(await page.locator('.split-stat').count(),0);
  await page.locator('[data-setting=conservativeClaim]').fill('9000');
  page.once('dialog',d=>d.accept());await page.locator('[data-split=demo]').click();assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥1,200.00');
  await page.locator('[data-setting=conservativeClaim]').fill('6000');assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥1,533.34');
  const download=page.waitForEvent('download');await page.locator('[data-split=export]').click();const report=fs.readFileSync(await (await download).path(),'utf8');assert.ok(report.includes('¥13,800.00'));assert.ok(report.includes('未扣除垫付款'));
  await page.reload();await page.waitForSelector('#split-form');assert.equal(await page.locator('[data-setting=conservativeClaim]').inputValue(),'6000');assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥1,533.34');
  await page.locator('[data-split=add-expense]').click();const last=page.locator('.split-expense').last();await last.locator('.split-expense-details summary').click();
  await last.locator('[data-expense-field=name]').fill('两人活动');await last.locator('[data-expense-field=price]').fill('20');
  for(let i=2;i<9;i++)await last.locator('[data-participant]').nth(i).uncheck();
  let result=M.calculate(await stored(page));assert.equal(result.expenses.at(-1).indexes.length,2);assert.equal(result.expected.costs[0]-result.expected.costs[2],1000);
  // Changing the amount basis updates its label and keeps quantities and participants.
  await last.locator('[data-expense-field=perPerson]').selectOption('true');assert.ok((await last.locator('.split-quick-cost label').innerText()).includes('每人每次'));
  assert.equal(M.calculate(await stored(page)).expenses.at(-1).expected,4000);
  await last.locator('[data-expense-field=perPerson]').selectOption('false');
  await page.locator('#split-group-settings summary').first().click();await page.locator('#split-member-settings summary').click();
  await page.locator('.split-member').first().locator('[data-member-field=name]').fill('<img src=x onerror=alert(1)>');
  await page.locator('#split-person-results summary').click();assert.equal(await page.locator('#split-output img').count(),0);
  assert.equal(await page.locator('.split-person-table th').nth(3).innerText(),'<img src=x onerror=alert(1)>');
  await page.locator('[data-group=people]').fill('10');await page.locator('[data-group=funded]').fill('7');await page.locator('[data-group=cap]').fill('1500');await page.locator('[data-split=apply-group]').click();
  data=await stored(page);assert.equal(data.members.length,10);assert.equal(data.members.filter(m=>Number(m.cap)>0).length,7);assert.equal(data.expenses[0].participants.length,10);assert.equal(data.expenses.at(-1).participants.length,2);
  assert.equal(data.members[0].name,'<img src=x onerror=alert(1)>');assert.equal(data.expenses[0].price,'400');assert.equal(data.expenses[0].upper,'500');
  await page.locator('[data-group=funded]').fill('11');await page.locator('[data-split=apply-group]').click();assert.equal(await page.locator('#split-group-error').isVisible(),true);assert.equal((await stored(page)).members.length,10);
  await page.locator('[data-group=funded]').fill('7');
  await page.locator('#site-more summary').click();await page.locator('#site-more a[href="#tags"]').click();await page.waitForSelector('.tag-grid');
  await page.locator('#site-more summary').click();await page.locator('#site-more a[href="#split"]').click();await page.waitForSelector('#split-form');assert.equal(await page.locator('[data-setting=conservativeClaim]').inputValue(),'6000');
  await page.evaluate(()=>Object.defineProperty(navigator,'onLine',{get:()=>false,configurable:true}));await page.evaluate(()=>route());await page.waitForSelector('#split-form');assert.equal(new URL(page.url()).hash,'#split');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page overflow at '+width);
  assert.deepEqual(errors,[]);await context.close();console.log('PASS '+width+': short form, automatic ceiling, advanced caps/subsets, counts, safe names, drafts, export and offline');
 }
 // Old stored budgets keep exact totals, names, partial participants and claim assumptions.
 const old=M.demo();old.members[0].name='原成员 A';old.members[0].cap='2000';old.expenses[0].participants=old.members.slice(0,6).map(m=>m.id);old.conservativeClaim='6000';const expected=M.calculate(old);
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
 await page.addInitScript(data=>localStorage.setItem('travel-expense-split-v1',JSON.stringify(data)),old);
 await context.route('**/*',route=>{
  const u=new URL(route.request().url());if(u.pathname==='/api/bootstrap')return route.fulfill({json:{site:{site_name:'行笺',tagline:'旅行',footer:'旅程'},session:{authenticated:false},guides:[]}});
  const file=path.join(root,u.pathname==='/'?'static/index.html':u.pathname);return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});
 });
 await page.goto('http://split.test/#split');await page.waitForSelector('#split-form');const actual=await page.evaluate(()=>TravelSplitMath.calculate(JSON.parse(localStorage.getItem('travel-expense-split-v1'))));
 assert.deepEqual(actual.expected,expected.expected);assert.deepEqual(actual.worst,expected.worst);assert.equal((await stored(page)).members[0].name,'原成员 A');
 await page.locator('.split-expense').first().locator('[data-expense-field=price]').fill('420');assert.equal((await stored(page)).expenses[0].upper,'500');
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:process.env.SPLIT_TEST_SCREENSHOT||'/tmp/travel-split-simple-phone.png',fullPage:true});
 await context.close();console.log('PASS: existing budgets keep names, caps, participants, ceilings and claim assumptions');
 const single=M.blank();single.expenses[0].price='400';single.expenses[0].upper='500';const singleResult=M.calculate(single);
 const oldContext=await browser.newContext({viewport:{width:390,height:844}}),oldPage=await oldContext.newPage();
 await oldPage.addInitScript(data=>localStorage.setItem('travel-expense-split-v1',JSON.stringify(data)),single);
 await oldContext.route('**/*',route=>{
  const u=new URL(route.request().url());if(u.pathname==='/api/bootstrap')return route.fulfill({json:{site:{site_name:'行笺',tagline:'旅行',footer:'旅程'},session:{authenticated:false},guides:[]}});
  const file=path.join(root,u.pathname==='/'?'static/index.html':u.pathname);return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});
 });
 await oldPage.goto('http://split.test/#split');await oldPage.waitForSelector('#split-form');assert.equal(await oldPage.locator('.split-expense').count(),4,'old lodging-only draft gets empty total fields');
 await oldPage.locator('[data-setting=conservativeClaim]').fill('0');const upgraded=M.calculate(await stored(oldPage));assert.deepEqual(upgraded.expected,singleResult.expected);assert.deepEqual(upgraded.worst,singleResult.worst);
 await oldContext.close();console.log('PASS: old lodging-only draft gains empty expense fields without changing totals');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
