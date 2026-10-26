const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value = '') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  map:'<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/>',
  tag:'<path d="M20 13 13 20a2 2 0 0 1-3 0l-7-7V3h10l7 7a2 2 0 0 1 0 3Z"/><circle cx="7.5" cy="7.5" r="1"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
  up:'<path d="M6 18 18 6M6 6h12v12"/>',
  back:'<path d="M19 12H5m6-6-6 6 6 6"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  pin:'<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  book:'<path d="M4 3h12a3 3 0 0 1 3 3v15H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3M3 18a3 3 0 0 1 3-3h13M8 7h6"/>',
  spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  edit:'<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14v6Z"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L6 21"/>',
  money:'<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/>',
  restore:'<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7"/>',
  logout:'<path d="M9 4H4v16h5M9 12h12m-4-4 4 4-4 4"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`;
const state = { admin:false, csrf:'', guides:[], query:'', country:'', tag:'', destination:'', status:'', sort:'updated', route:'', load:0 };
const statusName = { public:'公开', private:'私密', draft:'草稿' };
const autumnTag = '2026秋游备选';
function guideTopics(guide){return [...new Set(guide.tags||[])].filter(t=>t&&!['参考','AI参考',autumnTag].includes(t)).slice(0,3);}
const autumnOptions = [
  {destination:'西双版纳', theme:'傣族生活与热带绿意', fit:'园林佛寺、植物导览、村寨手作', effort:'中等 · 两天郊外往返', season:'户外内容多，出发前按天气调整', note:'先确认抵离时间；勐养曼掌村与勐仑植物园分天走', group:'¥19,350—30,600', priority:'环境反差、傣族文化', days:['曼听 · 告庄夜市','勐仑植物园 · 导览','曼掌村 · 手作体验','总佛寺 · 返程']},
  {destination:'泉州', theme:'在海丝古城听一场戏', fit:'古寺石桥、南音木偶、闽南吃逛', effort:'低到中等 · 古城慢走', season:'室内看展和街区结合，海边注意风雨', note:'演出先查具体场馆与当周排期，九人预约同场', group:'¥15,840—26,100', priority:'吃逛、人文、轻松节奏', days:['开元寺 · 西街','海交馆 · 洛阳桥 · 戏曲可选','蟳埔 · 天后宫','涂门街 · 返程']},
  {destination:'景德镇', theme:'从一座窑到自己的杯子', fit:'御窑建筑、工业遗产、拉坯彩绘', effort:'中等 · 市区与三宝转场', season:'看展和手作适合换季，市集另查当周公告', note:'手作先确认九人工位，烧制与邮寄费用问清', group:'¥16,830—27,720', priority:'陶瓷手作、建筑、设计', days:['陶溪川 · 老厂区','御窑博物馆 · 陶阳里','陶瓷博物馆 · 三宝手作','小店短逛 · 返程']},
  {destination:'西安', theme:'听懂秦唐，再走进街巷', fit:'文物讲解、古城尺度、面食生活', effort:'中等 · 看展站立与临潼往返', season:'夜游与城墙备保暖防风层', note:'陕历博九人按 5＋4 分组预约，同场成功后再落实', group:'¥17,100—27,720', priority:'历史文物、城市建筑', days:['钟鼓楼 · 回坊','陕历博 · 大雁塔','兵马俑 · 丽山园可选','城墙 · 书院门 · 返程']},
  {destination:'婺源', added:true, theme:'晒秋与徽州村落', fit:'篁岭晒秋、徽商民居、廊桥慢走', effort:'中等 · 石阶与两天郊外用车', season:'主看晒秋与村落；红叶、晨雾需看临近实况', note:'县城连住；篁岭与北线分天，不为石城晨雾凌晨赶路', group:'¥18,000—29,250', priority:'秋天氛围、村落摄影', days:['县城街巷 · 河岸','篁岭 · 晒秋与民居','思溪延村 · 彩虹桥','汽糕早餐 · 品茶 · 返程']},
  {destination:'北京', added:true, theme:'红墙古建与长城秋景', fit:'故宫讲解、慕田峪山色、胡同生活', effort:'中到较高 · 看展站立与长城台阶', season:'赏秋窗口可考虑；公园和山地叶色不同步', note:'周六故宫不含暂闭的延禧宫；北京房价可能超过统一住宿目标', group:'¥19,350—31,050', priority:'古建、秋景、长城', days:['地坛 · 五道营','故宫 · 景山 · 角楼','慕田峪 · 开放段短走','什刹海 · 胡同 · 返程']},
  {destination:'重庆', added:true, theme:'山城生活与宋代石刻', fit:'大足讲解、移民会馆、江景与地方菜', effort:'中等 · 坡路与一天大足往返', season:'秋季适合城市慢走，需准备阴雨与湿滑坡路', note:'大足独立一天；集合写清入口楼层，不把地图近当成好走', group:'¥17,100—28,350', priority:'城市夜景、石刻、美食', days:['山城巷 · 洪崖洞','大足宝顶山 · 石刻讲解','湖广会馆 · 南岸老街','李子坝 · 返程']},
];
function autumnGuides(){return autumnOptions.map(option=>({...option,guide:state.guides.find(g=>g.destination===option.destination&&g.tags.includes(autumnTag))})).filter(item=>item.guide);}
function autumnBanner(){return autumnGuides().length?`<a class="autumn-banner" href="#autumn"><span>${icon('sun')}2026 秋日出游计划</span><strong>9 人 · 9 间房，七种不同的文化之旅。</strong><span class="autumn-banner-link">10.30 周五 — 11.02 周一 · 打开七地对比 ${icon('arrow')}</span></a>`:'';}
const date = value => new Date(value).toLocaleDateString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit'}).replaceAll('/', '.');
function toast(message, error=false) { const node=$('#toast'); node.textContent=message; node.className=`show ${error?'error':''}`; clearTimeout(toast.timer); toast.timer=setTimeout(()=>node.className='',3500); }
// Ordinary pages use the same anonymous view even while the admin tab is signed in.
// Preview only changes the view: the server still requires a real admin session.
const adminPreview = new URLSearchParams(location.search).get('preview') === '1';
const PublicImages=createTravelImages({roots:['#app','#memory-viewer[open]'],credentials:adminPreview?'same-origin':'omit',attribute:'data-travel-src'});
let publicReads=new AbortController();
function cancelPublicReads(){publicReads.abort();publicReads=new AbortController();}
async function api(path, options={}) {
  const read=['GET','HEAD'].includes((options.method||'GET').toUpperCase());
  const headers={'X-CSRF-Token':state.csrf,...options.headers};let body=options.body;
  if(body&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}
  const controller=read?new AbortController():null,source=publicReads.signal;
  let timedOut=false;const abort=()=>controller.abort();
  if(read)source.addEventListener('abort',abort,{once:true});
  const timer=read?setTimeout(()=>{timedOut=true;controller.abort();},15000):null;
  try{
    const response=await fetch('/api'+path,{...options,body,headers,credentials:adminPreview?'same-origin':'omit',...(read?{signal:controller.signal,priority:'high'}:{})});
    let data;try{data=await response.json();}catch(e){if(controller?.signal.aborted)throw e;throw Error('服务暂时不可用，请稍后重试');}
    if(!response.ok){const error=Error(data.error||'操作未完成，请稍后重试');error.status=response.status;throw error;}
    return data;
  }catch(error){if(timedOut)throw Error('加载超时，请点击重试。');throw error;}
  finally{clearTimeout(timer);if(read)source.removeEventListener('abort',abort);}
}
function updateShell(view='home') {
  document.body.dataset.view=view;
  const navView=({guide:'guides',record:'footprints'})[view]||view;
  if(adminPreview&&state.admin&&!$('#admin-preview-notice')){
    const notice=document.createElement('div');notice.id='admin-preview-notice';notice.className='admin-preview-notice';notice.setAttribute('role','status');
    notice.innerHTML='<div><strong>管理员预览</strong><p>这里可能包含私密或草稿内容，仅登录管理员可见。访客网站只展示公开内容。</p></div><div class="preview-links"><a href="/">查看访客网站 →</a><a href="/admin#guides">返回攻略管理</a></div>';
    $('#app').before(notice);
  }
  const entries=[['home','grid','首页'],['guides','book','攻略'],['footprints','image','足迹']];
  const installed=TravelPWA.standalone()&&!adminPreview;
  document.body.classList.toggle('is-standalone',installed);
  if(installed)entries.push(['offline','download','离线']);
  $('#browser-tools').hidden=installed;
  $('#site-more summary span').textContent=installed?'浏览':'更多';
  $('#site-more summary').setAttribute('aria-label',installed?'更多浏览方式':'更多功能');
  $('#more-autumn').hidden=!autumnGuides().length;
  $('#site-more').classList.toggle('has-current',(['destinations','autumn','split'].includes(navView)||!installed&&navView==='offline'));
  for(const link of document.querySelectorAll('#site-more a[href]')){if(link.hash==='#'+navView)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
  $('#navigation').innerHTML=entries.map(([key,ico,label])=>`<a class="nav-item ${navView===key?'active':''}" href="#${key}" ${navView===key?'aria-current="page"':''}>${icon(ico)}<span>${label}</span>${key==='guides'?`<span class="nav-count">${state.guides.length}</span>`:''}</a>`).join('');
  const mobile=entries;
  $('#mobile-navigation').style.setProperty('--nav-columns',String(mobile.length));
  $('#mobile-navigation').innerHTML=mobile.map(([key,ico,label])=>`<a href="#${key}" ${navView===key?'aria-current="page"':''}>${icon(ico)}<span>${label}</span></a>`).join('');
  $('#breadcrumb').textContent=({split:'费用分摊',offline:'已保存攻略',home:'旅行首页',guides:'旅行攻略',footprints:'旅行足迹',record:'足迹详情',autumn:'秋游七地对比',destinations:'目的地',trash:'回收站',guide:'攻略详情',edit:'编辑攻略',new:'新建攻略'})[view]||'攻略收藏';
}
function heading(title, description, eyebrow='旅行收藏') {
  return `<section class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${esc(title)}</h1><p>${esc(description)}</p></div></section>`;
}
function card(guide) {
  return `<article class="guide-card"><a href="#guide/${guide.id}" aria-label="查看攻略：${esc(guide.title)}"><div class="card-image-wrap"><img class="card-image" data-travel-src="${esc(travelImageUrl(guide.cover,640))}" alt="${esc(guide.destination)}攻略封面" loading="lazy"><span class="place-badge">${icon('pin')}${esc(guide.country?`${guide.country} · ${guide.destination}`:guide.destination)}</span>${guide.sample?'<span class="sample-badge">示例攻略</span>':''}</div><div class="card-body"><h3 class="card-title">${esc(guide.title)}</h3><p class="card-summary">${esc(guide.summary||'一段新的旅程，等你慢慢记录。')}</p><div class="card-tags">${guideTopics(guide).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}${state.admin&&guide.status!=='public'?`<span class="status-badge ${guide.status}">${statusName[guide.status]}</span>`:''}</div></div><div class="card-footer"><span>${icon('clock')}${guide.days} 天行程</span><span>${date(guide.updated_at)} 更新</span></div></a></article>`;
}
function empty(title,copy,action=''){return `<div class="empty">${icon('map')}<h3>${title}</h3><p>${copy}</p>${action}</div>`;}
function home(){Footprints.home(card);}
function guidesHome() {
  updateShell('guides');
  const countries=[...new Set(state.guides.map(g=>g.country).filter(Boolean))];
  $('#app').innerHTML=heading('旅行攻略','按目的地查找路线、交通、住宿与预算。')+autumnBanner()+
    `<section aria-label="攻略收藏"><div class="collection-toolbar"><div class="section-title"><h2>${esc(state.destination||state.tag||'全部攻略')}</h2><span class="count-pill" id="result-count">${state.guides.length}</span></div><div class="search-sort"><div class="search-box">${icon('search')}<input id="search" type="search" aria-label="搜索攻略" placeholder="搜索目的地、攻略或主题…" value="${esc(state.query)}"></div><select id="sort" class="sort-select" aria-label="排序方式"><option value="updated">最近更新</option><option value="title">标题排序</option><option value="days">旅行天数</option></select></div></div><div class="filter-row"><div class="chips"><button class="chip ${!state.country?'active':''}" data-action="country" data-value="">全部目的地</button>${countries.map(c=>`<button class="chip ${state.country===c?'active':''}" data-action="country" data-value="${esc(c)}">${esc(c)}</button>`).join('')}${state.tag||state.destination?'<button class="chip" data-action="clear">清除筛选 ×</button>':''}</div></div>${state.admin?`<div class="state-tabs">${[['','全部状态'],['public','公开'],['private','私密'],['draft','草稿']].map(([v,l])=>`<button class="chip ${state.status===v?'active':''}" data-action="status" data-value="${v}">${l}</button>`).join('')}</div>`:''}<div class="guides-grid" id="guide-grid"></div></section>`;
  $('#sort').value=state.sort;
  $('#search').addEventListener('input',e=>{state.query=e.target.value;renderCards();});
  $('#sort').addEventListener('change',e=>{state.sort=e.target.value;renderCards();});
  renderCards();
}
function autumn(){
  updateShell('autumn');document.title='秋游七选一 · '+(state.site?.site_name||'行笺');
  const options=autumnGuides();
  $('#app').innerHTML=heading('把秋天，留给四天假期。','暂定 2026 年 10 月 30 日—11 月 2 日 · 周五、周六、周日、周一','FOUR DAYS · SEVEN PLACES · AUTUMN 2026')+
    `<section class="autumn-intro"><div><span class="autumn-label">一起选下一站</span><h2>新增晒秋、古建与山城，<br>七个目的地，一起慢慢选。</h2><p>七篇完整图文攻略，共 42 张实景照片。每篇写清景点特色、可参与的项目、每天怎么走、住哪里和九人费用，先按兴趣选，再比较出发交通。</p></div><div class="autumn-facts"><p><strong>四天三晚</strong><span>周五 14:00 前到酒店 · 周一傍晚返程</span></p><p><strong>9 人 · 每晚 9 间独立客房</strong><span>连住 3 晚＝27 个房晚 · 住宿总预算 ¥8,100—13,500</span></p><p><strong>¥1,760—3,450 / 人</strong><span>按目的地区分 · 含每人单住 · 不含往返大交通</span></p></div></section>`+
    `<section class="autumn-bottom" aria-label="新增三地的季节选择"><h2>这次加的三处，分别看什么？</h2><p><strong>婺源：</strong>把晒秋和徽州村落放在一起，适合想要秋天氛围与乡村摄影的人；不承诺石城红叶和晨雾。</p><p><strong>北京：</strong>红墙古建、胡同与长城秋景组合，叶色需看临近实况；已按当前公告调整故宫路线。</p><p><strong>重庆：</strong>取秋季步行游览的舒适度，以大足石刻、会馆和山城生活为主题；雨天少走湿滑台阶。</p><p>原有西双版纳、泉州、景德镇、西安继续保留。下表可同时比较兴趣、季节与九人费用。</p></section>`+
    `<section class="autumn-compare" aria-label="九人旅行方案速查"><h2>先按大家最想体验的内容选。</h2><div class="autumn-table-wrap"><table><thead><tr><th>目的地</th><th>最适合的兴趣</th><th>季节考虑</th><th>九人当地费用</th><th>住宿口径</th></tr></thead><tbody>${options.map(o=>`<tr><th><a href="#guide/${o.guide.id}">${esc(o.destination)}</a></th><td>${esc(o.priority)}</td><td>${esc(o.season)}</td><td>${esc(o.group)}</td><td>9 间 × 3 晚</td></tr>`).join('')}</tbody></table></div><p>共同假设：每间每晚 ¥300—500，每人独住；以上为规划预算，航班、高铁及个人购物另计。北京房价可能超出统一目标，九间实际报价确认后重算。</p></section>`+
    (options.length?`<section class="autumn-grid" aria-label="七个目的地方案">${options.map((o,i)=>`<article class="autumn-option"><a class="autumn-cover" href="#guide/${o.guide.id}"><img src="${esc(travelImageUrl(o.guide.cover,640))}" alt="${esc(o.destination)}景点实景，摄影来源见攻略正文" loading="lazy"><span>0${i+1} / ${esc(o.destination)}</span></a><div class="autumn-option-body"><div class="autumn-label">${o.added?'新增 · ':''}${esc(o.theme)}</div><h2><a href="#guide/${o.guide.id}">${esc(o.destination)} · 四天三晚</a></h2><p class="autumn-fit">${esc(o.fit)}</p><dl><div><dt>预算</dt><dd>${esc(o.guide.budget)}</dd></div><div><dt>九人合计</dt><dd>${esc(o.group)}</dd></div><div><dt>强度</dt><dd>${esc(o.effort)}</dd></div><div><dt>季节</dt><dd>${esc(o.season)}</dd></div></dl><ol class="autumn-days">${o.days.map((d,j)=>`<li><span>${['周五','周六','周日','周一'][j]}</span>${esc(d)}</li>`).join('')}</ol><p class="autumn-note">${esc(o.note)}</p><a class="button secondary" href="#guide/${o.guide.id}">查看图文攻略与项目玩法 ${icon('arrow')}</a></div></article>`).join('')}</section>`:empty('暂时没有公开的秋游攻略','请返回收藏查看其他旅行灵感。'))+
    `<section class="autumn-bottom"><h2>出发前，把这几件事定下来。</h2><p>往返交通尚未加入预算。周五晚到时删减第一天下午，周一早走时删减最后半天；不要压缩周末的核心行程。若换到相邻周末，门票日期和开放时间也需一起调整。</p><p>七篇均附官方资料、携程或马蜂窝游记参考，以及实景照片的作者与授权。核对日期为 2026 年 9 月 20 日；酒店是询价候选，九间房的房价、余量、演出与手作名额需按实际日期确认。</p><a class="back-link" href="#guides">${icon('back')}返回全部攻略</a></section>`;
}
function renderCards(){
  const query=state.query.trim().toLocaleLowerCase();
  let guides=state.guides.filter(g=>(!query||[g.title,g.destination,g.country,g.summary,...g.tags].join(' ').toLocaleLowerCase().includes(query))&&(!state.country||g.country===state.country)&&(!state.tag||g.tags.includes(state.tag))&&(!state.destination||g.destination===state.destination)&&(!state.status||g.status===state.status));
  if(state.sort==='title')guides.sort((a,b)=>a.title.localeCompare(b.title,'zh-CN'));
  if(state.sort==='days')guides.sort((a,b)=>a.days-b.days);
  $('#result-count').textContent=guides.length;
  $('#guide-grid').innerHTML=guides.length?guides.map(g=>card(g)).join(''):empty('还没有找到这段旅程','换个关键词，或清除筛选查看全部攻略。','<button class="button secondary" data-action="clear">清除筛选</button>');
}
function destinations(){
  updateShell('destinations');const groups=new Map();state.guides.forEach(g=>{const list=groups.get(g.destination)||[];list.push(g);groups.set(g.destination,list);});
  $('#app').innerHTML=heading('目的地','按地点浏览已收录的旅行攻略。','想去的远方')+`<div class="destination-grid">${[...groups].map(([name,list])=>`<button class="destination-card" data-action="destination" data-value="${esc(name)}"><img data-travel-src="${esc(travelImageUrl(list[0].cover,640))}" alt="${esc(name)}旅行封面" loading="lazy"><p>${esc(list[0].country||'下一站')}</p><h2>${esc(name)}</h2><p>${list.length} 篇攻略 · 探索这个目的地 ↗</p></button>`).join('')||empty('目的地清单还是空的','公开攻略会按目的地整理在这里。')}</div>`;
}

async function detail(id, generation, saved=false){
  const savedEntry=saved?await TravelPWA.read(id):null;
  const {guide:g}=savedEntry||await api(`/guides/${id}?view=read`);if(state.load!==generation)return;updateShell(saved?'offline':'guide');document.title=`${g.title} · ${state.site?.site_name||'行笺'}`;
  $('#app').innerHTML=`<div class="detail-top"><a class="back-link" href="#${saved?'offline':g.deleted_at?'trash':g.tags.includes(autumnTag)?'autumn':'guides'}">${icon('back')}返回${saved?'已保存攻略':g.deleted_at?'回收站':g.tags.includes(autumnTag)?'七地对比':'攻略收藏'}</a>${state.admin?`<div class="detail-actions">${g.deleted_at?`<a class="button secondary" href="/admin#trash">管理回收站</a>`:`<a class="button secondary" href="/admin#edit/${g.id}">${icon('edit')}编辑攻略</a>`}</div>`:''}</div><img class="detail-cover" fetchpriority="high" ${saved?`src="${esc(savedEntry.cover)}"`:`data-travel-src="${esc(travelImageUrl(g.cover,1280))}"`} alt="${esc(g.destination)}攻略封面"><div class="detail-layout"><article><header class="article-header">${g.sample?'<span class="sample-note">示例攻略 · 可登录后编辑为自己的旅行记录</span>':''}<h1>${esc(g.title)}</h1><p class="summary">${esc(g.summary)}</p><div class="article-meta"><span>${icon('pin')} ${esc(g.country)} · ${esc(g.destination)}</span><span>${date(g.updated_at)} 更新</span>${state.admin?`<span class="status-badge ${g.status}">${statusName[g.status]}${g.deleted_at?' · 已删除':''}</span>`:''}</div></header><div class="prose">${PublicImages.prepareHTML(g.html||'<p>这篇攻略还在慢慢整理中。</p>')}</div>${g.sources?`<section class="source-box"><h3>参考资料与来源</h3>${esc(g.sources)}</section>`:''}</article><aside class="detail-aside"><h3>这段旅程，一眼看懂</h3>${[['clock','建议天数',`${g.days} 天`],['sun','适合季节',g.season||'尚未填写'],['money','人均预算',g.budget||'尚未填写'],['map','目的地',g.destination],['book','最后核实',g.verified_at||'出发前记得核实']].map(([i,l,v])=>`<div class="info-row">${icon(i)}<span><small>${l}</small><strong>${esc(v)}</strong></span></div>`).join('')}<div class="aside-tags">${guideTopics(g).map(t=>`<button class="chip" data-action="tag" data-value="${esc(t)}"># ${esc(t)}</button>`).join('')}</div></aside></div>`;
  JourneyView.mount($('#app'),g);
  const sections=[...document.querySelectorAll('.prose h2')];
  if(sections.length>=8){
    const nav=document.createElement('nav');nav.className='article-jump';nav.setAttribute('aria-label','攻略目录');
    nav.innerHTML='<strong>跳到想看的内容</strong><div>'+sections.map((h,i)=>`<button type="button" data-section="${i}">${esc(h.textContent)}</button>`).join('')+'</div>';
    nav.addEventListener('click',event=>{const button=event.target.closest('button[data-section]');if(button)sections[Number(button.dataset.section)].scrollIntoView({behavior:'smooth',block:'start'});});
    document.querySelector('.article-header').after(nav);
  }
  if(saved){
    const notice=document.createElement('div');notice.className='pwa-snapshot';notice.innerHTML=`<strong>离线保存版</strong><span>${esc(new Date(savedEntry.savedAt).toLocaleString('zh-CN'))} 保存${savedEntry.missing?' · 部分图片未保存':''}</span><a href="#guide/${g.id}">联网查看最新攻略 →</a>`;$('.article-header').before(notice);
  }else{void TravelPWA.attachGuide(g);Footprints.related(g.id,generation);}
  const jump=location.hash.split('/')[2];
  if(/^day-\d+$/.test(jump||'')){
    const day=Number(jump.slice(4));
    const number=word=>{if(/^\d+$/.test(word))return Number(word);let value=0,digit=0;for(const c of word){if(c==='十'||c==='百'){value+=(digit||1)*(c==='十'?10:100);digit=0;}else digit='零一二三四五六七八九'.indexOf(c);}return value+digit;};
    const match=[...document.querySelectorAll('.prose h2,.prose h3')].find(h=>{const m=h.textContent.match(/第\s*([零一二三四五六七八九十百\d]+)\s*天|(?:Day\s*|D)(\d+)(?!\d)/i);return m&&number(m[1]||m[2])===day;});
    if(match)requestAnimationFrame(()=>{if(state.load===generation)match.scrollIntoView();});
  }

}
function clearFilters(){state.query='';state.country='';state.destination='';state.tag='';state.status='';}
// Keep the optional calculator out of the reading path. The inert template also
// lets the existing PWA precache these exact versioned URLs for offline use.
const splitAssets=new Map();
function loadSplitAsset(source){
  const url=source.src||source.href;
  if(splitAssets.has(url))return splitAssets.get(url);
  const node=document.createElement(source.tagName),pending=new Promise((resolve,reject)=>{
    node.onload=resolve;
    node.onerror=()=>{node.remove();splitAssets.delete(url);reject(Error('费用分摊组件暂时无法加载，请重试。'));};
  });
  splitAssets.set(url,pending);
  if(source.tagName==='SCRIPT'){node.src=url;node.async=false;}else{node.rel='stylesheet';node.href=url;}
  document.head.append(node);return pending;
}
async function openSplit(generation){
  updateShell('split');
  const assets=$('#split-assets').content;
  let timer;
  const ready=Promise.all([
    loadSplitAsset(assets.querySelector('link')),
    (async()=>{for(const script of assets.querySelectorAll('script'))await loadSplitAsset(script);})()
  ]);
  // A timed out request remains shared until it settles, avoiding duplicate
  // script execution if the connection recovers after the user clicks retry.
  try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('费用分摊加载超时，请检查网络后重试。')),15000);})]);}
  finally{clearTimeout(timer);}
  if(generation===state.load)TravelSplit.mount();
}
document.addEventListener('click',async event=>{
  if(event.target.closest('.skip-link')){event.preventDefault();$('#app').focus();return;}
  const node=event.target.closest('[data-action]');if(!node)return;const action=node.dataset.action,value=node.dataset.value;
  try{
    if(action==='retry-page')await route();
    if(action==='login')location.href='/admin';
    if(action==='country'){state.country=value;guidesHome();}
    if(action==='status'){state.status=value;guidesHome();}
    if(action==='clear'){clearFilters();guidesHome();}
    if(action==='destination'||action==='tag'){clearFilters();state[action]=value;location.hash='guides';guidesHome();window.scrollTo(0,0);}
  }catch(error){toast(error.message,true);}
});
async function route(){
  let hash=location.hash.slice(1)||'home';
  // Keep old bookmarks usable without retaining a separate tag catalogue.
  if(hash==='tags'){hash='guides';clearFilters();history.replaceState(null,'','#guides');}
  if(!adminPreview&&!navigator.onLine&&!hash.startsWith('offline')&&hash!=='split'){
    const guideId=hash.match(/^guide\/(\d+)/)?.[1];let hasSaved=false;try{hasSaved=guideId&&await TravelPWA.has(guideId);}catch{}
    hash=hasSaved?'offline/'+guideId:'offline';history.replaceState(null,'','#'+hash);
  }
  if(/^(edit|new|trash)(\/|$)/.test(hash)){location.href='/admin#'+hash;return;}
  JourneyView.dispose($('#app'));cancelPublicReads();PublicImages.pause();TravelPWA.release();state.route=hash;const generation=++state.load;const [view,id]=hash.split('/');document.title=(state.site?.site_name||'行笺')+' · 攻略与旅行足迹';
  if(['guide','record'].includes(view)&&!/^\d+$/.test(id||'')){location.hash='home';return;}
  const app=$('#app'),previous=app.firstChild;app.inert=true;app.setAttribute('aria-busy','true');const loading=setTimeout(()=>{if(state.load===generation&&app.firstChild===previous)app.innerHTML='<div class="loading">正在整理你的旅行灵感…</div>';},120);
  try{if(view==='split')await openSplit(generation);else if(view==='offline'){if(id&&/^\d+$/.test(id))await detail(id,generation,true);else await TravelPWA.list(generation);}else if(view==='guides')guidesHome();else if(view==='footprints')await Footprints.list(generation,id||'');else if(view==='record')await Footprints.detail(id,generation);else if(view==='autumn')autumn();else if(view==='destinations')destinations();else if(view==='guide')await detail(id,generation);else home();if(state.load===generation)window.scrollTo(0,0);}catch(error){if(state.load!==generation||error.name==='AbortError')return;$('#app').innerHTML=empty('这段旅程暂时无法打开',esc(error.message),'<button class="button secondary" data-action="retry-page">重新加载</button> <a class="button secondary" href="#offline">查看已保存攻略</a>');}finally{clearTimeout(loading);if(state.load===generation){app.inert=false;app.removeAttribute('aria-busy');PublicImages.resume();}}
}
const moreMenu=$('#site-more');
// Installation can change without a page reload; keep the current content intact.
function syncDisplayMode(){moreMenu.open=false;if(state.site)updateShell(document.body.dataset.view||'home');}
matchMedia('(display-mode: standalone)').addEventListener('change',syncDisplayMode);
window.addEventListener('pageshow',syncDisplayMode);
document.addEventListener('click',event=>{if(moreMenu.open&&(!moreMenu.contains(event.target)||event.target.closest('a,button')))moreMenu.open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&moreMenu.open){moreMenu.open=false;$('summary',moreMenu).focus();}});
window.addEventListener('hashchange',()=>{moreMenu.open=false;route();});
window.addEventListener('online',()=>{if(state.bootstrapOffline)void init();});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='k'&&$('#search')){event.preventDefault();$('#search').focus();}});
async function init(){
  TravelPWA.start();
  $('#today').textContent=new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
  if(location.hash==='#split'){state.site=state.site||{site_name:'行笺'};await route();}
  try{const bootstrap=await api('/bootstrap');state.bootstrapOffline=false;state.site=bootstrap.site;const brand=$('.brand>span:last-child');brand.innerHTML=esc(state.site.site_name)+'<small>旅行攻略 · 旅途手记</small>';$('.footer>span:first-child').textContent=state.site.site_name+' · '+state.site.footer;$('meta[name=description]').content=state.site.tagline;const session=bootstrap.session;state.admin=session.authenticated;state.csrf=session.csrf;state.guides=bootstrap.guides;state.records=bootstrap.records||[];state.recordCount=bootstrap.record_count||0;Footprints.seed(bootstrap.record_page);if(location.hash==='#split'&&$('#split-form'))updateShell('split');else await route();}catch(error){
    if(location.hash==='#split'){state.bootstrapOffline=true;return;}
    if(!adminPreview&&TravelPWA.supported){
      state.bootstrapOffline=true;state.admin=false;state.csrf='';state.guides=[];state.records=[];state.site={site_name:'行笺'};
      const id=location.hash.match(/^#guide\/(\d+)/)?.[1];let saved=false;try{saved=id&&await TravelPWA.has(id);}catch{}
      if(!location.hash.startsWith('#offline'))history.replaceState(null,'',saved?'#offline/'+id:'#offline');
      await route();toast('暂时无法连接网站，可以查看已保存的攻略。');
    }else{$('#app').innerHTML=empty('暂时无法连接旅行空间',esc(error.message),'<button class="button secondary" id="retry">重新连接</button>');$('#retry').onclick=init;}
  }
}
init();
