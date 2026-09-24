/* Explicit public-guide downloads. API responses and admin pages never enter SW caches. */
const TravelPWA=(()=>{
 const preview=new URLSearchParams(location.search).has('preview');
 const supported=!preview&&isSecureContext&&'serviceWorker' in navigator&&'indexedDB' in window;
 const MiB=1024*1024,MAX_GUIDE=25*MiB,MAX_TOTAL=100*MiB,MAX_GUIDES=20,MAX_IMAGES=80;
 let database,registration,installPrompt,busy=null,objectURLs=[],validating=false,started=false;
 const formatSize=n=>n>=MiB?(n/MiB).toFixed(1)+' MB':Math.ceil(n/1024)+' KB';
 const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 const sameGuide=id=>location.hash==='#offline/'+id;
 function databaseOpen(){
  if(database)return database;
  database=new Promise((resolve,reject)=>{
   const request=indexedDB.open('travel-offline',1);
   request.onupgradeneeded=()=>{for(const name of ['guides','catalog'])request.result.createObjectStore(name,{keyPath:'id'});};
   request.onerror=()=>reject(Error('这台设备暂时无法保存离线内容，请检查浏览器存储设置。'));
   request.onblocked=()=>reject(Error('请关闭其他行笺页面后重试。'));
   request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();database=null;};resolve(db);};
  }).catch(error=>{database=null;throw error;});return database;
 }
 async function get(store,id){const db=await databaseOpen();return new Promise((resolve,reject)=>{const q=db.transaction(store).objectStore(store);const r=id===undefined?q.getAll():q.get(Number(id));r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
 async function remove(id){const db=await databaseOpen();await new Promise((resolve,reject)=>{const tx=db.transaction(['guides','catalog'],'readwrite');for(const name of ['guides','catalog'])tx.objectStore(name).delete(Number(id));tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('移除失败，请重试。'));});}
 async function commit(entry){
  const db=await databaseOpen();return new Promise((resolve,reject)=>{
   const tx=db.transaction(['guides','catalog'],'readwrite');let problem;
   const q=tx.objectStore('catalog').getAll();q.onsuccess=()=>{
    const others=q.result.filter(row=>row.id!==entry.id);
    if(others.length>=MAX_GUIDES||others.reduce((n,row)=>n+row.bytes,0)+entry.bytes>MAX_TOTAL){problem=Error('离线空间已满，请先移除一些攻略（最多 20 篇、100 MB）。');tx.abort();return;}
    const {guide,images,...meta}=entry;
    tx.objectStore('guides').put(entry);tx.objectStore('catalog').put({...meta,title:guide.title,destination:guide.destination});
   };
   tx.oncomplete=resolve;tx.onabort=()=>reject(problem||Error('没有足够的可用空间，请移除一些离线攻略后重试。'));
  });
 }
 function release(){objectURLs.forEach(url=>URL.revokeObjectURL(url));objectURLs=[];}
 function blobURL(blob){const url=URL.createObjectURL(blob);objectURLs.push(url);return url;}
 function imageURL(source){
  try{
   const url=new URL(source,location.origin);if(url.origin!==location.origin)return null;
   if(/^\/media\/[a-f0-9]{32}\.webp$/.test(url.pathname))return url.pathname+'?w=640';
   if(/^\/static\/(assets|optimized)\/[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp|svg)$/.test(url.pathname)){
    const original=Object.entries(travelImageCatalog).find(([key,values])=>key===url.pathname||Object.values(values).includes(url.pathname));
    return original?original[1]['640']:url.pathname;
   }
  }catch{}return null;
 }
 async function fetchPublic(url,{signal,timeout=20000,type='json'}={}){
  const controller=new AbortController(),abort=()=>controller.abort();
  if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,timeout);
  try{
   const response=await fetch(url,{credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
   if(!response.ok){const error=Error('获取内容失败，请联网后重试。');error.status=response.status;throw error;}
   if(type==='blob'){
    if(!response.headers.get('Content-Type')?.startsWith('image/'))throw Error('图片格式不正确');
    const blob=await response.blob();if(blob.size>3*MiB)throw Error('图片过大');return blob;
   }
   return await response.json();
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 async function verify(id,signal,timeout=20000){
  const data=await fetchPublic('/api/guides/'+Number(id)+'?view=read',{signal,timeout});
  const guide=data.guide;
  if(!guide||Number(guide.id)!==Number(id)||guide.status!=='public'||guide.deleted_at){const error=Error('这篇攻略已不再公开，不能离线保存。');error.status=404;throw error;}
  return guide;
 }
 function denied(error){return [401,403,404,410].includes(error.status);}
 function progress(text){
  const node=document.querySelector('#pwa-progress');node.hidden=!text;
  node.innerHTML=text?'<span>'+esc(text)+'</span><button type="button" data-pwa="cancel">取消</button>':'';
 }
 async function ensureShell(){
  if(!supported)throw Error('请使用支持离线保存的浏览器，并通过 HTTPS 打开网站。');
  if(!navigator.onLine)throw Error('请先联网，再保存攻略。');
  let timer;
  try{await Promise.race([(async()=>{await registration;await navigator.serviceWorker.ready;})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('离线阅读准备未完成，请稍后再试。')),30000);})]);}
  finally{clearTimeout(timer);}
 }
 async function save(id){
  if(busy){toast('已有一篇攻略正在保存，请稍候。');return;}
  const controller=new AbortController();busy={id:Number(id),controller};progress('正在准备离线攻略…');
  try{
   await ensureShell();if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
   const guide=await verify(id,controller.signal);const template=document.createElement('template');template.innerHTML=guide.html||'';
   const sources=[guide.cover,...[...template.content.querySelectorAll('img')].map(img=>img.getAttribute('src'))];
   const unsupported=sources.filter(src=>!imageURL(src)).length;
   const urls=[...new Set(sources.map(imageURL).filter(Boolean))];
   if(urls.length>MAX_IMAGES)throw Error('这篇攻略配图较多，暂不支持完整离线保存（最多 80 张）。');
   const images={};let bytes=new Blob([JSON.stringify(guide)]).size,done=0,missing=unsupported,index=0;
   async function download(){while(index<urls.length){
    const url=urls[index++];if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
    try{const blob=await fetchPublic(url,{signal:controller.signal,type:'blob'});if(bytes+blob.size>MAX_GUIDE)throw Error('Size limit');images[url]=blob;bytes+=blob.size;}
    catch(error){if(controller.signal.aborted)throw error;missing++;}
    progress('正在保存配图 '+(++done)+' / '+urls.length+' · '+formatSize(bytes));
   }}
   await Promise.all([download(),download()]);if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
   // Recheck after image downloads so a visibility change during the save cannot commit.
   const current=await verify(id,controller.signal);
   if(current.updated_at!==guide.updated_at)throw Error('攻略刚刚有更新，请重新保存最新版本。');
   await commit({id:Number(id),guide,images,bytes,savedAt:new Date().toISOString(),imageCount:Object.keys(images).length,missing});
   navigator.storage?.persist?.().catch(()=>{});
   toast(missing?'攻略文字已保存，部分图片未下载，联网后可重新更新。':'攻略和配图已保存，可在「已保存攻略」中打开。');
   if(location.hash==='#offline')await route();
   else if(location.hash==='#guide/'+id)await attachGuide(guide);
  }catch(error){
   if(denied(error)){await remove(id).catch(()=>{});toast('这篇攻略已不再公开，已移除本机离线副本。',true);if(sameGuide(id))await route();}
   else toast(controller.signal.aborted?'已取消保存，原有离线版本保留。':error.message||'保存失败，请稍后重试。',!controller.signal.aborted);
  }finally{busy=null;progress('');}
 }
 async function attachGuide(guide){
  if(!supported||guide.status!=='public'||guide.deleted_at)return;
  const top=document.querySelector('.detail-top');if(!top)return;
  top.querySelector('.pwa-guide-actions')?.remove();
  const node=document.createElement('div');node.className='pwa-guide-actions';
  node.innerHTML='<button type="button" class="button secondary" data-pwa="save" data-id="'+guide.id+'">保存离线攻略</button>';
  top.append(node);
  try{const saved=await get('catalog',guide.id);if(saved&&node.isConnected)node.innerHTML='<a class="button secondary" href="#offline/'+guide.id+'">查看离线版</a><button class="button ghost" type="button" data-pwa="save" data-id="'+guide.id+'">更新保存</button>';}catch{/* Reading stays available when device storage is disabled. */}
 }
 async function validateOne(id){
  if(!navigator.onLine)return;
  try{await verify(id,undefined,6000);}
  catch(error){if(denied(error)){await remove(id);throw Error('这篇攻略已不再公开，本机离线副本已移除。');}}
 }
 async function read(id){
  if(!supported)throw Error('此浏览器暂不支持离线阅读。');
  await validateOne(id);const entry=await get('guides',id);
  if(!entry)throw Error('这台设备还没有保存这篇攻略，请联网后打开攻略并保存。');
  const template=document.createElement('template');template.innerHTML=entry.guide.html||'';
  for(const img of template.content.querySelectorAll('img')){
   const blob=entry.images[imageURL(img.getAttribute('src'))];
   if(blob){img.src=blobURL(blob);img.removeAttribute('srcset');img.removeAttribute('data-travel-src');}
   else{const label=document.createElement('p');label.className='pwa-image-missing';label.textContent='配图未保存'+(img.alt?' · '+img.alt:'');img.replaceWith(label);}
  }
  const coverBlob=entry.images[imageURL(entry.guide.cover)];
  return {guide:{...entry.guide,html:template.innerHTML},cover:coverBlob?blobURL(coverBlob):'/static/favicon.svg',...{savedAt:entry.savedAt,missing:entry.missing}};
 }
 async function list(generation){
  updateShell('offline');
  if(!supported){document.querySelector('#app').innerHTML=heading('已保存攻略',preview?'管理员预览不提供离线保存，请返回访客网站。':'当前浏览器暂不支持离线保存，请用 Safari 或其他支持的浏览器打开网站。')+'<a class="button secondary" href="/">返回访客网站</a>';return;}
  const entries=(await get('catalog')).sort((a,b)=>b.savedAt.localeCompare(a.savedAt));if(generation!==state.load)return;
  document.querySelector('#app').innerHTML=heading('把行程，随身带上。','提前保存公开攻略，没网时也能查路线、看配图。')+
   '<section class="pwa-library-intro"><div><strong>'+entries.length+' 篇已保存 · '+formatSize(entries.reduce((n,e)=>n+e.bytes,0))+'</strong><p>仅保存在这台设备。离线时显示保存版本；联网后核对公开状态。外部链接和关联足迹需要联网。</p></div></section>'+
   (entries.length?'<section class="pwa-library" aria-label="已保存攻略">'+entries.map(e=>'<article class="pwa-saved-card"><div><span class="pwa-place">'+esc(e.destination)+'</span><h2><a href="#offline/'+e.id+'">'+esc(e.title)+'</a></h2><p>'+esc(new Date(e.savedAt).toLocaleString('zh-CN'))+' 保存 · '+formatSize(e.bytes)+' · '+e.imageCount+' 张配图'+(e.missing?' · 部分图片未保存':'')+'</p></div><div class="pwa-saved-actions"><a class="button primary" href="#offline/'+e.id+'">打开攻略</a><button class="button secondary" data-pwa="save" data-id="'+e.id+'">更新</button><button class="button ghost" data-pwa="remove" data-id="'+e.id+'">移除</button></div></article>').join('')+'</section>':empty('行囊还是空的','联网打开一篇攻略，点击「保存离线攻略」，下次出发就能带着走。','<a class="button primary" href="#guides">挑选一篇攻略</a>'))+
   '<p class="pwa-storage-note">最多保存 20 篇、共 100 MB。浏览器清理数据可能移除本机副本，出发前请在断网状态下检查一次。</p>';
 }
 async function revalidate(){
  if(!supported||validating||!navigator.onLine)return;validating=true;let changed=false,index=0;
  try{const entries=await get('catalog');async function check(){while(index<entries.length){const entry=entries[index++];try{await validateOne(entry.id);}catch{changed=true;}}}await Promise.all([check(),check()]);
   if(changed){toast('已移除不再公开的离线攻略。');if(location.hash.startsWith('#offline'))await route();}
  }catch{}finally{validating=false;}
 }
 async function install(){
  if(standalone()){toast('已经在独立的行笺窗口中。');return;}
  if(installPrompt){await installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;return;}
  let dialog=document.querySelector('#pwa-install');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='pwa-install';dialog.className='pwa-install-dialog';dialog.innerHTML='<button class="dialog-close" data-pwa="close-install" aria-label="关闭">×</button><img src="/static/assets/pwa-icon-192.png" alt="行笺图标" width="64" height="64"><h2>把行笺放到主屏幕</h2><p>下次出发，从桌面一键打开。</p><ol><li>在 iPhone 的 Safari 中打开本站。</li><li>点「分享」，选择「添加到主屏幕」。</li><li>如有「作为网页 App 打开」选项，请开启，再点「添加」。</li></ol><p class="muted">其他设备可在浏览器菜单中选择「安装应用」或「添加到主屏幕」。安装后，请在该窗口里保存需要离线阅读的攻略。</p><button class="button primary" data-pwa="close-install">知道了</button>';document.body.append(dialog);}dialog.showModal();
 }
 function start(){
  if(started)return;started=true;
  const net=()=>{const node=document.querySelector('#pwa-network');if(node)node.hidden=navigator.onLine;document.body.classList.toggle('is-offline',!navigator.onLine);};net();window.addEventListener('offline',net);window.addEventListener('online',()=>{net();void revalidate();});
  if(!supported)return;
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;});
  let hadController=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadController)location.reload();hadController=true;});
  registration=new Promise((resolve,reject)=>{
   const register=()=>navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).then(reg=>{
    function update(){if(!reg.waiting||!navigator.serviceWorker.controller)return;let node=document.querySelector('#pwa-update');if(!node){node=document.createElement('div');node.id='pwa-update';node.className='pwa-update';node.innerHTML='<span>行笺有新版本</span><button type="button" data-pwa="update-app">更新并打开</button>';document.querySelector('.footer').before(node);}}
    update();reg.addEventListener('updatefound',()=>reg.installing?.addEventListener('statechange',update));resolve(reg);
   },reject);
   if(document.readyState==='complete')register();else window.addEventListener('load',register,{once:true});
  });registration.catch(()=>{});
  void revalidate();
 }
 document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-pwa]');if(!button)return;const action=button.dataset.pwa,id=Number(button.dataset.id);
  try{
   if(action==='install')await install();
   if(action==='close-install')document.querySelector('#pwa-install')?.close();
   if(action==='save')await save(id);
   if(action==='cancel')busy?.controller.abort();
   if(action==='remove'){
    if(busy?.id===id){toast('请先取消这篇攻略的保存。');return;}
    if(confirm('移除这台设备上的离线副本？网站上的攻略会保留。')){await remove(id);if(location.hash.startsWith('#offline'))await route();toast('已移除本机副本。');}
   }
   if(action==='update-app'){if(busy){toast('请等待攻略保存完成，或先取消保存。');return;}(await registration)?.waiting?.postMessage({type:'APPLY_UPDATE'});}
  }catch(error){toast(error.message||'操作未完成，请重试。',true);}
 });
 return {start,supported,list,read,release,attachGuide,has:async id=>supported&&!!await get('catalog',id)};
})();
