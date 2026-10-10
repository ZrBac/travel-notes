/* Footprint editor AI uses the existing travel queue, with no stored browser drafts. */
const RecordAssistant=(()=>{
 const endpoint='/admin/record-assistant/tasks',names={record_generate:'生成游记',record_polish:'润色正文'},statuses={queued:'等待整理',running:'正在整理',done:'整理完成',failed:'未完成',cancelled:'已停止'};
 const fields=['id','revision','title','destination','start_date','end_date','summary','body','actual_cost','photos'];
 let ctx=null,sequence=0;
 const active=t=>['queued','running','testing','publishing'].includes(t?.status);
 function normalize(value){const copy={};for(const field of fields){const v=value[field];copy[field]=field==='photos'?(v||[]).map(p=>({url:p.url,caption:(p.caption||'').trim()})):field==='id'||field==='revision'?v??null:typeof v==='string'?v.trim():v||'';}return copy;}
 const signature=value=>JSON.stringify(normalize(value));
 const key=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');
 const here=c=>ctx===c&&c.generation===state.generation&&c.form.isConnected;
 function panel(){return `<details id="record-ai" class="record-ai"><summary><span>${icon('spark')}AI 整理</span><small>几张照片，几句经历，留成一篇游记</small></summary><div class="record-ai-content"><label for="record-ai-prompt">经历或修改要求<textarea id="record-ai-prompt" rows="3" maxlength="2000" placeholder="例如：和家人在南京逛老街，吃了鸭血粉丝汤，下午走累了就回酒店休息。&#10;已有正文也可以说：写得自然一点，缩短重复的部分。"></textarea></label><p class="help">根据正文、照片说明和补充经历整理。给照片加一句说明，会更贴近真实回忆。</p><div class="actions"><button type="button" class="button primary" data-record-ai="generate">生成游记</button><button type="button" class="button" data-record-ai="polish">润色正文</button></div><p id="record-ai-status" class="help" role="status"></p><div id="record-ai-result"></div><details class="record-ai-history"><summary>最近的整理记录</summary><div id="record-ai-tasks"><p class="help">展开后查看。</p></div></details></div></details>`;}
 function stop(){sequence++;if(!ctx)return;clearTimeout(ctx.timer);ctx.reader.abort();ctx=null;}
 function report(c,error){if(!here(c)||error.name==='AbortError')return;$('#record-ai-status').textContent=error.message;}
 function matches(c){return c.task?.snapshot&&signature(c.getSnapshot())===signature(c.task.snapshot);}
 function controls(c){if(!here(c))return;for(const button of c.panel.querySelectorAll('[data-record-ai=generate],[data-record-ai=polish]'))button.disabled=c.writing||active(c.task);const apply=$('[data-record-ai=apply]',c.panel);if(apply)apply.disabled=c.writing||!!c.applied||!matches(c);const undo=$('[data-record-ai=undo]',c.panel);if(undo)undo.disabled=c.writing||!c.undo||signature(c.getSnapshot())!==c.undo.after;}
 function changed(){const c=ctx;if(!c||!here(c))return;controls(c);const warning=$('#record-ai-stale');if(warning)warning.hidden=matches(c)||!!c.applied;}
 function render(c){if(!here(c)||!c.task)return;const t=c.task,p=t.proposal;$('#record-ai-status').textContent=`${names[t.action]||'足迹整理'} · #${t.id} · ${statuses[t.status]||t.status}`;
  $('#record-ai-result').innerHTML=p?`<div class="record-ai-preview"><h3>${esc(p.title)}</h3><p>${esc(p.summary)}</p>${p.warnings.map(w=>`<p class="record-ai-warning">${esc(w)}</p>`).join('')}<details class="record-ai-body" open><summary>游记预览</summary><article class="prose">${AdminImages.prepareHTML(p.html)}</article></details><p class="record-ai-warning" id="record-ai-stale" ${matches(c)||c.applied?'hidden':''}>生成后正文、日期或照片有更新，请按最新内容重新整理，当前改动会保留。</p><label class="record-ai-choice"><input id="record-ai-meta" type="checkbox" ${t.action==='record_generate'?'checked':''}>同时采用标题和简介</label><div class="actions"><button class="button primary" type="button" data-record-ai="apply">${c.applied?'已填入编辑器':'采用到编辑器'}</button>${c.undo?'<button class="button" type="button" data-record-ai="undo">撤销本次填入</button>':''}${!matches(c)&&!c.applied&&!c.getSnapshot().id&&!t.snapshot.id?'<button class="button" type="button" data-record-ai="restore">取回这次的照片和原稿</button>':''}</div><p class="help">采用后仍需点击「保存旅行足迹」，可见范围由保存时的选择决定。</p></div>`:`<p class="help">${esc(t.reason||(active(t)?'关闭页面后仍会继续，回来可在整理记录中查看。':'可以保留当前文字和照片，修改要求后重试。'))}</p>${active(t)?'<div class="actions"><button type="button" class="button small" data-record-ai="refresh">查看进度</button><button type="button" class="button small" data-record-ai="cancel">停止整理</button></div>':''}`;
  controls(c);AdminImages.resume();
 }
 async function history(c){if(!here(c)||c.historyLoaded)return;c.historyLoaded=true;
  try{const d=await api(endpoint+'?record_id='+(c.getSnapshot().id||'new'),{signal:c.reader.signal});if(!here(c))return;
   $('#record-ai-tasks').innerHTML=d.tasks.length?d.tasks.map(t=>`<button type="button" class="record-ai-task" data-record-ai="select" data-id="${t.id}"><span><strong>${esc(names[t.action])} · #${t.id}</strong><small>${esc(t.prompt.slice(0,80))}</small></span><small>${esc(statuses[t.status]||t.status)}</small></button>`).join(''):'<p class="help">还没有整理记录。</p>';
  }catch(error){c.historyLoaded=false;report(c,error);if(here(c)&&error.name!=='AbortError')$('#record-ai-tasks').innerHTML='<button class="button small" type="button" data-record-ai="history">重新读取记录</button>';}
 }
 function schedule(c){clearTimeout(c.timer);if(here(c)&&c.panel.open&&!document.hidden&&active(c.task)&&c.failures<3)c.timer=setTimeout(()=>refresh(c).catch(error=>report(c,error)),5000);}
 async function refresh(c){if(!here(c)||document.hidden||!c.panel.open)return;if(c.reading)return c.reading;
  const id=c.task?.id;if(!id)return;const version=sequence;
  const job=(async()=>{try{const previous=JSON.stringify([c.task.status,c.task.reason,c.task.proposal]);let d=await api(endpoint+'/'+id+'?view=status',{signal:c.reader.signal});if(!here(c)||version!==sequence)return;
   c.task={...c.task,...d.task};if(d.task.status==='done')d=await api(endpoint+'/'+id,{signal:c.reader.signal});if(!here(c)||version!==sequence)return;
   c.task={...c.task,...d.task};c.failures=0;if(previous!==JSON.stringify([c.task.status,c.task.reason,c.task.proposal]))render(c);
  }catch(error){if(here(c)&&version===sequence&&error.name!=='AbortError'){c.failures++;if(error.status===404){c.task={...c.task,status:'failed',reason:'整理记录已删除，当前照片和文字仍保留，可以重新整理。'};render(c);}controls(c);report(c,error);}}finally{if(here(c)){c.reading=null;schedule(c);}}})();c.reading=job;return job;
 }
 async function select(c,id,initial){if(!here(c)||c.writing)return;clearTimeout(c.timer);c.reader.abort();c.reader=new AbortController();const version=++sequence;
  c.task=null;c.undo=null;c.applied=null;$('#record-ai-status').textContent='正在读取整理记录…';$('#record-ai-result').replaceChildren();
  const d=initial?{task:initial}:await api(endpoint+'/'+id,{signal:c.reader.signal});if(!here(c)||version!==sequence)return;
  c.task=d.task;$('#record-ai-prompt').value=d.task.prompt||'';c.failures=0;render(c);schedule(c);
 }
 function mount(adapter,initial){stop();ctx={...adapter,generation:state.generation,panel:$('#record-ai'),form:$('#record-editor-form'),reader:new AbortController(),task:null,writing:false,failures:0,applied:null,undo:null};const c=ctx;
  c.panel.addEventListener('toggle',()=>{if(!here(c))return;clearTimeout(c.timer);if(c.panel.open&&active(c.task))refresh(c).catch(error=>report(c,error));});
  $('.record-ai-history',c.panel).addEventListener('toggle',event=>{if(event.target.open)history(c).catch(error=>report(c,error));});
  const id=new URLSearchParams(state.route.split('?')[1]||'').get('ai');if(id&&/^[1-9][0-9]{0,17}$/.test(id)){c.panel.open=true;select(c,Number(id),initial).catch(error=>report(c,error));}
 }
 async function submit(c,action){if(c.writing||active(c.task))return;if(TravelEditor.busy||c.uploading()){toast('请等待照片上传或编辑器加载完成。');return;}
  const snapshot=c.getSnapshot(),prompt=$('#record-ai-prompt').value.trim();if(!snapshot.destination){throw Error('先填写这次旅行的地点，再让助手整理。');}
  const requestSignature=JSON.stringify([action,signature(snapshot),prompt]);if(c.submission?.signature!==requestSignature)c.submission={signature:requestSignature,key:key()};
  c.writing=true;controls(c);$('#record-ai-status').textContent='正在提交整理需求…';
  try{const d=await api(endpoint,{method:'POST',body:{action,prompt,record:snapshot,request_key:c.submission.key}});if(!here(c))return;c.submission=null;c.undo=null;c.applied=null;c.historyLoaded=false;
   c.writing=false;await select(c,d.id);if($('.record-ai-history',c.panel).open)await history(c);toast('已提交，结果会保留在整理记录里');
  }finally{c.writing=false;controls(c);}
 }
 async function apply(c){if(c.writing||c.applied||!c.task?.proposal)return;if(TravelEditor.busy||c.uploading())throw Error('请等待照片上传或编辑器加载完成。');
  if(!matches(c))throw Error('内容已更新，请按最新正文和照片重新整理。');const before=c.getSnapshot(),useMeta=$('#record-ai-meta').checked;
  c.writing=true;c.form.inert=true;controls(c);
  try{const answer=await api(endpoint+'/'+c.task.id+'/preview',{method:'POST',body:{record:before}});if(!here(c))return;
   if(signature(c.getSnapshot())!==signature(before))throw Error('内容已更新，当前改动已保留，请重新整理。');
   await TravelEditor.replace(answer.proposal.body,answer.proposal.html);if(!here(c))return;
   if(useMeta){c.form.elements.title.value=answer.proposal.title;c.form.elements.summary.value=answer.proposal.summary;}
   c.onChange();c.applied=c.task.id;c.undo={before,after:signature(c.getSnapshot())};render(c);$('#record-save-note').textContent='AI 整理已填入，尚未保存。';toast('已填入编辑器，请检查后保存');
  }finally{c.writing=false;c.form.inert=false;controls(c);}
 }
 async function undo(c){if(c.writing||!c.undo)return;if(TravelEditor.busy||c.uploading())throw Error('请等待编辑器或上传完成。');if(signature(c.getSnapshot())!==c.undo.after)throw Error('填入后已有新的修改，当前内容会保留。');
  c.writing=true;c.form.inert=true;try{await TravelEditor.replace(c.undo.before.body);if(!here(c))return;c.form.elements.title.value=c.undo.before.title;c.form.elements.summary.value=c.undo.before.summary;c.undo=null;c.applied=null;c.onChange();render(c);toast('已撤销本次填入');}finally{c.writing=false;c.form.inert=false;controls(c);}
 }
 document.addEventListener('click',async event=>{const node=event.target.closest('[data-record-ai]'),c=ctx;if(!node||!c||!here(c))return;try{const action=node.dataset.recordAi;
  if(action==='generate'||action==='polish')await submit(c,action==='generate'?'record_generate':'record_polish');
  if(action==='select')await select(c,Number(node.dataset.id));
  if(action==='apply')await apply(c);
  if(action==='undo')await undo(c);
  if(action==='history')await history(c);
  if(action==='refresh'){c.failures=0;await refresh(c);}
  if(action==='cancel'&&!c.writing){c.writing=true;try{await api('/admin/travel-agent/tasks/'+c.task.id+'/cancel',{method:'POST',body:{}});}finally{c.writing=false;}await refresh(c);}
  if(action==='restore'&&!c.writing){if(TravelEditor.busy||c.uploading())throw Error('请等待编辑器或照片上传完成。');if(state.dirty&&!confirm('取回这次整理时的照片和原稿？当前未保存的内容将被替换。'))return;c.writing=true;c.form.inert=true;try{await c.restore(c.task.snapshot);if(here(c)){c.onChange();render(c);}}finally{c.writing=false;c.form.inert=false;controls(c);}}
 }catch(error){report(c,error);if(here(c)&&error.name!=='AbortError')toast(error.message,true);}});
 document.addEventListener('visibilitychange',()=>{const c=ctx;if(!c||!here(c))return;clearTimeout(c.timer);if(document.hidden){c.reader.abort();c.reader=new AbortController();}else if(c.panel.open&&active(c.task)){c.failures=0;refresh(c).catch(error=>report(c,error));}});
 window.addEventListener('pagehide',stop);
 return {panel,mount,stop,changed,get busy(){return !!ctx?.writing;},get appliedTask(){return ctx?.applied||null;}};
})();
