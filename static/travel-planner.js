/* Private research assistant; all content comes from authenticated APIs. */
const TravelPlanner = (() => {
  let revision=0, timer=null, epoch=0, busy=false, selected=null, tasks=[], detail=null, nextBefore=null, expanded=false;
  const checked=new Set();
  const endpoint='/admin/travel-agent';
  const active=status=>['queued','running','testing','publishing'].includes(status);
  const labels={queued:'排队中',running:'正在研究',testing:'正在测试',publishing:'正在发布',done:'已完成',failed:'未完成',cancelled:'已停止'};
  const fields=['destination','origin','dates','days','people','rooms','budget','preferences','excluded','mode','companions','pace','walking','transport','food'];
  const familyFields=['origin','people','rooms','budget','companions','pace','walking','transport','preferences','food','excluded'];
  let family={preferences:{},updated_at:null},familyDirty=false,tripDirty=false;
  const paceNames={relaxed:'宽松',balanced:'适中',active:'紧凑'};
  const here=()=>state.user&&state.route.split('/')[0]==='travel-agent';
  function stop(){TaskManager.cancel();checked.clear();clearTimeout(timer);timer=null;epoch++;$('#main')?.removeEventListener('click',handle);}
  function input(name,label,placeholder='',extra=''){
    return `<label>${label}<input name="${name}" placeholder="${placeholder}" ${extra}></label>`;
  }
  function paceField(){
    return `<label>游玩节奏<select name="pace"><option value="">按本次行程安排</option>${Object.entries(paceNames).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label>`;
  }
  function syncDirty(){state.dirty=familyDirty||tripDirty;}
  function freezeForm(form){
    const controls=[...form.elements].map(node=>[node,node.disabled]);form.inert=true;
    for(const [node] of controls)node.disabled=true;
    return ()=>{form.inert=false;for(const [node,disabled] of controls)node.disabled=disabled;};
  }
  function familyPanel(){
    return `<section class="panel planner-family"><details id="planner-family-settings"><summary>家庭出游偏好 <span id="planner-family-badge"></span></summary><p class="help">按当前管理员账号保存在服务器，换手机也能读取。新旅行自动带入，本次修改不会改变保存的偏好。</p><form id="planner-family-form"><div class="planner-fields">${input('origin','常用出发地','如上海','maxlength="80"')}${input('people','常用出行人数','不固定可留空','type="number" min="1" max="50"')}${input('rooms','住宿偏好','如少换酒店，优先双床房','maxlength="120"')}${input('budget','常用预算','注明人均或合计、是否含大交通','maxlength="120"')}</div><details class="planner-more"><summary>同行情况、节奏和兴趣</summary><label>常用同行情况<textarea name="companions" rows="2" maxlength="300" placeholder="如两位成人，或带老人/孩子；不固定可留空"></textarea></label><div class="planner-fields">${paceField()}${input('walking','步行 / 体力要求','如少爬台阶，连续步行不超过半小时','maxlength="120"')}${input('transport','交通偏好','如公共交通为主，远郊可包车','maxlength="120"')}${input('food','饮食口味 / 忌口','如少辣、不吃海鲜；没有可留空','maxlength="300"')}</div><label>兴趣偏好<textarea name="preferences" rows="2" maxlength="1500" placeholder="人文街区、美食、博物馆、自然风景……"></textarea></label>${input('excluded','不考虑的目的地','多个目的地用逗号分隔','maxlength="500"')}</details><div class="actions"><button class="button primary small" type="submit">保存家庭偏好</button><button class="button small" type="button" data-planner="apply-family">带入本次规划</button></div><p id="planner-family-status" class="help" role="status"></p><p id="planner-family-error" class="form-error" role="alert"></p></form></details></section>`;
  }
  function fillFamily(){
    const form=$('#planner-family-form');if(!form)return;
    for(const key of familyFields)form.elements[key].value=family.preferences[key]??'';
    $('#planner-family-badge').textContent=family.updated_at?'已保存':'可选设置';
    $('#planner-family-status').textContent=family.updated_at?'保存的偏好会用于新旅行，也可以手动带入本次规划。':'填一次常用条件，以后规划时自动复用。没有固定要求的项目可以留空。';
  }
  function applyFamily(){
    const form=$('#planner-form');
    for(const key of familyFields){
      const value=family.preferences[key];if(key==='people'&&value==null)continue;
      form.elements[key].value=value??'';
    }
  }
  async function saveFamily(event){
    event.preventDefault();event.stopImmediatePropagation();const form=event.currentTarget;if(busy||!form.reportValidity())return;
    const token=epoch,values=Object.fromEntries(new FormData(form)),preferences={};
    for(const key of familyFields)preferences[key]=key==='people'?(values[key]===''?null:Number(values[key])):values[key];
    busy=true;const release=freezeForm(form);$('#planner-family-error').textContent='';
    try{
      const response=await api(endpoint+'/preferences',{method:'PUT',body:{preferences}});if(token!==epoch)return;
      family=response;familyDirty=false;fillFamily();
      if(!tripDirty&&!$('#planner-form').dataset.parent)applyFamily();syncDirty();toast('家庭偏好已保存，新旅行会自动带入');
    }catch(error){if(token===epoch)$('#planner-family-error').textContent=error.message;}
    finally{busy=false;release();}
  }
  async function page(gen,id){
    stop();const token=epoch;tasks=[];detail=null;expanded=false;selected=/^\d+$/.test(id||'')?Number(id):null;
    const data=await api(endpoint);if(gen!==state.generation||token!==epoch)return;
    tasks=data.tasks;nextBefore=data.next_before;family=data.family_preferences||{preferences:{},updated_at:null};familyDirty=false;tripDirty=false;if(!selected)selected=tasks[0]?.id||null;
    $('#main').innerHTML=heading('为自己和家人，安排下一次出发。','记住常用偏好，结合这次日期与同行情况，整理一份图文旅行计划。')+`
      <section class="panel planner-intro"><div><span class="eyebrow">家庭出游规划</span><h2>旅游助手</h2><p>行程 · 景点美食 · 住宿预算 · 预约与天气备选</p></div><span id="planner-service" role="status"></span></section>
      ${familyPanel()}
      <div class="planner-layout"><section class="panel planner-compose"><div class="panel-top"><h2>这次，想去哪里？</h2><button class="button small" type="button" data-planner="example">填入家庭出游示例</button></div>
      <form id="planner-form">
        <div class="planner-smart"><strong>家庭出游 · 智能图文攻略</strong><p>根据目的地、季节和同行人的节奏，安排顺路的景点、美食与休息时间。</p><span>每日路线与行程表</span><span>景点与美食图文</span><span>预约与雨天备选</span></div>
        <label>规划方式<select name="mode"><option value="itinerary">生成目的地攻略</option><option value="compare">比较几个候选地</option></select></label>
        <div class="planner-fields">${input('destination','目的地 / 候选范围','如南京，或推荐适合秋季家庭出游的三个城市','maxlength="120"')}${input('origin','出发地','未定可留空','maxlength="80"')}
        ${input('dates','出行日期 / 季节','填写具体日期，或先选月份/季节','maxlength="120"')}${input('days','旅行天数','','type="number" min="1" max="30" value="4" required')}
        ${input('people','出行人数','','type="number" min="1" max="50" value="1" required')}${input('rooms','房间需求','如 1 间双床房，住 3 晚','maxlength="120"')}</div>
        ${input('budget','预算','请注明人均或总预算、是否含大交通','maxlength="120"')}
        <details class="planner-more"><summary>本次同行情况与偏好</summary><label>本次同行情况<textarea name="companions" rows="2" maxlength="300" placeholder="按这次出行填写；带老人或孩子时可说明年龄、体力需求"></textarea></label><div class="planner-fields">${paceField()}${input('walking','步行 / 体力要求','如安排午休，少爬台阶','maxlength="120"')}${input('transport','交通偏好','如公共交通为主，少换乘','maxlength="120"')}${input('food','饮食口味 / 忌口','没有特殊要求可留空','maxlength="300"')}</div><label>旅行兴趣<textarea name="preferences" rows="2" maxlength="1500" placeholder="人文街区、美食、博物馆、自然风景……"></textarea></label>${input('excluded','不考虑的地方','多个目的地用逗号分隔','maxlength="500"')}<p class="help">这里只调整本次旅行，长期偏好在上方单独保存。</p></details>
        <label>补充要求 / 继续修改（选填）<textarea name="prompt" rows="3" minlength="2" maxlength="6000" placeholder="例如：午后留休息时间，少换酒店，多介绍当地特色与美食。没有补充要求可直接生成。"></textarea></label>
        <p id="planner-followup" class="help">可与网站管家同时运行；本助手一次生成一份攻略，关闭页面后可以回来查看。</p>
        <div class="actions"><button class="button primary" type="submit">生成攻略参考</button><button class="button" type="button" data-planner="new">新建一趟旅行</button></div>
        <p id="planner-error" class="form-error" role="alert"></p>
      </form></section>
      <section class="panel planner-history"><div class="panel-top"><h2>旅行灵感档案</h2><button class="button small" type="button" data-planner="refresh">刷新</button></div>${TaskManager.bar('planner')}<div id="planner-tasks"></div><button id="planner-older" class="button small" type="button" data-planner="older" hidden>加载更早的记录</button></section></div>
      <section class="panel planner-detail" id="planner-detail" aria-live="polite"></section>`;
    fillFamily();applyFamily();service(data.service);renderTasks();bind();
    await loadDetail(token);if(token===epoch)schedule(token);
  }
  function service(info){
    const available=info.online&&info.authenticated;
    $('#planner-service').innerHTML=`<span class="agent-dot ${available?'online':''}"></span> ${available?(info.concurrency>=2?'可以开始规划 · 可与网站管家并行':'可以开始规划'):info.online?'账号需要重新登录':'助手暂未连接'}`;
    $('#planner-service').className='planner-service';
  }
  function renderTasks(){
    $('#planner-tasks').innerHTML=tasks.map(t=>TaskManager.row(t,`<button type="button" class="agent-task ${t.id===selected?'selected':''}" data-planner="select" data-id="${t.id}"><span><strong>${esc(t.trip.destination||t.prompt.slice(0,65))}</strong><small>${t.trip.mode==='compare'?'候选地比较':'旅行攻略'} · ${Number(t.trip.days)||4} 天 · ${date(t.created_at)}</small><small>${esc(t.prompt.slice(0,95))}</small></span><span class="agent-state ${esc(t.status)}">${esc(labels[t.status]||t.status)}</span></button>`,'planner',checked)).join('')||empty('下一次出发，从这里开始','生成过的攻略和后续修改都会保存在这里。');
    TaskManager.update('planner',tasks,checked);$('#planner-older').hidden=!nextBefore;
  }
  function forgetTask(id){
    revision++;tasks=tasks.filter(t=>t.id!==id);selected=null;detail=null;
    const form=$('#planner-form');
    if(Number(form.dataset.parent)===id){delete form.dataset.parent;$('#planner-followup').textContent='关联记录已删除，当前填写内容将作为新任务提交。';}
    if(state.route==='travel-agent/'+id){history.replaceState(null,'','#travel-agent');state.route='travel-agent';}
    renderTasks();
  }
  async function loadDetail(token=epoch){
    if(!selected){$('#planner-detail').innerHTML=empty('让计划先有一个起点','填好旅行想法，助手会结合季节、当地特色与参考资料整理方案。');return;}
    const id=selected,version=revision;let data;
    const current=tasks.find(t=>t.id===id);
    // A fresh task list supplies the version; running tasks always bypass this cache.
    const query=current?.status==='done'&&current.updated_at?'?updated='+encodeURIComponent(current.updated_at):'';
    try{data=await api(endpoint+'/tasks/'+id+query);}catch(error){
      if(token!==epoch||version!==revision||id!==selected||!here())return;
      if(error.status!==404)throw error;
      forgetTask(id);await loadDetail(token);return;
    }
    if(token!==epoch||version!==revision||id!==selected||!here())return;
    if(detail?.id===id&&detail.updated_at===data.task.updated_at)return;
    detail=data.task;renderDetail();
  }
  function publicationActions(t){
    const count=t.destinations?.length||0, mode=count>1?'split':'single', ids=t.publications?.[mode];
    if(ids?.length)return `<div class="planner-publications"><strong>已存档 ${ids.length} 篇攻略</strong><p class="help">状态可在攻略管理中调整；重复操作不会覆盖编辑内容。</p><div class="actions">${ids.map((id,i)=>`<a class="button" href="#edit/${id}">${esc(mode==='split'?t.destinations[i]:'编辑攻略')} →</a><a class="button small" href="/?preview=1#guide/${id}" target="_blank" rel="noopener">预览 ↗</a>`).join('')}</div></div>`;
    return `<button type="button" class="button primary" data-planner="publication-preview" data-mode="${mode}">${count>1?'拆分为 '+count+' 篇攻略发布':'预览并发布攻略'}</button>`;
  }
  function renderDetail(){
    const t=detail,g=t.guide,complete=t.status==='done'&&g;
    const controls=['queued','running'].includes(t.status)?`<button type="button" class="button small" data-planner="cancel" data-id="${t.id}">停止生成</button>`:active(t.status)?'':`<button type="button" class="button small" data-planner="followup">继续修改</button>`;
    $('#planner-detail').innerHTML=`<div class="panel-top"><div><span class="eyebrow">${complete?'YOUR TRAVEL PLAN':'TRAVEL RESEARCH'} · #${t.id}</span><h2>${esc(g?.title||t.trip.destination||'旅行攻略参考')}</h2></div><div class="actions"><span class="agent-state ${esc(t.status)}">${esc(labels[t.status]||t.status)}</span>${controls}${!active(t.status)?`<button type="button" class="button small danger" data-planner="delete" data-id="${t.id}">删除记录</button>`:''}</div></div>
      ${t.parent_id?`<p class="help">根据 <button type="button" class="planner-text-button" data-planner="select" data-id="${t.parent_id}">#${t.parent_id} 的方案</button> 继续完善</p>`:''}
      <details><summary>查看这次需求</summary><p class="agent-request">${esc(t.prompt)}</p><p class="help">${esc([t.trip.origin&&'出发：'+t.trip.origin,t.trip.dates,`${t.trip.days} 天 / ${t.trip.people} 人`,t.trip.rooms,t.trip.budget,t.trip.companions,paceNames[t.trip.pace]&&'节奏：'+paceNames[t.trip.pace],t.trip.walking,t.trip.transport,t.trip.food&&'饮食：'+t.trip.food,t.trip.preferences,t.trip.excluded&&'排除：'+t.trip.excluded].filter(Boolean).join(' · '))}</p></details>
      ${complete?`<p class="planner-summary">${esc(g.summary)}</p><div class="planner-meta"><span>${esc(g.destination)} · ${g.days} 天</span><span>${esc(g.season)}</span><span>${esc(g.budget)}</span></div>
      <p class="planner-reference">${t.web_search_count?'已联网检索参考资料。':'未记录到联网检索，请另行核实。'} 门票、营业时间、价格和预约规则以出行时官方信息为准。</p>
      <div class="planner-result-actions actions">${publicationActions(t)}${t.guide_id?`<a class="button primary" href="#edit/${t.guide_id}">编辑已存档攻略 →</a>`:`<button type="button" class="button primary" data-planner="save">存为攻略草稿</button>`}<button type="button" class="button" data-planner="copy">复制正文</button><a class="button" href="/api/admin/travel-agent/tasks/${t.id}/export" download>下载图文 HTML</a><button type="button" class="button" data-planner="enrich">智能整理图文与路线</button></div>
      ${t.photo_count?`<p class="help">已保存 ${t.photo_count} 张参考照片；下载 HTML 后也可离线查看图片。</p>`:`<p class="help">这份方案暂未配入照片，可点击“智能整理图文与路线”重新整理。</p>`}${t.photo_missing?.length?`<p class="help">待补配图：${t.photo_missing.map(esc).join('、')}。缺少准确素材时保留文字，不用相似景点或不同菜品替代。</p>`:''}<div id="planner-publication"></div><article class="prose planner-prose">${AdminImages.prepareHTML(t.html)}</article>${g.sources?`<details class="planner-sources"><summary>参考资料汇总</summary><pre>${esc(g.sources)}</pre></details>`:''}`:
      `<p class="agent-answer">${esc(t.result||'任务已加入队列，轮到后会开始研究。')}</p>${t.progress.length?`<details open><summary>正在参考的资料</summary><ul class="planner-progress">${t.progress.map(p=>`<li>${esc(p)}</li>`).join('')}</ul></details>`:''}`}`;
  }
  async function refresh(token=epoch){
    if(token!==epoch||!here()||busy||document.hidden)return;
    const version=revision;const data=await api(endpoint);if(token!==epoch||!here()||version!==revision||busy)return;
    service(data.service);
    if(!familyDirty&&data.family_preferences){family=data.family_preferences;fillFamily();}
    tasks=expanded?[...new Map([...tasks,...data.tasks].map(t=>[t.id,t])).values()].sort((a,b)=>b.id-a.id):data.tasks;
    if(!expanded)nextBefore=data.next_before;
    renderTasks();const current=tasks.find(t=>t.id===selected);
    if(!detail||detail.id!==selected||active(detail.status)||(current&&current.updated_at!==detail.updated_at))await loadDetail(token);
  }
  function schedule(token){
    clearTimeout(timer);timer=setTimeout(async()=>{if(token!==epoch||!here())return;
      try{await refresh(token);}catch(e){if(token===epoch&&$('#planner-service'))$('#planner-service').textContent=e.message;}
      finally{if(token===epoch&&here())schedule(token);}
    },tasks.some(t=>active(t.status))?4000:20000);
  }
  function fill(trip,replace=false){const form=$('#planner-form');for(const key of fields){if(trip[key]!==undefined)form.elements[key].value=trip[key];else if(replace)form.elements[key].value=({days:4,people:1,mode:'itinerary'})[key]??'';}}
  function bind(){
    const familyForm=$('#planner-family-form');familyForm.addEventListener('input',()=>{familyDirty=true;syncDirty();});familyForm.addEventListener('submit',saveFamily);
    const form=$('#planner-form');form.addEventListener('input',()=>{tripDirty=true;syncDirty();});
    form.addEventListener('submit',async e=>{
      e.preventDefault();e.stopImmediatePropagation();if(busy||!form.reportValidity())return;
      const token=epoch;busy=true;const btn=$('button[type=submit]',form);btn.disabled=true;$('#planner-error').textContent='';
      const data=Object.fromEntries(new FormData(form)),trip={};for(const key of fields)trip[key]=['days','people'].includes(key)?Number(data[key]):data[key];
      const release=freezeForm(form);
      try{
        const prompt=data.prompt.trim()||(trip.mode==='compare'?'根据本次旅行条件推荐并比较候选目的地，按家庭出游图文模板整理完整方案。':'根据本次旅行条件，按家庭出游图文模板整理完整攻略。');
        const answer=await api(endpoint+'/tasks',{method:'POST',body:{prompt,trip,...(form.dataset.parent?{parent_id:Number(form.dataset.parent)}:{})}});
        if(token!==epoch)return;selected=answer.id;detail=null;form.prompt.value='';delete form.dataset.parent;tripDirty=false;syncDirty();
        $('#planner-followup').textContent='已提交，关闭页面后仍会继续；完成后可以继续修改或存档。';toast('旅行需求已提交');
      }catch(error){if(token===epoch)$('#planner-error').textContent=error.message;}
      finally{busy=false;release();btn.disabled=false;if(token===epoch)await refresh(token).catch(()=>{});}
    });
    $('#main').addEventListener('click',handle);
  }
  function text(){const g=detail.guide;return `# ${g.title}\n\n${g.summary}\n\n${g.body}\n\n## 参考资料\n\n${g.sources}\n`;}
  async function handle(e){
    const node=e.target.closest('[data-planner]');if(!node||busy)return;
    const action=node.dataset.planner,token=epoch;
    try{
      if(TaskManager.select('planner',action,node,tasks,checked))return;
      if(action==='apply-family'){
        if(!family.updated_at){$('#planner-family-error').textContent='请先保存家庭偏好，再带入本次规划。';return;}
        if(tripDirty&&!confirm('将保存的家庭偏好带入本次，替换出发地、住宿、预算和偏好；日期与目的地保留。继续？'))return;
        applyFamily();tripDirty=true;syncDirty();toast('已带入本次规划，可继续调整');
      }
      if(action==='select'){selected=Number(node.dataset.id);detail=null;renderTasks();await loadDetail(token);if(token===epoch)$('#planner-detail').scrollIntoView({behavior:'smooth',block:'start'});}
      if(action==='refresh')await refresh(token);
      if(action==='older'){
        if(!nextBefore)return;const version=revision;const data=await api(endpoint+'?before='+nextBefore);if(token!==epoch||version!==revision||busy)return;
        tasks=[...new Map([...tasks,...data.tasks].map(t=>[t.id,t])).values()].sort((a,b)=>b.id-a.id);nextBefore=data.next_before;expanded=true;renderTasks();
      }
      if(action==='followup'||action==='enrich'){
        const form=$('#planner-form');if(tripDirty&&!confirm('使用这份攻略的条件继续修改？当前未提交的表单内容将被替换。'))return;
        fill(detail.trip,true);form.dataset.parent=detail.id;form.prompt.value=action==='enrich'?'按智能图文攻略重新整理完整攻略，根据目的地特色、季节和偏好融合人文、自然与美食体验，保留原有日期、人数、房间数、预算和目的地约束，补齐景点体验、当地特色菜品、推荐街区、参考花费和对应照片查询，逐日写清游玩节点、顺路交通、上午下午晚上的执行表及午餐晚餐。按内置复核规范检查日期星期与周一闭馆、房间数和间夜、预算上下限与团队合计、照片对象和许可、官方预约渠道、首末日及雨天替换；合并旧版本的有效内容并去重，输出可独立存档的完整稿。':'';tripDirty=action==='enrich';syncDirty();
        $('#planner-followup').textContent='正在继续完善 #'+detail.id+'，会参考之前的要求和攻略。修改条件后写下新要求即可。';form.prompt.focus();form.scrollIntoView({behavior:'smooth',block:'start'});
      }
      if(action==='new'||action==='example'){
        if(tripDirty&&!confirm('替换当前未提交的旅行条件？'))return;
        const form=$('#planner-form');form.reset();delete form.dataset.parent;applyFamily();tripDirty=false;syncDirty();
        $('#planner-followup').textContent='新的一趟旅行，提交后可以继续修改。';
        if(action==='example'){
          fill({mode:'compare',destination:'推荐适合秋季家庭出游的三个候选地',dates:'秋季，具体日期待定',days:4,people:family.preferences.people??2,preferences:family.preferences.preferences||'城市人文、美食、轻松散步，少换酒店',pace:family.preferences.pace||'relaxed'});
          form.prompt.value='推荐三个适合四天三晚的目的地，比较季节、当地特色、交通、行程强度和预算，按当前同行情况与偏好规划。每天列出顺路行程、美食、休息余量、预约事项和雨天替换。';tripDirty=true;syncDirty();
        }
        form.prompt.focus();
      }
      if(action==='delete'||action==='delete-selected'){
        const ids=action==='delete'?[Number(node.dataset.id)]:[...checked];if(!ids.length)return;
        revision++;busy=true;const result=await TaskManager.remove(endpoint,ids);if(token!==epoch||!result)return;
        const removed=new Set(result.ids);tasks=tasks.filter(t=>!removed.has(t.id));for(const id of removed)checked.delete(id);
        if(removed.has(selected)){forgetTask(selected);await loadDetail(token);}
        const form=$('#planner-form');if(removed.has(Number(form.dataset.parent))){delete form.dataset.parent;$('#planner-followup').textContent='关联记录已删除，当前填写内容将作为新任务提交。';}
        renderTasks();toast('已删除 '+result.count+' 条任务记录');
      }
      if(action==='cancel'){await api(endpoint+'/tasks/'+node.dataset.id+'/cancel',{method:'POST',body:{}});toast('已请求停止');await refresh(token);}
      if(action==='publication-preview'){
        busy=true;node.disabled=true;const id=detail.id,mode=node.dataset.mode;
        const answer=await api(endpoint+'/tasks/'+id+'/publication?mode='+mode);
        if(token!==epoch||selected!==id)return;
        $('#planner-publication').innerHTML=`<section class="planner-publication-preview"><h3>${mode==='split'?'按候选地独立存档':'发布前预览'} · ${answer.guides.length} 篇</h3><p>检查下方内容后选择存为草稿或公开发布。公开发布后，所有访客都能看到。</p>${answer.guides.map(g=>`<details><summary>${esc(g.title)} · ${g.days} 天</summary><p>${esc(g.summary)}</p><article class="prose planner-prose">${AdminImages.prepareHTML(g.html)}</article><details><summary>参考资料</summary><pre>${esc(g.sources)}</pre></details></details>`).join('')}<div class="actions"><button type="button" class="button primary" data-planner="publish" data-id="${id}" data-mode="${mode}" data-status="public">公开发布这 ${answer.guides.length} 篇攻略</button><button type="button" class="button" data-planner="publish" data-id="${id}" data-mode="${mode}" data-status="draft">存为 ${answer.guides.length} 篇草稿</button><button type="button" class="button" data-planner="close-publication">收起预览</button></div></section>`;
        $('#planner-publication').scrollIntoView({behavior:'smooth',block:'start'});
      }
      if(action==='close-publication')$('#planner-publication').replaceChildren();
      if(action==='publish'){
        const id=Number(node.dataset.id);if(id!==detail?.id)return;
        busy=true;node.disabled=true;
        const answer=await api(endpoint+'/tasks/'+id+'/publish',{method:'POST',body:{mode:node.dataset.mode,status:node.dataset.status}});
        if(token!==epoch||selected!==id)return;
        detail=null;await loadDetail(token);
        toast(answer.already_saved?'已存档，未重复创建或覆盖':`已${node.dataset.status==='public'?'公开发布':'保存为草稿'} ${answer.guides.length} 篇攻略`);
      }
      if(action==='save'){
        busy=true;node.disabled=true;const answer=await api(endpoint+'/tasks/'+detail.id+'/save',{method:'POST',body:{}});
        if(token!==epoch)return;detail=null;await loadDetail(token);toast(answer.already_saved?'这份攻略已存档':'已保存为草稿，可进入编辑后发布');
      }
      if(action==='copy'){await navigator.clipboard.writeText(text());toast('已复制完整攻略正文');}

    }catch(error){toast(error.message,true);}finally{busy=false;node.disabled=false;}
  }
  return {page,stop};
})();
