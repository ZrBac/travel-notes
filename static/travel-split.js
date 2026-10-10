/* Local-only trip budget. No names, reimbursement amounts or expenses are sent to an API. */
const TravelSplit=(()=>{
 const storageName='travel-expense-split-v1';
 let draft=null,result=null,storageWarning='',serial=0;
 const yuan=cents=>'¥'+(cents/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
 const uid=prefix=>prefix+Date.now().toString(36)+(++serial);
 const input=(label,attr,value,extra='')=>`<label>${label}<input ${attr} value="${esc(value)}" ${extra}></label>`;
 const number=(label,attr,value,extra='')=>input(label,attr,value,`type="number" min="0" max="99999999.99" step="0.01" inputmode="decimal" ${extra}`);
 const valueOrEmpty=value=>Number(value)===0?'':value;
 const amount=value=>value===''?'0':value;
 function fresh(){return TravelSplitMath.blank();}
 function load(){
  if(draft)return;
  try{
   const raw=localStorage.getItem(storageName);
   if(raw){
    const data=JSON.parse(raw);
    if(data.version!==1||!Array.isArray(data.members)||!data.members.length||data.members.length>50||!Array.isArray(data.expenses)||data.expenses.length>200||data.members.some(m=>!m||typeof m.id!=='string')||data.expenses.some(e=>!e||!Array.isArray(e.participants)))throw Error('invalid');
    draft=data;
   }
  }catch{storageWarning='上次保存的内容暂时无法读取。修改前不会覆盖旧内容。';}
  if(!draft)draft=fresh();
  draft=TravelSplitMath.asPublic(draft);
  // Replace only the untouched old three-category form; entered items stay separate.
  const oldNames=['吃饭','市内交通','门票和游玩'];
  if(draft.expenses.length===3&&draft.expenses.every((e,i)=>(e.name===oldNames[i]||(i===1&&e.name==='交通'))&&Number(e.price)===0&&Number(e.upper)===0&&String(e.quantity)==='1'&&!e.perPerson&&e.participants.length===draft.members.length&&draft.members.every(m=>e.participants.includes(m.id)))){
   draft.expenses=[{...fresh().expenses[0],participants:draft.members.map(m=>m.id)}];
  }
  // Shared items keep their amounts and participants; personal items are archived.
  for(const e of draft.expenses)if(typeof e.upperAuto!=='boolean')e.upperAuto=Number(e.upper)===Number(e.price);
 }
 function persist(){
  try{localStorage.setItem(storageName,JSON.stringify(draft));storageWarning='';}
  catch{storageWarning='浏览器暂时无法保存，请导出结果后再关闭页面。';}
  storageStatus();
 }
 function storageStatus(){
  const node=$('#split-storage');
  if(node){node.textContent=storageWarning||'自动保存在这个浏览器，可导出结果；换手机或清理浏览器数据后不会同步。';node.classList.toggle('is-error',!!storageWarning);}
 }
 function members(){
  return draft.members.map(m=>`<div class="split-member" data-member="${esc(m.id)}">${input('姓名','data-member-field="name"',m.name,'maxlength="40" required')}${number('这个人的报销额度 / 元','data-member-field="cap"',m.cap)}<button class="split-remove" type="button" data-split="remove-member" ${draft.members.length===1?'disabled':''}>移除成员</button></div>`).join('');
 }
 function groupFields(){
  const funded=draft.members.filter(m=>Number(m.cap)>0),caps=[...new Set(funded.map(m=>String(Number(m.cap))))];
  return `<details id="split-group-settings" class="split-details"><summary>更改人数和额度</summary><div class="split-group-fields">${input('总共几个人','data-group="people"',draft.members.length,'type="number" min="1" max="50" step="1" inputmode="numeric"')}${input('其中几个人有额度','data-group="funded"',funded.length,'type="number" min="0" max="50" step="1" inputmode="numeric"')}${number('有额度的人，每人能报多少 / 元','data-group="cap"',caps.length===1?caps[0]:'','placeholder="例如 1500"')}</div>${caps.length>1?'<p class="split-help">当前成员的额度不同，可以在下面逐人调整；使用此处更新会将有额度的成员统一为同一金额。</p>':''}<p id="split-group-error" class="split-error" role="alert" hidden></p><button class="button secondary small" type="button" data-split="apply-group">更新人数与额度</button><details id="split-member-settings" class="split-details"><summary>逐人调整姓名或特殊额度</summary><div class="split-members">${members()}</div><button class="button secondary small" type="button" data-split="add-member">＋ 添加成员</button></details></details>`;
 }
 function expenseRows(){
  return draft.expenses.map((e,i)=>{
   const label=e.perPerson?'每人每次金额 / 元':String(e.quantity)==='1'?'合计金额 / 元':'每次合计金额 / 元';
   return `<article class="split-expense" data-expense="${esc(e.id)}" aria-label="第 ${i+1} 笔费用"><div class="split-entry-fields">${input('费用名称','data-expense-field="name"',e.name,'maxlength="80" required placeholder="例如：周五晚餐"')}<div class="split-quick-cost">${number(label,'data-expense-field="price"',valueOrEmpty(e.price),'placeholder="0.00"')}</div></div><p class="split-help split-cost-note" data-cost-note></p><div class="split-expense-controls"><details class="split-expense-details split-details"><summary>预算和参与人</summary><div class="split-detail-fields">${number('最高预算 / 元（与上面的金额口径一致）','data-expense-field="upper"',e.upperAuto?'':e.upper,'placeholder="不填就按上面的金额计算"')}<label>填的是哪种金额<select data-expense-field="perPerson"><option value="true" ${e.perPerson?'selected':''}>每个人的金额</option><option value="false" ${!e.perPerson?'selected':''}>所有参与者的总金额</option></select></label>${input('要花几次','data-expense-field="quantity"',e.quantity,'type="number" min="1" max="365" step="1" inputmode="numeric"')}</div><p class="split-help">谁参加这项费用？默认所有人一起分摊。</p><div class="split-participants">${draft.members.map(m=>`<label class="split-check"><input type="checkbox" data-participant="${esc(m.id)}" ${e.participants.includes(m.id)?'checked':''}><span data-person-label="${esc(m.id)}">${esc(m.name)}</span></label>`).join('')}</div></details><button type="button" class="split-remove" data-split="remove-expense" aria-label="移除第 ${i+1} 笔费用">移除</button></div></article>`;
  }).join('')||'<p class="split-help">点击「新增费用」开始记录。</p>';
 }
 function listTotal(r){
  $('#split-expense-total').textContent=r?yuan(r.expected.total):'—';
  $('#split-expense-maximum').textContent=r?(r.worst.total!==r.expected.total?'最高预算 '+yuan(r.worst.total):''): '请完善费用和报销信息后查看合计';
 }
 function personalArchive(){
  const rows=draft.personalExpenses||[];if(!rows.length)return '';
  const total=(e,field)=>{
   try{return yuan(TravelSplitMath.money(e[field])*Number(e.quantity)*(e.perPerson?e.participants.length:1));}
   catch{return '原输入：'+esc(e[field]);}
  };
  return `<details id="split-personal-archive" class="split-panel split-details"><summary>原个人费用 · ${rows.length} 项已移出公共分摊</summary><p class="split-help">原来的住宿、机票金额保留在这里供核对，不计入公共费用。</p><div class="split-table-wrap"><table class="split-table"><thead><tr><th>个人费用</th><th>原预计合计</th><th>原最高合计</th></tr></thead><tbody>${rows.map(e=>`<tr><th>${esc(e.name)}</th><td>${total(e,'price')}</td><td>${total(e,'upper')}</td></tr>`).join('')}</tbody></table></div></details>`;
 }
 function mount(){
  const openIds=[...document.querySelectorAll('.split-tool details[id][open]')].map(n=>n.id);
  load();updateShell('split');document.title='费用分摊 · '+(state.site?.site_name||'行笺');
  $('#app').innerHTML=`<div class="split-tool">${heading('公共费用，每人还要掏多少？','机票报销款一起共享，吃饭、交通、游玩费用在这里分摊。','费用分摊')}<form id="split-form" novalidate><section class="split-panel split-group-panel"><h2>一起出游的人</h2><p id="split-capacity" class="split-group-summary"></p>${groupFields()}</section><section class="split-panel"><div class="split-section-head"><h2>公共费用清单</h2><button type="button" class="split-demo-link" data-split="demo">不会填？试试示例</button></div><p class="split-help">每笔填名称和合计金额，例如晚餐、包车、门票。个人机票和酒店不计入这里。</p><div id="split-expenses">${expenseRows()}</div><div class="split-expenses-footer"><button type="button" class="button secondary small" data-split="add-expense">＋ 新增费用</button><div class="split-list-total" aria-live="polite" aria-atomic="true"><span>公共费用合计</span><strong id="split-expense-total">¥0.00</strong><small id="split-expense-maximum"></small></div></div></section><section class="split-panel"><h2>可共享的机票报销款</h2>${number('用于大家一起分摊的报销款 / 元','data-setting="conservativeClaim"',draft.conservativeClaim,'placeholder="拿不准时填 0"')}<p class="split-help">默认按机票足额报销填写 9,000 元，可修改。即使聚餐和游玩本身不能报销，也会用这笔共享款抵扣公共费用。</p><details id="split-claim-settings" class="split-details"><summary>调整预计报销金额</summary>${number('正常情况下预计能报多少 / 元','data-setting="expectedClaim"',draft.expectedClaim)}<p class="split-help">默认预计和保守计算都使用 9,000 元，受成员总额度限制。保守金额不能高于预计金额。</p></details></section></form><section id="split-results" tabindex="-1"><div id="split-error" class="split-error" role="alert" hidden></div><div id="split-output"></div></section>${personalArchive()}<div class="split-bottom"><button type="button" class="split-remove" data-split="reset">清空重新算</button><p id="split-storage" class="split-storage" role="status"></p></div></div>`;
  for(const id of openIds)if($('#'+id))$('#'+id).open=true;
  const root=$('.split-tool');root.addEventListener('input',edit);root.addEventListener('change',event=>{if(event.target.matches('select,input[type=checkbox]'))edit(event);});root.addEventListener('click',click);
  $('#split-form').addEventListener('submit',event=>event.preventDefault());storageStatus();calculate();
 }
 function edit(event){
  const node=event.target,mrow=node.closest('[data-member]'),erow=node.closest('[data-expense]');
  if(node.dataset.memberField&&mrow){
   const m=draft.members.find(m=>m.id===mrow.dataset.member);m[node.dataset.memberField]=node.dataset.memberField==='cap'?amount(node.value):node.value;
   if(node.dataset.memberField==='name')for(const label of document.querySelectorAll('[data-person-label]'))if(label.dataset.personLabel===m.id)label.textContent=node.value;
  }else if(node.dataset.expenseField&&erow){
   const e=draft.expenses.find(e=>e.id===erow.dataset.expense),field=node.dataset.expenseField;
   if(field==='upper'){e.upperAuto=node.value==='';e.upper=e.upperAuto?e.price:node.value;}
   else if(field==='price'){e.price=amount(node.value);if(e.upperAuto)e.upper=e.price;}
   else e[field]=field==='eligible'?node.checked:field==='perPerson'?node.value==='true':node.value;
   if(field==='perPerson'){
    const id=e.id;persist();mount();const updated=[...document.querySelectorAll('[data-expense]')].find(row=>row.dataset.expense===id);updated.querySelector('details').open=true;return;
   }
  }else if(node.dataset.participant&&erow){
   const e=draft.expenses.find(e=>e.id===erow.dataset.expense);e.participants=[...erow.querySelectorAll('[data-participant]:checked')].map(n=>n.dataset.participant);
  }else if(node.dataset.setting)draft[node.dataset.setting]=amount(node.value);else return;
  persist();calculate();
 }
 function summaries(){
  try{
   const cap=draft.members.reduce((sum,m)=>sum+TravelSplitMath.money(m.cap),0),funded=draft.members.filter(m=>Number(m.cap)>0),same=new Set(funded.map(m=>Number(m.cap))).size===1;
   $('#split-capacity').innerHTML=`<strong>${draft.members.length} 人同行</strong><span>${funded.length} 人${same?'各有 '+yuan(TravelSplitMath.money(funded[0].cap)):'有'}机票报销额度，合计 ${yuan(cap)}，一起共享。</span>`;
  }catch{$('#split-capacity').textContent='请检查成员的报销额度。';}
  for(const row of document.querySelectorAll('[data-expense]')){
   const e=draft.expenses.find(e=>e.id===row.dataset.expense);
   try{
    const price=TravelSplitMath.money(e.price),total=price*Number(e.quantity)*(e.perPerson?e.participants.length:1);
    row.querySelector('[data-cost-note]').textContent=(e.perPerson?`${e.participants.length} 人 × ${e.quantity} 次`:`${e.participants.length} 人分摊${Number(e.quantity)>1?'，共 '+e.quantity+' 次':''}`)+`，合计 ${yuan(total)}`+(e.upperAuto?'':'（已另设最高预算）');
   }catch{row.querySelector('[data-cost-note]').textContent='请填写有效金额。';}
  }
 }
 function calculate(){
  summaries();const error=$('#split-error'),output=$('#split-output');result=null;
  const openIds=[...output.querySelectorAll('details[id][open]')].map(n=>n.id);
  try{
   result=TravelSplitMath.calculate(draft);listTotal(result);error.hidden=true;const r=result,average=s=>yuan(Math.round(s.ownTotal/r.members.length));
   if(r.none.total===0){output.innerHTML='<div class="split-empty"><h2>填一笔费用，就能看到结果</h2><p>每笔填名称和金额，清单会自动加总，再用共享报销款抵扣并分摊。</p></div>';return;}
   const sameExpected=new Set(r.expected.net).size===1,sameWorst=new Set(r.worst.net).size===1;
   output.innerHTML=`<div class="split-summary"><div class="split-stat"><span>${sameExpected?'公共费用 · 预计每人自付':'公共费用 · 预计平均每人自付'}</span><strong>${average(r.expected)}</strong><small>总费用 ${yuan(r.expected.total)}<br>共享款抵扣 ${yuan(r.expected.applied)}</small></div><div class="split-stat is-worst"><span>${sameWorst?'公共费用 · 每人最多准备':'公共费用 · 有人最多需要准备'}</span><strong>${yuan(r.worst.maxPerson)}</strong><small>费用按最高预算算<br>共享款抵扣 ${yuan(r.worst.applied)}</small></div></div>${r.expected.remaining||r.worst.remaining?`<p class="split-remainder" role="status">预计剩余共享报销款 <strong>${yuan(r.expected.remaining)}</strong>；按最高预算花费后剩余 <strong>${yuan(r.worst.remaining)}</strong>。剩余款单独列出，供大家另行分配。</p>`:''}<p class="split-result-note">这里只计算公共费用。报销到账前仍可能需要先垫付；结果未扣除个人垫付款。超预算或报销不足时，需要准备更多。</p><details id="split-person-results" class="split-details split-panel"><summary>看看每个人分别掏多少</summary><div class="split-table-wrap"><table class="split-table split-person-table"><thead><tr><th>成员</th><th>预计自付</th><th>最多准备</th></tr></thead><tbody>${r.members.map((m,i)=>`<tr><th>${esc(m.name)}</th><td>${yuan(r.expected.net[i])}</td><td><strong>${yuan(r.worst.net[i])}</strong></td></tr>`).join('')}</tbody><tfoot><tr><th>合计</th><td>${yuan(r.expected.ownTotal)}</td><td>${yuan(r.worst.ownTotal)}</td></tr></tfoot></table></div></details><details id="split-calculation-details" class="split-details split-panel"><summary>查看费用明细与计算说明</summary><div class="split-table-wrap"><table class="split-table split-cost-table"><thead><tr><th>费用</th><th>预计总额</th><th>最高预算</th></tr></thead><tbody>${r.expenses.map(e=>`<tr><th>${esc(e.name)}</th><td>${yuan(e.expected)}</td><td>${yuan(e.maximum)}</td></tr>`).join('')}</tbody></table></div><p class="split-help">共享报销取成员总额度和填写到账金额中的较小值，来源为机票，不要求公共费用本身可以报销。最多准备的金额按公共费用最高预算减去共享款计算。</p><p class="split-help">报销抵扣由所有人均享，每人最多抵扣自己的费用；剩余再分给其他人，精确到分。谁参加了哪些项目，就分摊哪些项目。</p><p class="split-help">如果完全没报下来，最高预算下有人最多需要 ${yuan(r.none.maxPerson)}。</p></details>${r.expected.reimbursement<r.planned||r.worst.reimbursement<r.conservative?'<p class="split-limit-note">填写的共享报销款超过了成员总额度，已按额度上限计算。</p>':''}<div class="split-result-actions"><button type="button" class="button secondary" data-split="export">导出结果</button></div>`;
   for(const id of openIds)if($('#'+id))$('#'+id).open=true;
  }catch(err){listTotal(null);error.hidden=false;error.textContent=err.message.replaceAll('保守报销总额','至少能报下来的金额').replaceAll('预计报销总额','预计报销金额').replaceAll('单价上限','最高预算').replaceAll('预计单价','填写金额');output.innerHTML='';}
 }
 function report(){
  const r=result;
  const lines=['公共费用分摊测算','生成时间：'+new Date().toLocaleString('zh-CN'),`成员 ${r.members.length} 人；机票报销总额度 ${yuan(r.capacity)}`,`预计共享报销 ${yuan(r.planned)}；保守共享报销 ${yuan(r.conservative)}`,'','公共费用明细：',...r.expenses.map(e=>`${e.name}：${e.perPerson?'每人':'合计'} × ${e.quantity} 次；参与者 ${r.members.filter((m,i)=>e.indexes.includes(i)).map(m=>m.name).join('、')}；预计 ${yuan(e.expected)}；最高预算 ${yuan(e.maximum)}`),'',`预计公共费用 ${yuan(r.expected.total)}；共享报销 ${yuan(r.expected.reimbursement)}；实际抵扣 ${yuan(r.expected.applied)}；剩余报销 ${yuan(r.expected.remaining)}；总自付 ${yuan(r.expected.ownTotal)}`,`公共费用最高预算 ${yuan(r.worst.total)}；共享报销 ${yuan(r.worst.reimbursement)}；实际抵扣 ${yuan(r.worst.applied)}；剩余报销 ${yuan(r.worst.remaining)}；总自付 ${yuan(r.worst.ownTotal)}`,'','每人公共费用结果：',...r.members.map((m,i)=>`${m.name}｜额度 ${yuan(m.cap)}｜共享抵扣 ${yuan(r.expected.benefits[i])}｜预计自付 ${yuan(r.expected.net[i])}｜最多准备 ${yuan(r.worst.net[i])}｜完全无报销 ${yuan(r.none.net[i])}`)];
  if(draft.personalExpenses?.length)lines.push('','原个人费用（已移出公共分摊，仅供核对）：',...draft.personalExpenses.map(e=>`${e.name}｜原${e.perPerson?'每人':'合计'}输入 ${e.price} 元｜原上限 ${e.upper} 元｜数量 ${e.quantity}｜原参与人数 ${e.participants.length}`));
  lines.push('','口径：个人机票和酒店自行承担；机票报销款作为独立共享资金，不受公共费用可报销金额限制，但不超过成员总额度。公共费用按参与者均分，报销抵扣全体均享，单人抵扣不超过自身费用。余款单独列出，供大家另行分配。未独立设置最高预算时沿用填写金额。报销到账前可能需要先垫付；结果未扣除垫付款，不能直接作为转账清单。');
  return lines.join('\n');
 }
 function applyGroup(){
  const error=$('#split-group-error');
  try{
   const people=$('[data-group=people]').value,funded=$('[data-group=funded]').value,cap=$('[data-group=cap]').value;
   if(!/^\d{1,2}$/.test(people)||Number(people)<1||Number(people)>50)throw Error('总人数填 1～50 的整数');
   if(!/^\d{1,2}$/.test(funded)||Number(funded)>Number(people))throw Error('有额度的人数不能超过总人数');
   const capCents=TravelSplitMath.money(amount(cap),'每人报销额度');
   if(Number(funded)>0&&capCents===0)throw Error('请填写有额度的人每人能报多少');
   if(Number(people)<draft.members.length&&!confirm('人数减少会移除末尾的成员和额度，已填费用会保留。继续？'))return;
   const oldSize=draft.members.length,oldCapacity=draft.members.reduce((sum,m)=>sum+TravelSplitMath.money(m.cap),0),all=draft.expenses.filter(e=>e.participants.length===oldSize);
   const rows=draft.members.slice(0,Number(people));
   while(rows.length<Number(people))rows.push({id:uid('p'),name:'成员 '+(rows.length+1),cap:'0'});
   rows.forEach((m,i)=>m.cap=i<Number(funded)?amount(cap):'0');draft.members=rows;
   for(const e of draft.expenses)e.participants=all.includes(e)?rows.map(m=>m.id):e.participants.filter(id=>rows.some(m=>m.id===id));
   const capacity=Number(funded)*capCents;
   if(draft.reimbursementSource!=='external'&&TravelSplitMath.money(draft.expectedClaim)===oldCapacity&&TravelSplitMath.money(draft.conservativeClaim)<=capacity)draft.expectedClaim=(capacity/100).toFixed(2);
   persist();mount();toast('人数和额度已更新');
  }catch(err){error.hidden=false;error.textContent=err.message;}
 }
 function click(event){
  const node=event.target.closest('[data-split]');if(!node)return;const action=node.dataset.split;
  if(action==='apply-group'){applyGroup();return;}
  if(action==='add-member'){
   if(draft.members.length>=50){toast('最多支持 50 人',true);return;}
   const m={id:uid('p'),name:'新成员',cap:'0'},old=draft.members.length;
   for(const e of draft.expenses)if(e.participants.length===old)e.participants.push(m.id);draft.members.push(m);
  }else if(action==='remove-member'){
   const id=node.closest('[data-member]').dataset.member;if(draft.members.length<=1)return;
   if(!confirm('移除这位成员及其报销额度？费用仍会保留。'))return;
   draft.members=draft.members.filter(m=>m.id!==id);for(const e of draft.expenses)e.participants=e.participants.filter(p=>p!==id);
  }else if(action==='add-expense'){
   if(draft.expenses.length>=200){toast('最多支持 200 项费用',true);return;}
   draft.expenses.push({id:uid('e'),name:'公共费用',price:'0',upper:'0',upperAuto:true,quantity:'1',perPerson:false,eligible:false,participants:draft.members.map(m=>m.id)});
  }else if(action==='remove-expense'){
   if(!confirm('删除这项费用？'))return;draft.expenses=draft.expenses.filter(e=>e.id!==node.closest('[data-expense]').dataset.expense);
  }else if(action==='demo'||action==='reset'){
   if(!confirm(action==='demo'?'用公共费用演示价格替换当前输入？机票报销共享 9,000 元，费用可自行修改。':'清空公共费用，恢复为 9 人、共享机票报销 9,000 元？'))return;
   draft=action==='demo'?TravelSplitMath.demo():fresh();for(const e of draft.expenses)e.upperAuto=Number(e.upper)===Number(e.price);
  }else if(action==='export'){
   if(!result)return;
   const url=URL.createObjectURL(new Blob(['\ufeff'+report()],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='旅行费用分摊-'+new Date().toISOString().slice(0,10)+'.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
  }else return;
  persist();mount();
  if(action==='add-member'){$('#split-group-settings').open=true;$('#split-member-settings').open=true;$('.split-member:last-child input').focus();}
  if(action==='add-expense'){const name=$('.split-expense:last-child [data-expense-field=name]');name.focus();name.select();}
 }
 return {mount};
})();
