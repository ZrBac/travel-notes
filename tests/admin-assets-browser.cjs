// Synthetic login, failed downloads and rapid navigation; no production requests.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const root=path.resolve(__dirname,'..'),origin='http://assets.test';
const session=user=>({csrf:user?'signed-in':'signed-out',user:user?{id:1,username:'fixture',display_name:'测试管理员'}:null});
const html=fs.readFileSync(path.join(root,'static/admin.html'),'utf8').replace(/((?:src|href)="\/static\/([^"?]+\.(?:js|css)))(?=")/g,(_,prefix,file)=>prefix+'?v='+crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'static',file))).digest('hex').slice(0,16));
async function fixture(browser,authenticated=true){
 const ctx=await browser.newContext({viewport:{width:390,height:844}}),p=await ctx.newPage();
 const calls=[],errors=[],fails=new Set(),holds=new Map();let loggedIn=authenticated,allowLogin=true;
 p.on('pageerror',e=>errors.push(e.message));
 await ctx.addInitScript(()=>{const timer=setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,ms===15000&&window.shortTimeout?350:ms,...args);});
 await ctx.route('**/*',async r=>{
  const req=r.request(),u=new URL(req.url()),name=path.basename(u.pathname);assert.equal(u.origin,origin);
  calls.push({path:u.pathname,name,method:req.method(),query:u.search});
  if(holds.has(name))await holds.get(name).promise;
  if(fails.delete(name))return r.abort('failed');
  if(u.pathname.startsWith('/api/')){
   let data,status=200;
   if(req.method()!=='GET')assert.equal(req.headers()['x-csrf-token'],session(loggedIn).csrf);
   if(u.pathname==='/api/session')data=session(loggedIn);
   else if(u.pathname==='/api/login'){
    assert.equal(req.method(),'POST');assert.equal(req.postDataJSON().username,'fixture');
    if(allowLogin){loggedIn=true;data=session(true);}else{status=401;data={error:'账号或密码不正确'};}
   }else if(u.pathname==='/api/logout'){loggedIn=false;data={ok:true};}
   else if(u.pathname==='/api/expired'){loggedIn=false;status=401;data={error:'请重新登录'};}
   else if(u.pathname==='/api/admin/guides')data={guides:[],total:0,page:1,pages:1};
   else if(u.pathname==='/api/admin/taxonomy')data={categories:[],tags:[]};
   else if(u.pathname==='/api/records')data={records:[],total:0,page:1,pages:1};
   else if(u.pathname==='/api/admin/trips')data={trips:[],focus:null,total:0,page:1,pages:1};
   else if(u.pathname==='/api/admin/travel-agent')data={tasks:[],service:{online:true,authenticated:true,execution:{model:'fixture',effort:'test'}},family_preferences:{preferences:{},updated_at:null}};
   else if(u.pathname==='/api/admin/agent')data={tasks:[],service:{online:true,authenticated:true,execution:{model:'fixture',effort:'test'},health:{warnings:[]},versions:[]}};
   else if(u.pathname==='/api/admin/media')data={media:[],defaults:[]};
   else if(u.pathname==='/api/site')data={site_name:'行笺',tagline:'旅行记录',footer:'测试',show_samples:false};
   else throw Error('Unexpected API '+u.pathname);
   return r.fulfill({status,json:data});
  }
  const file=path.join(root,u.pathname==='/admin'?'static/admin.html':u.pathname);
  return r.fulfill({body:u.pathname==='/admin'?html:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream',headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:"}});
 });
 return {ctx,p,calls,errors,fails,
  setLogin(value){allowLogin=value;},
  hold(name){let release;const promise=new Promise(resolve=>release=resolve);holds.set(name,{promise});return()=>{holds.delete(name);release();};},
  count(value){return calls.filter(c=>c.path===value||c.name===value).length;},
  async close(){assert.deepEqual(errors,[]);assert.equal(await p.evaluate(()=>localStorage.length+sessionStorage.length),0);await ctx.close();}
 };
}
async function ready(p,hash,selector){await p.waitForFunction(h=>typeof state!=='undefined'&&state.route===h&&!document.querySelector('#main').inert,hash);if(selector)await p.waitForSelector(selector);}
async function go(p,hash,selector){await p.evaluate(h=>location.hash=h,hash);await ready(p,hash,selector);}
async function requested(f,name){await f.p.waitForFunction(()=>true);for(let i=0;i<100&&!f.count(name);i++)await new Promise(r=>setTimeout(r,20));assert.ok(f.count(name),'request started: '+name);}
function resources(f){return f.calls.filter(c=>/\.(js|css)$/.test(c.name));}
function stats(f){const files=resources(f);return {files:files.length,js:files.filter(f=>f.name.endsWith('.js')).length,css:files.filter(f=>f.name.endsWith('.css')).length,raw:files.reduce((n,f)=>n+fs.statSync(path.join(root,f.path)).size,0),gzip:files.reduce((n,f)=>n+zlib.gzipSync(fs.readFileSync(path.join(root,f.path))).length,0)};}
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});const measurements={};try{
 // Logged-out visitors download only the login bootstrap and shared presentation.
 {
  const f=await fixture(browser,false),{p}=f;await p.goto(origin+'/admin#trips');await p.waitForSelector('#login-page:not([hidden])');
  assert.deepEqual(resources(f).map(c=>c.name).sort(),['admin-boot.js','admin-mobile.css','admin-workspace.css','admin.css'].sort());
  assert.deepEqual(f.calls.filter(c=>c.path.startsWith('/api/')).map(c=>c.path),['/api/session']);measurements.login=stats(f);
  await p.locator('[name=username]').fill('fixture');await p.locator('[name=password]').fill('fixture-password');f.setLogin(false);
  await p.locator('#login-form button[type=submit]').click();await p.waitForFunction(()=>document.querySelector('#login-error').textContent.includes('不正确'));
  assert.equal(f.count('admin.js'),0);assert.equal(await p.locator('[name=username]').inputValue(),'fixture');
  f.setLogin(true);const release=f.hold('login');
  await p.locator('#login-form button[type=submit]').click();await requested(f,'login');
  await p.evaluate(()=>document.querySelector('#login-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(f.count('login'),2,'one failed attempt and one pending attempt; no duplicate submission');release();
  await ready(p,'trips');assert.equal(f.count('session'),1,'handoff uses the login response, no second session round trip');
  assert.equal(await p.locator('[name=password]').inputValue(),'');assert.equal(f.count('trips.js'),1);
  for(const name of ['trip-assistant.js','journey-view.js','travel-editor.js','footprints-admin.js','travel-planner.js','agent-admin.js'])assert.equal(f.count(name),0,name+' is unnecessary for the trip list');
  await p.evaluate(()=>document.querySelector('[data-action=logout]').click());await p.waitForSelector('#login-page:not([hidden])');
  assert.equal(await p.locator('#main').innerText(),'');assert.equal(await p.locator('#admin-shell').isVisible(),false);
  await p.locator('[name=password]').fill('fixture-password');await p.locator('#login-form button[type=submit]').click();await ready(p,'trips');
  assert.equal(f.count('login'),3);assert.equal(f.count('trips.js'),1);assert.equal(await p.locator('#admin-mobile-tabs').count(),1);await f.close();
 }
 // Every cold URL requests its own resources; stylesheet cascade is visit-order independent.
 for(const [hash,selector,required,absent]of [
  ['guides','#filter-form',[],['travel-editor.js','trips.js','footprints-admin.js','travel-planner.js']],
  ['records','#record-filter-form',['footprints-admin.js'],['travel-editor.js','record-assistant.js','record-album.js','trips.js']],
  ['trips','#main h1',['trips.js'],['trip-assistant.js','journey-view.js','travel-editor.js']],
  ['travel-agent','#planner-form',['travel-planner.js','task-manager.js','journey-view.js'],['agent-admin.js','trips.js','travel-editor.js']],
  ['agent','#agent-task-form',['agent-admin.js','task-manager.js'],['travel-planner.js','trips.js','travel-editor.js']],
  ['import','#html-import-form',[],['guide-templates.js','travel-editor.js','footprints-admin.js']]
 ]){
  const f=await fixture(browser),{p}=f;await p.goto(origin+'/admin#'+hash);await ready(p,hash,selector);
  for(const name of required)assert.equal(f.count(name),1);for(const name of absent)assert.equal(f.count(name),0);
  assert.ok(resources(f).every(c=>/^\?v=[a-f0-9]{16}$/.test(c.query)),'all eager/lazy assets use content fingerprints');measurements[hash]=stats(f);
  for(const dest of ['agent','records','travel-agent','guides'])await go(p,dest);
  const order=await p.evaluate(()=>[...document.head.querySelectorAll('[data-admin-style-order]')].map(n=>Number(n.dataset.adminStyleOrder)));
  assert.deepEqual(order,[...order].sort((a,b)=>a-b));
  assert.deepEqual(await p.evaluate(()=>[...document.head.querySelectorAll('link[rel=stylesheet]')].slice(-2).map(n=>new URL(n.href).pathname)),['/static/admin-mobile.css','/static/admin-workspace.css']);
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  for(const name of ['task-manager.js','agent-admin.js','travel-planner.js','footprints-admin.js'])assert.equal(f.count(name),1,'shared/existing scripts execute once');
  await f.close();
 }
 // Failed script and stylesheet downloads can retry independently of cached siblings.
 {
  const f=await fixture(browser),{p}=f;f.fails.add('footprints-admin.js');await p.goto(origin+'/admin#records');await p.waitForSelector('[data-action=retry-page]');
  assert.equal(f.count('/api/records'),0);await p.locator('[data-action=retry-page]').click();await ready(p,'records','#record-filter-form');
  assert.equal(f.count('footprints-admin.js'),2);assert.equal(f.count('footprints-admin.css'),1);
  f.fails.add('travel-planner.css');await go(p,'travel-agent','[data-action=retry-page]');assert.equal(f.count('/api/admin/travel-agent'),0);
  await p.locator('[data-action=retry-page]').click();await ready(p,'travel-agent','#planner-form');
  assert.equal(f.count('travel-planner.css'),2);assert.equal(f.count('travel-planner.js'),1);await f.close();
 }
 // Cancelled pages never fetch their data/render; late shared downloads still execute once.
 {
  const f=await fixture(browser),{p}=f;await p.goto(origin+'/admin#guides');await ready(p,'guides');
  const release=f.hold('footprints-admin.js');await p.evaluate(()=>location.hash='records');await requested(f,'footprints-admin.js');
  await go(p,'account','#account-form');release();await p.waitForFunction(()=>typeof FootprintsAdmin!=='undefined');
  assert.equal(f.count('/api/records'),0);assert.equal(await p.locator('#account-form').count(),1);
  await go(p,'records','#record-filter-form');assert.equal(f.count('footprints-admin.js'),1);
  const releaseTasks=f.hold('task-manager.js');await p.evaluate(()=>location.hash='travel-agent');await requested(f,'task-manager.js');
  await go(p,'guides','#filter-form');releaseTasks();await p.waitForFunction(()=>typeof TaskManager!=='undefined');
  assert.equal(f.count('travel-planner.js'),0,'cancellation does not start remaining dependent downloads');assert.equal(f.count('/api/admin/travel-agent'),0);
  await f.close();
 }
 // A waiter timeout is not a failed download: retries share the same late script.
 {
  const f=await fixture(browser),{p}=f;await p.goto(origin+'/admin#guides');await ready(p,'guides');
  await p.evaluate(()=>window.shortTimeout=true);const release=f.hold('footprints-admin.js');
  await go(p,'records','[data-action=retry-page]');assert.ok((await p.locator('#main').innerText()).includes('超时'));
  await p.locator('[data-action=retry-page]').click();release();await ready(p,'records','#record-filter-form');assert.equal(f.count('footprints-admin.js'),1);
  const releasePlanner=f.hold('travel-planner.js');await p.evaluate(()=>location.hash='travel-agent');await requested(f,'travel-planner.js');
  await p.evaluate(()=>api('/expired').catch(()=>{}));await p.waitForSelector('#login-page:not([hidden])');releasePlanner();
  await p.waitForFunction(()=>typeof TravelPlanner!=='undefined');assert.equal(f.count('/api/admin/travel-agent'),0);assert.equal(await p.locator('#main').innerText(),'');await f.close();
 }
 // Core download retry after login does not repost credentials or duplicate shell listeners.
 {
  const f=await fixture(browser,false),{p}=f;f.fails.add('admin-mobile.js');await p.goto(origin+'/admin#guides');await p.waitForSelector('#login-page:not([hidden])');
  await p.locator('[name=username]').fill('fixture');await p.locator('[name=password]').fill('fixture-password');await p.locator('#login-form button[type=submit]').click();
  await p.waitForSelector('#admin-boot-retry');assert.equal(await p.locator('[name=password]').inputValue(),'');
  await p.locator('#admin-boot-retry').click();await ready(p,'guides','#filter-form');
  assert.equal(f.count('login'),1);assert.equal(f.count('session'),1);assert.equal(f.count('admin.js'),1);assert.equal(f.count('admin-mobile.js'),2);assert.equal(await p.locator('#admin-mobile-tabs').count(),1);await f.close();
 }
 // Initial connection failure remains retryable before any core code has loaded.
 {
  const f=await fixture(browser,false),{p}=f;f.fails.add('session');await p.goto(origin+'/admin');await p.waitForSelector('#admin-boot-retry');
  assert.equal(f.count('admin.js'),0);await p.locator('#admin-boot-retry').click();await p.waitForSelector('#login-page:not([hidden])');assert.equal(f.count('session'),2);await f.close();
 }
 console.log('PASS: lean login, cold page assets, versioned CSS order, deduplication, login/session handoff, failed JS/CSS retry, cancelled route downloads, timeout retry, expiry and logout');
 console.log(JSON.stringify(measurements));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
