/* Local-only trip budget. No names, reimbursement amounts or expenses are sent to an API. */
const TravelSplit=(()=>{
 const storageName='travel-expense-split-v1';let draft=null,result=null,storageWarning='',serial=0;
 const yuan=cents=>'¥'+(cents/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
 const uid=prefix=>prefix+Date.now().toString(36)+(++serial);
 const input=(label,attr,value,extra='')=>`<label>${label}<input ${attr} value="${esc(value)}" ${extra}></label>`;
 const number=(label,attr,value)=>input(label,attr,value,'type="number" min="0" max="99999999.99" step="0.01" inputmode="decimal" required');
 function load(){
  if(draft)return;
  try{
   const raw=localStorage.getItem(storageName);if(raw){const data=JSON.parse(raw);if(data.version!==1||!Array.isArray(data.members)||!data.members.length||data.members.length>50||!Array.isArray(data.expenses)||data.expenses.length>200||data.members.some(m=>!m||typeof m.id!=='string')||data.expenses.some(e=>!e||!Array.isArray(e.participants)))throw Error('invalid');draft=data;}
  }catch{storageWarning='上次的本地数据暂时无法读取，本次修改前不会覆盖旧数据。';}
  if(!draft)draft=TravelSplitMath.blank();
 }
 function persist(){
  try{localStorage.setItem(storageName,JSON.stringify(draft));storageWarning='';}
  catch{storageWarning='当前浏览器无法保存数据，请及时导出结果；关闭后可能丢失。';}
  storageStatus();
 }
 function storageStatus(){const node=$('#split-storage');if(node){node.textContent=storageWarning||'自动保存在当前浏览器，不上传服务器；不同设备不会自动同步，清理浏览器数据会删除记录。';node.classList.toggle('is-error',!!storageWarning);}}
 function memberRows(){return draft.members.map(m=>`<div class="split-member" data-member="${esc(m.id)}">${input('姓名','data-member-field="name"',m.name,'maxlength="40" required')}${number('报销额度 / 元','data-member-field="cap"',m.cap)}<button class="split-remove" type="button" data-split="remove-member" ${draft.members.length===1?'disabled':''}>移除成员</button></div>`).join('');}
 function expenseRows(){return draft.expenses.map(e=>`<article class="split-expense" data-expense="${esc(e.id)}"><div class="split-expense-fields">${input('费用名称','data-expense-field="name"',e.name,'maxlength="80" required')}<label>单价口径<select data-expense-field="perPerson"><option value="true" ${e.perPerson?'selected':''}>每位参与者</option><option value="false" ${!e.perPerson?'selected':''}>全体参与者合计</option></select></label>${number('预计单价 / 元','data-expense-field="price"',e.price)}${number('单价上限 / 元','data-expense-field="upper"',e.upper)}${input('次数 / 晚数','data-expense-field="quantity"',e.quantity,'type="number" min="1" max="365" step="1" inputmode="numeric" required')}</div><div class="split-expense-options"><label class="split-check"><input type="checkbox" data-expense-field="eligible" ${e.eligible?'checked':''}>计入可报销费用</label><button type="button" class="split-remove" data-split="remove-expense">删除这项费用</button></div><details><summary>分摊成员 · <span data-participant-count>${e.participants.length}</span> 人（点开调整）</summary><div class="split-participants">${draft.members.map(m=>`<label class="split-check"><input type="checkbox" data-participant="${esc(m.id)}" ${e.participants.includes(m.id)?'checked':''}><span data-person-label="${esc(m.id)}">${esc(m.name)}</span></label>`).join('')}</div></details></article>`).join('')||'<p class="split-help">添加住宿、聚餐、交通、门票等费用后即可计算。</p>';}
 function mount(){
  const membersOpen=$('#split-member-settings')?.open||false;load();updateShell('split');document.title='费用分摊 · '+(state.site?.site_name||'行笺');
  $('#app').innerHTML=`<div class="split-tool">${heading('一起出发，费用算清楚。','报销款共享，费用按参与成员分摊。先看预计花费，再看预算上限下每人要准备多少。','旅行工具 · 费用分摊')}<div class="split-toolbar"><button type="button" class="button secondary" data-split="results">查看计算结果 ↓</button><button type="button" class="button secondary" data-split="demo">载入 9 人示例</button><button type="button" class="button secondary" data-split="reset">清空重算</button></div><p id="split-storage" class="split-storage" role="status"></p><form id="split-form" novalidate><section class="split-panel"><div class="split-section-head"><h2>01 · 成员与报销额度</h2><button class="button secondary small" type="button" data-split="add-member">＋ 添加成员</button></div><p class="split-help">默认 9 人，其中 6 人各有 1,500 元额度。各自按实际规则申报，约定将到账报销款共享给全体成员。</p><p id="split-capacity" class="split-setup-summary"></p><details id="split-member-settings" ${membersOpen?'open':''}><summary>编辑成员姓名与额度</summary><div class="split-members">${memberRows()}</div></details></section><section class="split-panel"><h2>02 · 报销按多少计算</h2><div class="split-claims">${number('预计可到账报销总额 / 元','data-setting="expectedClaim"',draft.expectedClaim)}${number('保守可到账报销总额 / 元','data-setting="conservativeClaim"',draft.conservativeClaim)}</div><p class="split-help">预计值用于正常预算；保守值用于预算上限情景。不确定能报多少时，保守值填 0。实际计算还会受总额度、已勾选可报销费用限制；额度不会直接当作现金。</p></section><section class="split-panel"><div class="split-section-head"><h2>03 · 住宿、聚餐与游玩</h2><button type="button" class="button secondary small" data-split="add-expense">＋ 添加费用</button></div><p class="split-help">单人单间住 3 晚：选「每位参与者」，填房间每晚价格，数量填 3。整桌聚餐：选「全体参与者合计」，填整桌费用，数量填 1。所有金额均为人民币。</p><div id="split-expenses">${expenseRows()}</div><p class="split-help">只有实际符合报销条件的部分才计入可报销费用；一笔费用只有部分可报销时，请拆为两项。工具按你填写的报销金额测算，不核验单位报销规则。</p></section></form><section id="split-results" tabindex="-1"><div id="split-error" class="split-error" role="alert" hidden></div><div id="split-output"></div></section></div>`;
  const root=$('.split-tool');root.addEventListener('input',edit);root.addEventListener('change',event=>{if(event.target.matches('select,input[type=checkbox]'))edit(event);});root.addEventListener('click',click);
  $('#split-form').addEventListener('submit',event=>event.preventDefault());storageStatus();calculate();
 }
 function edit(event){
  const node=event.target,mrow=node.closest('[data-member]'),erow=node.closest('[data-expense]');
  if(node.dataset.memberField&&mrow){const m=draft.members.find(m=>m.id===mrow.dataset.member);m[node.dataset.memberField]=node.value;
   if(node.dataset.memberField==='name')for(const label of document.querySelectorAll('[data-person-label]'))if(label.dataset.personLabel===m.id)label.textContent=node.value;
  }else if(node.dataset.expenseField&&erow){const e=draft.expenses.find(e=>e.id===erow.dataset.expense),field=node.dataset.expenseField;e[field]=field==='eligible'?node.checked:field==='perPerson'?node.value==='true':node.value;
  }else if(node.dataset.participant&&erow){const e=draft.expenses.find(e=>e.id===erow.dataset.expense);e.participants=[...erow.querySelectorAll('[data-participant]:checked')].map(n=>n.dataset.participant);erow.querySelector('[data-participant-count]').textContent=e.participants.length;
  }else if(node.dataset.setting)draft[node.dataset.setting]=node.value;else return;
  persist();calculate();
 }
 function calculate(){
  const error=$('#split-error'),output=$('#split-output');result=null;
  try{result=TravelSplitMath.calculate(draft);error.hidden=true;const r=result;
   $('#split-capacity').textContent=`${r.members.length} 人 · ${r.members.filter(m=>m.cap>0).length} 人有额度 · 总额度 ${yuan(r.capacity)} · 全部用满且均分时，约 ${yuan(Math.floor(r.capacity/r.members.length))} / 人`;
   const average=s=>yuan(Math.round(s.ownTotal/r.members.length));
   output.innerHTML=`<div class="split-summary"><div class="split-stat"><span>正常预计 · 人均自付</span><strong>${average(r.expected)}</strong><small>预计总费用 ${yuan(r.expected.total)}<br>按报销 ${yuan(r.expected.reimbursement)} 计算</small></div><div class="split-stat is-worst"><span>预算上限 · 单人最高自付</span><strong>${yuan(r.worst.maxPerson)}</strong><small>费用全部取上限，报销取保守值<br>人均 ${average(r.worst)} · 合计自付 ${yuan(r.worst.ownTotal)}</small></div><div class="split-stat"><span>完全报销失败 · 单人最高自付</span><strong>${yuan(r.none.maxPerson)}</strong><small>上限费用 ${yuan(r.none.total)} 全部自付<br>报销到账前还需要有人先垫付费用</small></div></div><div class="split-panel"><h2>每个人分别承担多少</h2><p class="split-help">「预算上限自付」是费用不超过所填上限、且保守报销金额能够到账时的情景计算。实际超预算或报销少于保守值时，可能需要更多。</p><div class="split-table-wrap"><table class="split-table split-person-table"><thead><tr><th>成员</th><th>个人额度</th><th>预计费用份额</th><th>预计共享抵扣</th><th>预计自付</th><th>预算上限自付</th><th>无报销自付</th></tr></thead><tbody>${r.members.map((m,i)=>`<tr><th>${esc(m.name)}</th><td>${yuan(m.cap)}</td><td>${yuan(r.expected.costs[i])}</td><td>${yuan(r.expected.benefits[i])}</td><td>${yuan(r.expected.net[i])}</td><td><strong>${yuan(r.worst.net[i])}</strong></td><td>${yuan(r.none.net[i])}</td></tr>`).join('')}</tbody><tfoot><tr><th>合计</th><td>${yuan(r.capacity)}</td><td>${yuan(r.expected.total)}</td><td>${yuan(r.expected.reimbursement)}</td><td>${yuan(r.expected.ownTotal)}</td><td>${yuan(r.worst.ownTotal)}</td><td>${yuan(r.none.ownTotal)}</td></tr></tfoot></table></div><p class="split-help">手机可左右滑动表格查看全部金额。成员参加的项目不同，自付也可能不同；最终负担不等于现在要转账的金额，本工具暂不抵扣个人垫付款。</p></div><div class="split-panel"><h2>费用与报销怎么算</h2><div class="split-table-wrap"><table class="split-table"><thead><tr><th>费用</th><th>参与人数</th><th>预计总额</th><th>总额上限</th><th>可报销</th></tr></thead><tbody>${r.expenses.map(e=>`<tr><th>${esc(e.name)}</th><td>${e.indexes.length}</td><td>${yuan(e.expected)}</td><td>${yuan(e.maximum)}</td><td>${e.eligible?'是':'否'}</td></tr>`).join('')}</tbody></table></div><p class="split-formula">预计报销 = 总额度、预计可报销费用、预计到账金额三者中的最小值：${yuan(r.expected.reimbursement)}。<br>上限情景报销 = 总额度、上限可报销费用、保守到账金额三者中的最小值：${yuan(r.worst.reimbursement)}。<br>每项费用由勾选成员均分；报销抵扣由全体均享，每人最多抵扣自身费用，剩余再分给其他人。精确到分，余数按成员顺序分配。</p>${r.expected.reimbursement<r.planned||r.worst.reimbursement<r.conservative?'<p class="split-error">填写的到账金额超过了总额度或可报销费用，已按较小值计算，未将剩余额度算作现金。</p>':''}</div><div class="split-result-actions"><button type="button" class="button secondary" data-split="export">导出完整测算（文本）</button></div>`;
  }catch(err){error.hidden=false;error.textContent=err.message;output.innerHTML='';$('#split-capacity').textContent='请先修正下方提示，再查看金额。';}
 }
 function report(){const r=result;return ['旅行费用分摊测算','生成时间：'+new Date().toLocaleString('zh-CN'),`成员 ${r.members.length} 人；总额度 ${yuan(r.capacity)}`,`填写的预计报销 ${yuan(r.planned)}；保守报销 ${yuan(r.conservative)}`,'','费用明细：',...r.expenses.map(e=>`${e.name}：${e.perPerson?'每人':'合计'} × ${e.quantity} 次/晚；参与者 ${r.members.filter((m,i)=>e.indexes.includes(i)).map(m=>m.name).join('、')}；预计 ${yuan(e.expected)}；上限 ${yuan(e.maximum)}；${e.eligible?'计入':'不计入'}可报销费用`),'',`预计总费用 ${yuan(r.expected.total)}；预计报销 ${yuan(r.expected.reimbursement)}；总自付 ${yuan(r.expected.ownTotal)}`,`预算上限总费用 ${yuan(r.worst.total)}；保守报销实际计入 ${yuan(r.worst.reimbursement)}；总自付 ${yuan(r.worst.ownTotal)}`,'','每人结果：',...r.members.map((m,i)=>`${m.name}｜额度 ${yuan(m.cap)}｜预计费用 ${yuan(r.expected.costs[i])}｜共享抵扣 ${yuan(r.expected.benefits[i])}｜预计自付 ${yuan(r.expected.net[i])}｜预算上限自付 ${yuan(r.worst.net[i])}｜完全无报销 ${yuan(r.none.net[i])}`),'','口径：报销取额度、对应情景可报销费用、填写到账金额的最小值。各项费用按参与者均分；报销款全体均享，抵扣不超过本人费用，余数按成员顺序分配。预算上限不是无限风险下的保证；本结果未扣除垫付款，不能直接作为转账清单。'].join('\n');}
 function click(event){
  const node=event.target.closest('[data-split]');if(!node)return;const action=node.dataset.split;
  if(action==='results'){$('#split-results').scrollIntoView({behavior:'smooth'});$('#split-results').focus({preventScroll:true});return;}
  if(action==='add-member'){
   if(draft.members.length>=50){toast('最多支持 50 人',true);return;}
   const m={id:uid('p'),name:'新成员',cap:'0'};const old=draft.members.length;
   for(const e of draft.expenses)if(e.participants.length===old)e.participants.push(m.id);draft.members.push(m);
  }else if(action==='remove-member'){
   const id=node.closest('[data-member]').dataset.member;if(draft.members.length<=1)return;
   if(!confirm('移除这位成员及其报销额度？相关费用仍会保留，请重新核对分摊人数。'))return;
   draft.members=draft.members.filter(m=>m.id!==id);for(const e of draft.expenses)e.participants=e.participants.filter(p=>p!==id);
  }else if(action==='add-expense'){
   if(draft.expenses.length>=200){toast('最多支持 200 项费用',true);return;}
   draft.expenses.push({id:uid('e'),name:'新增费用',price:'0',upper:'0',quantity:'1',perPerson:false,eligible:false,participants:draft.members.map(m=>m.id)});
  }else if(action==='remove-expense'){
   if(!confirm('删除这项费用？'))return;draft.expenses=draft.expenses.filter(e=>e.id!==node.closest('[data-expense]').dataset.expense);
  }else if(action==='demo'||action==='reset'){
   if(!confirm(action==='demo'?'用示例替换当前输入？示例价格仅用于演示，并假设 9,000 元报销可到账。':'清空费用，恢复为 9 人、6 人各 1,500 元额度？'))return;
   draft=action==='demo'?TravelSplitMath.demo():TravelSplitMath.blank();
  }else if(action==='export'){
   if(!result)return;const url=URL.createObjectURL(new Blob(['\ufeff'+report()],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='旅行费用分摊-'+new Date().toISOString().slice(0,10)+'.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
  }else return;
  persist();mount();if(action==='add-member'){$('#split-member-settings').open=true;$('.split-member:last-child input').focus();}if(action==='add-expense')$('.split-expense:last-child input').focus();
 }
 return {mount};
})();
