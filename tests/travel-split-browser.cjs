// Synthetic fixtures only. Public expenses are subsidized by an independent airfare pool.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const M=require('../static/travel-split-math.js'),root=path.resolve(__dirname,'..');
const stored=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('travel-expense-split-v1')));
function staticReply(route){const u=new URL(route.request().url());assert.equal(route.request().method(),'GET');const file=path.join(root,u.pathname==='/'?'static/index.html':u.pathname);return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});}
const bootstrap={site:{site_name:'行笺',tagline:'旅行',footer:'旅程'},session:{authenticated:false,csrf:''},guides:[],records:[],record_count:0};
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 for(const width of [320,390,1440]){
  const context=await browser.newContext({viewport:{width,height:844},acceptDownloads:true}),page=await context.newPage(),errors=[];let releaseBootstrap;
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());assert.equal(url.origin,'http://split.test');assert.equal(req.method(),'GET');
   if(url.pathname==='/api/bootstrap'){if(!releaseBootstrap)await new Promise(resolve=>{releaseBootstrap=resolve;});return route.fulfill({json:bootstrap});}
   assert.ok(!url.pathname.startsWith('/api/'));return staticReply(route);
  });
  await page.goto('http://split.test/#split');await page.waitForSelector('#split-form');
  assert.equal(await page.locator('.split-expense').count(),3);assert.equal(await page.locator('.split-empty').isVisible(),true);
  assert.equal(await page.locator('[data-expense-field=eligible]').count(),0);assert.equal(await page.locator('.split-expense [data-expense-title]').allInnerTexts().then(a=>a.some(s=>s.includes('住宿'))),false);
  assert.equal(await page.locator('[data-setting=conservativeClaim]').inputValue(),'9000');assert.equal(await page.locator('[data-setting=expectedClaim]').isVisible(),false);
  const rows=page.locator('.split-expense');await rows.nth(0).locator('[data-expense-field=price]').fill('6000');releaseBootstrap();await page.waitForFunction(()=>state.site?.tagline==='旅行');
  assert.equal(await rows.nth(0).locator('[data-expense-field=price]').inputValue(),'6000');
  await rows.nth(1).locator('[data-expense-field=price]').fill('3000');await rows.nth(2).locator('[data-expense-field=price]').fill('3000');
  assert.equal(await page.locator('.split-stat').first().locator('strong').innerText(),'¥333.33');assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥333.35');
  let data=await stored(page);assert.equal(data.reimbursementSource,'external');assert.equal(data.expenses[0].upper,'6000');assert.ok(data.expenses.every(e=>!e.eligible));
  await rows.nth(0).locator('.split-expense-details summary').click();await rows.nth(0).locator('[data-expense-field=upper]').fill('9000');assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥666.68');
  await rows.nth(0).locator('[data-expense-field=price]').fill('6400');assert.equal((await stored(page)).expenses[0].upper,'9000');
  await rows.nth(0).locator('[data-expense-field=upper]').fill('');assert.equal((await stored(page)).expenses[0].upper,'6400');
  await rows.nth(0).locator('[data-expense-field=price]').fill('3000');await rows.nth(1).locator('[data-expense-field=price]').fill('1000');await rows.nth(2).locator('[data-expense-field=price]').fill('1000');
  assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥0.00');assert.ok((await page.locator('.split-remainder').innerText()).includes('¥4,000.00'));data=M.calculate(await stored(page));assert.equal(data.expected.applied,500000);assert.equal(data.expected.reimbursement,900000);
  await page.locator('[data-setting=conservativeClaim]').fill('10000');assert.equal(await page.locator('#split-error').isVisible(),true);assert.equal(await page.locator('.split-stat').count(),0);await page.locator('[data-setting=conservativeClaim]').fill('9000');
  page.once('dialog',d=>d.accept());await page.locator('[data-split=demo]').click();assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥500.00');
  await page.locator('[data-setting=conservativeClaim]').fill('6000');assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥833.34');
  const download=page.waitForEvent('download');await page.locator('[data-split=export]').click();const report=fs.readFileSync(await (await download).path(),'utf8');assert.ok(report.includes('公共费用'));assert.ok(report.includes('¥7,500.00'));assert.ok(report.includes('未扣除垫付款'));assert.ok(report.includes('剩余报销'));
  await page.reload();await page.waitForSelector('#split-form');assert.equal(await page.locator('[data-setting=conservativeClaim]').inputValue(),'6000');assert.equal(await page.locator('.split-stat.is-worst strong').innerText(),'¥833.34');
  await page.locator('[data-split=add-expense]').click();const last=page.locator('.split-expense').last();await last.locator('.split-expense-details summary').click();await last.locator('[data-expense-field=name]').fill('两人活动');await last.locator('[data-expense-field=price]').fill('20');
  for(let i=2;i<9;i++)await last.locator('[data-participant]').nth(i).uncheck();
  let result=M.calculate(await stored(page));assert.equal(result.expenses.at(-1).indexes.length,2);assert.equal(result.expected.costs[0]-result.expected.costs[2],1000);
  await last.locator('[data-expense-field=perPerson]').selectOption('true');assert.ok((await last.locator('.split-quick-cost label').innerText()).includes('每人每次'));assert.equal(M.calculate(await stored(page)).expenses.at(-1).expected,4000);await last.locator('[data-expense-field=perPerson]').selectOption('false');
  await page.locator('#split-group-settings summary').first().click();await page.locator('#split-member-settings summary').click();await page.locator('.split-member').first().locator('[data-member-field=name]').fill('<img src=x onerror=alert(1)>');await page.locator('#split-person-results summary').click();assert.equal(await page.locator('#split-output img').count(),0);
  await page.locator('[data-group=people]').fill('10');await page.locator('[data-group=funded]').fill('7');await page.locator('[data-group=cap]').fill('1500');await page.locator('[data-split=apply-group]').click();data=await stored(page);assert.equal(data.members.length,10);assert.equal(data.expenses[0].participants.length,10);assert.equal(data.expenses.at(-1).participants.length,2);assert.equal(data.expectedClaim,'9000','adding allowance does not invent external income');
  await page.locator('[data-group=funded]').fill('11');await page.locator('[data-split=apply-group]').click();assert.equal(await page.locator('#split-group-error').isVisible(),true);assert.equal((await stored(page)).members.length,10);
  await page.locator('#site-more summary').click();await page.locator('#site-more a[href="#tags"]').click();await page.waitForSelector('.tag-grid');await page.locator('#site-more summary').click();await page.locator('#site-more a[href="#split"]').click();await page.waitForSelector('#split-form');assert.equal(await page.locator('[data-setting=conservativeClaim]').inputValue(),'6000');
  await page.evaluate(()=>Object.defineProperty(navigator,'onLine',{get:()=>false,configurable:true}));await page.evaluate(()=>route());await page.waitForSelector('#split-form');assert.equal(new URL(page.url()).hash,'#split');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);await context.close();console.log('PASS '+width+': public-only form, independent reimbursement, remaining pool, upper limits, groups, export and offline');
 }
 const old=M.blank();delete old.reimbursementSource;old.simpleForm=true;old.members[0].name='原成员 A';old.conservativeClaim='0';old.expenses=[{id:'hotel',name:'住宿',price:'400',upper:'500',quantity:'3',perPerson:true,eligible:true,participants:old.members.map(m=>m.id)},{id:'food',name:'聚餐',price:'2700',upper:'3600',quantity:'1',perPerson:false,eligible:false,participants:old.members.map(m=>m.id)}];
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();await page.addInitScript(data=>localStorage.setItem('travel-expense-split-v1',JSON.stringify(data)),old);
 await context.route('**/*',route=>new URL(route.request().url()).pathname==='/api/bootstrap'?route.fulfill({json:bootstrap}):staticReply(route));
 await page.goto('http://split.test/#split');await page.waitForSelector('#split-form');assert.equal(await page.locator('.split-expense').count(),1);assert.equal(await page.locator('.split-expense [data-expense-title]').innerText(),'聚餐');assert.equal(await page.locator('[data-setting=conservativeClaim]').inputValue(),'9000');
 await page.locator('[data-setting=conservativeClaim]').fill('9000');let upgraded=await stored(page);assert.equal(upgraded.personalExpenses.length,1);assert.equal(upgraded.personalExpenses[0].price,'400');assert.equal(upgraded.personalExpenses[0].upper,'500');assert.equal(upgraded.members[0].name,'原成员 A');assert.equal(upgraded.expenses[0].upper,'3600');assert.equal(upgraded.previousCalculation.conservativeClaim,'0');assert.equal(M.calculate(upgraded).expected.total,270000);assert.equal(M.calculate(upgraded).expected.remaining,630000);
 await page.locator('#split-personal-archive summary').click();assert.ok((await page.locator('#split-personal-archive').innerText()).includes('¥10,800.00'));assert.ok((await page.locator('.split-remainder').innerText()).includes('¥6,300.00'));
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:process.env.SPLIT_TEST_SCREENSHOT||'/tmp/travel-split-public-phone.png',fullPage:true});await context.close();console.log('PASS: old individual hotel expense archived, shared amounts/participants/ceilings retained, old claim assumptions recorded');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
