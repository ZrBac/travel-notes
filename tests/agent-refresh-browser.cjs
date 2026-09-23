// Offline: completed task details should download once, then only after an update.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{const b=await chromium.launch({args:['--no-sandbox']});try{
 const ctx=await b.newContext(),p=await ctx.newPage(),errors=[];let calls=0,stamp='2026-09-23T10:00:00Z';
 p.on('pageerror',e=>errors.push(e.message));
 await ctx.route('**/*',r=>{const u=new URL(r.request().url());assert.equal(u.origin,'http://agent.test');assert.equal(r.request().method(),'GET');
 const task={id:1,prompt:'检查网站',kind:'diagnose',status:'done',created_at:stamp,updated_at:stamp,result:'已完成',report:{tests:'通过'}};
 if(u.pathname==='/api/session')return r.fulfill({json:{csrf:'fixture',user:{username:'test',display_name:'测试'}}});
 if(u.pathname==='/api/admin/agent')return r.fulfill({json:{tasks:[task],service:{online:true,authenticated:true,versions:[],health:{}}}});
 if(u.pathname==='/api/admin/agent/tasks/1'){calls++;return r.fulfill({json:{task}});}
 const f=path.join(root,u.pathname==='/admin'?'static/admin.html':u.pathname);return r.fulfill({body:fs.readFileSync(f),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(f)]||'application/octet-stream'});
 });
 await p.goto('http://agent.test/admin#agent');await p.waitForSelector('[data-agent=select]');await p.locator('[data-agent=select]').click();await p.waitForSelector('#agent-detail:not([hidden])');assert.equal(calls,1);
 for(let i=0;i<3;i++){const response=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/agent');await p.locator('[data-agent=refresh]').click();await response;}
 assert.equal(calls,1,'unchanged completed report must not download again');
 stamp='2026-09-23T10:01:00Z';await p.locator('[data-agent=refresh]').click();await p.waitForFunction(()=>document.querySelector('#agent-detail').dataset.updated==='2026-09-23T10:01:00Z');assert.equal(calls,2,'updated report must reload');
 await p.evaluate(()=>location.hash='account');await p.waitForSelector('#account-form');assert.deepEqual(errors,[]);await ctx.close();console.log('PASS: completed reports reused, updated reports refreshed, navigation intact');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exit(1)});
