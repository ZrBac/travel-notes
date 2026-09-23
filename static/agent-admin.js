/* The existing administrator session protects every task endpoint. */
const TravelAgent = (()=>{
  let revision=0, timer=null, selected=null, generation=0, busy=false, service={}, working=false;
  const labels={queued:'等待执行',running:'正在处理',testing:'正在测试',ready:'等待发布',done:'已完成',failed:'未完成',cancelled:'已取消',publishing:'正在发布',published:'已发布',manual:'需要单独部署'};
  function statusLabel(task){const r=task.report||task;if(active(task.status)&&Number(r.repair_attempt)>0)return task.status==='testing'?'修复后复测':'自动修复中';if(task.status==='done'&&r.outcome==='no_changes')return '未产生改动';if(task.status==='done'&&r.outcome==='documentation')return '仅完成说明';return labels[task.status]||task.status;}
  const kinds={change:'功能建设',diagnose:'故障诊断',chat:'咨询',publish:'发布',rollback:'回退'};
  const active=s=>['queued','running','testing','publishing'].includes(s);
  function stop(){clearTimeout(timer);timer=null;generation++;document.querySelector('#main')?.removeEventListener('click',handle);}
  async function page(gen){
    stop();const token=generation;selected=null;
    const data=await api('/admin/agent');if(gen!==state.generation||token!==generation)return;
    service=data.service;working=data.tasks.some(t=>active(t.status));
    $('#main').innerHTML=heading('网站管家','把需求交给管家，随时回来查看处理结果。')+`
      <section class="panel agent-overview" id="agent-overview"></section><section class="panel"><div class="panel-top"><div><h2>常用操作</h2><p class="help">新增账号直接在表单办理；功能修改交给下方助手。任务测试失败时会自动尝试修复一次，仍由你决定是否发布。</p></div><button type="button" class="button secondary" data-admin-accounts>管理员管理</button></div></section>
      <div class="agent-layout"><section class="panel agent-compose"><h2>安排一个任务</h2>
        <form id="agent-task-form"><label>任务类型<select name="kind"><option value="change">功能建设 · 修改开发副本</option><option value="diagnose">故障诊断 · 只读检查</option><option value="chat">咨询 · 只读讨论</option></select></label>
        <label>需求<textarea name="prompt" required minlength="2" maxlength="6000" rows="7" placeholder="例如：给旅行足迹增加按目的地筛选；或者检查最近网站是否运行正常。"></textarea></label>
        <p class="help" id="agent-followup-note">网站管家一次处理一个任务，可与旅游助手同时运行；关闭页面后继续。改动测试通过后，由你查看并发布。</p>
        <div class="actions"><button type="submit" class="button primary">提交任务</button><button type="button" class="button" data-agent="new">新建对话</button></div>
        <p class="form-error" id="agent-form-error" role="alert"></p></form>
        <details class="agent-rollback"><summary>发布记录与回退</summary><p class="help">回退网站代码，保留攻略、足迹及上传文件。涉及数据库结构的旧版本需单独处理。</p><div id="agent-versions"></div></details>
      </section><section class="panel agent-task-panel"><div class="panel-top"><h2>任务记录</h2><button class="button small" type="button" data-agent="refresh">刷新</button></div><div id="agent-tasks"></div></section></div>
      <section class="panel agent-detail" id="agent-detail" hidden></section>`;
    renderOverview();renderTasks(data.tasks);bind();schedule(token);
  }
  function renderOverview(){
    const health=service.health||{};
    $('#agent-overview').innerHTML=`<div><span class="agent-dot ${service.online?'online':''}"></span><strong>${service.online?'管家在线':'管家暂未连接'}</strong><span>${service.authenticated?'ChatGPT 账号已连接':'账号需要重新登录'}</span></div><div><span>最近巡检：${health.checked_at?date(health.checked_at*1000):'等待巡检'}</span><span>磁盘可用：${service.disk_free?(service.disk_free/1024**3).toFixed(1)+' GB':'—'}</span></div>${(health.warnings||[]).map(w=>`<p class="form-error">${esc(w)}</p>`).join('')}`;
    $('#agent-versions').innerHTML=(service.versions||[]).map(v=>`<div class="agent-version"><code>${esc(v)}</code><button type="button" class="button small" data-agent="rollback" data-version="${esc(v)}">回退</button></div>`).join('')||'<p class="muted">暂无代码检查点。</p>';
  }
  function renderTasks(tasks){
    $('#agent-tasks').innerHTML=tasks.length?tasks.map(t=>`<button type="button" class="agent-task ${selected===t.id?'selected':''}" data-agent="select" data-id="${t.id}"><span><strong>${esc(t.prompt.slice(0,70))}</strong><small>${kinds[t.kind]} · ${date(t.created_at)}</small></span><span class="agent-state ${t.status}">${esc(statusLabel(t))}</span></button>`).join(''):'<p class="muted">还没有任务，从左侧提交第一个需求。</p>';
  }
  function renderDetail(task){
    const r=task.report||{};$('#agent-detail').hidden=false;
    $('#agent-detail').innerHTML=`<div class="panel-top"><h2>任务 #${task.id} · ${esc(statusLabel(task))}</h2><div class="actions">${['queued','running','testing'].includes(task.status)?`<button type="button" class="button small" data-agent="cancel" data-id="${task.id}">停止任务</button>`:''}${!active(task.status)?`<button type="button" class="button small danger" data-agent="delete" data-id="${task.id}">删除记录</button>`:''}${!active(task.status)&&['change','diagnose','chat'].includes(task.kind)?`<button type="button" class="button small" data-agent="followup" data-id="${task.id}" data-kind="${task.kind}">继续补充需求</button>`:''}</div></div>
      ${r.code_start?`<p class="help">${esc(r.code_start)}</p>`:''}${r.repair_attempt?`<p class="help">已启动自动修复 ${Number(r.repair_attempt)} / 1 次；任务总时限仍为 20 分钟。</p>`:''}
      <p class="agent-request">${esc(task.prompt)}</p><div class="agent-answer">${esc(task.result||'任务已保存，等待处理。')}</div>
      ${r.progress?.length?`<details ${active(task.status)?'open':''}><summary>执行进度</summary><pre>${esc(r.progress.join('\n'))}</pre></details>`:''}
      ${r.files?.length?`<h3>变更预览</h3><ul class="agent-files">${r.files.map(f=>`<li><span>${esc(f.action)}</span><code>${esc(f.path)}</code>${f.automatic?'':'<small>需单独部署</small>'}</li>`).join('')}</ul><details><summary>查看代码差异${r.diff_truncated?'（内容较长，已截取）':''}</summary><pre>${esc(r.diff||'没有文本差异')}</pre></details>`:''}
      ${r.repair_history?.length?`<details><summary>首次失败记录</summary><pre>${esc(r.repair_history.map(h=>h.tests).join('\n'))}</pre></details>`:''}
      ${r.tests?`<details><summary>${r.tests_passed?'测试通过':'测试未通过'} · 查看结果</summary><pre>${esc(r.tests)}</pre></details>`:''}
      ${r.reason?`<p class="help agent-outcome" role="status">${esc(r.reason)}</p>`:''}
      ${task.status==='ready'&&r.publishable?`<div class="agent-publish"><p>请查看上面的修改与测试结果。发布前会备份，发布后检查网站，失败时恢复原代码。</p><button type="button" class="button primary" data-agent="publish" data-id="${task.id}" data-artifact="${esc(r.artifact)}">发布这个版本</button></div>`:''}
      ${r.usage?.input_tokens?`<p class="help">本次用量：输入 ${Number(r.usage.input_tokens).toLocaleString()} / 输出 ${Number(r.usage.output_tokens||0).toLocaleString()} tokens。使用已登录账号权益。</p>`:''}`;
  }
  function forgetTask(id){
    revision++;selected=null;$('#agent-detail').hidden=true;$('#agent-detail').innerHTML='';delete $('#agent-detail').dataset.updated;
    const form=$('#agent-task-form');
    if(Number(form.dataset.parent)===id){delete form.dataset.parent;$('#agent-followup-note').textContent='关联记录已删除，当前填写内容将作为新任务提交。';}
  }
  async function refresh(token=generation){
    if(token!==generation||state.route!=='agent'||busy||document.hidden)return;
    const version=revision;const data=await api('/admin/agent');if(token!==generation||version!==revision||busy)return;
    service=data.service;working=data.tasks.some(t=>active(t.status));renderOverview();renderTasks(data.tasks);
    const current=data.tasks.find(t=>t.id===selected);
    if(selected&&(!current||active(current.status)||$('#agent-detail').dataset.updated!==current.updated_at)){const id=selected;let detail;
      try{detail=await api('/admin/agent/tasks/'+id);}catch(error){
        if(token!==generation||version!==revision||id!==selected||busy)return;
        if(error.status!==404)throw error;
        forgetTask(id);renderTasks(data.tasks.filter(t=>t.id!==id));return;
      }
      if(token===generation&&version===revision&&!busy&&detail.task.id===selected){
      const signature=detail.task.updated_at;
      if($('#agent-detail').dataset.updated!==signature){const opened=[...document.querySelectorAll('#agent-detail details')].map(d=>d.open);renderDetail(detail.task);$('#agent-detail').dataset.updated=signature;document.querySelectorAll('#agent-detail details').forEach((d,i)=>{if(opened[i])d.open=true;});}
    }}
  }
  function schedule(token){clearTimeout(timer);timer=setTimeout(async()=>{if(token!==generation||state.route!=='agent')return;try{await refresh(token);}catch(e){if($('#agent-overview'))$('#agent-overview').textContent=e.message;}finally{if(token===generation&&state.route==='agent')schedule(token);}},working?4000:15000);}
  function bind(){
    $('#agent-task-form').addEventListener('submit',async e=>{
      e.preventDefault();e.stopImmediatePropagation();if(busy)return;const form=e.target;if(!form.reportValidity())return;
      busy=true;const submit=$('button[type=submit]',form);submit.disabled=true;$('#agent-form-error').textContent='';
      try{const data=Object.fromEntries(new FormData(form));if(form.dataset.parent)data.parent_id=Number(form.dataset.parent);const result=await api('/admin/agent/tasks',{method:'POST',body:data});selected=result.id;form.prompt.value='';delete form.dataset.parent;$('#agent-followup-note').textContent='任务已提交，关闭页面后仍会继续。';toast('任务已提交');}
      catch(e){$('#agent-form-error').textContent=e.message;}finally{busy=false;submit.disabled=false;await refresh().catch(()=>{});}
    });
    $('#main').addEventListener('click',handle);
  }
  async function handle(e){
    const node=e.target.closest('[data-agent]');if(!node||busy)return;const action=node.dataset.agent;
    try{
      if(action==='select'){selected=Number(node.dataset.id);$('#agent-detail').dataset.updated='';await refresh();$('#agent-detail').scrollIntoView({behavior:'smooth',block:'start'});}
      if(action==='refresh')await refresh();
      if(action==='followup'){const form=$('#agent-task-form');form.dataset.parent=node.dataset.id;form.kind.value=node.dataset.kind;$('#agent-followup-note').textContent='继续任务 #'+node.dataset.id+'；会带上历史需求、实际测试错误及可用候选；正式代码更新后会从最新版继续。';form.prompt.focus();}
      if(action==='new'){delete $('#agent-task-form').dataset.parent;$('#agent-followup-note').textContent='网站管家一次处理一个任务，可与旅游助手同时运行；关闭页面后继续。';$('#agent-task-form').prompt.focus();}
      if(action==='delete'){
        const id=Number(node.dataset.id);
        if(!confirm('永久删除任务 #'+id+' 的需求、结果和检查记录？删除后不能恢复或发布该候选版本；已发布的网站改动不受影响。若有后续任务，需先删除后续记录。'))return;
        const token=generation;revision++;busy=true;node.disabled=true;
        await api('/admin/agent/tasks/'+id,{method:'DELETE'});
        if(token!==generation)return;
        forgetTask(id);
        toast('任务记录已删除');busy=false;await refresh(token);
      }
      if(action==='cancel'){await api('/admin/agent/tasks/'+node.dataset.id+'/cancel',{method:'POST',body:{}});toast('已请求停止');await refresh();}
      if(action==='publish'||action==='rollback'){
        const message=action==='publish'?'发布这个已测试的候选版本？网站会短暂重启，发布前自动备份。':'回退到所选代码版本？攻略、足迹和图片会保留，网站会短暂重启。';
        if(!confirm(message))return;busy=true;node.disabled=true;
        const d=await api(action==='publish'?'/admin/agent/tasks/'+node.dataset.id+'/publish':'/admin/agent/rollback',{method:'POST',body:action==='publish'?{artifact:node.dataset.artifact}:{version:node.dataset.version}});selected=d.id;toast('已加入任务队列');
      }
    }catch(error){toast(error.message,true);}finally{busy=false;node.disabled=false;}
  }
  return {page,stop};
})();
