// Exercise independent list contexts and unsaved forms without production writes.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const guide={id:1,title:'和家人慢慢游南京：博物馆、古城街巷与地方风味四天三晚完整攻略',destination:'南京',country:'中国',days:4,status:'private',tags:[],cover:'/static/assets/lake.jpg',body:'<p>计划</p>',html:'<p>计划</p>',revision:1,updated_at:'2026-10-26'};
const record={id:1,title:'家人的旅行手记',destination:'南京',start_date:'2026-10-26',status:'private',cover:guide.cover,photo_count:0,photos:[],body:'<p>回忆</p>',html:'<p>回忆</p>',revision:1};
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 for(const width of [320,390,1440]){
  const ctx=await browser.newContext({viewport:{width,height:900}}),p=await ctx.newPage(),errors=[],calls=[],writes=[];
  let accept=false,confirms=0,failSave=true,holdSave=false,releaseSave;
  p.on('pageerror',e=>errors.push(e.message));p.on('dialog',async d=>{confirms++;await(accept?d.accept():d.dismiss());});
  const site={site_name:'行笺',tagline:'记录旅程',footer:'旅行',show_samples:false};
  await ctx.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());assert.equal(u.origin,'http://state.test');
   if(req.method()!=='GET'){
    const data=req.postDataJSON();writes.push({path:u.pathname,data});
    if(u.pathname==='/api/admin/preview')return route.fulfill({json:{html:data.body}});
    assert.equal(req.headers()['x-csrf-token'],'fixture');
    if(u.pathname==='/api/admin/settings'){
     if(holdSave){holdSave=false;await new Promise(resolve=>releaseSave=resolve);}
     if(failSave)return route.fulfill({status:503,json:{error:'模拟保存失败'}});
     Object.assign(site,data);return route.fulfill({json:{ok:true}});
    }
    if(u.pathname==='/api/admin/agent/tasks')return route.fulfill({json:{id:9}});
    throw Error('Unexpected write '+u.pathname);
   }
   if(u.pathname.startsWith('/api/')){
    calls.push(u.pathname+u.search);let data;
    if(u.pathname==='/api/session')data={csrf:'fixture',user:{id:1,username:'fixture',display_name:'旅行管理员'}};
    else if(u.pathname==='/api/admin/taxonomy')data={categories:[],tags:[]};
    else if(u.pathname==='/api/admin/guides'||u.pathname==='/api/records'){
     const trash=u.searchParams.get('trash')==='1',page=Number(u.searchParams.get('page')||1);
     data={page:trash?1:page,pages:trash?1:3,total:trash?0:43,[u.pathname.endsWith('/records')?'records':'guides']:trash?[]:[u.pathname.endsWith('/records')?record:guide]};
    }
    else if(u.pathname==='/api/guides/1')data={guide};
    else if(u.pathname==='/api/guides')data={guides:[guide]};
    else if(u.pathname==='/api/records/1')data={record};
    else if(u.pathname==='/api/site')data=site;
    else if(u.pathname==='/api/admin/agent')data={tasks:[],service:{online:true,authenticated:true,versions:[]}};
    else if(u.pathname==='/api/admin/agent/tasks/9')data={task:{id:9,kind:'chat',prompt:'整理一个测试需求',status:'succeeded',report:{},updated_at:'2026-10-26',logs:[]}};
    else throw Error('Unexpected API '+u.pathname);
    return route.fulfill({json:data});
   }
   const file=path.join(root,u.pathname==='/admin'?'static/admin.html':u.pathname);
   return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.jpg':'image/jpeg'})[path.extname(file)]||'application/octet-stream'});
  });
  const go=async hash=>{await p.evaluate(h=>location.hash=h,hash);await p.waitForFunction(h=>state.route===h&&!document.querySelector('#main').inert&&!TravelEditor.busy,hash);};
  await p.goto('http://state.test/admin#guides');await p.waitForSelector('#filter-form');
  if(width<901)assert.ok(await p.locator('tbody tr').evaluate(row=>{const t=row.querySelector('.title-cell').getBoundingClientRect(),box=row.querySelector('input[type=checkbox]').getBoundingClientRect();return t.right+4<=box.left;}),'long title must not touch the selection box');
  await p.locator('#filter-form [name=q]').fill('南京');await p.locator('#filter-form button[type=submit]').click();await p.waitForFunction(()=>!document.querySelector('#main').inert);
  await p.locator('[data-action=guide-page][data-page="2"]').click();await p.waitForFunction(()=>state.page===2&&!document.querySelector('#main').inert);
  await go('edit/1');await go('guides');assert.equal(await p.locator('#filter-form [name=q]').inputValue(),'南京');assert.equal(await p.evaluate(()=>state.page),2);
  await go('trash');assert.equal(await p.locator('#filter-form [name=q]').inputValue(),'');assert.equal(await p.locator('.pagination button').count(),0);
  await go('guides');assert.equal(await p.evaluate(()=>state.page),2);
  await go('records');await p.locator('#record-filter-form [name=q]').fill('回忆');await p.locator('#record-filter-form button[type=submit]').click();await p.waitForFunction(()=>!document.querySelector('#main').inert);
  await p.locator('[data-record-action=page][data-page="2"]').click();await p.waitForFunction(()=>document.querySelector('.pagination').textContent.includes('2 / 3')&&!document.querySelector('#main').inert);
  await go('record-edit/1');await go('records');assert.equal(await p.locator('#record-filter-form [name=q]').inputValue(),'回忆');assert.ok((await p.locator('.pagination').innerText()).includes('2 / 3'));
  await go('record-trash');assert.equal(await p.locator('#record-filter-form [name=q]').inputValue(),'');assert.equal(await p.locator('.pagination button').count(),0);
  await go('records');assert.ok((await p.locator('.pagination').innerText()).includes('2 / 3'));
  await p.locator('[data-record-action=reset-filters]').click();await p.waitForFunction(()=>!document.querySelector('#main').inert);assert.equal(await p.locator('#record-filter-form [name=q]').inputValue(),'');assert.ok((await p.locator('.pagination').innerText()).includes('1 / 3'));
  await go('settings');await p.locator('[name=tagline]').fill('还没保存的修改');assert.equal(await p.evaluate(()=>state.dirty),true);
  const prior=confirms;await p.evaluate(()=>location.hash='guides');await p.waitForFunction(()=>location.hash==='#settings');assert.equal(confirms,prior+1);assert.equal(await p.locator('[name=tagline]').inputValue(),'还没保存的修改');
  holdSave=true;await p.locator('#settings-form button[type=submit]').click();await p.waitForFunction(()=>document.querySelector('#settings-form').inert);
  await p.locator('[name=tagline]').focus();await p.keyboard.type('保存期间不应写入');assert.equal(await p.locator('[name=tagline]').inputValue(),'还没保存的修改');
  while(!releaseSave)await new Promise(resolve=>setTimeout(resolve,10));releaseSave();await p.waitForFunction(()=>!adminPendingWrites&&!document.querySelector('#settings-form').inert);assert.equal(await p.evaluate(()=>state.dirty),true);
  failSave=false;await p.locator('#settings-form button[type=submit]').click();await p.waitForFunction(()=>!adminPendingWrites&&!state.dirty);
  await p.locator('[name=tagline]').fill('再次修改');await p.locator('[name=tagline]').fill('还没保存的修改');assert.equal(await p.evaluate(()=>state.dirty),false,'reverting to the saved value is clean');
  await go('account');await p.locator('[name=current_password]').fill('fixture-only-password');assert.equal(await p.evaluate(()=>state.dirty),true);
  await p.evaluate(()=>location.hash='guides');await p.waitForFunction(()=>location.hash==='#account');assert.equal(await p.locator('[name=current_password]').inputValue(),'fixture-only-password');
  await p.locator('[name=current_password]').fill('');assert.equal(await p.evaluate(()=>state.dirty),false);
  await go('agent');await p.locator('#agent-task-form [name=prompt]').fill('整理一个测试需求');await p.evaluate(()=>location.hash='guides');await p.waitForFunction(()=>location.hash==='#agent');
  await p.locator('#agent-task-form button[type=submit]').click();await p.waitForFunction(()=>!adminPendingWrites&&!state.dirty);await go('guides');
  assert.equal(await p.evaluate(()=>localStorage.length+sessionStorage.length),0,'private drafts stay in memory');
  assert.ok(writes.every(w=>!JSON.stringify(w.data).includes('fixture-only-password')));assert.deepEqual(errors,[]);await ctx.close();
  console.log('PASS '+width+': title hit area, independent active/trash filters, edit return pages, concise pagination, settings/account/assistant draft protection and save retry');
 }
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
