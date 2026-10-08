// Synthetic fixtures only: no real credentials, account creation or deletion.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 for(const width of [320,390,1440]){
  const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage(),errors=[],writes=[];
  let accounts=[{id:1,username:'current_admin',display_name:'当前管理员'},{id:2,username:'second_admin',display_name:'第二位管理员'}],releaseDelete;
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());assert.equal(url.origin,'http://accounts.test');
   if(url.pathname.startsWith('/api/')){
    if(url.pathname==='/api/session')return route.fulfill({json:{csrf:'fixture-csrf',user:accounts[0]}});
    if(url.pathname==='/api/admin/accounts'&&req.method()==='GET')return route.fulfill({json:{accounts}});
    assert.equal(req.headers()['x-csrf-token'],'fixture-csrf');const body=req.postDataJSON();writes.push({method:req.method(),path:url.pathname,body});
    if(req.method()==='DELETE'){
     assert.equal(url.pathname,'/api/admin/accounts/2');
     if(body.current_password!=='fixture-password')return route.fulfill({status:400,json:{error:'当前管理员密码不正确'}});
     await new Promise(resolve=>{releaseDelete=resolve;});accounts=accounts.filter(a=>a.id!==2);return route.fulfill({json:{ok:true}});
    }
    assert.equal(req.method(),'POST');assert.equal(url.pathname,'/api/admin/accounts');
    accounts.push({id:3,username:body.username,display_name:body.display_name});return route.fulfill({status:201,json:{account:accounts[1]}});
   }
   const file=path.join(root,url.pathname==='/admin'?'static/admin.html':url.pathname);
   return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});
  });
  await page.goto('http://accounts.test/admin#account');await page.locator('#account-form [data-admin-accounts]').click();
  await page.waitForSelector('[data-remove-admin="2"]');assert.equal(await page.locator('[data-remove-admin="1"]').count(),0);
  assert.ok((await page.locator('#dialog-content').innerText()).includes('当前账号'));
  if(width<900){await page.waitForSelector('#dialog-content .admin-card-table');assert.ok(await page.locator('[data-remove-admin="2"]').evaluate(el=>{const r=el.getBoundingClientRect();return r.width>=44&&r.height>=44&&r.right<=innerWidth;}));}
  await page.locator('[data-remove-admin="2"]').click();assert.ok((await page.locator('#dialog-content').innerText()).includes('second_admin'));
  await page.locator('#remove-admin-form [type=submit]').click();assert.equal(writes.length,0,'empty password must not submit');
  await page.locator('#cancel-remove-admin').click();await page.waitForSelector('[data-remove-admin="2"]');assert.equal(writes.length,0,'return never deletes');
  await page.locator('[data-remove-admin="2"]').click();await page.locator('#remove-admin-form [name=current_password]').fill('wrong-password');await page.locator('#remove-admin-form [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#remove-admin-error').textContent.includes('密码不正确'));
  assert.equal(await page.locator('#remove-admin-form [type=submit]').isEnabled(),true);
  await page.locator('#remove-admin-form [name=current_password]').fill('fixture-password');await page.locator('#remove-admin-form [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#remove-admin-form [type=submit]').disabled);
  await page.locator('#remove-admin-form').evaluate(form=>form.requestSubmit());
  await page.waitForTimeout(50);assert.equal(writes.length,2,'duplicate removal is blocked');assert.ok(releaseDelete);releaseDelete();
  await page.waitForSelector('#create-admin-form');assert.equal(await page.locator('[data-remove-admin]').count(),0,'successful deletion refreshes the list');
  assert.equal(await page.locator('#create-admin-form [name=current_password]').inputValue(),'');
  for(const [name,value] of Object.entries({username:'new_admin',display_name:'新管理员',password:'fixture-eight',confirm_password:'fixture-eight',current_password:'fixture-password'}))await page.locator('#create-admin-form [name='+name+']').fill(value);
  await page.locator('#create-admin-form [type=submit]').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);
  assert.equal(writes.length,3);await page.locator('#account-form [data-admin-accounts]').click();await page.waitForSelector('[data-remove-admin="3"]');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  await context.close();console.log('PASS '+width+': removal, cancel, validation, retry, duplicate guard, refreshed list and creation');
 }
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exit(1);});
