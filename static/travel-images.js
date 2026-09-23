// Keep image downloads bounded and cancellable so navigation data can load first.
function createTravelImages({roots,credentials,attribute='data-admin-src'}){
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
     const displayURL=typeof travelDisplayImageUrl==='function'?travelDisplayImageUrl(entry.url,img):entry.url;
     const response=await fetch(displayURL,{credentials,priority:img.getAttribute('fetchpriority')==='high'?'high':'low',signal:controller.signal});
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
  for(const [img,entry]of entries)if(!img.isConnected||img.closest('dialog:not([open])')||img.getAttribute(attribute)!==entry.source)release(img,entry);
  if(paused||document.hidden)return;
  for(const img of document.querySelectorAll(roots.map(root=>root+' img['+attribute+']').join(','))){
   if(entries.has(img))continue;
   const source=img.getAttribute(attribute);let url;try{url=new URL(source,location.origin);}catch{continue;}
   if(url.origin!==location.origin||!/^\/(media\/|static\/(?:assets|optimized)\/)/.test(url.pathname))continue;
   const entry={url:url.href,source};entries.set(img,entry);img.src=placeholder;observer.observe(img);
  }
 }
 function pause(){
  paused=true;queue=[];observer.disconnect();
  for(const [img,entry]of entries)if(!entry.done)release(img,entry);
  for(const controller of active)controller.abort();active.clear();
 }
 function resume(){paused=false;scan();pump();}
 new MutationObserver(scan).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open',attribute]});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();else resume();});
 window.addEventListener('pagehide',()=>{pause();for(const [img,entry]of entries)release(img,entry);});
 function prepareHTML(html){
  const template=document.createElement('template');template.innerHTML=html;
  for(const img of template.content.querySelectorAll('img[src]')){
   const src=img.getAttribute('src');let url;try{url=new URL(src,location.origin);}catch{continue;}
   if(url.origin===location.origin&&/^\/(media\/|static\/(?:assets|optimized)\/)/.test(url.pathname)){
    img.setAttribute(attribute,src);img.removeAttribute('src');img.removeAttribute('srcset');img.setAttribute('decoding','async');
   }
  }
  return template.innerHTML;
 }
 return {pause,resume,scan,prepareHTML};
}
