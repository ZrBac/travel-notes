/* One travel assistant, working on a private, real journey. No browser persistence. */
const TripAssistant=(()=>{
 const names={adjust_day:'调整当天',check_departure:'临行复核',recap:'整理旅行回忆',preferences:'总结出游偏好'};
 const preferenceNames={origin:'常用出发地',rooms:'住宿偏好',budget:'预算',companions:'同行情况',walking:'步行与休息',transport:'交通偏好',preferences:'旅行兴趣',food:'饮食口味',excluded:'不考虑的地方',people:'常用人数',pace:'游玩节奏'};
 const preferenceValue=s=>s.field==='pace'?({relaxed:'宽松',balanced:'适中',active:'紧凑'})[s.value]||s.value:s.value;
 const status={queued:'排队中',running:'正在整理',done:'已完成',failed:'未完成',cancelled:'已停止'};
 let epoch=0,timer=null,current=null,day=1,tasks=[],selected=null,photos=[],notes=[],busy=false,reload=null,listLoad=null,resultLoad=null,nextPage=null,draft=false;
 const active=s=>['queued','running','testing','publishing'].includes(s);
 const path=()=>'/admin/trips/'+current.trip.id;
 function freeze(form){if(!form)return()=>{};const controls=[...form.elements].map(n=>[n,n.disabled]);form.inert=true;controls.forEach(([n])=>n.disabled=true);return()=>{form.inert=false;controls.forEach(([n,disabled])=>n.disabled=disabled);};}
 function setDraft(value){draft=value;state.dirty=draft||Trips.hasDraft;}
 const key=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
 const here=token=>token===epoch&&state.user&&current&&document.querySelector('#trip-assistant-zone');
 function stop(){clearTimeout(timer);timer=null;epoch++;current=null;draft=false;listLoad=null;resultLoad=null;tasks=[];notes=[];photos=[];selected=null;$('#main')?.removeEventListener('click',click);$('#main')?.removeEventListener('submit',submit);$('#main')?.removeEventListener('change',change);$('#main')?.removeEventListener('input',input);}
 function panel(data,selectedDay){
  const tab=data.tab,t=data.trip;
  const compose=tab==='today'?`<form id="trip-assistant-form" data-action="adjust_day"><label>今天想怎么调整？<textarea name="prompt" rows="2" minlength="2" maxlength="6000" placeholder="例如：下雨了，减少户外活动；已经去过的地点保留。" required></textarea></label><button class="button primary" type="submit" ${!data.plan?'disabled':''}>让助手调整第 ${selectedDay} 天</button></form>`:
    tab==='prepare'?`<p class="help">结合本次日期、已订交通住宿和当前行程，检查天气、开放与预约事项。</p><button class="button" type="button" data-tripa="start" data-action="check_departure">复核出发准备</button>`:
    tab==='recap'?`<p class="help">用真实照片、随记和已去地点整理回忆。先生成预览，确认后存为私密足迹。</p><div class="actions"><button class="button primary" type="button" data-tripa="start" data-action="recap">整理图文游记</button><button class="button" type="button" data-tripa="start" data-action="preferences">总结下次出游偏好</button></div><div id="trip-linked-records"></div>`:
    `<p class="help">可以在今日行程调整安排，在随手记留下照片，回来后整理成游记。</p>`;
  return `<section class="panel trip-assistant-zone" id="trip-assistant-zone"><div class="panel-top"><h2>${icon('spark')} 本次旅行助手</h2><a class="button small" href="#travel-agent?trip=${t.id}">继续规划攻略</a></div>${compose}<p class="form-error" id="trip-assistant-error" role="alert"></p><details id="trip-assistant-history"><summary>本次旅行的助手记录</summary><div id="trip-assistant-tasks"><p class="help">展开后读取记录。</p></div></details><div id="trip-assistant-result" aria-live="polite"></div></section>`;
 }
 function notesPanel(t){
  const selectedDate=t.start_date;
  return `<section class="panel trip-notes-compose"><h2>几张照片，一句感受</h2><p class="help">自动归入本次旅行，只有管理员可见。</p><form id="trip-note-form"><div class="trip-fields"><label>记录日期<input name="captured_date" type="date" min="${t.start_date}" max="${t.end_date}" value="${selectedDate}" required></label><label>地点（选填）<input name="place" maxlength="120" placeholder="例如：老门东"></label></div><label>留一句感受<textarea name="note" rows="3" maxlength="2000" placeholder="今天走得有点累，下次午后多留点休息时间……"></textarea></label><div class="trip-note-photos" id="trip-note-photos"></div><label class="button trip-photo-upload">${icon('image')} 选几张照片<input id="trip-note-upload" type="file" multiple accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"></label><p class="help" id="trip-note-upload-status">每张最多 50 MB，每条随记最多 30 张；上传后保存随记完成存档。</p><div class="actions"><button class="button primary" type="submit">保存随记</button><button class="button small" type="button" data-tripa="cancel-note" hidden>取消编辑</button></div><p class="form-error" id="trip-note-error" role="alert"></p></form></section><section class="panel"><div class="panel-top"><h2>这趟旅行的随记</h2><button class="button small" type="button" data-tripa="notes-refresh">刷新</button></div><div id="trip-notes-list"></div><button class="button small" type="button" data-tripa="notes-older" hidden>查看更多随记</button></section>`;
 }
 async function mount(data,selectedDay,onReload){
  stop();current=data;day=selectedDay;reload=onReload;const token=epoch;
  $('#main').addEventListener('click',click);$('#main').addEventListener('submit',submit);$('#main').addEventListener('change',change);$('#main').addEventListener('input',input);
  const history=$('#trip-assistant-history');history.addEventListener('toggle',()=>{if(history.open&&!busy)loadTasks(token).catch(error=>fail(error,token));});
  if(data.tab==='notes'||data.tab==='recap')try{await loadNotes(token);}catch(error){fail(error,token);}
 }
 function fail(error,token=epoch){if(!here(token)||error.name==='AbortError')return;const el=$('#trip-assistant-error');if(el)el.textContent=error.message;toast(error.message,true);}
 function photoCards(){
  $('#trip-note-photos').innerHTML=photos.map((p,i)=>`<div class="trip-note-photo"><img data-admin-src="${esc(adminThumbnail(p.url,320))}" alt="已选旅行照片" loading="lazy" decoding="async"><button class="button small" type="button" data-tripa="photo-remove" data-index="${i}" aria-label="移除第 ${i+1} 张照片">×</button><input data-photo-caption="${i}" value="${esc(p.caption||'')}" maxlength="200" aria-label="第 ${i+1} 张照片说明" placeholder="照片说明（选填）"></div>`).join('');AdminImages.resume();
 }
 function noteList(){
  const el=$('#trip-notes-list');if(!el)return;
  el.innerHTML=notes.map(n=>`<article class="trip-note"><div class="panel-top"><h3>${esc(n.captured_date)}${n.place?' · '+esc(n.place):''}</h3><div class="actions"><button class="button small" type="button" data-tripa="edit-note" data-id="${n.id}">编辑</button><button class="button small danger" type="button" data-tripa="delete-note" data-id="${n.id}">删除</button></div></div><p class="trip-note-text">${esc(n.note)}</p><div class="trip-note-gallery">${n.photos.map(p=>`<button type="button" data-tripa="photo-preview" data-url="${esc(p.url)}"><img data-admin-src="${esc(adminThumbnail(p.url,320))}" alt="${esc(p.caption||'旅行照片')}" loading="lazy" decoding="async"></button>`).join('')}</div></article>`).join('')||'<p class="help">先留几张照片、一句感受，回来后交给助手整理。</p>';AdminImages.resume();
 }
 async function loadNotes(token=epoch,older=false){
  const answer=await api(path()+'/notes'+(older?'?page='+nextPage:current.tab==='recap'?'?view=links':''));if(!here(token))return;
  notes=older?[...notes,...answer.notes]:answer.notes;nextPage=answer.next_page;noteList();if($('[data-tripa=notes-older]'))$('[data-tripa=notes-older]').hidden=!nextPage;
  if($('#trip-linked-records'))$('#trip-linked-records').innerHTML=answer.records.map(r=>`<a class="button" href="#record-edit/${r.id}">${esc(r.title)} · ${esc(statusName[r.status])} →</a>`).join('');
  const form=$('#trip-note-form');if(form&&!form.dataset.edit&&!form.dataset.key&&!draft){const offset=current.trip.today_day||(current.trip.phase==='completed'?current.trip.days:1);const d=new Date(current.trip.start_date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+offset-1);form.elements.captured_date.value=d.toISOString().slice(0,10);form.dataset.key=key();}
 }
 async function loadTasks(token=epoch){
  if(listLoad)return listLoad;
  listLoad=doLoadTasks(token);try{return await listLoad;}finally{if(token===epoch)listLoad=null;}
 }
 async function doLoadTasks(token){
  const answer=await api(path()+'/assistant');if(!here(token))return;
  tasks=answer.tasks;
  $('#trip-assistant-tasks').innerHTML=tasks.map(t=>`<button class="button trip-assistant-task" type="button" data-tripa="task" data-id="${t.id}"><span>${esc(names[t.action])}${t.day?' · 第 '+t.day+' 天':''}<small>${esc(t.prompt.slice(0,90))}</small></span><span class="agent-state ${esc(t.status)}">${esc(status[t.status]||t.status)}</span></button>`).join('')||'<p class="help">还没有这趟旅行的助手任务。</p>';
  const chosen=tasks.find(t=>t.id===selected);const box=$('#trip-assistant-result');if(selected&&(!chosen||box.dataset.task!==String(selected)||box.dataset.updated!==chosen.updated_at||box.dataset.stale!==String(chosen.stale)))await loadResult(token);
  schedule(token);
 }
 async function loadResult(token=epoch){
  const id=selected;const pending={id,token,promise:api(path()+'/assistant?task_id='+id)};if(resultLoad?.id===id&&resultLoad.token===token)return resultLoad.promise;resultLoad=pending;let answer;try{answer=await pending.promise;}finally{if(resultLoad===pending)resultLoad=null;}if(!here(token)||id!==selected)return;
  const t=answer.tasks[0];if(!t)return;renderResult(t);schedule(token);
 }
 function renderResult(t){
  const r=t.result;const box=$('#trip-assistant-result');box.dataset.task=t.id;box.dataset.status=t.status;box.dataset.updated=t.updated_at;box.dataset.stale=String(t.stale);
  box.innerHTML=`<div class="trip-assistant-preview"><div class="panel-top"><h3>${esc(names[t.action])} · #${t.id}</h3><span class="agent-state ${esc(t.status)}">${esc(status[t.status]||t.status)}</span></div>${t.applied?`<p class="help">建议已采用。${t.applied.record_id?`<a href="#record-edit/${t.applied.record_id}">编辑私密足迹 →</a>`:''}</p>`:''}${r?`<p>${esc(r.summary)}</p>${(r.warnings||[]).map(w=>`<p class="trip-assistant-warning">${esc(w)}</p>`).join('')}<article class="prose">${AdminImages.prepareHTML(t.html)}</article>${r.day_plan?Trips.dayPreview(r.day_plan):''}${r.checks?.length?`<div class="trip-assistant-options">${r.checks.map((c,i)=>`<label><input type="checkbox" data-check-index="${i}" checked><span><strong>${esc(c.title)}</strong><small>${esc(c.note)}</small></span></label>`).join('')}</div>`:''}${r.suggestions?.length?`<div class="trip-assistant-options">${r.suggestions.map(s=>`<label><input type="checkbox" data-preference-field="${esc(s.field)}" checked><span><strong>${esc(preferenceNames[s.field]||s.field)}：${esc(preferenceValue(s))}</strong><small>${esc(s.reason)}</small></span></label>`).join('')}</div>`:''}${r.sources?`<details><summary>参考资料</summary><pre>${esc(r.sources)}</pre></details>`:''}${!t.applied&&!t.stale&&!(t.action==='check_departure'&&!r.checks?.length)&&!(t.action==='preferences'&&!r.suggestions?.length)?`<button class="button primary" type="button" data-tripa="apply" data-id="${t.id}" data-action="${t.action}">${({adjust_day:'采用为新计划版本',check_departure:'把所选事项加入准备清单',recap:'存为私密旅行足迹',preferences:'记住所选偏好'})[t.action]}</button>`:''}${t.stale&&!t.applied?'<p class="trip-assistant-warning">旅行资料在生成后有更新，请按最新资料重新生成。</p>':''}`:`<p class="help">${esc(t.reason||(active(t.status)?'关闭页面后仍会继续，可以稍后回来看。':'任务未完成，可重新提交。'))}</p>${t.progress?.length?`<details open><summary>执行进度</summary><pre>${esc(t.progress.join('\n'))}</pre></details>`:''}${active(t.status)?`<button class="button small" type="button" data-tripa="cancel-task" data-id="${t.id}">停止任务</button>`:''}`}</div>`;AdminImages.resume();
 }
 function schedule(token){clearTimeout(timer);timer=null;if(!here(token)||document.hidden||busy)return;const pending=tasks.some(t=>active(t.status))||active($('#trip-assistant-result')?.dataset.status);if(pending)timer=setTimeout(()=>loadTasks(token).catch(error=>fail(error,token)),5000);}
 async function start(action,prompt=''){
  if(busy)return;if(Trips.hasDraft){toast('请先保存本页旅行资料或手动日程，再让助手整理。');return;}
  const token=epoch;busy=true;const release=freeze($('#trip-assistant-form'));$('#trip-assistant-error').textContent='';
  try{const form=$('#trip-assistant-form');if(form)form.dataset.key??=key();const answer=await api(path()+'/assistant',{method:'POST',body:{action,prompt,revision:current.trip.revision,...(action==='adjust_day'?{day}:{}),request_key:form?.dataset.key||key()}});if(!here(token))return;selected=answer.id;if(form){form.reset();delete form.dataset.key;setDraft(false);}$('#trip-assistant-history').open=true;await loadTasks(token);toast('旅行需求已提交，关闭页面后仍会继续');}
  catch(error){fail(error,token);}finally{release();busy=false;schedule(token);}
 }
 async function upload(input){
  if(busy)return;const files=[...input.files];if(!files.length)return;if(photos.length+files.length>30){toast('每条随记最多 30 张照片。',true);input.value='';return;}
  const token=epoch;busy=true;input.disabled=true;let finished=0;const errors=[];const statusEl=$('#trip-note-upload-status');const queue=[...files];
  try{
   const worker=async()=>{while(queue.length){const file=queue.shift();try{if(file.size>50*1024*1024)throw Error(file.name+' 超过 50 MB');const data=new FormData();data.append('image',file);const result=await api('/upload',{method:'POST',body:data});if(here(token)){photos.push({url:result.url,caption:''});setDraft(true);photoCards();}}catch(error){errors.push(error.message);}finally{finished++;if(here(token))statusEl.textContent=`已处理 ${finished} / ${files.length} 张，成功 ${finished-errors.length} 张。`;}}};
   await Promise.all([worker(),worker()]);if(here(token)){statusEl.textContent=errors.length?'部分照片未上传：'+errors.join('；'):'照片已上传，保存随记完成存档。';}
  }finally{busy=false;input.disabled=false;input.value='';schedule(epoch);}
 }
 async function submit(event){
  const form=event.target;if(!['trip-assistant-form','trip-note-form'].includes(form.id))return;event.preventDefault();event.stopImmediatePropagation();if(busy||!form.reportValidity())return;
  if(form.id==='trip-assistant-form'){await start('adjust_day',form.elements.prompt.value);return;}
  const token=epoch,values=Object.fromEntries(new FormData(form));busy=true;const release=freeze(form);const button=$('button[type=submit]',form);button.disabled=true;$('#trip-note-error').textContent='';
  try{const answer=await api(path()+'/notes'+(form.dataset.edit?'/'+form.dataset.edit:''),{method:form.dataset.edit?'PUT':'POST',body:{...values,photos,revision:form.dataset.edit?Number(form.dataset.revision):current.trip.revision,request_key:form.dataset.key||key()}});if(!here(token))return;setDraft(false);resetNote();busy=false;await reload();toast('随记已保存，只有管理员可见');}
  catch(error){if(here(token)){$('#trip-note-error').textContent=error.message;toast(error.message,true);}}
  finally{release();busy=false;button.disabled=false;}
 }
 function resetNote(){const form=$('#trip-note-form');form.reset();delete form.dataset.edit;delete form.dataset.revision;form.dataset.key=key();photos=[];photoCards();$('[data-tripa=cancel-note]').hidden=true;$('button[type=submit]',form).textContent='保存随记';}
 function input(event){if(event.target.hasAttribute('data-photo-caption'))photos[Number(event.target.dataset.photoCaption)].caption=event.target.value;if(event.target.closest('#trip-note-form,#trip-assistant-form'))setDraft(true);}
 async function change(event){if(event.target.id==='trip-note-upload')await upload(event.target);}
 async function click(event){
  const node=event.target.closest('[data-tripa]');if(!node||busy)return;const action=node.dataset.tripa,token=epoch;
  try{
   if(action==='start')await start(node.dataset.action);
   if(action==='task'){selected=Number(node.dataset.id);await loadResult(token);}
   if(action==='notes-older'&&nextPage)await loadNotes(token,true);
   if(action==='notes-refresh'){if(state.dirty){toast('请先保存随记再刷新。');return;}await loadNotes(token);}
   if(action==='cancel-task'){await api('/admin/travel-agent/tasks/'+node.dataset.id+'/cancel',{method:'POST',body:{}});await loadTasks(token);}
   if(action==='photo-remove'){photos.splice(Number(node.dataset.index),1);setDraft(true);photoCards();}
   if(action==='photo-preview')showDialog(`<h2>旅行照片</h2><img data-admin-src="${esc(adminThumbnail(node.dataset.url,1280))}" alt="旅行照片" style="width:100%;max-height:70vh;object-fit:contain">`);
   if(action==='cancel-note'){if(state.dirty&&!confirm('放弃这条尚未保存的随记？上传的图片素材会保留。'))return;resetNote();setDraft(false);}
   if(action==='edit-note'){
    if(state.dirty&&!confirm('替换当前尚未保存的随记？'))return;const n=notes.find(n=>n.id===Number(node.dataset.id));const form=$('#trip-note-form');form.dataset.edit=n.id;form.dataset.revision=n.revision;for(const field of ['captured_date','place','note'])form.elements[field].value=n[field];photos=cloneAdminData(n.photos);photoCards();$('[data-tripa=cancel-note]').hidden=false;$('button[type=submit]',form).textContent='保存修改';setDraft(false);form.scrollIntoView({behavior:'smooth',block:'start'});
   }
   if(action==='delete-note'){
    if(state.dirty){toast('请先保存或取消当前随记。');return;}if(!confirm('删除这条随记？已上传的图片和已生成的足迹会保留。'))return;const n=notes.find(n=>n.id===Number(node.dataset.id));busy=true;await api(path()+'/notes/'+n.id,{method:'DELETE',body:{revision:n.revision}});busy=false;await reload();toast('随记已删除');
   }
   if(action==='apply'){
    if(state.dirty||Trips.hasDraft){toast('请先保存本页未保存的内容，再采用建议。');return;}
    const id=Number(node.dataset.id),workflow=node.dataset.action;
    if(!confirm(({adjust_day:'确认采用？只调整所选日期，保留已去地点和其他日期，并生成新计划版本。',check_departure:'把选中的建议加入准备清单？不会自动订票或完成预约。',recap:'保存为私密旅行足迹？之后可编辑，并自行决定是否公开。',preferences:'把勾选的建议记入你的家庭偏好？未选字段保留。'})[workflow]))return;
    busy=true;node.disabled=true;
    const values={revision:current.trip.revision};
    if(workflow==='check_departure')values.indices=[...$('#trip-assistant-result').querySelectorAll('[data-check-index]:checked')].map(n=>Number(n.dataset.checkIndex));
    if(workflow==='preferences')values.fields=[...$('#trip-assistant-result').querySelectorAll('[data-preference-field]:checked')].map(n=>n.dataset.preferenceField);
    const answer=await api(workflow==='adjust_day'?path()+'/plan':path()+'/assistant/'+id+'/apply',{method:'POST',body:workflow==='adjust_day'?{...values,assistant_task:id}:values});
    if(!here(token))return;toast('建议已采用');busy=false;await reload();
   }
  }catch(error){fail(error,token);}finally{busy=false;if(node.isConnected)node.disabled=false;}
 }
 document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);timer=null;}else if(current&&$('#trip-assistant-history')?.open)loadTasks(epoch).catch(error=>fail(error));});
 return {panel,notesPanel,mount,stop,get dirty(){return draft;},get busy(){return busy;}};
})();
