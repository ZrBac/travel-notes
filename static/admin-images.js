// Keep image downloads bounded and cancellable so navigation data can load first.
const AdminImages=(()=>{
 const entries=new Map(),active=new Set();let queue=[],paused=true;
 const placeholder='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="4" height="3"%3E%3C/svg%3E';
 function release(img,entry){
  entry.controller?.abort();if(entry.objectURL)URL.revokeObjectURL(entry.objectURL);
  observer.unobserve(img);entries.delete(img);
 }
 function pump(){
  if(paused||document.hidden)return;
  while(active.size<2&&queue.length){
   const [img,entry]=queue.shift();
   if(!img.isConnected||entries.get(img)!==entry)continue;
   const controller=new AbortController();entry.controller=controller;active.add(controller);
   void(async()=>{
    try{
     const response=await fetch(entry.url,{credentials:'same-origin',priority:'low',signal:controller.signal});
     if(!response.ok)throw Error('Image unavailable');
     const blob=await response.blob();
     if(controller.signal.aborted||!img.isConnected||entries.get(img)!==entry)return;
     entry.objectURL=URL.createObjectURL(blob);entry.done=true;img.src=entry.objectURL;
    }catch(e){if(!controller.signal.aborted&&img.isConnected)img.classList.add('image-unavailable');}
    finally{active.delete(controller);entry.controller=null;pump();}
   })();
  }
 }
 const observer=new IntersectionObserver(changes=>{
  for(const change of changes){const entry=entries.get(change.target);if(change.isIntersecting&&entry&&!entry.queued&&!entry.done){entry.queued=true;queue.push([change.target,entry]);observer.unobserve(change.target);}}
  pump();
 },{rootMargin:'120px'});
 function scan(){
  for(const [img,entry]of entries)if(!img.isConnected||img.closest('dialog:not([open])'))release(img,entry);
  if(paused||document.hidden)return;
  for(const img of document.querySelectorAll('#main img[data-admin-src],#dialog[open] img[data-admin-src]')){
   if(entries.has(img))continue;
   const url=new URL(img.dataset.adminSrc,location.origin);
   if(url.origin!==location.origin||!/^\/(media\/|static\/assets\/)/.test(url.pathname))continue;
   const entry={url:url.href};entries.set(img,entry);img.src=placeholder;observer.observe(img);
  }
 }
 function pause(){
  paused=true;queue=[];observer.disconnect();
  for(const [img,entry]of entries)if(!entry.done)release(img,entry);
  for(const controller of active)controller.abort();active.clear();
 }
 function resume(){paused=false;scan();pump();}
 new MutationObserver(scan).observe(document.querySelector('#main'),{childList:true,subtree:true});
 new MutationObserver(scan).observe(document.querySelector('#dialog'),{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();else resume();});
 window.addEventListener('pagehide',()=>{pause();for(const [img,entry]of entries)release(img,entry);});
 return {pause,resume,scan};
})();
