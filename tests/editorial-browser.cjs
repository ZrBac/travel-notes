// Offline UI regression: synthetic public content, no server or credentials.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const guide={id:1,title:'沿着海岸走：四天的城市与村落',destination:'泉州',country:'中国',days:4,summary:'从古城街巷到海边村落，记录交通、住宿和每天的步行路线。',cover:'/static/assets/lake.jpg',tags:['海边'],status:'public',updated_at:'2026-09-20',html:'<h2>第一天</h2><p>沿着街道步行，午后到海边。</p>',season:'秋季',budget:'待核实'};
const record={id:1,title:'海边散步的一天',destination:'泉州',start_date:'2026-09-18',end_date:'2026-09-18',summary:'傍晚的海风和街边的小店。',cover:guide.cover,photo_count:1,status:'public',photos:[{url:guide.cover,caption:'海岸'}],html:'<p>沿着海岸慢慢走。</p>'};
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{
  for(const width of [1440,768,390,320]){
   const context=await browser.newContext({viewport:{width,height:1000}});
   let empty=false;const errors=[];
   await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.origin!=='http://journal.test')return route.abort();
    if(u.pathname.startsWith('/api/')){
     assert.equal(route.request().method(),'GET');
     const guides=empty?[]:[guide,{...guide,id:2,title:'山间的周末',destination:'山城',tags:['山野']}];
     let data;
     if(u.pathname==='/api/bootstrap')data={site:{site_name:'行笺',tagline:'记录路线与旅途见闻。',footer:'旅行存档'},session:{authenticated:false,csrf:''},guides,records:empty?[]:[record],record_count:empty?0:1};
     else if(u.pathname==='/api/guides/1')data={guide};
     else if(u.pathname==='/api/records/1')data={record,guide};
     else if(u.pathname==='/api/records')data={records:empty?[]:[record],destinations:['泉州'],years:[2026],total:empty?0:1,page:1,pages:1};
     else throw Error('Unexpected API '+u.pathname);
     return route.fulfill({json:data});
    }
    const file=path.join(root,u.pathname==='/'?'static/index.html':u.pathname);
    const ext=path.extname(file);return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'})[ext]||'application/octet-stream'});
   });
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   const fits=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`viewport overflow at ${width}: ${page.url()}`);
   await page.goto('http://journal.test/');await page.locator('.journal-lead h2').waitFor();await fits();
   assert.equal(await page.locator('.journal-lead h2').innerText(),record.title);
   await page.screenshot({path:`/tmp/editorial-home-${width}.png`,fullPage:true});
   await page.locator('nav a[href="#guides"]:visible').click();await page.locator('#search').fill('山间');
   assert.equal(await page.locator('#guide-grid .guide-card').count(),1);await fits();
   await page.locator('#search').fill('不存在');assert.equal(await page.locator('#guide-grid .guide-card').count(),0);
   await page.locator('#search').fill('');await page.locator('#sort').selectOption('days');
   await page.locator('#guide-grid a[href="#guide/1"]').click();await page.locator('.article-header').waitFor();await fits();
   await page.locator('nav a[href="#footprints"]:visible').click();await page.locator('#memory-filter').waitFor();await fits();
   await page.locator('.memory-card a').first().click();await page.locator('.memory-header').waitFor();await fits();
   await page.locator('[data-fp="photo"]').click();assert.equal(await page.locator('#memory-viewer').evaluate(d=>d.open),true);await page.keyboard.press('Escape');
   for(const hash of ['destinations','tags']){await page.locator(`#navigation a[href="#${hash}"]`).click();await page.locator(hash==='tags'?'.tag-tile':'.destination-card').first().waitFor();await fits();}
   empty=true;await page.goto('http://journal.test/');await page.locator('.journal-lead h2').waitFor();assert.equal(await page.locator('.journal-photo').count(),0);await fits();
   assert.deepEqual(errors,[]);await context.close();console.log(`PASS ${width}px: home, search, sort, details, album, navigation, empty state; no overflow or JS errors`);
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
