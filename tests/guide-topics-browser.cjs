// Synthetic content only: optional topics, custom labels, legacy routes and small screens.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),out=process.env.TRAVEL_SCREENSHOTS||'/tmp/guide-topics';fs.mkdirSync(out,{recursive:true});
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 for(const width of [320,390,1440]){
  const ctx=await browser.newContext({viewport:{width,height:900}}),errors=[],writes=[];
  let guide={id:1,title:'西双版纳四天三晚',destination:'西双版纳',country:'中国',days:4,summary:'热带植物与傣族文化',season:'秋季',budget:'参考预算',cover:'/static/assets/lake.jpg',tags:['AI参考','参考','自然风景'],status:'public',category_id:1,body:'<p>真实攻略正文</p>',html:'<p>真实攻略正文</p>',sources:'',verified_at:'',sample:false,revision:1,updated_at:'2026-10-10'};
  const publicGuide={...guide,tags:['AI参考','参考','2026秋游备选','自然风景','自然风景']},other={...guide,id:2,title:'城市随行',destination:'南京',tags:['人文体验','美食','摄影','漫步','小巷']};
  const taxonomy={categories:[{id:1,name:'国内旅行',count:2}],tags:[{name:'AI参考',count:4},{name:'自然风景',count:1},{name:'摄影',count:1},{name:'过时主题',count:0}]};
  await ctx.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());assert.equal(u.origin,'http://topics.test');
   if(u.pathname.startsWith('/api/')){
    let data;
    if(req.method()==='PUT'){
     assert.equal(u.pathname,'/api/guides/1');assert.equal(req.headers()['x-csrf-token'],'fixture');
     const body=req.postDataJSON();writes.push(body);guide={...guide,...body,revision:guide.revision+1};data={id:1};
    }else if(req.method()==='POST'){
     assert.equal(u.pathname,'/api/admin/preview');data={html:req.postDataJSON().body||''};
    }else{
     assert.equal(req.method(),'GET');
     if(u.pathname==='/api/session')data={csrf:'fixture',user:{id:1,username:'fixture'}};
     else if(u.pathname==='/api/bootstrap')data={site:{site_name:'行笺'},session:{authenticated:false,csrf:''},guides:[publicGuide,other],records:[],record_count:0};
     else if(u.pathname==='/api/records')data={records:[],total:0,pages:1,page:1,years:[],destinations:[]};
     else if(u.pathname==='/api/admin/taxonomy')data=taxonomy;
     else if(u.pathname==='/api/admin/guides')data={guides:[guide],total:1,pages:1,page:1};
     else if(u.pathname==='/api/guides/1')data={guide:u.searchParams.get('view')==='read'?publicGuide:guide};
     else throw Error('Unexpected API '+u.pathname);
    }
    return route.fulfill({json:data});
   }
   const file=path.join(root,u.pathname==='/admin'?'static/admin.html':u.pathname==='/'?'static/index.html':u.pathname);
   return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.jpg':'image/jpeg'})[path.extname(file)]||'application/octet-stream'});
  });
  const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));
  const go=async hash=>{await p.evaluate(h=>location.hash=h,hash);await p.waitForFunction(h=>state.route===h&&!document.querySelector('#main').inert&&!TravelEditor.busy,hash);};
  const fits=async()=>assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow at '+width);
  await p.goto('http://topics.test/admin#guides');await p.waitForSelector('#filter-form');
  assert.equal(await p.locator('#filter-form select[name=tag]').count(),0);assert.equal(await p.locator('#filter-form select').count(),2);
  await go('edit/1');const topics=p.locator('.guide-topic-editor');assert.equal(await topics.getAttribute('open'),null);
  await topics.locator('summary').click();assert.equal(await topics.locator('[data-guide-topic]').count(),6);
  const input=topics.locator('[name=tags]');assert.equal(await input.inputValue(),'自然风景');
  for(const name of ['人文体验','美食','摄影'])await topics.locator('[data-guide-topic="'+name+'"]').click();
  assert.equal(await input.inputValue(),'自然风景，人文体验，美食');assert.equal(await topics.locator('[data-guide-topic="摄影"]').getAttribute('aria-pressed'),'false');
  await topics.locator('[data-guide-topic="自然风景"]').click();await topics.locator('[data-guide-topic="摄影"]').click();
  assert.equal(await input.inputValue(),'人文体验，美食，摄影');assert.equal(await p.evaluate(()=>state.dirty),true);await fits();
  await p.screenshot({path:out+'/editor-'+width+'.png',fullPage:true});
  await input.fill('人文体验，自定义主题,人文体验,AI参考');await p.locator('#editor-form button[type=submit]').click();
  await p.waitForFunction(()=>!state.dirty&&!document.querySelector('#main').inert&&!TravelEditor.busy);
  assert.equal(writes.length,1);assert.deepEqual(writes[0].tags,['人文体验','自定义主题']);assert.equal(writes[0].body,'<p>真实攻略正文</p>');
  await go('taxonomy');assert.equal(await p.locator('#main h1').innerText(),'分类管理');
  assert.equal(await p.locator('.guide-topic-maintenance').getAttribute('open'),null);await p.locator('.guide-topic-maintenance summary').click();
  assert.deepEqual(await p.locator('.guide-topic-maintenance .taxonomy-row strong').allInnerTexts(),['自然风景','摄影']);assert.equal(await p.locator('[data-kind=tag][data-action=taxonomy-form]:not([data-name])').count(),0);await fits();
  const publicPage=await ctx.newPage();publicPage.on('pageerror',e=>errors.push(e.message));
  await publicPage.goto('http://topics.test/#guides');await publicPage.waitForSelector('#guide-grid');
  assert.equal(await publicPage.locator('#site-more a[href="#tags"]').count(),0);
  assert.deepEqual(await publicPage.locator('.guide-card').first().locator('.tag').allInnerTexts(),['自然风景']);assert.equal(await publicPage.locator('.guide-card').nth(1).locator('.tag').count(),3);
  await publicPage.evaluate(()=>location.hash='guide/1');await publicPage.waitForSelector('.article-header');
  assert.deepEqual(await publicPage.locator('.aside-tags .chip').allInnerTexts(),['# 自然风景']);
  await publicPage.locator('.aside-tags .chip').click();await publicPage.waitForSelector('#guide-grid');assert.equal(await publicPage.locator('.guide-card').count(),1,'topic still filters relevant guides');
  await publicPage.evaluate(()=>location.hash='tags');await publicPage.waitForFunction(()=>location.hash==='#guides'&&!document.querySelector('#app').inert);
  assert.equal(await publicPage.locator('.guide-card').count(),2);assert.ok(await publicPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await publicPage.screenshot({path:out+'/public-'+width+'.png',fullPage:true});assert.deepEqual(errors,[]);await ctx.close();console.log('PASS '+width+': optional topics, custom labels, clean navigation and legacy bookmarks');
 }
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
