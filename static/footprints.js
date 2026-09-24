/* Public travel memories. Loaded before app.js; shared helpers are used at render time. */
const Footprints=(()=>{
  const filters={q:'',destination:'',year:'',page:1,guide:''};
  let album=[],photoIndex=0;
  // Per-tab public summaries only. Never persist or reuse administrator preview data.
  const listCache=new Map(),CACHE_TTL=15000;
  const listKey=()=>new URLSearchParams(filters).toString();
  function remember(key,data){
    if(adminPreview||!data||data.records.some(r=>r.status!=='public'||r.deleted_at))return;
    listCache.delete(key);listCache.set(key,{data,expires:Date.now()+CACHE_TTL});
    while(listCache.size>8)listCache.delete(listCache.keys().next().value);
  }
  function seed(data){
    listCache.clear();if(!data)return;
    remember(new URLSearchParams({q:'',destination:'',year:'',page:1,guide:''}).toString(),data);
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden)listCache.clear();});
  const dates=r=>r.start_date.replaceAll('-','.')+(r.end_date&&r.end_date!==r.start_date?' — '+r.end_date.replaceAll('-','.'):'');
  function card(r){return `<article class="memory-card"><a href="#record/${r.id}"><div class="memory-photo"><img data-travel-src="${esc(travelImageUrl(r.cover,640))}" alt="${esc(r.destination)}旅行记录封面" width="640" height="480" loading="lazy"><span>${r.photo_count} 张照片</span></div><div class="memory-copy"><span class="memory-date">${esc(dates(r))} · ${esc(r.destination)}</span><h3>${esc(r.title)}</h3><p>${esc(r.summary||'把旅途里的片刻，留在这里。')}</p>${state.admin&&r.status!=='public'?`<span class="status-badge ${r.status}">${statusName[r.status]}</span>`:''}</div></a></article>`;}
  function home(guideCard){
    updateShell('home');const records=state.records||[],featured=records[0];
    const guide=state.guides.find(g=>!g.sample)||state.guides[0],lead=featured||guide,image=lead?.cover;
    const leadRoute=lead?'#'+(featured?'record/':'guide/')+lead.id:'#guides';
    const places=new Set(state.guides.map(g=>g.destination).filter(Boolean));
    const otherGuides=featured?state.guides:state.guides.filter(g=>g.id!==guide?.id);
    const picks=(otherGuides.length?otherGuides:state.guides).slice(0,3);
    $('#app').innerHTML=
      `<section class="journal-lead ${image?'has-photo':''}" aria-label="旅行手记"><div class="journal-copy"><span class="journal-label"><span></span>我们的旅行手记</span><h1>去远方，<br>也把远方留下。</h1><p>${esc(state.site?.tagline||'出发前，整理路线与灵感；回来后，收藏照片与见闻。')}</p><div class="journal-actions"><a class="button primary" href="#guides">找一份旅行攻略 ${icon('arrow')}</a><a class="journal-secondary" href="#footprints">翻看旅行足迹 ${icon('arrow')}</a></div><div class="journal-stats" aria-label="收录概况"><span><strong>${state.guides.length}</strong> 篇攻略</span><span><strong>${places.size}</strong> 个目的地</span><span><strong>${state.recordCount||0}</strong> 篇足迹</span></div></div><div class="journal-feature">${image?`<a class="journal-photo" href="${leadRoute}" aria-label="阅读：${esc(lead.title)}"><img data-travel-src="${esc(travelImageUrl(image,1280))}" alt="${esc(lead.destination)}旅行封面" width="1280" height="960" fetchpriority="high"></a>`:'<div class="journal-placeholder" aria-hidden="true">'+icon('map')+'</div>'}<div class="journal-caption"><div class="journal-caption-meta"><span>${featured?'最近的足迹':guide?'本期选读':'旅行存档'}</span>${lead?`<span>${esc(lead.destination)} · ${featured?esc(dates(featured)):guide.days+' 天行程'}</span>`:''}</div><h2>${lead?`<a href="${leadRoute}">${esc(lead.title)}</a>`:'还没有公开的旅行笔记'}</h2><a class="journal-read" href="${leadRoute}" aria-label="${lead?'阅读'+esc(lead.title):'浏览旅行攻略'}">${icon('arrow')}</a></div></div></section>`+
      `<section class="memory-section home-guides"><div class="memory-section-heading"><div><p class="section-kicker">出发之前</p><h2>下一站，去哪儿</h2><p class="section-description">把路线、住宿和当地风味，一起装进行程。</p></div><a href="#guides">全部攻略 ${icon('arrow')}</a></div>${picks.length?`<div class="guides-grid">${picks.map(g=>guideCard(g)).join('')}</div>`:'<div class="memory-empty"><h3>攻略正在路上</h3><p>公开的旅行攻略会收录在这里。</p></div>'}</section>`+
      `<section class="memory-section home-memories"><div class="memory-section-heading"><div><p class="section-kicker">归来之后</p><h2>留住旅途里的片刻</h2><p class="section-description">照片、见闻，以及想再去一次的理由。</p></div><a href="#footprints">全部足迹 ${icon('arrow')}</a></div>${records.length?`<div class="memory-grid">${records.map(card).join('')}</div>`:`<div class="memory-empty memory-empty-home"><span>${icon('image')}</span><div><h3>足迹还在路上</h3><p>还没有公开的旅行记录。下一次出发，再来留下一页回忆。</p></div><a href="#footprints">翻开旅行相册 ${icon('arrow')}</a></div>`}</section>`;
  }
  async function list(gen,guide=''){
    updateShell('footprints');if(filters.guide!==guide){filters.guide=guide;filters.page=1;}
    const key=listKey(),cached=adminPreview?null:listCache.get(key);
    if(cached&&cached.expires>Date.now()){renderList(cached.data,guide);return;}
    listCache.delete(key);
    renderList({records:[],destinations:[],years:[],total:0,pages:1,page:filters.page},guide,true);
    const data=await api('/records?'+key);if(gen!==state.load)return;
    remember(key,data);renderList(data,guide);
  }
  function renderList(data,guide,pending=false){
    const linked=state.guides.find(g=>String(g.id)===guide);
    $('#app').innerHTML=heading('旅行足迹',linked?'与「'+linked.title+'」相关的照片与游记。':'按日期和地点，翻看每一段旅程的真实片刻。','沿途的照片与故事')+
      (guide?`<p class="memory-back"><a href="#guide/${Number(guide)}">← 返回关联攻略</a> · <a href="#footprints">查看全部足迹</a></p>`:'')+
      `<form id="memory-filter" class="memory-filter"><label>搜索记录<input name="q" type="search" placeholder="地点、标题或片刻…" value="${esc(filters.q)}"></label><label>地点<select name="destination"><option value="">所有地点</option>${data.destinations.map(d=>`<option ${d===filters.destination?'selected':''}>${esc(d)}</option>`).join('')}</select></label><label>年份<select name="year"><option value="">所有年份</option>${data.years.map(y=>`<option ${String(y)===filters.year?'selected':''}>${y}</option>`).join('')}</select></label><button class="button secondary" type="submit">筛选</button><button class="button ghost" type="button" data-fp="reset">重置</button></form>`+
      `<p class="memory-total">${pending?'正在读取旅行记录…':`共 ${data.total} 篇旅行记录 · 按游玩日期排列`}</p>`+
      (pending?'<div class="memory-loading" aria-label="旅行足迹列表正在加载"><span></span><span></span><span></span></div>':data.records.length?`<div class="memory-grid">${data.records.map(card).join('')}</div>`:`<div class="memory-empty"><span>${icon('image')}</span><h3>${data.total?'暂时没有记录':'还没有找到这段回忆'}</h3><p>${filters.q||filters.destination||filters.year?'换个筛选条件，再翻翻看。':'照片和故事，会随着每一次旅行慢慢积累。'}</p></div>`)+
      (data.pages>1?`<div class="memory-pagination"><button class="button secondary" data-fp="page" data-page="${data.page-1}" ${data.page===1?'disabled':''}>上一页</button><span>${data.page} / ${data.pages}</span><button class="button secondary" data-fp="page" data-page="${data.page+1}" ${data.page===data.pages?'disabled':''}>下一页</button></div>`:'');
    $('#memory-filter').addEventListener('submit',event=>{event.preventDefault();Object.assign(filters,Object.fromEntries(new FormData(event.currentTarget)),{page:1});listCache.delete(listKey());route();});
  }
  async function detail(id,gen){
    const {record:r,guide}=await api('/records/'+id+'?view=read');if(gen!==state.load)return;
    updateShell('record');document.title=r.title+' · 旅行足迹 · '+(state.site?.site_name||'行笺');album=r.photos;
    $('#app').innerHTML=`<div class="memory-detail-top"><a class="back-link" href="#footprints">${icon('back')}返回旅行足迹</a>${r.status==='public'&&!r.deleted_at?'<button class="button secondary small" data-fp="share">分享这段旅程</button>':''}</div><header class="memory-header"><span class="eyebrow">A PAGE FROM THE JOURNEY</span><h1>${esc(r.title)}</h1><p class="memory-meta">${icon('pin')}${esc(r.destination)}<span>·</span>${esc(dates(r))}<span>·</span>${r.photo_count} 张照片</p>${r.summary?`<p class="memory-summary">${esc(r.summary)}</p>`:''}${state.admin&&r.status!=='public'?`<p class="memory-private">${statusName[r.status]}记录 · 仅管理员可见</p>`:''}${r.deleted_at?'<p class="memory-private">这篇记录已在回收站。</p>':''}</header>`+
      (r.photos.length?`<section class="memory-album" aria-label="旅行相册">${r.photos.map((p,i)=>`<figure><button type="button" data-fp="photo" data-index="${i}" aria-label="放大第 ${i+1} 张照片：${esc(p.caption||r.destination)}"><img data-travel-src="${esc(travelImageUrl(p.url,640))}" width="640" height="480" alt="${esc(p.caption||r.destination+'旅行照片 '+(i+1))}" loading="${i===0?'eager':'lazy'}" decoding="async"><span>${icon('image')} ${i+1} / ${r.photos.length}</span></button>${p.caption?`<figcaption>${esc(p.caption)}</figcaption>`:''}</figure>`).join('')}</section>`:'')+
      `<div class="memory-story-layout"><article class="memory-story">${r.html?'<h2>旅途手记</h2><div class="prose">'+PublicImages.prepareHTML(r.html)+'</div>':''}${!r.html&&r.photos.length?'<p class="memory-photo-note">有些回忆，照片已经说得很好。</p>':''}</article><aside class="memory-trip-note"><h2>这一段旅程</h2><dl><dt>游玩日期</dt><dd>${esc(dates(r))}</dd><dt>地点</dt><dd>${esc(r.destination)}</dd>${r.actual_cost?`<dt>实际花费</dt><dd>${esc(r.actual_cost)}</dd>`:''}</dl>${guide?`<a class="memory-plan-link" href="#guide/${guide.id}${r.guide_day?'/day-'+r.guide_day:''}"><span>回看出发前的计划${r.guide_day?' · 第 '+r.guide_day+' 天':''}</span><strong>${esc(guide.title)} ${icon('arrow')}</strong></a>`:''}</aside></div>`;
  }
  async function related(guideId,generation){
    try{const data=await api('/records?guide='+guideId);if(generation!==state.load||!data.records.length)return;
      const section=document.createElement('section');section.className='memory-section guide-memories';section.innerHTML=`<div class="memory-section-heading"><div><span class="eyebrow">FROM PLAN TO MEMORY</span><h2>这份攻略，后来有了这些故事</h2></div><a href="#footprints/${guideId}">全部足迹 ${icon('arrow')}</a></div><div class="memory-grid">${data.records.slice(0,3).map(card).join('')}</div>`;$('#app').append(section);
    }catch{/* The guide remains readable if related memories cannot be loaded. */}
  }
  function viewer(){let dialog=$('#memory-viewer');if(dialog)return dialog;dialog=document.createElement('dialog');dialog.id='memory-viewer';dialog.className='memory-viewer';dialog.setAttribute('aria-label','旅行照片浏览');dialog.innerHTML='<button class="viewer-close" data-fp="close" aria-label="关闭照片">×</button><div class="viewer-main"><button data-fp="previous" aria-label="上一张照片">‹</button><img alt=""><button data-fp="next" aria-label="下一张照片">›</button></div><div class="viewer-description"><span id="viewer-count" aria-live="polite"></span><p id="viewer-caption"></p></div>';document.body.append(dialog);
    let touch=null;dialog.addEventListener('pointerdown',e=>touch={x:e.clientX,y:e.clientY});dialog.addEventListener('pointerup',e=>{if(touch&&Math.abs(e.clientX-touch.x)>60&&Math.abs(e.clientX-touch.x)>Math.abs(e.clientY-touch.y)*1.5)showPhoto(photoIndex+(e.clientX<touch.x?1:-1));touch=null;});
    dialog.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();showPhoto(photoIndex+(e.key==='ArrowRight'?1:-1));}});
    return dialog;
  }
  function showPhoto(index){if(!album.length)return;photoIndex=(index+album.length)%album.length;const dialog=viewer(),photo=album[photoIndex];$('img',dialog).setAttribute('data-travel-src',travelImageUrl(photo.url,1280));$('img',dialog).alt=photo.caption||'旅行照片 '+(photoIndex+1);$('#viewer-count').textContent=(photoIndex+1)+' / '+album.length;$('#viewer-caption').textContent=photo.caption||'';dialog.querySelectorAll('.viewer-main button').forEach(b=>b.hidden=album.length===1);if(!dialog.open)dialog.showModal();}
  async function share(){const url=location.origin+location.pathname+location.hash;try{if(!navigator.clipboard?.writeText)throw Error();await navigator.clipboard.writeText(url);toast('分享链接已复制');}catch{let dialog=$('#memory-share');if(!dialog){dialog=document.createElement('dialog');dialog.id='memory-share';dialog.innerHTML='<h2>分享这段旅程</h2><p>复制下面的链接，分享给一起出发的人。</p><label>公开记录链接<input readonly aria-label="公开记录链接"></label><button class="button primary" data-fp="share-close">完成</button>';document.body.append(dialog);}const input=$('input',dialog);input.value=url;dialog.showModal();input.focus();input.select();}}
  document.addEventListener('click',e=>{const node=e.target.closest('[data-fp]');if(!node)return;const a=node.dataset.fp;if(a==='reset'){Object.assign(filters,{q:'',destination:'',year:'',page:1});route();}if(a==='page'){filters.page=Number(node.dataset.page);route();}if(a==='photo')showPhoto(Number(node.dataset.index));if(a==='previous')showPhoto(photoIndex-1);if(a==='next')showPhoto(photoIndex+1);if(a==='close')$('#memory-viewer').close();if(a==='share')share();if(a==='share-close')$('#memory-share').close();});
  return {home,list,detail,related,card,seed};
})();
