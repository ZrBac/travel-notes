// Ordinary official-page interaction only. No proxies, stealth patches or internal API calls.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function resource(url){
 try{const u=new URL(url),file=u.pathname.split('/').pop();return {host:u.hostname,file:/^[A-Za-z0-9_.-]{1,180}\.(?:js|css)$/.test(file)?file:undefined};}
 catch{return {host:''};}
}
function errorName(error){return /^[A-Za-z]{1,40}Error$/.test(error.name)?error.name:'Error';}
async function runCheck({stateDir,origin='https://www.xiaohongshu.com',executablePath,requestLimit=300,apiLimit=40,duration=45000,scriptQuietMs=750}={}){
 process.umask(0o077);fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
 const started=Date.now(),deadline=started+duration;
 const report={result:'unavailable',phase:'launch',requests:0,request_types:{},response_statuses:{},failed_requests:0,cancelled_requests:0,actions:[],page_errors:[]};
 const events=[],pending=new Map();let context,page,stopping=false,closing=false,timer,domReady=false,lastScriptActivity=started,lastPageState=null,closePromise;
 const log=data=>{if(events.length<1400)events.push({ms:Date.now()-started,...data});else report.network_events_dropped=(report.network_events_dropped||0)+1;};
 const scriptCount=()=>[...pending.values()].filter(r=>r.type==='script').length;
 function snapshot(){
  if(report.pending_requests)return;
  report.pending_requests=[...pending.values()].map(r=>({...r,age_ms:Date.now()-started-r.started_ms}));
  report.pending_scripts=report.pending_requests.filter(r=>r.type==='script');
  report.page_state=lastPageState;
 }
 async function stop(result,trigger){
  if(stopping)return closePromise;
  stopping=true;report.result=result;report.trigger=trigger;snapshot();
  closePromise=context?context.close().catch(()=>{}):Promise.resolve();return closePromise;
 }
 function deadlineReason(){
  if(scriptCount())return 'scripts_not_ready';
  if(report.page_errors.length)return 'script_errors_observed';
  if(report.click_completed)return 'login_not_shown';
  if(lastPageState?.ready_state==='loading'||!domReady)return 'page_not_ready';
  return 'login_controls_missing';
 }
 async function inspect(){
  const info=await page.evaluate(()=>{
   const text=document.body?.innerText||'',visible=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
   const loginRoot=[...document.querySelectorAll('.login-container,[role=dialog]')].find(visible);
   const qrScope=loginRoot||(location.pathname.startsWith('/website-login')?document:null);
   const qrImages=qrScope?[...qrScope.querySelectorAll('img[class*=qr],[class*=qrcode] img,[class*=qr-code] img')]:[];
   return {blocked:/300012|IP存在风险|IP 存在风险|安全限制|安全验证/.test(text),code300012:text.includes('300012'),ready_state:document.readyState,
    phone:[...document.querySelectorAll('input')].some(n=>visible(n)&&/手机号|手机号码/.test(n.placeholder)),
    qr:qrImages.some(n=>visible(n)&&n.complete&&n.naturalWidth>0)||!!qrScope&&[...qrScope.querySelectorAll('canvas[class*=qr],[class*=qrcode] canvas,[class*=qr-code] canvas')].some(n=>visible(n)&&n.width>0&&n.height>0),
    login:[...document.querySelectorAll('.login-container')].some(visible),
    guestInput:[...document.querySelectorAll('input[placeholder="登录探索更多内容"]')].some(n=>visible(n)&&!n.disabled),
    loginButton:[...document.querySelectorAll('button,[role=button]')].some(n=>visible(n)&&!n.disabled&&n.textContent.trim()==='登录')};
  });
  const u=new URL(page.url());info.host=u.hostname;info.path=['/explore','/website-login/error','/search_result'].includes(u.pathname)?u.pathname:'[other-page]';
  info.dom_content_loaded=domReady;info.pending_script_count=scriptCount();lastPageState=info;return info;
 }
 try{
  context=await chromium.launchPersistentContext(path.join(stateDir,'profile'),{headless:true,executablePath,locale:'zh-CN',viewport:{width:1280,height:900},args:['--no-sandbox'],timeout:Math.min(10000,duration)});
  timer=setTimeout(()=>void stop('timeout',deadlineReason()),Math.max(1,deadline-Date.now()));
  context.on('request',request=>{
   const id=++report.requests,type=request.resourceType();report.request_types[type]=(report.request_types[type]||0)+1;
   const entry={id,type,...resource(request.url()),started_ms:Date.now()-started,response_received:false};pending.set(request,entry);log({event:'request',...entry});
   if(type==='script')lastScriptActivity=Date.now();
   const api=(report.request_types.xhr||0)+(report.request_types.fetch||0);
   if(report.requests>=requestLimit||api>=apiLimit)void stop('request_limit',api>=apiLimit?'api_limit':'total_request_limit');
  });
  context.on('requestfinished',request=>{
   const entry=pending.get(request);if(entry){log({event:'request_finished',id:entry.id,type:entry.type});if(entry.type==='script')lastScriptActivity=Date.now();pending.delete(request);}
  });
  context.on('requestfailed',request=>{
   const entry=pending.get(request),error=request.failure()?.errorText||'';
   if(stopping||closing)report.cancelled_requests++;else report.failed_requests++;
   log({event:'request_failed',id:entry?.id,type:request.resourceType(),cancelled_by_probe:stopping||closing,error:/^net::[A-Z_]+$/.test(error)?error:'network_error'});
   if(entry?.type==='script')lastScriptActivity=Date.now();pending.delete(request);
  });
  context.on('response',response=>{
   const status=response.status(),request=response.request(),entry=pending.get(request),type=request.resourceType();
   report.response_statuses[status]=(report.response_statuses[status]||0)+1;
   if(entry){entry.response_received=true;entry.status=status;}
   log({event:'response',id:entry?.id,status,type});
   if(status===429||status===403&&['document','xhr','fetch'].includes(type))void stop('blocked','http_'+status);
  });
  page=context.pages()[0]||await context.newPage();
  page.on('domcontentloaded',()=>{domReady=true;log({event:'dom_content_loaded'});});
  page.on('framenavigated',frame=>{if(frame===page.mainFrame()){domReady=false;log({event:'main_frame_navigation',...resource(frame.url())});}});
  page.on('pageerror',error=>{
   const info={name:errorName(error),fingerprint:crypto.createHash('sha256').update(String(error.message)).digest('hex').slice(0,16)};
   const source=String(error.stack||'').match(/https?:\/\/[^\s)]+\.js(?:\?[^\s):]*)?/);if(source)info.source=resource(source[0]);
   if(report.page_errors.length<10)report.page_errors.push(info);log({event:'page_error',...info});
  });
  page.on('console',message=>{if(message.type()==='error'){const at=message.location();log({event:'console_error',...resource(at.url||''),line:at.lineNumber});}});
  report.phase='open_home';report.actions.push('open_home');
  try{await page.goto(origin+'/explore',{waitUntil:'commit',timeout:Math.max(1,Math.min(15000,deadline-Date.now()))});}
  catch(error){if(stopping)throw error;log({event:'navigation_wait',error:errorName(error)});}
  report.phase='wait_page_ready';let attempted=false;
  while(!stopping&&Date.now()<deadline){
   let info;try{info=await inspect();}catch{await new Promise(r=>setTimeout(r,100));continue;}
   if(info.blocked){await stop('blocked',info.code300012?'300012':'security_page');break;}
   if(info.phone||info.qr){report.phone_visible=info.phone;report.qr_visible=info.qr;report.login_visible=info.login;report.result='login_ready';report.phase='login_ready';break;}
   const ready=(domReady||info.ready_state==='complete')&&scriptCount()===0&&Date.now()-lastScriptActivity>=scriptQuietMs;
   if(!attempted&&!info.login&&ready&&(info.guestInput||info.loginButton)){
    report.phase='open_login';attempted=true;report.ready_before_click={...info,script_quiet_ms:Date.now()-lastScriptActivity};
    const target=info.loginButton?page.getByRole('button',{name:'登录',exact:true}).first():page.getByPlaceholder('登录探索更多内容');
    report.actions.push(info.loginButton?'click_login':'click_login_entry');
    try{await target.click({timeout:Math.max(1,Math.min(5000,deadline-Date.now()))});report.click_completed=true;log({event:'login_click_completed'});}
    catch(error){report.click_completed=false;log({event:'login_click_failed',error:errorName(error)});}
    report.phase='wait_login';
   }else if(info.login)report.phase='wait_login_controls';
   await new Promise(r=>setTimeout(r,200));
  }
  if(!stopping&&report.result!=='login_ready')await stop('timeout',deadlineReason());
  // Only observe the login form; never send SMS, submit credentials or retry the click.
 }catch(error){if(!stopping){report.result=errorName(error)==='TimeoutError'?'timeout':'error';report.error_type=errorName(error);}}
 finally{
  clearTimeout(timer);snapshot();closing=true;if(closePromise)await closePromise;if(context)await context.close().catch(()=>{});
  report.duration_ms=Date.now()-started;report.browser_closed=true;
  fs.writeFileSync(path.join(stateDir,'last-run.json'),JSON.stringify(report,null,2),{mode:0o600});
  fs.writeFileSync(path.join(stateDir,'last-network.json'),JSON.stringify(events,null,2),{mode:0o600});
 }
 return report;
}
module.exports={runCheck};
if(require.main===module)runCheck({stateDir:process.env.XHS_STATE_DIR||'/var/lib/travel-xhs',executablePath:'/opt/travel-xhs/browser/chrome-headless-shell'}).then(report=>console.log(JSON.stringify(report))).catch(error=>{console.error(errorName(error));process.exitCode=1;});
