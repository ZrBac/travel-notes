// Slow/hanging/error fixtures on loopback only; no external platform requests.
const {runCheck}=require(process.env.XHS_TEST_MODULE||'../check.cjs');
const http=require('http'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-readiness-'));let mode='slow-script',clicks=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/clicked'){clicks++;res.end('ok');return;}
  if(req.url.startsWith('/startup.js')){
   res.setHeader('Content-Type','application/javascript');res.setHeader('X-Content-Type-Options','nosniff');res.flushHeaders();
   if(mode==='hanging-script'){res.write('// still loading '+'.'.repeat(8192)+'\n');return;}
   if(mode==='script-error'){res.end("throw new ReferenceError('SECRET-FIXTURE-DO-NOT-LOG')");return;}
   setTimeout(()=>{if(!res.destroyed)res.end("document.querySelector('input').onclick=()=>{fetch('/clicked');document.body.innerHTML='<input placeholder=手机号><input placeholder=验证码>';}");},2500);return;
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(mode==='delayed-modal')res.end(`<body><input placeholder="登录探索更多内容"><script>document.querySelector('input').onclick=()=>{fetch('/clicked');document.body.innerHTML='<div class="login-container">正在加载</div>';setTimeout(()=>document.querySelector('.login-container').innerHTML='<input placeholder=手机号><input placeholder=验证码>',9500);};</script></body>`);
  else res.end('<html><head><script '+(mode==='async-script'?'async':'defer')+' src="/startup.js?token=SECRET-FIXTURE-QUERY"></script></head><body><input placeholder="登录探索更多内容"></body></html>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 async function run(duration=16000){const stateDir=path.join(root,mode);const report=await runCheck({stateDir,origin,duration,executablePath:process.env.XHS_TEST_BROWSER});const logs=fs.readFileSync(path.join(stateDir,'last-network.json'),'utf8');assert.ok(!logs.includes('SECRET-FIXTURE'));assert.ok(!JSON.stringify(report).includes('SECRET-FIXTURE'));return {report,logs};}
 try{
  let {report,logs}=await run();assert.equal(report.result,'login_ready','must wait for deferred script before clicking');assert.equal(clicks,1);
  assert.equal(report.ready_before_click.pending_script_count,0);assert.equal(report.click_completed,true);assert.ok(report.ready_before_click.dom_content_loaded);assert.ok(logs.includes('request_finished'));
  mode='async-script';clicks=0;({report}=await run());assert.equal(report.result,'login_ready','DOMContentLoaded alone is insufficient while async script is pending');assert.equal(clicks,1);assert.equal(report.ready_before_click.pending_script_count,0);
  mode='delayed-modal';clicks=0;({report}=await run());assert.equal(report.result,'login_ready','must wait longer than eight seconds and through empty modal');assert.equal(clicks,1);assert.ok(report.duration_ms>=9500);assert.ok(report.duration_ms<16000);
  mode='hanging-script';clicks=0;({report}=await run(3500));assert.equal(report.result,'timeout');assert.equal(report.trigger,'scripts_not_ready');assert.equal(clicks,0);assert.deepEqual(report.actions,['open_home']);assert.ok(report.pending_scripts.some(r=>r.file==='startup.js'&&typeof r.response_received==='boolean')); // Chromium may defer response notification until more of the body is available.
  assert.equal(report.browser_closed,true);
  mode='script-error';clicks=0;({report,logs}=await run(4000));assert.equal(report.result,'timeout');assert.equal(report.trigger,'script_errors_observed');assert.ok(report.page_errors.some(e=>e.name==='ReferenceError'));assert.ok(logs.includes('page_error'));assert.equal(report.browser_closed,true);
  console.log('PASS: deferred script body readiness, one click only, modal delayed over eight seconds, empty modal wait, hanging script diagnostics, JS errors, secret-free logs, bounded closure');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1)});
