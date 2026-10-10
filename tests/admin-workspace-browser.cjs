// Every response is synthetic; the layout check never reaches production or a model.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out='/tmp/admin-redesign';fs.mkdirSync(out,{recursive:true});
const guide={id:1,title:'南京四天三晚：老城、人文与地方美食',destination:'南京',country:'中国',summary:'放慢节奏，走一走老城。',days:4,status:'private',tags:['家庭旅行'],category_id:1,cover:'/static/assets/lake.jpg',body:'<p>参考行程</p>',html:'<p>参考行程</p>',revision:1,updated_at:'2026-10-10'};
const record={id:1,title:'在老城散步的一天',destination:'南京',start_date:'2026-10-01',end_date:'2026-10-04',photos:[],photo_count:3,cover:guide.cover,status:'private',summary:'几张照片和一点回忆',body:'<p>旅行手记</p>',html:'<p>旅行手记</p>',revision:1};
const day={day:1,destination:'南京',theme:'到达南京，逛一逛老城',stops:['老门东','夫子庙'],transport:'地铁与步行',lunch:'南京鸭血粉丝汤',dinner:'家常菜',stay:'市中心酒店',pace:'轻松',slots:['上午','下午','晚上'].map(period=>({period,plan:'在老城慢慢逛，留出休息时间',transport:'步行或地铁',reservation:'请出发前核实开放时间'}))};
const trip={id:1,title:'和家人去南京',destination:'南京',start_date:'2026-10-10',end_date:'2026-10-13',people:3,state:'active',revision:1,phase:'travelling',today_day:1,countdown:0,days:4,plan_version:1,checklist_total:8,checklist_done:3,companions:'三位成人',lodging:'已订市中心酒店',transport:'高铁往返',notes:'慢一点，留下休息时间',progress:{},checklist:[{id:'c1',kind:'prepare',title:'确认往返交通',note:'',done:true,plan_version:null},{id:'c2',kind:'reservation',title:'核实博物馆开放时间',note:'出发前再确认一次',done:false,day:2,plan_version:1}]};
const itinerary=Array.from({length:4},(_,i)=>({...day,day:i+1}));
const plan={id:1,version:1,label:'采用攻略',snapshot:{title:guide.title,country:'中国',summary:guide.summary,days:4,budget:'按实际预约与支出核实',conditions:{people:3},itinerary}};
const overview={trip,counts:{total:4,private:3,draft:1,trash:0},records:{total:2,public:1},media:{count:24,bytes:3600000},recent:[guide],database:'PostgreSQL',backup:{created_at:'2026-10-10T03:15:00+08:00',filename:'example-backup.tar.gz'}};
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 for(const width of [320,390,768,1024,1440]){
  const ctx=await browser.newContext({viewport:{width,height:900}}),p=await ctx.newPage(),errors=[],calls=[];
  p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());
  await ctx.addInitScript(()=>Object.defineProperty(globalThis,'structuredClone',{value:undefined,configurable:true}));
  await ctx.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());assert.equal(u.origin,'http://workspace.test');
   if(req.method()!=='GET'){
    assert.equal(req.method(),'POST');assert.equal(u.pathname,'/api/admin/preview');assert.equal(req.headers()['x-csrf-token'],'fixture');
    return route.fulfill({json:{html:req.postDataJSON().body||''}});
   }
   if(u.pathname.startsWith('/api/')){
    calls.push(u.pathname);let data;
    if(u.pathname==='/api/session')data={csrf:'fixture',user:{id:1,username:'fixture',display_name:'旅行管理员'}};
    else if(u.pathname==='/api/admin/overview')data=overview;
    else if(u.pathname==='/api/admin/taxonomy')data={categories:[{id:1,name:'国内旅行',count:4}],tags:[{name:'家庭旅行',count:4}]};
    else if(u.pathname==='/api/admin/guides')data={guides:[guide],total:1,page:1,pages:1};
    else if(u.pathname==='/api/guides/1')data={guide};
    else if(u.pathname==='/api/guides')data={guides:[guide]};
    else if(u.pathname==='/api/records')data={records:[record],total:1,page:1,pages:1};
    else if(u.pathname==='/api/records/1')data={record};
    else if(u.pathname==='/api/admin/media')data={media:Array.from({length:6},(_,i)=>({url:guide.cover,filename:String(i).padStart(32,'0')+'.webp',name:'旅行图片 '+(i+1),width:1280,height:960,bytes:90000,references:[],deleted_at:null})),defaults:[]};
    else if(u.pathname==='/api/admin/travel-agent')data={tasks:[],next_before:null,family_preferences:{preferences:{people:3,origin:'上海'},updated_at:null},service:{online:true,authenticated:true,concurrency:2}};
    else if(u.pathname==='/api/admin/travel-agent/preferences')data={preferences:{people:3},updated_at:null};
    else if(u.pathname==='/api/admin/agent')data={tasks:[],next_before:null,service:{online:true,authenticated:true,health:{warnings:[]},versions:[]}};
    else if(u.pathname==='/api/admin/trips')data={trips:[trip],focus:trip,total:1,page:1,pages:1};
    else if(u.pathname==='/api/admin/trips/1')data={trip,plan,versions:[{version:1,label:'采用攻略',created_at:'2026-10-10'}]};
    else if(u.pathname==='/api/site')data={site_name:'行笺',tagline:'为家人和自己准备每一次出发',footer:'收藏旅行',show_samples:false};
    else if(u.pathname==='/api/admin/audit')data={logs:[{id:1,action:'trip.create',actor:'管理员',created_at:'2026-10-10',target:'1',details:{title:trip.title}}],total:1,page:1,pages:1};
    else throw Error('Unexpected API '+u.pathname);
    return route.fulfill({json:data});
   }
   const file=path.join(root,u.pathname==='/admin'?'static/admin.html':u.pathname);
   return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.jpg':'image/jpeg'})[path.extname(file)]||'application/octet-stream'});
  });
  const go=async hash=>{const encoded=await p.evaluate(h=>{location.hash=h;return location.hash.slice(1);},hash);await p.waitForFunction(h=>state.route===h&&!document.querySelector('#main').inert,encoded);await p.waitForFunction(()=>!TravelEditor.busy);await p.evaluate(()=>new Promise(requestAnimationFrame));};
  const fits=async route=>assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow: '+route+' / '+width);
  const snap=async name=>{if([390,1440].includes(width)){await p.evaluate(()=>scrollTo(0,0));await p.waitForTimeout(150);await p.screenshot({path:out+'/'+name+'-'+width+'.png',fullPage:true});}};
  await p.goto('http://workspace.test/admin#dashboard');await p.waitForSelector('.workspace-start');
  assert.ok((await p.locator('.journey-hero').innerText()).includes('今天是第 1 天'));assert.equal(await p.locator('.journey-readiness progress').getAttribute('value'),'3');
  assert.equal(calls.filter(path=>path==='/api/admin/overview').length,1,'one overview request renders the whole dashboard');
  await fits('dashboard');await snap('dashboard');
  const mobile=width<=900;
  if(mobile){
   assert.deepEqual(await p.locator('#admin-mobile-tabs a').allInnerTexts(),['旅行','攻略','足迹','素材','助手']);
   assert.deepEqual(await p.locator('#admin-mobile-tabs a').evaluateAll(ns=>ns.map(n=>n.getAttribute('aria-label'))),['我的旅行','攻略管理','旅行足迹','图片素材','旅游助手']);
   assert.equal(await p.locator('#navigation').isVisible(),false);
   await p.locator('#admin-menu-toggle').click();await p.waitForFunction(()=>document.activeElement.classList.contains('admin-drawer-close'));
   assert.equal(await p.locator('.workspace').evaluate(n=>n.inert),true);assert.equal(await p.locator('.sidebar').getAttribute('aria-hidden'),'false');
   await p.locator('.sidebar-foot [data-action=logout]').focus();await p.keyboard.press('Tab');assert.equal(await p.evaluate(()=>document.activeElement.classList.contains('brand')),true,'drawer traps focus');
   await snap('navigation');await p.keyboard.press('Escape');assert.equal(await p.locator('#admin-menu-toggle').getAttribute('aria-expanded'),'false');assert.equal(await p.locator('.workspace').evaluate(n=>n.inert),false);assert.equal(await p.evaluate(()=>document.activeElement.id),'admin-menu-toggle');
   await p.locator('#admin-menu-toggle').click();await p.locator('.admin-menu-backdrop').click({position:{x:width-2,y:200}});assert.equal(await p.locator('#navigation').isVisible(),false);
   if(width===390){await p.locator('#admin-menu-toggle').click();await p.setViewportSize({width:1024,height:900});await p.waitForFunction(()=>!document.querySelector('.sidebar').inert&&!document.querySelector('.workspace').inert);assert.equal(await p.locator('#navigation').isVisible(),true);await p.setViewportSize({width,height:900});await p.waitForFunction(()=>document.querySelector('.sidebar').inert);assert.equal(await p.locator('#navigation').isVisible(),false);}
   await p.locator('#admin-menu-toggle').click();await p.locator('#navigation [href="#trips"]').click();await p.waitForSelector('.trip-card');assert.equal(await p.locator('#navigation').isVisible(),false);
  }else{
   assert.equal(await p.locator('#admin-mobile-tabs').isVisible(),false);assert.equal(await p.locator('#admin-menu-toggle').isVisible(),false);
   assert.equal(await p.locator('.nav-system').getAttribute('open'),null);assert.equal(await p.locator('#navigation [aria-current=page]').getAttribute('href'),'#dashboard');
  }
  for(const route of ['trips','trip/1/prepare','trip/1/today','trip/1/plan','trips?q=南京&state=active','trip-new','guides','trash','records','record-trash','media','taxonomy','travel-agent','agent','settings','data','audit','account','new','edit/1','record-new','record-edit/1','import']){
   await go(route);await fits(route);assert.equal(await p.locator('#main .initial-loading').count(),0);assert.equal(await p.locator('#main h1').count(),1,'clear page heading '+route);
   if(mobile&&route.startsWith('trips')){await p.waitForFunction(()=>document.querySelector('#admin-mobile-tabs [aria-current=page]')?.hash==='#trips');}
   if(route==='media')assert.ok(await p.locator('.media-body .button').evaluateAll(ns=>ns.every(n=>n.scrollWidth<=n.clientWidth+1)),'media action labels fit '+width);
   if(['guides','records','media','travel-agent','agent','settings','account','edit/1','trip/1/today'].includes(route))await snap(route.replaceAll('/','-'));
   if(route==='account'&&!mobile)assert.ok(await p.locator('.nav-system').getAttribute('open')!==null,'settings group expands on its own page');
   if(route==='edit/1')await p.waitForFunction(()=>!TravelEditor.busy);
  }
  await go('dashboard');const empty=await p.evaluate(()=>AdminWorkspace.dashboard({...{counts:{total:0,private:0,draft:0,trash:0},records:{total:0,public:0},media:{count:0,bytes:0},recent:[],backup:null},trip:null}));
  await p.locator('#main').evaluate((n,html)=>n.innerHTML=html,empty);await fits('empty dashboard');await snap('dashboard-empty');assert.equal(await p.locator('.journey-hero [href="#travel-agent"]').count(),1);
  await p.evaluate(()=>{state.user=null;showLogin();});assert.equal(await p.locator('#main').innerText(),'');assert.equal(await p.locator('#admin-mobile-tabs').isVisible(),false);assert.equal(await p.locator('.admin-menu-backdrop').isVisible(),false);await fits('login');await snap('login');
  assert.deepEqual(errors,[]);await ctx.close();console.log('PASS '+width+': all administration pages, overview/empty state, navigation, drawer focus/Escape/backdrop, five tabs and query selection, logout, no extra API requests');
 }
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
