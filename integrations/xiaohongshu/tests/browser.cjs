// Local fixtures only: no Xiaohongshu or production site requests.
const {runCheck}=require('../check.cjs'),http=require('http'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
(async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-guard-test-'));let scenario='ready',hits=0,cookieSeen=false,assetHits=0;
const server=http.createServer((req,res)=>{
 hits++;if((req.headers.cookie||'').includes('fixture_session=SECRET-FIXTURE'))cookieSeen=true;
 if(req.url.startsWith('/asset')){assetHits++;res.setHeader('Cache-Control','public, max-age=3600');res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');
 if(scenario==='status429'){res.statusCode=429;res.end('rate limited');return;}
 if(scenario==='blocked'||req.url==='/website-login/error'){res.end('<body>安全限制 IP存在风险 300012</body>');return;}
 if(scenario==='limit'){res.end('<body>'+Array.from({length:60},(_,i)=>`<img src="/asset?${i}">`).join('')+'</body>');return;}
 res.setHeader('Set-Cookie','fixture_session=SECRET-FIXTURE; Max-Age=3600; HttpOnly; SameSite=Lax');
 const action=scenario==='click-blocked'?"location.href='/website-login/error'":"document.body.innerHTML='<input placeholder=手机号><input placeholder=验证码>'";
 res.end(`<body><canvas class="qrcode" width="64" height="64"></canvas><input placeholder="登录探索更多内容"><img src="/asset"><script>document.querySelector('input').onclick=()=>{${action}};</script></body>`);
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
try{
 const persistent=path.join(root,'persistent');let report=await runCheck({executablePath:process.env.XHS_TEST_BROWSER,stateDir:persistent,origin});assert.equal(report.result,'login_ready');assert.equal(report.phone_visible,true);
 const initialAssets=assetHits;cookieSeen=false;report=await runCheck({executablePath:process.env.XHS_TEST_BROWSER,stateDir:persistent,origin});assert.equal(report.result,'login_ready');assert.equal(cookieSeen,true);assert.equal(assetHits,initialAssets,'persistent browser should reuse cached asset');
 const logs=fs.readFileSync(path.join(persistent,'last-network.json'),'utf8');assert.ok(!logs.includes('SECRET-FIXTURE'));assert.ok(!logs.includes('cookie'));
 for(scenario of ['blocked','click-blocked','status429']){
  const folder=path.join(root,scenario);report=await runCheck({executablePath:process.env.XHS_TEST_BROWSER,stateDir:folder,origin});assert.equal(report.result,'blocked',scenario);assert.equal(report.browser_closed,true);if(scenario==='blocked')assert.deepEqual(report.actions,['open_home']);
 }
 scenario='limit';report=await runCheck({executablePath:process.env.XHS_TEST_BROWSER,stateDir:path.join(root,'limit'),origin,requestLimit:15});assert.equal(report.result,'request_limit');assert.ok(report.requests>=15);assert.equal(report.browser_closed,true);
 console.log('PASS: persistent cookies/cache, visible phone form, 300012 stop before/after login, 429 stop, request budget closes browser, private redacted network counts');
}finally{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exit(1)});
