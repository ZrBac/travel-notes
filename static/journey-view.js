/* Route maps load only on request. Journey text never depends on map availability. */
const JourneyView=(()=>{
 const states=new Set(),known=new WeakMap();let library=null,styleReady=false;
 const leaflet='/static/vendor/leaflet/leaflet.js?v=dc71f8a6880bc3ca';
 const leafletStyle='/static/vendor/leaflet/leaflet.css?v=a783710282418482';
 const safeURL=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')?u.href:null;}catch{return null;}};
 function parse(value){
  try{
   if(typeof value!=='string'||value.length>16000)return null;const data=JSON.parse(value);
   if(!data||!Array.isArray(data.stops)||data.stops.length>20||data.stops.some(s=>typeof s!=='string'||s.length>120))return null;
   const points=Array.isArray(data.waypoints)?data.waypoints:[],seen=new Set(),valid=[];
   for(const p of points.slice(0,20)){
    if(!p||typeof p.name!=='string'||!data.stops.includes(p.name)||seen.has(p.name)||typeof p.lat!=='number'||typeof p.lng!=='number'||!Number.isFinite(p.lat)||!Number.isFinite(p.lng)||Math.abs(p.lat)>90||Math.abs(p.lng)>180||!safeURL(p.source))continue;
    valid.push(p);seen.add(p.name);
   }
   return {...data,waypoints:valid,destination:typeof data.destination==='string'?data.destination.slice(0,80):'',country:typeof data.country==='string'?data.country.slice(0,50):''};
  }catch{return null;}
 }
 function navigation(name,data,point=null){
  if(/iPhone|iPad|iPod/.test(navigator.userAgent))return 'https://maps.apple.com/?'+new URLSearchParams({q:data.destination+' '+name,...(point?{ll:point.lat+','+point.lng}:{})});
  if(data.country&&data.country!=='中国'&&data.country!=='China')return 'https://www.google.com/maps/search/?'+new URLSearchParams({api:'1',query:data.destination+' '+name});
  return 'https://uri.amap.com/search?'+new URLSearchParams({keyword:name,city:data.destination,src:'travel-notes',callnative:'1'});
 }
 function load(){
  if(globalThis.L&&styleReady)return Promise.resolve(globalThis.L);if(library)return library;
  library=new Promise((resolve,reject)=>{
   const script=document.createElement('script'),style=document.createElement('link');let finished=false,scriptReady=false;
   script.src=leaflet;style.rel='stylesheet';style.href=leafletStyle;
   const fail=()=>{if(finished)return;finished=true;styleReady=false;clearTimeout(timer);script.remove();style.remove();reject(Error('地图组件暂时未加载成功，请稍后重试。'));};
   const timer=setTimeout(fail,8000);
   const ready=()=>{if(finished||!scriptReady||!styleReady)return;finished=true;clearTimeout(timer);resolve(globalThis.L);};
   script.onerror=style.onerror=fail;script.onload=()=>{if(finished)return;if(!globalThis.L){fail();return;}scriptReady=true;ready();};style.onload=()=>{if(finished)return;styleReady=true;ready();};
   document.head.append(style,script);
  }).catch(error=>{library=null;throw error;});return library;
 }
 function node(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text)el.textContent=text;return el;}
 function upgradeLegacy(root,defaults){
  for(const day of root.querySelectorAll('.trip-day')){
   const route=day.querySelector('.trip-route');
   if(route&&!route.hasAttribute('data-journey')){
    const stops=[...route.querySelectorAll('.trip-stop')].map(stop=>stop.textContent.replace(/^\d+\s*[·.、]\s*/,'').trim());
    const title=day.querySelector('h3')?.textContent||'',match=title.match(/^D\d+\s*·\s*(.+?)｜/);
    if(stops.length&&stops.length<=20)route.setAttribute('data-journey',JSON.stringify({destination:match?.[1]||defaults.destination||'',country:defaults.country||'',stops,waypoints:[]}));
   }
   if(day.querySelector('.trip-timeline'))continue;const table=day.querySelector('.trip-table-wrap table');if(!table)continue;
   const rows=[...table.querySelectorAll('tbody tr')].map(row=>[...row.querySelectorAll('th,td')].map(cell=>cell.textContent.trim()));
   if(rows.length!==3||rows.some((row,i)=>row.length!==4||row[0]!==['上午','下午','晚上'][i]))continue;
   const timeline=node('div','trip-timeline');
   for(const row of rows){
    const item=node('div','trip-timeline-item'),title=node('div','trip-time-title'),body=node('div','trip-time-body');
    title.append(node('span','trip-time-period',row[0]),node('span','trip-time-clock','灵活安排'));body.append(node('p','trip-time-plan',row[1]));
    for(const [label,field,value]of [['交通与耗时','trip-time-transport',row[2]],['预约与提醒','trip-time-reservation',row[3]]]){const p=node('p');p.append(node('strong','',label),node('span',field,value));body.append(p);}
    item.append(title,body);timeline.append(item);
   }
   table.closest('.trip-table-wrap').replaceWith(timeline);
  }
 }
 function close(state){
  state.open=false;state.generation++;clearTimeout(state.timer);state.timer=null;
  if(state.map){state.map.remove();state.map=null;}
  state.canvas.replaceChildren();state.canvas.hidden=true;state.button.textContent='查看当天地图';state.button.setAttribute('aria-expanded','false');state.button.disabled=false;state.notice.textContent='';
 }
 async function open(state){
  if(state.open){close(state);return;}state.open=true;const generation=++state.generation;
  state.button.textContent='收起地图';state.button.setAttribute('aria-expanded','true');
  if(!navigator.onLine){state.open=false;state.button.textContent='联网后查看地图';state.button.setAttribute('aria-expanded','false');state.notice.textContent='当前离线，地图联网后可查看；文字行程仍可阅读。';return;}
  state.notice.textContent='正在加载地图…';state.button.disabled=true;
  try{
   const L=await load();if(!state.live||!state.host.isConnected||generation!==state.generation)return;
   state.button.disabled=false;state.canvas.hidden=false;
   const map=L.map(state.canvas,{scrollWheelZoom:false,attributionControl:true,zoomControl:true});state.map=map;
   const points=state.data.stops.flatMap((name,index)=>{const p=state.data.waypoints.find(p=>p.name===name);return p?[{...p,index}]:[];});
   const coords=points.map(p=>[p.lat,p.lng]);
   const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,referrerPolicy:'strict-origin',updateWhenIdle:true,keepBuffer:0,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'}).addTo(map);
   let loaded=0;const fallback=()=>{if(state.live&&generation===state.generation)state.notice.textContent='底图暂时无法加载，地点标记与文字行程仍可查看；可点击地点打开导航。';};
   tiles.on('tileload',()=>{loaded++;if(generation===state.generation){clearTimeout(state.timer);state.notice.textContent='已定位 '+points.length+' / '+state.data.stops.length+' 个地点；连线表示游览顺序，实际交通路线请以导航为准。';}});
   tiles.on('tileerror',()=>{if(!loaded)fallback();});state.timer=setTimeout(()=>{if(!loaded)fallback();},7000);
   for(const p of points){
    const popup=node('div','journey-map-popup'),title=node('strong','',p.name),a=node('a','','打开导航 ↗'),source=node('a','','坐标来源 ↗');
    a.href=navigation(p.name,state.data,p);source.href=safeURL(p.source);for(const link of [a,source]){link.target='_blank';link.rel='noopener noreferrer';}
    popup.append(title,a,source);
    L.marker([p.lat,p.lng],{title:p.name,icon:L.divIcon({className:'journey-map-marker',html:String(p.index+1),iconSize:[30,30],iconAnchor:[15,15]})}).bindPopup(popup).addTo(map);
   }
   if(coords.length>1)L.polyline(coords,{color:'#356c53',weight:3,dashArray:'6 6',interactive:false}).addTo(map);
   if(coords.length===1)map.setView(coords[0],14);else map.fitBounds(coords,{padding:[30,30],maxZoom:15});
   map.invalidateSize();
  }catch(error){if(state.live&&generation===state.generation){state.open=false;state.button.disabled=false;state.button.textContent='重试地图';state.button.setAttribute('aria-expanded','false');state.notice.textContent=error.message||'地图暂时无法加载，文字行程仍可查看。';}}
 }
 function mount(root,defaults={}){
  if(!root)return;for(const state of [...states])if(!state.host.isConnected)disposeState(state);upgradeLegacy(root,defaults);
  for(const host of root.querySelectorAll('[data-journey]')){
   if(known.has(host))continue;const data=parse(host.getAttribute('data-journey'));if(!data||!data.stops.length)continue;
   const route=host.closest('.trip-day');
   if(route)for(const stop of host.querySelectorAll('.trip-stop')){
    const name=stop.textContent.replace(/^\d+\s*[·.、]\s*/,'').trim();if(!data.stops.includes(name))continue;
    if(stop.nextElementSibling?.classList.contains('journey-stop-nav'))continue;
    const a=node('a','journey-stop-nav','导航 ↗');a.href=navigation(name,data,data.waypoints.find(p=>p.name===name));a.target='_blank';a.rel='noopener noreferrer';stop.after(a);
   }
   const controls=node('div','journey-map-controls'),notice=node('p','journey-map-note'),canvas=node('div','journey-map');canvas.hidden=true;canvas.setAttribute('role','region');canvas.setAttribute('aria-label','当天地点与游览顺序地图');
   if(!data.waypoints.length){notice.textContent='路线地点可点击导航；地图位置待补充坐标来源。';controls.append(notice);host.after(controls);known.set(host,{controls});continue;}
   const button=node('button','button secondary journey-map-toggle','查看当天地图');button.type='button';button.setAttribute('aria-expanded','false');
   const state={host,controls,canvas,button,notice,data,live:true,open:false,generation:0,map:null,timer:null};
   button.addEventListener('click',()=>void open(state));controls.append(button,notice,canvas);host.after(controls);states.add(state);known.set(host,state);
  }
 }
 function disposeState(state){state.live=false;close(state);states.delete(state);known.delete(state.host);state.controls.remove();}
 function dispose(root){for(const state of [...states])if(!state.host.isConnected||root?.contains(state.host))disposeState(state);}
 function deadline(item){
  const value=item.due_date||item.suggested_date;if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return '';
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const label=(item.due_date?'办理日期 ':'建议 ')+value+' 前完成';
  return label+(item.done?' · 已完成':value<today?' · 日期已过，待确认':value===today?' · 今天处理':'');
 }
 return {mount,dispose,navigation,deadline};
})();
