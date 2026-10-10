/* Private journeys: ordinary APIs handle viewing, adoption and preparation. */
const Trips=(()=>{
 const phases={upcoming:'待出发',travelling:'旅行中',completed:'已归来',archived:'已归档'};
 const periods=['上午','下午','晚上'];
 let epoch=0,busy=false,current=null,selectedDay=1,source=null,targets=[],targetPage=1,targetPages=1;
 const dirtyForms=new Set();
 const here=token=>token===epoch&&state.user;
 const path=id=>'/admin/trips'+(id?'/'+id:'');
 const range=t=>t.start_date+' — '+t.end_date;
 const mark=form=>{dirtyForms.add(form.id);state.dirty=true;};
 const clean=form=>{dirtyForms.delete(form.id);state.dirty=dirtyForms.size>0;};
 const input=(name,label,value='',extra='')=>`<label>${esc(label)}<input name='${name}' value='${esc(value)}' ${extra}></label>`;
 const area=(name,label,value='',max=2000)=>`<label>${esc(label)}<textarea name='${name}' rows='3' maxlength='${max}'>${esc(value)}</textarea></label>`;
 const addDays=(value,count)=>{if(!value)return '';const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+count);return d.toISOString().slice(0,10);};
 const key=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
 function freeze(form){const saved=[...form.elements].map(n=>[n,n.disabled]);form.inert=true;for(const [n]of saved)n.disabled=true;return()=>{form.inert=false;for(const [n,disabled]of saved)n.disabled=disabled;};}
 function stop(){epoch++;current=null;source=null;targets=[];dirtyForms.clear();$('#main')?.removeEventListener('click',click);$('#main')?.removeEventListener('change',change);$('#main')?.removeEventListener('input',inputChanged);$('#main')?.removeEventListener('submit',submit);}
 function bind(){$('#main').addEventListener('click',click);$('#main').addEventListener('change',change);$('#main').addEventListener('input',inputChanged);$('#main').addEventListener('submit',submit);}
 function inputChanged(event){const form=event.target.closest('form[data-trip-form]');if(form)mark(form);}
 function homeCard(t){
  if(!t)return `<section class='panel trip-focus'><span class='trip-label'>我的旅行 · 仅管理员可见</span><h2>把想去的地方，安排成一次出发。</h2><p>先让助手规划，选好方案后带入一趟旅行；准备事项和当天安排都在这里。</p><div class='actions'><a class='button primary' href='#travel-agent'>让助手规划</a><a class='button secondary' href='#trip-new'>安排一趟旅行</a><a class='button small' href='#trips'>查看我的旅行</a></div></section>`;
  return `<section class='panel trip-focus'><div class='panel-top'><span class='trip-label'>我的旅行 · ${esc(phases[t.phase])}</span><a class='button small' href='#trips'>全部旅行 →</a></div><h2><a href='#trip/${t.id}'>${esc(t.title)}</a></h2><p>${esc(range(t))} · ${t.people} 人 · ${t.phase==='travelling'?'今天是第 '+t.today_day+' 天':'还有 '+t.countdown+' 天出发'}</p><p class='help'>${t.plan_version?'已采用第 '+t.plan_version+' 版计划':'尚未采用计划'} · 准备事项 ${t.checklist_done||0} / ${t.checklist_total||0} 完成</p><div class='actions'><a class='button primary' href='#trip/${t.id}/${t.phase==='travelling'?'today':'prepare'}'>${t.phase==='travelling'?'打开今日行程':'继续出发准备'}</a><a class='button secondary' href='#trip/${t.id}/plan'>查看旅行计划</a></div></section>`;
 }
 async function list(gen){
  stop();const token=epoch,query=new URLSearchParams(location.hash.split('?')[1]||'');
  const data=await api(path()+'?'+query);if(!here(token)||gen!==state.generation)return;
  $('#main').innerHTML=heading('我的旅行','一次真实出行，把计划、准备事项和每天的安排放在一起。','<a class="button primary" href="#trip-new">安排一趟旅行</a>')+homeCard(data.focus)+`<section class='panel'><form id='trip-filter'><div class='trip-fields'>${input('q','搜索旅行',query.get('q')||'',"maxlength='120' placeholder='目的地或旅行名称'")}<label>显示范围<select name='state'><option value=''>全部旅行</option><option value='active' ${query.get('state')==='active'?'selected':''}>未归档</option><option value='archived' ${query.get('state')==='archived'?'selected':''}>已归档</option></select></label></div><button class='button secondary' type='submit'>筛选</button></form></section><section class='trip-grid'>${data.trips.map(t=>`<article class='panel trip-card'><div class='panel-top'><span class='badge'>${esc(phases[t.phase])}</span><span class='help'>${t.days} 天 · ${t.people} 人</span></div><h2><a href='#trip/${t.id}'>${esc(t.title)}</a></h2><p>${esc(t.destination)}</p><p class='help'>${esc(range(t))} · ${t.plan_version?'第 '+t.plan_version+' 版计划':'待安排行程'}</p><a class='button secondary' href='#trip/${t.id}'>打开这趟旅行 →</a></article>`).join('')||empty('还没有这趟旅行','可以从旅游助手采用方案，也可以先填写日期再安排。')}</section>${data.pages>1?`<div class='pagination'><button class='button small' data-trip='page' data-page='${data.page-1}' ${data.page===1?'disabled':''}>上一页</button><span>${data.page} / ${data.pages}</span><button class='button small' data-trip='page' data-page='${data.page+1}' ${data.page===data.pages?'disabled':''}>下一页</button></div>`:''}`;
  bind();
 }
 function sourceQuery(parts){const [kind,id,destination]=parts;const query=new URLSearchParams();if(kind==='task')query.set('task_id',id);else if(kind==='guide')query.set('guide_id',id);else return null;if(destination)query.set('destination',decodeURIComponent(destination));return query;}
 async function create(gen,parts=[]){
  stop();const token=epoch,query=sourceQuery(parts);let preferences={};targets=[];targetPage=1;targetPages=1;
  if(query){
   const [preview,data,saved]=await Promise.all([api(path()+'/source?'+query),api(path()+'?state=active'),api('/admin/travel-agent/preferences')]);if(!here(token)||gen!==state.generation)return;
   source=preview;targets=data.trips;targetPages=data.pages;preferences={...(saved.preferences||{}),...(preview.plan.conditions||{})};
  }else{
   const data=await api('/admin/travel-agent/preferences');if(!here(token)||gen!==state.generation)return;preferences=data.preferences||{};
  }
  const plan=source?.plan,days=plan?.days||4;
  const dates=(preferences.dates||'').match(/\d{4}-\d{2}-\d{2}/g)||[];
  const start=dates[0]||'',end=start?addDays(start,days-1):'';
  $('#main').innerHTML=heading(plan?'把这份方案，带入一次出发。':'安排一趟旅行','只有管理员可操作。采用计划和公开发布是独立的操作。','<a class="button secondary" href="#trips">返回我的旅行</a>')+
   (plan?`<section class='panel'><span class='trip-label'>采用方案 · ${esc(plan.destination)}</span><h2>${esc(plan.title)}</h2><p>${esc(plan.summary||'')}</p><p class='help'>${days} 天 · ${esc(plan.conditions?.people?plan.conditions.people+' 人的参考方案':'请确认本次人数')} · ${esc(plan.budget||'预算待核实')}</p>${!plan.itinerary.some(d=>d.stops.length||d.slots.some(s=>s.plan))?'<p class="help">来源攻略还没有可识别的每日安排；完整正文会保留，采用后可在“今日行程”补充。</p>':''}<div class='trip-preview-route'>${plan.itinerary.map(d=>`<p><strong>D${d.day} ${esc(d.theme)}</strong><span>${d.stops.map(esc).join(' → ')||'每日路线可稍后补充'}</span></p>`).join('')}</div></section>`:'')+
   `<section class='panel'><form id='trip-create-form' data-trip-form data-days='${days}' data-key='${key()}'>${plan?`<label>采用方式<select name='target'><option value=''>创建一趟新旅行</option>${targetOptions(days)}</select></label><div class='actions'><button class='button small' type='button' data-trip='more-targets' ${targetPages<=1?'hidden':''}>加载更多已有旅行</button></div><p id='trip-target-note' class='help'>创建新旅行时填写日期；采用到已有旅行时，保留已有的日期、人数、备注和准备事项。</p>`:''}<div id='trip-create-meta'><div class='trip-fields'>${input('destination','目的地',plan?.destination||'',`required maxlength='80' ${plan?'readonly':''}`)}${input('people','同行人数',preferences.people??1,"type='number' min='1' max='50' required")}${input('start_date','出发日期',start,"type='date' required")}${input('end_date','返回日期',end,"type='date' required")}</div><p class='help'>${plan?'方案共 '+days+' 天，选择出发日期后自动填入返回日期；请核对实际交通日期。':'选择出发日期后暂按四天安排，返回日期可以修改。'}</p><details class='trip-more'><summary>旅行名称和同行情况（选填）</summary>${input('title','旅行名称','','maxlength=100')}${area('companions','同行情况',preferences.companions||'',300)}</details></div><div class='actions'><button class='button primary' type='submit'>${plan?'确认采用方案':'保存这趟旅行'}</button>${!plan?'<a class="button secondary" href="#travel-agent">先让助手规划</a>':''}</div><p class='form-error' id='trip-create-error' role='alert'></p></form></section>`;
  bind();
 }
 function targetOptions(days){return targets.map(t=>`<option value='${t.id}' ${t.days!==days?'disabled':''}>${esc(t.title)} · ${t.days} 天${t.days!==days?'（天数不同）':''}</option>`).join('');}
 function fromTask(task){
  const names=task.destinations?.length?task.destinations:[task.guide.destination];
  if(names.length===1){location.hash='trip-new/task/'+task.id+'/'+encodeURIComponent(names[0]);return;}
  showDialog(`<h2>选择这次想去的目的地</h2><p class='help'>采用其中一个完整方案，用于实际出行；其他候选攻略继续保留。</p><div class='trip-choice'>${names.map(name=>`<a class='button secondary' href='#trip-new/task/${task.id}/${encodeURIComponent(name)}' data-action='close-dialog'>${esc(name)} →</a>`).join('')}</div>`);
 }
 async function detail(gen,id,tab){
  stop();const token=epoch;if(!Number.isSafeInteger(Number(id))||Number(id)<1)throw Error('旅行编号不正确');
  const data=await api(path(id));if(!here(token)||gen!==state.generation)return;
  current=data;current.tab=['prepare','today','plan'].includes(tab)?tab:current.trip.phase==='travelling'?'today':'prepare';selectedDay=current.trip.today_day||1;
  render();bind();
 }
 function render(){
  const t=current.trip,p=current.plan;
  $('#main').innerHTML=heading(t.title,`${t.destination} · ${range(t)} · ${t.people} 人 · ${phases[t.phase]} · 仅管理员可见`,'<a class="button secondary" href="#trips">返回我的旅行</a>')+
   `<nav class='trip-tabs' aria-label='这趟旅行'><a href='#trip/${t.id}/prepare' ${current.tab==='prepare'?"aria-current='page'":''}>出发准备</a><a href='#trip/${t.id}/today' ${current.tab==='today'?"aria-current='page'":''}>今日行程</a><a href='#trip/${t.id}/plan' ${current.tab==='plan'?"aria-current='page'":''}>全部计划</a></nav><p class='trip-plan-status' id='trip-plan-status'>${p?'已采用第 '+p.version+' 版计划':'尚未采用计划，可先填写日程或从助手采用方案。'}</p><div id='trip-body'>${current.tab==='prepare'?prepare():current.tab==='today'?todayView():planView()}</div><p class='form-error' id='trip-error' role='alert'></p>`;
 }
 function metaForm(){const t=current.trip;return `<details class='trip-more panel'><summary>旅行资料与交通、住宿备忘</summary><form id='trip-meta-form' data-trip-form><div class='trip-fields'>${input('title','旅行名称',t.title,"required maxlength='100'")}${input('destination','目的地',t.destination,`required maxlength='80' ${current.plan?'readonly':''}`)}${input('start_date','出发日期',t.start_date,"type='date' required")}${input('end_date','返回日期',t.end_date,"type='date' required")}${input('people','同行人数',t.people,"type='number' min='1' max='50' required")}${input('companions','同行情况',t.companions,"maxlength='300'")}</div>${area('transport','实际交通备忘',t.transport)}${area('lodging','实际住宿备忘',t.lodging)}${area('notes','其他备忘',t.notes,4000)}<button class='button primary' type='submit'>保存旅行资料</button><p class='form-error' id='trip-meta-error' role='alert'></p></form></details>`;}
 function checks(){
  const t=current.trip,version=current.plan?.version;
  return ['prepare','reservation','packing'].map(kind=>{const items=t.checklist.filter(c=>c.kind===kind);return `<section class='panel trip-check-group'><div class='panel-top'><h2>${({prepare:'交通住宿与出发确认',reservation:'预约事项',packing:'行李清单'})[kind]}</h2><span class='help'>${items.filter(c=>c.done).length} / ${items.length}</span></div>${items.map(item=>`<div class='trip-check ${item.done?'is-done':''}' data-check-id='${esc(item.id)}'><label><input type='checkbox' data-trip-check='${esc(item.id)}' ${item.done?'checked':''}><span><strong>${esc(item.title)}</strong>${item.note?`<small>${esc(item.note)}</small>`:''}${item.plan_version&&item.plan_version!==version?'<small class="trip-old-note">来自旧方案，请核对是否仍适用</small>':''}</span></label><div class='trip-check-actions'><button type='button' class='button small' data-trip='edit-check' data-id='${esc(item.id)}'>编辑</button><button type='button' class='button small' data-trip='remove-check' data-id='${esc(item.id)}'>移除</button></div></div>`).join('')||'<p class="help">暂未列出需要预约的项目，可按实际安排补充。</p>'}</section>`;}).join('');
 }
 function prepare(){const t=current.trip;return `<section class='panel trip-readiness'><div><span class='trip-label'>${esc(phases[t.phase])}</span><h2>${t.phase==='upcoming'?'还有 '+t.countdown+' 天出发':t.phase==='travelling'?'旅行第 '+t.today_day+' 天':'回看这趟旅行的准备'}</h2><p class='help'>方案中的预约提醒会整理成待办，是否已预约由你确认。勾选后即时保存。</p></div><a class='button secondary' href='#trip/${t.id}/today'>查看当天安排 →</a></section>${metaForm()}<div id='trip-checks'>${checks()}</div><section class='panel'><h2>补充一件准备事项</h2><form id='trip-check-add' data-trip-form><div class='trip-fields'>${input('title','事项名称','','required maxlength=200')}<label>分类<select name='kind'><option value='prepare'>出发确认</option><option value='reservation'>预约</option><option value='packing'>行李</option></select></label></div>${input('note','备注（选填）','','maxlength=500')}<button class='button secondary' type='submit'>添加事项</button><p class='form-error' id='trip-check-add-error' role='alert'></p></form></section>`;}
 function blankDays(){const t=current.trip;return Array.from({length:t.days},(_,i)=>({day:i+1,destination:t.destination,theme:'待安排',stops:[],transport:'',lunch:'',dinner:'',stay:'',pace:'',slots:periods.map(period=>({period,plan:'',transport:'',reservation:''}))}));}
 function itinerary(){return current.plan?.snapshot.itinerary||blankDays();}
 function mapLink(stop,day){const country=current.plan?.snapshot.country||'';if(country&&country!=='中国'&&country!=='China')return 'https://www.google.com/maps/search/?'+new URLSearchParams({api:'1',query:day.destination+' '+stop});return 'https://uri.amap.com/search?'+new URLSearchParams({keyword:stop,city:day.destination,src:'travel-notes',callnative:'1'});}
 function dayRead(day,progress=false){
  const t=current.trip,p=current.plan,version=p?.version;
  return `<section class='panel trip-day-read'><div class='panel-top'><div><span class='trip-label'>D${day.day} · ${esc(addDays(t.start_date,day.day-1))}</span><h2>${esc(day.theme||'待安排')}</h2></div>${progress?`<button class='button small' type='button' data-trip='edit-day' data-day='${day.day}'>调整这一天</button>`:''}</div>${day.stops.length?`<ol class='trip-stops'>${day.stops.map((stop,index)=>{const saved=t.progress[version+':'+day.day+':'+index]||'';return `<li><div class='trip-stop-main'><strong>${esc(stop)}</strong><a class='button small' href='${esc(mapLink(stop,day))}' target='_blank' rel='noopener noreferrer'>地图导航 ↗</a></div>${progress?`<div class='trip-progress' data-stop-index='${index}'><button class='button small ${saved==='done'?'is-selected':''}' data-trip='progress' data-day='${day.day}' data-index='${index}' data-status='${saved==='done'?'':'done'}' ${!p?'disabled':''}>${saved==='done'?'✓ 已去':'已去'}</button><button class='button small ${saved==='skipped'?'is-selected':''}' data-trip='progress' data-day='${day.day}' data-index='${index}' data-status='${saved==='skipped'?'':'skipped'}' ${!p?'disabled':''}>${saved==='skipped'?'已跳过':'跳过'}</button></div>`:''}</li>`;}).join('')}</ol>`:'<p class="help">路线还没填，可以先采用攻略，或点“调整这一天”补充。</p>'}<div class='trip-slots'>${day.slots.map(slot=>`<article><span class='trip-label'>${esc(slot.period)}</span><p>${esc(slot.plan||'待安排')}</p>${slot.transport?`<p class='help'>交通：${esc(slot.transport)}</p>`:''}${slot.reservation?`<p class='trip-reservation'>预约／提醒：${esc(slot.reservation)}</p>`:''}</article>`).join('')}</div><div class='trip-meal-notes'><p><strong>午餐</strong>${esc(day.lunch||'待定')}</p><p><strong>晚餐</strong>${esc(day.dinner||'待定')}</p></div>${day.transport?`<p class='help'>怎么走：${esc(day.transport)}</p>`:''}${day.stay?`<p class='help'>住宿／返程：${esc(day.stay)}</p>`:''}${day.pace?`<p class='help'>体力与节奏：${esc(day.pace)}</p>`:''}</section>`;
 }
 function todayView(){const t=current.trip,days=itinerary();selectedDay=Math.min(Math.max(1,selectedDay),days.length);const day=days[selectedDay-1];return `<section class='panel trip-today-top'><label>选择旅行日<select id='trip-day-select'>${days.map(d=>`<option value='${d.day}' ${d.day===selectedDay?'selected':''}>第 ${d.day} 天 · ${esc(addDays(t.start_date,d.day-1))}${d.day===t.today_day?' · 今天':''}</option>`).join('')}</select></label><p class='help'>${t.phase==='travelling'?'默认显示本次旅行的今天，也可以提前查看其他日期。':t.phase==='upcoming'?'还未出发，当前是行程预览。':'旅行已结束，可以回看每天的安排。'}</p></section><div id='trip-today-content'>${dayRead(day,true)}</div><div id='trip-day-edit'></div>${t.transport||t.lodging?`<section class='panel'><h2>实际交通与住宿备忘</h2>${t.transport?`<p class='trip-text'>${esc(t.transport)}</p>`:''}${t.lodging?`<p class='trip-text'>${esc(t.lodging)}</p>`:''}</section>`:''}`;}
 function planView(){const t=current.trip,p=current.plan;return `<section class='panel'><div class='panel-top'><h2>${p?'第 '+p.version+' 版旅行计划':'开始安排每天怎么走'}</h2><a class='button small' href='#travel-agent'>让旅游助手规划</a></div>${p?`<p>${esc(p.snapshot.summary||'')}</p><p class='help'>${esc(p.snapshot.budget||'预算待核实')} · ${esc(p.snapshot.conditions?.people&&p.snapshot.conditions.people!==t.people?'原参考方案按 '+p.snapshot.conditions.people+' 人规划，当前 '+t.people+' 人，请重新核算人数相关费用。':'')}</p>`:'<p class="help">可以从旅游助手结果采用，也可以在“今日行程”手动填写。已有攻略的编辑页也提供“安排出行”。</p>'}<div class='actions'>${p?`<button class='button secondary' type='button' data-trip='reference'>查看采用时的参考攻略</button>`:''}<button class='button small' type='button' data-trip='archive'>${t.state==='archived'?'取消归档':'归档这趟旅行'}</button></div><p class='help'>每天的实际安排以当前计划为准；参考攻略保留采用时的内容。</p></section>${itinerary().map(d=>dayRead(d)).join('')}${current.versions.length?`<section class='panel'><h2>计划版本</h2><p class='help'>调整或再次采用会生成新版本，准备事项和交通、住宿备忘保留。</p><div class='trip-versions'>${current.versions.map(v=>`<div><span>第 ${v.version} 版 · ${esc(v.label)}<small>${date(v.created_at)}</small></span><button class='button small' type='button' data-trip='version' data-version='${v.version}'>查看</button>${v.version!==p.version?`<button class='button small' type='button' data-trip='restore' data-version='${v.version}'>恢复为当前计划</button>`:''}</div>`).join('')}</div></section>`:''}<div id='trip-reference'></div>`;}
 function dayEditor(day){return `<section class='panel'><div class='panel-top'><h2>调整第 ${day.day} 天</h2><button class='button small' type='button' data-trip='cancel-day'>收起</button></div><form id='trip-day-form' data-trip-form data-day='${day.day}'>${input('theme','当天主题',day.theme,'maxlength=100')}${area('stops','路线地点（每行一个）',day.stops.join('\n'),2500)}${day.slots.map((slot,index)=>`<details class='trip-more' open><summary>${esc(slot.period)}</summary>${area('plan'+index,'游玩安排',slot.plan,1000)}${input('transport'+index,'交通与耗时',slot.transport,'maxlength=1000')}${input('reservation'+index,'预约提醒',slot.reservation,'maxlength=1000')}</details>`).join('')}<div class='trip-fields'>${input('lunch','午餐',day.lunch,'maxlength=500')}${input('dinner','晚餐',day.dinner,'maxlength=500')}${input('stay','住宿／返程',day.stay,'maxlength=500')}${input('pace','体力与节奏',day.pace,'maxlength=500')}</div>${input('transport','当天交通',day.transport,'maxlength=1000')}<button class='button primary' type='submit'>保存为新计划版本</button><p class='form-error' id='trip-day-error' role='alert'></p></form></section>`;}
 async function write(url,body,form,errorId,success){
  if(busy)return;busy=true;const token=epoch,release=form?freeze(form):()=>{};
  if(errorId&&$('#'+errorId))$('#'+errorId).textContent='';
  try{const answer=await api(url,{method:'POST',body});if(!here(token))return;await success(answer);}
  catch(error){if(here(token)){if(errorId&&$('#'+errorId))$('#'+errorId).textContent=error.message;toast(error.message,true);throw error;}}
  finally{release();busy=false;}
 }
 async function checkMutation(body){return write(path(current.trip.id)+'/checklist',{revision:current.trip.revision,...body},null,'trip-error',answer=>{current.trip.revision=answer.revision;current.trip.checklist=answer.checklist;$('#trip-checks').innerHTML=checks();toast('准备事项已保存');});}
 async function change(event){
  const node=event.target;
  try{
   if(node.dataset.tripCheck){const item=current.trip.checklist.find(c=>c.id===node.dataset.tripCheck);const prior=item.done;if(busy){node.checked=prior;return;}try{await checkMutation({action:'update',id:item.id,done:node.checked});}catch{node.checked=prior;}return;}
   if(node.id==='trip-day-select'){
    if(dirtyForms.has('trip-day-form')&&!confirm('当天安排尚未保存，切换日期会丢失修改。继续？')){node.value=selectedDay;return;}
    dirtyForms.delete('trip-day-form');state.dirty=dirtyForms.size>0;selectedDay=Number(node.value);$('#trip-today-content').innerHTML=dayRead(itinerary()[selectedDay-1],true);$('#trip-day-edit').innerHTML='';return;
   }
   if(node.name==='target'&&node.closest('#trip-create-form')){const existing=targets.find(t=>t.id===Number(node.value));$('#trip-create-meta').hidden=!!existing;for(const field of $('#trip-create-meta').querySelectorAll('input,textarea'))field.disabled=!!existing;$('#trip-target-note').textContent=existing?`采用到「${existing.title}」，保留 ${range(existing)}、${existing.people} 人及现有准备事项。`:'创建新旅行时填写日期；采用到已有旅行时保留原日期、人数和备忘。';mark(node.form);return;}
   if(node.name==='start_date'&&node.closest('form[data-trip-form]')){const form=node.form,days=form.id==='trip-create-form'?Number(form.dataset.days):current.trip.days;if(node.value)form.elements.end_date.value=addDays(node.value,days-1);}
  }catch(error){toast(error.message,true);}
 }
 async function submit(event){
  const form=event.target;if(!form.matches('form[data-trip-form],#trip-filter'))return;event.preventDefault();event.stopImmediatePropagation();if(busy||!form.reportValidity())return;
  const data=Object.fromEntries(new FormData(form));
  if(form.id==='trip-filter'){location.hash='trips?'+new URLSearchParams(data);return;}
  try{
   if(form.id==='trip-create-form'){
    const target=targets.find(t=>t.id===Number(data.target));
    if(target)await write(path(target.id)+'/plan',{revision:target.revision,source:source.source},form,'trip-create-error',()=>{clean(form);location.hash='trip/'+target.id+'/prepare';toast('方案已采用，已有备忘和准备事项保留');});
    else await write(path(),{...data,people:Number(data.people),request_key:form.dataset.key,...(source?{source:source.source}:{})},form,'trip-create-error',answer=>{clean(form);location.hash='trip/'+answer.id+'/prepare';toast('这趟旅行已保存');});
   }
   if(form.id==='trip-meta-form'){
    busy=true;const token=epoch,release=freeze(form);$('#trip-meta-error').textContent='';
    try{const answer=await api(path(current.trip.id),{method:'PUT',body:{...data,people:Number(data.people),revision:current.trip.revision}});if(here(token)){Object.assign(current.trip,answer.trip);clean(form);const header=$('#main .page-heading');header.querySelector('h1').textContent=current.trip.title;header.querySelector('p').textContent=current.trip.destination+' · '+range(current.trip)+' · '+current.trip.people+' 人 · '+phases[current.trip.phase]+' · 仅管理员可见';const ready=$('.trip-readiness h2');if(ready)ready.textContent=current.trip.phase==='upcoming'?'还有 '+current.trip.countdown+' 天出发':current.trip.phase==='travelling'?'旅行第 '+current.trip.today_day+' 天':'回看这趟旅行的准备';toast('旅行资料已保存');}}
    catch(error){if(here(token)){$('#trip-meta-error').textContent=error.message;toast(error.message,true);}}
    finally{release();busy=false;}
   }
   if(form.id==='trip-check-add')await write(path(current.trip.id)+'/checklist',{...data,action:'add',revision:current.trip.revision},form,'trip-check-add-error',answer=>{current.trip.revision=answer.revision;current.trip.checklist=answer.checklist;$('#trip-checks').innerHTML=checks();form.reset();clean(form);toast('准备事项已添加');});
   if(form.id==='trip-day-form'){
    const days=cloneAdminData(itinerary()),day=days[Number(form.dataset.day)-1];
    Object.assign(day,{...Object.fromEntries(['theme','transport','lunch','dinner','stay','pace'].map(k=>[k,data[k]])),stops:data.stops.split('\n').map(s=>s.trim()).filter(Boolean),slots:periods.map((period,i)=>({period,plan:data['plan'+i],transport:data['transport'+i],reservation:data['reservation'+i]}))});
    await write(path(current.trip.id)+'/plan',{revision:current.trip.revision,itinerary:days},form,'trip-day-error',async()=>{clean(form);const fresh=await api(path(current.trip.id));current=fresh;current.tab='today';render();toast('已保存新计划版本，准备事项和备忘保留');});
   }
  }catch{/* Inline error keeps the form and input intact. */}
 }
 async function click(event){
  const node=event.target.closest('[data-trip]');if(!node||busy)return;const action=node.dataset.trip;
  try{
   if(action==='page'){const query=new URLSearchParams(location.hash.split('?')[1]||'');query.set('page',node.dataset.page);location.hash='trips?'+query;}
   if(action==='more-targets'){const token=epoch,data=await api(path()+'?state=active&page='+(targetPage+1));if(!here(token))return;targets.push(...data.trips);targetPage=data.page;targetPages=data.pages;const select=$('#trip-create-form [name=target]'),value=select.value;select.innerHTML='<option value="">创建一趟新旅行</option>'+targetOptions(source.plan.days);select.value=value;node.hidden=targetPage>=targetPages;}
   if(action==='edit-day'){
    if(dirtyForms.has('trip-day-form')&&!confirm('替换当前未保存的日程修改？'))return;
    dirtyForms.delete('trip-day-form');state.dirty=dirtyForms.size>0;$('#trip-day-edit').innerHTML=dayEditor(itinerary()[Number(node.dataset.day)-1]);$('#trip-day-edit').scrollIntoView({behavior:'smooth',block:'start'});
   }
   if(action==='cancel-day'){if(dirtyForms.has('trip-day-form')&&!confirm('放弃这次尚未保存的修改？'))return;dirtyForms.delete('trip-day-form');state.dirty=dirtyForms.size>0;$('#trip-day-edit').innerHTML='';}
   if(action==='progress')await write(path(current.trip.id)+'/progress',{revision:current.trip.revision,plan_version:current.plan.version,day:Number(node.dataset.day),index:Number(node.dataset.index),status:node.dataset.status},null,'trip-error',answer=>{current.trip.revision=answer.revision;current.trip.progress=answer.progress;$('#trip-today-content').innerHTML=dayRead(itinerary()[selectedDay-1],true);});
   if(action==='remove-check'){const item=current.trip.checklist.find(c=>c.id===node.dataset.id);if(confirm('移除准备事项「'+item.title+'」？'))await checkMutation({action:'remove',id:item.id});}
   if(action==='edit-check'){
    const item=current.trip.checklist.find(c=>c.id===node.dataset.id);
    showDialog(`<h2>编辑准备事项</h2><form id='trip-check-edit'>${input('title','事项名称',item.title,'required maxlength=200')}${area('note','备注',item.note,500)}<button class='button primary' type='submit'>保存事项</button><p class='form-error' role='alert'></p></form>`);
    const form=$('#trip-check-edit');form.addEventListener('submit',async e=>{e.preventDefault();e.stopImmediatePropagation();if(busy||!form.reportValidity())return;const data=Object.fromEntries(new FormData(form));const release=freeze(form);try{await checkMutation({action:'update',id:item.id,...data});$('#dialog').close();}catch(error){form.querySelector('.form-error').textContent=error.message;}finally{release();}});
   }
   if(action==='reference'||action==='version'){
    const token=epoch,version=action==='reference'?current.plan.version:Number(node.dataset.version),answer=await api(path(current.trip.id)+'/plans/'+version);if(!here(token))return;
    const box=$('#trip-reference');box.innerHTML=`<section class='panel'><h2>第 ${version} 版 · ${esc(answer.plan.label)}</h2><p class='help'>参考攻略保留采用时的内容，当前日程以“今日行程／全部计划”为准。</p><div class='trip-version-days'>${answer.plan.snapshot.itinerary.map(d=>dayRead(d)).join('')}</div>${answer.html?`<details class='trip-more'><summary>采用时的完整参考攻略</summary><article class='prose'>${AdminImages.prepareHTML(answer.html)}</article></details>`:''}</section>`;box.scrollIntoView({behavior:'smooth',block:'start'});AdminImages.resume();
   }
   if(action==='restore'){
    if(!confirm('将第 '+node.dataset.version+' 版恢复为当前计划？现有准备事项和备忘保留，计划会生成一个新版本。'))return;
    await write(path(current.trip.id)+'/plan',{revision:current.trip.revision,restore_version:Number(node.dataset.version)},null,'trip-error',async()=>{const tab=current.tab;current=await api(path(current.trip.id));current.tab=tab;render();toast('计划已恢复为新版本');});
   }
   if(action==='archive'){
    if(state.dirty){toast('请先保存本页尚未保存的修改。');return;}
    busy=true;const token=epoch;
    try{await api(path(current.trip.id),{method:'PUT',body:{revision:current.trip.revision,state:current.trip.state==='archived'?'active':'archived'}});if(here(token))location.hash='trips';}finally{busy=false;}
   }
  }catch(error){toast(error.message,true);}
 }
 return {stop,list,create,detail,homeCard,fromTask,get busy(){return busy;}};
})();
