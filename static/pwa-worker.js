/* Deliberate allowlist: never intercept API, media, admin or preview requests. */
const SHELL='travel-shell-__BUILD__';
const ASSETS=__ASSETS__;
const ALLOWED=new Set(ASSETS.map(path=>new URL(path,self.location.origin).href));
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(SHELL);
 try{
  for(const path of ['/',...ASSETS]){
   const response=await fetch(path,{credentials:'omit',cache:'reload',redirect:'error'});
   if(!response.ok)throw Error('Shell resource unavailable');
   await cache.put(path,response);
  }
 }catch(error){await caches.delete(SHELL);throw error;}
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const key of await caches.keys())if(key.startsWith('travel-shell-')&&key!==SHELL)await caches.delete(key);
 await self.clients.claim();
})()));
self.addEventListener('message',event=>{if(event.data?.type==='APPLY_UPDATE')self.skipWaiting();});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin)return;
 if(request.mode==='navigate'&&url.pathname==='/'&&!url.search){
  event.respondWith(fetch(request).catch(async()=>{
   const cache=await caches.open(SHELL);return await cache.match('/')||Response.error();
  }));return;
 }
 if(ALLOWED.has(url.href))event.respondWith((async()=>{
  const cache=await caches.open(SHELL);return await cache.match(request)||fetch(request);
 })());
});
