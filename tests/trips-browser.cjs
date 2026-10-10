// Synthetic authenticated API fixtures; never writes production data or calls a model.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),clone=v=>JSON.parse(JSON.stringify(v));
const days=()=>[1,2].map(day=>({day,destination:'南京',theme:'老城慢游 '+day,stops:['南京老街','南京博物馆'],transport:'地铁约 20 分钟',lunch:'地方小吃',dinner:'家常菜',stay:'老城酒店',pace:'适中',slots:['上午','下午','晚上'].map(period=>({period,plan:'逛老街和博物馆',transport:'步行或地铁',reservation:period==='上午'?'博物馆提前预约':'无需预约'}))}));
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{for(const width of [320,390,1440]){
 const ctx=await browser.newContext({viewport:{width,height:844}}),p=await ctx.newPage(),errors=[],writes=[];
 await ctx.addInitScript(()=>Object.defineProperty(globalThis,'structuredClone',{value:undefined,configurable:true}));p.on('pageerror',e=>errors.push(e.message));
 let trip=null,plans=[],failCreate=true,failMeta=true,failPlan=true;
 const snapshot={title:'南京家庭慢游',destination:'南京',country:'中国',summary:'两天轻松安排',days:2,budget:'参考估算',conditions:{people:3,companions:'三位成人'},itinerary:days()};
 const task={id:1,status:'done',prompt:'比较南京和泉州',trip:{mode:'compare',destination:'南京、泉州',days:2,people:3},destinations:['南京','泉州'],guide:{...snapshot,body:'参考资料'},html:'<p>参考攻略</p>',progress:[],created_at:'2026-10-10',updated_at:'2026-10-10',publications:{}};
 const summary=()=>trip?{...clone(trip),phase:trip.state==='archived'?'archived':trip.phase,plan_version:plans.length}:null;
 function bump(){trip.revision++;return trip.revision;}
 function append(plan){const prior=plans.at(-1),version=plans.length+1;plans.push({id:version,version,label:'采用或调整',trip_id:1,snapshot:clone(plan),created_at:'2026-10-10'});if(prior)for(const day of plan.itinerary)for(const [index,stop]of day.stops.entries()){const old=prior.snapshot.itinerary[day.day-1].stops.indexOf(stop),status=trip.progress[prior.version+':'+day.day+':'+old];if(status)trip.progress[version+':'+day.day+':'+index]=status;}}
 await ctx.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());assert.equal(u.origin,'http://trips.test');const method=req.method(),data=method==='GET'?null:req.postDataJSON();
  if(u.pathname.startsWith('/api/')){
   if(method!=='GET'){assert.equal(req.headers()['x-csrf-token'],'fixture');writes.push({path:u.pathname,method,data:clone(data)});}
   if(u.pathname==='/api/session')return route.fulfill({json:{csrf:'fixture',user:{id:1,username:'fixture',display_name:'测试管理员'}}});
   if(u.pathname==='/api/admin/travel-agent')return route.fulfill({json:{tasks:[clone(task)],family_preferences:{preferences:{},updated_at:null},next_before:null,service:{online:true,authenticated:true,concurrency:2}}});
   if(u.pathname==='/api/admin/travel-agent/tasks/1')return route.fulfill({json:{task:clone(task)}});
   if(u.pathname==='/api/admin/travel-agent/preferences')return route.fulfill({json:{preferences:{people:3,origin:'上海'},updated_at:'2026-10-10'}});
   if(u.pathname==='/api/admin/trips/source'){assert.equal(u.searchParams.get('destination'),'南京');return route.fulfill({json:{plan:clone(snapshot),destinations:['南京','泉州'],source:{task_id:1,guide_id:null,destination:'南京',updated_at:'fixture'}}});}
   if(u.pathname==='/api/admin/trips'&&method==='GET')return route.fulfill({json:{trips:trip&&(!u.searchParams.get('state')||trip.state===u.searchParams.get('state'))?[summary()]:[],focus:trip?.state==='active'?summary():null,total:trip?1:0,page:1,pages:1}});
   if(u.pathname==='/api/admin/trips'&&method==='POST'){
    if(failCreate){failCreate=false;return route.fulfill({status:409,json:{error:'模拟采用失败，请重试'}});}
    assert.equal(data.source.destination,'南京');assert.equal(data.end_date,'2026-11-07');assert.equal(data.people,3);assert.match(data.request_key,/^[a-f0-9]{32}$/);
    trip={id:1,title:data.title||'南京家庭旅行',destination:'南京',start_date:data.start_date,end_date:data.end_date,people:data.people,companions:data.companions,lodging:'',transport:'',notes:'',state:'active',revision:1,phase:'travelling',today_day:2,countdown:0,days:2,progress:{},checklist:[{id:'c1',kind:'prepare',title:'确认车票',note:'',done:false,day:null,plan_version:null},{id:'c2',kind:'reservation',title:'博物馆预约',note:'预约完成后勾选',done:false,day:1,plan_version:1},{id:'c3',kind:'packing',title:'带充电器',note:'',done:false,day:null,plan_version:null}]};append(snapshot);return route.fulfill({status:201,json:{id:1}});
   }
   if(u.pathname==='/api/admin/trips/1'&&method==='GET')return route.fulfill({json:{trip:clone(trip),plan:clone(plans.at(-1)),versions:clone(plans).reverse().map(({version,label,created_at})=>({version,label,created_at}))}});
   if(u.pathname==='/api/admin/trips/1'&&method==='PUT'){
    assert.equal(data.revision,trip.revision);await new Promise(r=>setTimeout(r,180));
    if(failMeta){failMeta=false;return route.fulfill({status:409,json:{error:'模拟资料保存冲突'}});}
    const {revision,...values}=data;Object.assign(trip,values);bump();return route.fulfill({json:{ok:true,revision:trip.revision,trip:clone(trip)}});
   }
   if(u.pathname==='/api/admin/trips/1/checklist'){
    assert.equal(data.revision,trip.revision);
    if(data.action==='update'){const item=trip.checklist.find(c=>c.id===data.id);Object.assign(item,Object.fromEntries(['done','title','note'].filter(k=>k in data).map(k=>[k,data[k]])));}
    else if(data.action==='add')trip.checklist.push({id:'c'+(trip.checklist.length+1),kind:data.kind,title:data.title,note:data.note,done:false,day:null,plan_version:null});
    else if(data.action==='remove')trip.checklist=trip.checklist.filter(c=>c.id!==data.id);
    bump();return route.fulfill({json:{checklist:clone(trip.checklist),revision:trip.revision}});
   }
   if(u.pathname==='/api/admin/trips/1/progress'){
    assert.equal(data.revision,trip.revision);assert.equal(data.plan_version,plans.length);const key=plans.length+':'+data.day+':'+data.index;if(data.status)trip.progress[key]=data.status;else delete trip.progress[key];bump();return route.fulfill({json:{progress:clone(trip.progress),revision:trip.revision}});
   }
   if(u.pathname==='/api/admin/trips/1/plan'){
    assert.equal(data.revision,trip.revision);
    if(data.itinerary&&failPlan){failPlan=false;return route.fulfill({status:409,json:{error:'模拟日程保存冲突'}});}
    const plan=data.source?snapshot:data.restore_version?plans.find(v=>v.version===data.restore_version).snapshot:{...plans.at(-1).snapshot,itinerary:data.itinerary};append(plan);bump();return route.fulfill({json:{ok:true,revision:trip.revision,version:plans.length}});
   }
   if(u.pathname.startsWith('/api/admin/trips/1/plans/')){const version=Number(u.pathname.split('/').at(-1));return route.fulfill({json:{plan:clone(plans.find(v=>v.version===version)),html:'<p>采用时保存的参考攻略</p>'}});}
   if(u.pathname==='/api/admin/overview')return route.fulfill({json:{trip:summary(),counts:{total:0,draft:0,private:0,trash:0},records:{total:0,public:0},media:{count:0,bytes:0},recent:[],database:'PostgreSQL',backup:null}});
   throw Error('Unexpected API '+method+' '+u.pathname);
  }
  assert.equal(method,'GET');const file=path.join(root,u.pathname==='/admin'?'static/admin.html':u.pathname);return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});
 });
 const go=async hash=>{await p.evaluate(h=>location.hash=h,hash);await p.waitForFunction(h=>state.route===h&&!document.querySelector('#main').inert,hash);};
 await p.goto('http://trips.test/admin#travel-agent');await p.waitForSelector('[data-planner=trip-adopt]');await p.locator('[data-planner=trip-adopt]').click();await p.waitForSelector('#dialog[open]');assert.equal(await p.locator('.trip-choice a').count(),2);await p.locator('.trip-choice a').filter({hasText:'南京'}).click();await p.waitForSelector('#trip-create-form');
 assert.ok(p.url().includes('trip-new/task/1/'));assert.equal(await p.locator('#trip-create-form [name=people]').inputValue(),'3');assert.equal(await p.locator('.trip-preview-route strong').count(),2);
 await p.locator('#trip-create-form [name=start_date]').fill('2026-11-06');await p.locator('#trip-create-form [name=start_date]').press('Tab');assert.equal(await p.locator('#trip-create-form [name=end_date]').inputValue(),'2026-11-07');
 await p.locator('#trip-create-form button[type=submit]').click();await p.waitForFunction(()=>document.querySelector('#trip-create-error').textContent.includes('模拟采用失败'));assert.equal(await p.locator('#trip-create-form [name=start_date]').inputValue(),'2026-11-06');assert.ok(await p.evaluate(()=>state.dirty));
 await p.locator('#trip-create-form button[type=submit]').click();await p.waitForSelector('.trip-check');await p.waitForFunction(()=>!state.dirty);assert.equal(await p.locator('.trip-check').count(),3);assert.equal(plans.length,1);
 const tabRects=await p.locator('.trip-tabs a').evaluateAll(nodes=>nodes.map(n=>({top:n.getBoundingClientRect().top,left:n.getBoundingClientRect().left,height:n.getBoundingClientRect().height})));
 assert.ok(tabRects.every(r=>Math.abs(r.top-tabRects[0].top)<1&&r.height>=44),'trip tabs fit one touch-friendly row '+width);assert.ok(tabRects[1].left>tabRects[0].left&&tabRects[2].left>tabRects[1].left);
 assert.ok(await p.locator('#trip-meta-form').locator('..').locator('summary').isVisible(),'collapsed travel details remain visible');
 await p.locator('#trip-meta-form').locator('..').locator('summary').click();await p.locator('#trip-meta-form [name=lodging]').fill('已订老城酒店');await p.locator('#trip-meta-form [name=transport]').fill('已买高铁票');
 await p.locator('[data-trip-check=c1]').check();await p.waitForFunction(()=>!Trips.busy);assert.equal(await p.locator('#trip-meta-form [name=lodging]').inputValue(),'已订老城酒店');assert.ok(await p.evaluate(()=>state.dirty),'automatic checklist save preserves unsaved metadata');
 await p.locator('#trip-meta-form button[type=submit]').click();await p.waitForFunction(()=>document.querySelector('#trip-meta-error').textContent.includes('保存冲突'));assert.equal(await p.locator('#trip-meta-form [name=lodging]').inputValue(),'已订老城酒店');
 await p.locator('#trip-meta-form button[type=submit]').click();await p.waitForFunction(()=>!state.dirty&&!Trips.busy);assert.equal(trip.lodging,'已订老城酒店');assert.equal(trip.checklist[0].done,true);
 await p.locator('#trip-check-add [name=title]').fill('带相机');await p.locator('#trip-check-add button[type=submit]').click();await p.waitForFunction(()=>document.querySelectorAll('.trip-check').length===4&&!Trips.busy);assert.equal(await p.locator('#trip-check-add [name=title]').inputValue(),'');
 await go('trip/1/today');assert.equal(await p.locator('#trip-day-select').inputValue(),'2');assert.ok((await p.locator('#trip-body').innerText()).includes('已买高铁票'));await p.locator('#trip-day-select').selectOption('1');
 const map=await p.locator('.trip-stop-main a').first().getAttribute('href');assert.equal(new URL(map).hostname,'uri.amap.com');assert.equal(new URL(map).searchParams.get('city'),'南京');
 await p.locator('[data-trip=progress][data-index="0"][data-status=done]').click();await p.waitForFunction(()=>document.querySelector('.trip-progress .is-selected')?.textContent.includes('已去'));
 await p.locator('[data-trip=edit-day]').click();await p.locator('#trip-day-form [name=lunch]').fill('想吃鸭血粉丝汤');
 p.once('dialog',d=>d.dismiss());await p.locator('.trip-tabs [href="#trip/1/plan"]').click();await p.waitForFunction(()=>location.hash==='#trip/1/today');assert.equal(await p.locator('#trip-day-form [name=lunch]').inputValue(),'想吃鸭血粉丝汤');
 await p.locator('#trip-day-form button[type=submit]').click();await p.waitForFunction(()=>document.querySelector('#trip-day-error').textContent.includes('保存冲突'));assert.equal(await p.locator('#trip-day-form [name=lunch]').inputValue(),'想吃鸭血粉丝汤');
 await p.locator('#trip-day-form button[type=submit]').click();await p.waitForFunction(()=>document.querySelector('#trip-plan-status')?.textContent.includes('第 2 版')&&!Trips.busy);assert.ok((await p.locator('#trip-body').innerText()).includes('想吃鸭血粉丝汤'));assert.equal(trip.lodging,'已订老城酒店');assert.equal(trip.progress['2:1:0'],'done');
 if(width===390){await p.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await p.waitForTimeout(250);await p.screenshot({path:'/tmp/trips-today-phone.png',fullPage:true});}assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'today overflow '+width);
 await go('trip/1/plan');assert.equal(await p.locator('.trip-versions>div').count(),2);await p.locator('[data-trip=version][data-version="1"]').click();await p.waitForSelector('#trip-reference .panel');assert.ok((await p.locator('#trip-reference').innerText()).includes('地方小吃'));
 p.once('dialog',d=>d.accept());await p.locator('[data-trip=restore][data-version="1"]').click();await p.waitForFunction(()=>document.querySelector('#trip-plan-status').textContent.includes('第 3 版')&&!Trips.busy);assert.equal(plans.at(-1).snapshot.itinerary[0].lunch,'地方小吃');assert.equal(trip.checklist[0].done,true);
 await go('trip-new/task/1/'+encodeURIComponent('南京'));await p.waitForSelector('#trip-create-form');await p.locator('#trip-create-form [name=target]').selectOption('1');assert.equal(await p.locator('#trip-create-meta').isVisible(),false);await p.locator('#trip-create-form button[type=submit]').click();await p.waitForSelector('.trip-check');await p.waitForFunction(()=>!Trips.busy);assert.equal(plans.length,4);assert.equal(trip.lodging,'已订老城酒店');assert.equal(trip.people,3);
 if(width===390){await p.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await p.waitForTimeout(250);await p.screenshot({path:'/tmp/trips-prepare-phone.png',fullPage:true});}assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'prepare overflow '+width);
 await go('dashboard');assert.ok((await p.locator('.trip-focus').innerText()).includes('今天是第 2 天'));await go('trips');await p.locator('#trip-filter [name=state]').selectOption('active');await p.locator('#trip-filter button[type=submit]').click();await p.waitForFunction(()=>state.route==='trips?q=&state=active'&&!document.querySelector('#main').inert);assert.equal(await p.locator('.trip-card').count(),1);
 await go('trip/1/plan');await p.locator('[data-trip=archive]').click();await p.waitForFunction(()=>state.route==='trips'&&!document.querySelector('#main').inert);assert.equal(trip.state,'archived');assert.ok((await p.locator('.trip-card').innerText()).includes('已归档'));
 assert.deepEqual(errors,[]);assert.ok(writes.every(w=>w.path.startsWith('/api/admin/trips')));await p.evaluate(()=>{state.user=null;showLogin();});assert.equal(await p.locator('#main').innerText(),'');assert.equal(await p.locator('#admin-shell').isVisible(),false);
 await ctx.close();console.log('PASS '+width+': selected-candidate adoption, retry keeps input, private trip, booking/notes preservation, today navigation, visit marks, daily edit, versions/restore, existing-trip adoption, dashboard/filter/archive, logout and Safari clone fallback');
 }}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
