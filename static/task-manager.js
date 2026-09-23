// Shared task selection and explicit confirmation of the whole dependency branch.
const TaskManager=(()=>{
 const active=status=>['queued','running','testing','publishing'].includes(status);
 const labels={queued:'排队中',running:'处理中',testing:'测试中',publishing:'发布中',ready:'待发布',done:'已完成',failed:'未完成',cancelled:'已停止',published:'已发布',manual:'需单独部署'};
 let closeCurrent=null;
 function bar(prefix){return `<div class="task-selection" id="${prefix}-selection"><label><input type="checkbox" data-${prefix}="select-all" aria-label="全选已显示的可删除任务">全选已显示</label><span data-task-count>未选择</span><button class="button small danger" type="button" data-${prefix}="delete-selected" disabled>删除所选</button><button class="task-text-action" type="button" data-${prefix}="clear-selection" disabled>取消选择</button></div><p class="task-selection-help">处理中记录不可删除；有关联的后续记录会在确认时一起列出。</p>`;}
 function row(task,content,prefix,checked){return `<div class="task-row"><label class="task-check"><input type="checkbox" data-${prefix}="check" data-id="${task.id}" aria-label="选择任务 #${task.id}" ${checked.has(task.id)?'checked':''} ${active(task.status)?'disabled':''}></label>${content}<button class="task-text-action task-delete" type="button" data-${prefix}="delete" data-id="${task.id}" ${active(task.status)?'disabled title="等待任务结束后可删除"':''} aria-label="删除任务 #${task.id}">删除</button></div>`;}
 function update(prefix,tasks,checked){
  const usable=tasks.filter(t=>!active(t.status)),ids=new Set(usable.map(t=>t.id));for(const id of checked)if(!ids.has(id))checked.delete(id);
  const bar=$('#'+prefix+'-selection');if(!bar)return;
  const all=$('[data-'+prefix+'="select-all"]',bar);all.checked=!!ids.size&&checked.size===ids.size;all.indeterminate=checked.size>0&&checked.size<ids.size;all.disabled=!ids.size;
  $('[data-task-count]',bar).textContent=checked.size?'已选 '+checked.size+' 条':'未选择';
  for(const button of bar.querySelectorAll('button'))button.disabled=!checked.size;
  for(const input of document.querySelectorAll('[data-'+prefix+'="check"]')){input.checked=checked.has(Number(input.dataset.id));input.closest('.task-row').classList.toggle('is-checked',input.checked);}
 }
 function select(prefix,action,node,tasks,checked){
  if(action==='check'){const id=Number(node.dataset.id);if(node.checked)checked.add(id);else checked.delete(id);}
  else if(action==='select-all'){checked.clear();if(node.checked)for(const t of tasks)if(!active(t.status))checked.add(t.id);}
  else if(action==='clear-selection')checked.clear();else return false;
  update(prefix,tasks,checked);return true;
 }
 function cancel(){closeCurrent?.();}
 async function remove(endpoint,ids){
  cancel();
  showDialog('<h2>检查删除范围</h2><p>正在检查所选记录和关联的后续任务…</p>');
  const dialog=$('#dialog'),content=$('#dialog-content');
  return new Promise(resolve=>{
   let finished=false,writing=false,closed=false,plan=null,needsCheck=false;
   function finish(result){if(finished)return;finished=true;dialog.removeEventListener('close',onClose);dialog.removeEventListener('cancel',onCancel);if(closeCurrent===abort)closeCurrent=null;resolve(result);}
   function abort(){closed=true;if(dialog.open)dialog.close();if(!writing)finish(null);}
   function onClose(){closed=true;if(!writing)finish(null);}
   function onCancel(event){if(writing)event.preventDefault();}
   closeCurrent=abort;dialog.addEventListener('close',onClose);dialog.addEventListener('cancel',onCancel);
   async function check(){
    try{
     plan=await api(endpoint+'/tasks/delete-preview',{method:'POST',body:{ids}});if(finished||closed)return;
     needsCheck=false;
     content.innerHTML=`<h2>删除 ${plan.ids.length} 条任务记录？</h2><p class="task-delete-summary">你选择了 ${plan.selected_ids.length} 条${plan.added_count?'，另有 '+plan.added_count+' 条后续关联记录需一起删除':''}。</p><p class="help">删除后无法恢复。已发布的网站、已存档攻略和图片会保留；尚未存档的生成结果和待发布候选将无法再通过这些记录使用。</p>${plan.blocked_ids.length?'<p class="form-error">这组记录中有任务正在处理，本次不能删除。请先停止并等待结束，或取消选择相关上游记录。</p>':''}<div class="task-delete-list">${plan.tasks.map(t=>`<div><span><strong>#${t.id} · ${esc(t.title)}</strong><small>${t.selected?'所选记录':'后续关联'}${t.parent_id?' · 接续 #'+t.parent_id:''}</small></span><span class="agent-state ${esc(t.status)}">${esc(labels[t.status]||t.status)}</span></div>`).join('')}</div><p id="task-delete-error" class="form-error" role="alert"></p><div class="actions"><button class="button danger" id="task-delete-confirm" type="button" ${plan.can_delete?'':'disabled'}>确认删除 ${plan.ids.length} 条</button><button class="button" id="task-delete-cancel" type="button">取消</button></div>`;
     $('#task-delete-cancel').onclick=abort;$('#task-delete-confirm').onclick=commit;
    }catch(error){if(finished||closed)return;content.innerHTML='<h2>未能检查删除范围</h2><p class="form-error">'+esc(error.message)+'</p><button class="button" id="task-delete-cancel" type="button">关闭</button>';$('#task-delete-cancel').onclick=abort;}
   }
   async function commit(){
    if(writing||finished||closed)return;if(needsCheck){await check();return;}
    writing=true;for(const button of dialog.querySelectorAll('button'))button.disabled=true;
    try{const result=await api(endpoint+'/tasks/bulk-delete',{method:'POST',body:{ids,confirmation:plan.confirmation}});finish(result);if(dialog.open)dialog.close();}
    catch(error){if(closed){finish(null);return;}$('#task-delete-error').textContent=error.message;needsCheck=true;$('#task-delete-confirm').textContent='重新检查删除范围';}
    finally{writing=false;for(const button of dialog.querySelectorAll('button'))button.disabled=false;}
   }
   void check();
  });
 }
 return {bar,row,update,select,remove,cancel};
})();
