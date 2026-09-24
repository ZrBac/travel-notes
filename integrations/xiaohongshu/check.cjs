// Ordinary official-page interaction only. No proxies, stealth patches or internal API calls.
const {chromium}=require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs=require('fs'),path=require('path');
async function runCheck({stateDir,origin='https://www.xiaohongshu.com',executablePath,requestLimit=300,apiLimit=40,duration=45000}={}){
 process.umask(0o077);fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
 const started=Date.now(),report={result:'unavailable',phase:'launch',requests:0,request_types:{},response_statuses:{},failed_requests:0,actions:[]};
 const events=[],eventLimit=700;let context,page,stopping=false,timeout;
 const log=data=>{if(events.length<eventLimit)events.push({ms:Date.now()-started,...data});};
 async function stop(result,trigger){if(stopping)return;stopping=true;report.result=result;report.trigger=trigger;if(context)await context.close().catch(()=>{});}
 async function inspect(){return page.evaluate(()=>{
  const text=document.body?.innerText||'',visible=n=>n.getBoundingClientRect().width>0;
  return {blocked:/300012|IP存在风险|IP 存在风险|安全限制|安全验证/.test(text),code300012:text.includes('300012'),
   phone:[...document.querySelectorAll('input')].some(n=>visible(n)&&/手机号|手机号码/.test(n.placeholder)),
   qr:[...document.querySelectorAll('img[class*=qr],canvas[class*=qr],[class*=qrcode]')].some(visible),
   login:[...document.querySelectorAll('.login-container')].some(visible),
   guestInput:!!document.querySelector('input[placeholder="登录探索更多内容"]')};
 });}
 async function untilReady(kind,limit){
  const deadline=Date.now()+limit;let info={};
  while(!stopping&&Date.now()<deadline){
   try{info=await inspect();if(info.blocked){await stop('blocked',info.code300012?'300012':'security_page');return info;}
    if(info.phone||info.qr||info.login||(kind==='home'&&info.guestInput))return info;
   }catch{}
   await new Promise(resolve=>setTimeout(resolve,200));
  }
  return info;
 }
 try{
  context=await chromium.launchPersistentContext(path.join(stateDir,'profile'),{headless:true,executablePath,locale:'zh-CN',viewport:{width:1280,height:900},args:['--no-sandbox']});
  timeout=setTimeout(()=>void stop('timeout','total_deadline'),duration);
  context.on('request',request=>{
   report.requests++;const type=request.resourceType();report.request_types[type]=(report.request_types[type]||0)+1;
   let host='';try{host=new URL(request.url()).hostname;}catch{}
   log({event:'request',type,host});
   const api=(report.request_types.xhr||0)+(report.request_types.fetch||0);
   if(report.requests>=requestLimit||api>=apiLimit)void stop('request_limit',api>=apiLimit?'api_limit':'total_request_limit');
  });
  context.on('requestfailed',()=>{report.failed_requests++;});
  context.on('response',response=>{
   const status=response.status(),type=response.request().resourceType();report.response_statuses[status]=(report.response_statuses[status]||0)+1;
   log({event:'response',status,type});
   if(status===429||status===403&&['document','xhr','fetch'].includes(type))void stop('blocked','http_'+status);
  });
  page=context.pages()[0]||await context.newPage();report.phase='open_home';report.actions.push('open_home');
  try{await page.goto(origin+'/explore',{waitUntil:'commit',timeout:15000});}catch(error){if(stopping)throw error;log({event:'navigation_wait',error:error.name});}
  report.phase='wait_controls';let info=await untilReady('home',12000);if(stopping)return report;
  if(!info.phone&&!info.qr&&!info.login){
   report.phase='open_login';const login=page.getByRole('button',{name:'登录',exact:true});
   try{
    if(await login.count()){report.actions.push('click_login');await login.first().click({timeout:5000});}
    else if(info.guestInput){report.actions.push('click_login_entry');await page.getByPlaceholder('登录探索更多内容').click({timeout:5000});}
   }catch(error){log({event:'login_wait',error:error.name});}
   info=await untilReady('login',8000);
  }
  if(stopping)return report;
  report.phase='inspect_login';report.phone_visible=!!info.phone;report.qr_visible=!!info.qr;report.login_visible=!!info.login;
  report.result=info.phone||info.qr?'login_ready':'unavailable';
  // A probe stops here: it neither requests SMS codes nor publishes a QR code that will expire after closing.
 }catch(error){if(!stopping){report.result=error.name==='TimeoutError'?'timeout':'error';report.error_type=error.name;}}
 finally{
  clearTimeout(timeout);if(context)await context.close().catch(()=>{});
  report.duration_ms=Date.now()-started;report.browser_closed=true;
  fs.writeFileSync(path.join(stateDir,'last-run.json'),JSON.stringify(report,null,2),{mode:0o600});
  fs.writeFileSync(path.join(stateDir,'last-network.json'),JSON.stringify(events,null,2),{mode:0o600});
 }
 return report;
}
module.exports={runCheck};
if(require.main===module)runCheck({stateDir:process.env.XHS_STATE_DIR||'/var/lib/travel-xhs',executablePath:'/opt/travel-xhs/browser/chrome-headless-shell'}).then(report=>console.log(JSON.stringify(report))).catch(error=>{console.error(error.name);process.exitCode=1;});
