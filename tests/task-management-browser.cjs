// Offline, both assistants: list selection, dependency confirmation, cancellation and stale plans.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{const b=await chromium.launch({args:['--no-sandbox']});try{for(const width of [1440,390,320])for(const scope of ['agent','travel-agent']){
 const prefix=scope==='agent'?'agent':'planner',ctx=await b.newContext({viewport:{width,height:950}}),p=await ctx.newPage(),errors=[];
 p.on('pageerror',e=>errors.push(e.message));let deletes=0,listReads=0,stale=true;
 let tasks=[1,2,3,4,5,6].map(id=>({id,prompt:'测试记录 '+id,kind:'chat',trip:{destination:'城市 '+id,days:4,people:1},status:[3,5].includes(id)?'running':'done',parent_id:id===2?1:id===5?4:null,updated_at:'2026-09-23T10:00:00Z',created_at:'2026-09-23T10:00:00Z',result:'测试结果',report:{},progress:[]})).reverse();
 const active=t=>['queued','running','testing','publishing'].includes(t.status);
 function branch(ids){const set=new Set(ids);for(let n=0;n<tasks.length;n++)for(const t of tasks)if(set.has(t.parent_id))set.add(t.id);return tasks.filter(t=>set.has(t.id));}
 await ctx.route('**/*',r=>{const u=new URL(r.request().url());assert.equal(u.origin,'http://tasks.test');
 if(u.pathname==='/api/session')return r.fulfill({json:{csrf:'fixture',user:{username:'test',display_name:'测试'}}});
 if(u.pathname==='/api/admin/'+scope){listReads++;return r.fulfill({json:{tasks,next_before:null,service:{online:true,authenticated:true,versions:[],health:{},concurrency:2}}});}
 if(u.pathname.endsWith('/delete-preview')){const data=r.request().postDataJSON(),rows=branch(data.ids);assert.equal(r.request().headers()['x-csrf-token'],'fixture');return r.fulfill({json:{ids:rows.map(t=>t.id),selected_ids:data.ids,added_count:rows.length-data.ids.length,blocked_ids:rows.filter(active).map(t=>t.id),can_delete:!rows.some(active),confirmation:'fixture',tasks:rows.map(t=>({...t,title:t.prompt,selected:data.ids.includes(t.id)}))}});}
 if(u.pathname.endsWith('/bulk-delete')){
  const data=r.request().postDataJSON();assert.equal(data.confirmation,'fixture');deletes++;
  if(stale){stale=false;tasks.push({...tasks.find(t=>t.id===2),id:7,parent_id:2,prompt:'新增后续任务'});return r.fulfill({status:409,json:{error:'任务或关联记录已变化，请重新检查删除范围'}});}
  const rows=branch(data.ids);assert.ok(!rows.some(active));const ids=rows.map(t=>t.id);tasks=tasks.filter(t=>!ids.includes(t.id));return r.fulfill({json:{ok:true,ids,count:ids.length}});
 }
 if(/\/tasks\/\d+$/.test(u.pathname)){const task=tasks.find(t=>t.id===Number(u.pathname.split('/').pop()));return r.fulfill({json:{task}});}
 assert.ok(!u.pathname.startsWith('/api/'),'Unexpected request '+u.pathname);const f=path.join(root,u.pathname==='/admin'?'static/admin.html':u.pathname);return r.fulfill({body:fs.readFileSync(f),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(f)]||'application/octet-stream'});
 });
 await p.goto('http://tasks.test/admin#'+scope);await p.waitForSelector('.task-row');
 assert.equal(await p.locator('.task-row input:disabled').count(),2);assert.equal(await p.locator('.task-row .task-delete:disabled').count(),2);
 await p.locator('[data-'+prefix+'=select-all]').check();assert.equal(await p.locator('.task-row input:checked').count(),4);
 await p.locator('[data-'+prefix+'=delete-selected]').click();await p.waitForSelector('#task-delete-confirm');assert.ok(await p.locator('#task-delete-confirm').isDisabled());assert.ok((await p.locator('#dialog').innerText()).includes('正在处理'));await p.locator('#task-delete-cancel').click();assert.equal(deletes,0);
 await p.locator('[data-'+prefix+'=clear-selection]').click();
 // Direct deletion works from the list, without opening its detail first.
 await p.locator('.task-row [data-'+prefix+'=delete][data-id="1"]').click();await p.waitForSelector('#task-delete-confirm');assert.equal(await p.locator('.task-delete-list>div').count(),2);await p.locator('#task-delete-cancel').click();assert.equal(deletes,0);
 await p.locator('[data-'+prefix+'=check][data-id="1"]').check();await p.locator('[data-'+prefix+'=check][data-id="6"]').check();
 const refresh=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/'+scope);await p.locator('[data-'+prefix+'=refresh]').click();await refresh;assert.equal(await p.locator('.task-row input:checked').count(),2,'poll preserves selection');
 await p.locator('[data-'+prefix+'=delete-selected]').click();await p.waitForSelector('#task-delete-confirm');assert.equal(await p.locator('.task-delete-list>div').count(),3);
 await p.locator('#task-delete-confirm').click();await p.waitForFunction(()=>document.querySelector('#task-delete-confirm')?.textContent==='重新检查删除范围');assert.equal(deletes,1);
 await p.locator('#task-delete-confirm').click();await p.waitForFunction(()=>document.querySelectorAll('.task-delete-list>div').length===4);assert.equal(deletes,1,'changed scope requires another explicit confirmation');
 const reads=listReads;await p.locator('#task-delete-confirm').click();await p.waitForFunction(()=>!document.querySelector('#dialog').open&&document.querySelectorAll('.task-row').length===3);assert.equal(deletes,2);assert.equal(listReads,reads,'successful removal updates locally');assert.equal(await p.locator('.task-row input:checked').count(),0);
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overflow '+width+' '+scope);assert.deepEqual(errors,[]);
 if(process.env.TASK_SCREENSHOT_DIR)await p.screenshot({path:process.env.TASK_SCREENSHOT_DIR+'/'+prefix+'-'+width+'.png',fullPage:true});await ctx.close();
}console.log('PASS: both assistant lists, protected active tasks, selection retained, single/bulk cascade preview, cancel, explicit reconfirmation, local update, responsive');}finally{await b.close();}})().catch(e=>{console.error(e);process.exit(1)});
