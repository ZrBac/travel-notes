// Synthetic private API fixtures only; no production accounts, tasks or model calls.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const clone=value=>JSON.parse(JSON.stringify(value));
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{for(const width of [320,390,1440]){
  const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage(),errors=[],submitted=[];
  await context.addInitScript(()=>Object.defineProperty(globalThis,'structuredClone',{value:undefined,configurable:true}));
  let family={preferences:{origin:'上海',people:3,rooms:'一间家庭房',budget:'人均 3000 元',companions:'两位成人和一位孩子',pace:'relaxed',walking:'每天 6000 步以内',transport:'公共交通',preferences:'博物馆和美食',food:'不吃海鲜',excluded:'示例排除地'},updated_at:'2026-10-10T00:00:00Z'},failSave=false;
  const stamp='2026-10-10T00:00:00Z',legacy={id:1,prompt:'之前的团建行程',status:'done',parent_id:null,created_at:stamp,updated_at:stamp,result:'旧任务的结果',progress:[],guide:null,trip:{destination:'旧旅行',origin:'旧出发地',dates:'旧日期',days:4,people:9,rooms:'9 间',budget:'旧预算',preferences:'旧兴趣',excluded:'旧排除',mode:'itinerary'}};
  const tasks=[legacy];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());assert.equal(url.origin,'http://family.test');
   if(url.pathname==='/api/session')return route.fulfill({json:{csrf:'synthetic-csrf',user:{id:1,username:'family',display_name:'家庭规划'}}});
   if(url.pathname==='/api/admin/travel-agent'){
    assert.equal(request.method(),'GET');return route.fulfill({json:{tasks:clone(tasks),family_preferences:clone(family),next_before:null,service:{online:true,authenticated:true,concurrency:2}}});
   }
   if(url.pathname==='/api/admin/travel-agent/preferences'){
    assert.equal(request.method(),'PUT');assert.equal(request.headers()['x-csrf-token'],'synthetic-csrf');
    if(failSave){failSave=false;return route.fulfill({status:400,json:{error:'偏好保存失败，请重试'}});}
    family={preferences:request.postDataJSON().preferences,updated_at:stamp};return route.fulfill({json:clone(family)});
   }
   if(url.pathname==='/api/admin/travel-agent/tasks'){
    assert.equal(request.method(),'POST');assert.equal(request.headers()['x-csrf-token'],'synthetic-csrf');
    const data=request.postDataJSON();submitted.push(clone(data));const id=tasks.length+1;tasks.unshift({id,prompt:data.prompt,trip:clone(data.trip),status:'queued',parent_id:data.parent_id||null,created_at:stamp,updated_at:stamp,result:'排队中',progress:[],guide:null});return route.fulfill({status:201,json:{id}});
   }
   if(/^\/api\/admin\/travel-agent\/tasks\/\d+$/.test(url.pathname)){
    assert.equal(request.method(),'GET');const id=Number(url.pathname.split('/').at(-1));return route.fulfill({json:{task:clone(tasks.find(t=>t.id===id))}});
   }
   assert.equal(request.method(),'GET');assert.ok(!url.pathname.startsWith('/api/'),'unexpected private API '+url.pathname);
   const file=path.join(root,url.pathname==='/admin'?'static/admin.html':url.pathname);
   return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});
  });
  await page.goto('http://family.test/admin#travel-agent');await page.waitForSelector('#planner-form');
  const form=page.locator('#planner-form'),pref=page.locator('#planner-family-form'),field=name=>form.locator('[name='+name+']'),saved=name=>pref.locator('[name='+name+']');
  assert.equal(await field('origin').inputValue(),'上海');assert.equal(await field('people').inputValue(),'3');assert.equal(await field('food').inputValue(),'不吃海鲜');assert.equal(await page.locator('#planner-family-settings').evaluate(n=>n.open),false);assert.equal(await field('prompt').getAttribute('required'),null);
  await page.locator('#planner-family-settings>summary').click();await saved('origin').fill('北京');await saved('people').fill('2');await pref.locator('.planner-more>summary').click();await saved('food').fill('不吃花生');await saved('companions').fill('两位成人');
  await pref.locator('button[type=submit]').click();await page.waitForFunction(()=>!state.dirty&&document.querySelector('#planner-form [name=origin]').value==='北京');
  assert.equal(family.preferences.origin,'北京');assert.equal(await field('people').inputValue(),'2');assert.equal(await field('food').inputValue(),'不吃花生');
  await field('destination').fill('南京');await field('dates').fill('11 月，具体日期待定');await field('people').fill('4');await field('rooms').fill('2 间双床房');await form.locator('.planner-more>summary').click();await field('food').fill('少辣');
  await saved('origin').fill('郑州');await saved('food').fill('不吃海鲜');await pref.locator('button[type=submit]').click();await page.waitForFunction(()=>!document.querySelector('#planner-family-form').inert);
  assert.equal(await field('origin').inputValue(),'北京');assert.equal(await field('people').inputValue(),'4');assert.equal(await field('rooms').inputValue(),'2 间双床房');assert.equal(await field('food').inputValue(),'少辣');assert.ok(await page.evaluate(()=>state.dirty));
  failSave=true;await saved('walking').fill('测试失败时保留输入');await pref.locator('button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#planner-family-error').textContent.includes('保存失败'));assert.equal(await saved('walking').inputValue(),'测试失败时保留输入');assert.equal(family.preferences.walking,'每天 6000 步以内');
  await saved('walking').fill('每天 10000 步以内');
  await form.locator('button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#planner-followup').textContent.includes('已提交'));
  assert.equal(submitted.length,1);assert.ok(submitted[0].prompt.includes('家庭出游'));assert.equal(submitted[0].trip.people,4);assert.equal(submitted[0].trip.origin,'北京');assert.equal(submitted[0].trip.food,'少辣');assert.equal(submitted[0].trip.walking,'每天 6000 步以内');assert.ok(await page.evaluate(()=>state.dirty),'unsaved preference edits remain dirty after trip submission');assert.equal(await saved('walking').inputValue(),'每天 10000 步以内');
  await pref.locator('button[type=submit]').click();await page.waitForFunction(()=>!state.dirty);assert.equal(family.preferences.walking,'每天 10000 步以内');assert.equal(tasks[0].trip.people,4,'saving preferences does not change an existing task');
  await page.locator('[data-planner=select][data-id="1"]').click();await page.waitForSelector('[data-planner=followup]');await page.locator('[data-planner=followup]').click();
  assert.equal(await field('people').inputValue(),'9');assert.equal(await field('rooms').inputValue(),'9 间');assert.equal(await field('origin').inputValue(),'旧出发地');assert.equal(await field('companions').inputValue(),'');assert.equal(await field('food').inputValue(),'');assert.equal(await field('walking').inputValue(),'');assert.equal(await field('pace').inputValue(),'');
  await page.locator('[data-planner=apply-family]').click();assert.equal(await field('people').inputValue(),'2');assert.equal(await field('origin').inputValue(),'郑州');assert.equal(await field('destination').inputValue(),'旧旅行');assert.equal(await field('dates').inputValue(),'旧日期');
  page.once('dialog',d=>d.accept());await page.locator('[data-planner=new]').click();assert.equal(await field('destination').inputValue(),'');assert.equal(await field('people').inputValue(),'2');assert.equal(await field('origin').inputValue(),'郑州');assert.equal(await field('food').inputValue(),'不吃海鲜');assert.equal(await form.getAttribute('data-parent'),null);
  await page.locator('[data-planner=example]').click();assert.equal(await field('mode').inputValue(),'compare');assert.equal(await field('people').inputValue(),'2');assert.equal(await field('rooms').inputValue(),'一间家庭房');assert.ok(!(await field('dates').inputValue()).includes('2026'));assert.equal(await field('excluded').inputValue(),'示例排除地');assert.equal(family.preferences.people,2);
  page.once('dialog',d=>d.accept());await page.reload();await page.waitForSelector('#planner-form');assert.equal(await field('destination').inputValue(),'');assert.equal(await field('people').inputValue(),'2');assert.equal(await field('walking').inputValue(),'每天 10000 步以内');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  if(width===390){await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'/tmp/travel-family-planner-phone.png',fullPage:true});}
  assert.deepEqual(errors,[]);await context.close();console.log('PASS '+width+': family defaults, private save/reload, current-trip overrides, optional prompt, failed save preservation, dirty state, legacy followup and family example (Safari fallback)');
 }}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
