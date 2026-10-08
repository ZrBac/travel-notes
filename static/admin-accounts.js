/* Account credentials go only to the authenticated account endpoint, never a model task. */
const AdminAccounts=(()=>{
 let generation=0;
 async function open(){
  const token=++generation,routeGeneration=state.generation;
  const data=await api('/admin/accounts');if(token!==generation||routeGeneration!==state.generation)return;
  showDialog(`<h2>管理员管理</h2><p class="help">所有管理员具有相同管理权限，包括查看私密攻略和足迹。已有账号在自己的「账号设置」中修改。当前登录账号不能移除。</p><div class="table-wrap"><table><thead><tr><th>登录账号</th><th>显示名称</th><th>操作</th></tr></thead><tbody>${data.accounts.map(a=>`<tr><td>${esc(a.username)}</td><td>${esc(a.display_name)}</td><td><div class="table-actions">${a.id===state.user.id?'<span class="muted">当前账号</span>':`<button type="button" class="button small danger" data-remove-admin="${a.id}">移除</button>`}</div></td></tr>`).join('')}</tbody></table></div><form id="create-admin-form"><h3>新增管理员</h3>${field('username','新管理员登录账号','','required minlength="3" maxlength="32" pattern="[A-Za-z0-9_]{3,32}" autocomplete="off" autocapitalize="none" spellcheck="false"')}${field('display_name','显示名称','','required maxlength="40"')}${field('password','新管理员密码','','type="password" required minlength="8" maxlength="256" autocomplete="new-password"')}${field('confirm_password','确认新密码','','type="password" required minlength="8" maxlength="256" autocomplete="new-password"')}${field('current_password','你的当前登录密码','','type="password" required maxlength="256" autocomplete="current-password"')}<p class="help">提交成功后账号立即生效，无需运行助手任务或发布代码。</p><p class="form-error" id="create-admin-error" role="alert"></p><button type="submit" class="button primary">创建管理员</button></form>`);
  for(const button of document.querySelectorAll('[data-remove-admin]'))button.addEventListener('click',()=>remove(data.accounts.find(a=>String(a.id)===button.dataset.removeAdmin)));
  const form=$('#create-admin-form');let pending=false;
  form.addEventListener('submit',async event=>{
   event.preventDefault();event.stopImmediatePropagation();if(pending||!form.reportValidity())return;
   pending=true;const button=$('button[type=submit]',form);button.disabled=true;$('#create-admin-error').textContent='';
   try{const result=await api('/admin/accounts',{method:'POST',body:Object.fromEntries(new FormData(form))});form.reset();toast('管理员 '+result.account.username+' 已创建');if(token===generation&&$('#dialog').open){$('#dialog').close();}}
   catch(error){if(token===generation&&form.isConnected&&$('#dialog').open)$('#create-admin-error').textContent=error.message;}
   finally{pending=false;button.disabled=false;}
  });
 }
 function remove(account){
  if(!account||account.id===state.user.id)return;
  const token=++generation;
  showDialog(`<h2>移除管理员</h2><p>将移除账号 <strong>${esc(account.username)}</strong>（${esc(account.display_name)}）。</p><p class="help">该账号将无法继续登录，已有登录会话也会失效。攻略、足迹、图片和操作记录会保留。移除后不能直接恢复，重新新增需要设置密码。</p><form id="remove-admin-form">${field('current_password','你的当前登录密码','','type="password" required maxlength="256" autocomplete="current-password"')}<p class="form-error" id="remove-admin-error" role="alert"></p><div class="actions"><button type="button" class="button" id="cancel-remove-admin">返回</button><button type="submit" class="button danger">确认移除</button></div></form>`);
  const form=$('#remove-admin-form'),back=$('#cancel-remove-admin');let pending=false;
  back.addEventListener('click',()=>{if(!pending)open().catch(error=>toast(error.message,true));});
  form.addEventListener('submit',async event=>{
   event.preventDefault();event.stopImmediatePropagation();if(pending||!form.reportValidity())return;
   pending=true;const button=$('button[type=submit]',form);button.disabled=true;back.disabled=true;$('#remove-admin-error').textContent='';
   try{
    await api('/admin/accounts/'+account.id,{method:'DELETE',body:Object.fromEntries(new FormData(form))});form.reset();toast('管理员 '+account.username+' 已移除');
    if(token===generation&&$('#dialog').open)await open().catch(error=>{ $('#dialog').close();toast('账号已移除，列表刷新失败：'+error.message,true); });
   }catch(error){if(token===generation&&form.isConnected&&$('#dialog').open)$('#remove-admin-error').textContent=error.message;}
   finally{pending=false;button.disabled=false;back.disabled=false;}
  });
 }
 document.addEventListener('click',event=>{if(event.target.closest('[data-admin-accounts]'))open().catch(error=>toast(error.message,true));});
 document.querySelector('#dialog').addEventListener('close',()=>{generation++;document.querySelector('#create-admin-form')?.reset();document.querySelector('#remove-admin-form')?.reset();});
 return {open};
})();
