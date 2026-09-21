/* Account credentials go only to the authenticated account endpoint, never a model task. */
const AdminAccounts=(()=>{
 let generation=0;
 async function open(){
  const token=++generation,routeGeneration=state.generation;
  const data=await api('/admin/accounts');if(token!==generation||routeGeneration!==state.generation)return;
  showDialog(`<h2>管理员管理</h2><p class="help">所有管理员具有相同管理权限，包括查看私密攻略和足迹。已有账号在自己的「账号设置」中修改。</p><div class="table-wrap"><table><thead><tr><th>登录账号</th><th>显示名称</th></tr></thead><tbody>${data.accounts.map(a=>`<tr><td>${esc(a.username)}</td><td>${esc(a.display_name)}</td></tr>`).join('')}</tbody></table></div><form id="create-admin-form"><h3>新增管理员</h3>${field('username','新管理员登录账号','','required minlength="3" maxlength="32" pattern="[A-Za-z0-9_]{3,32}" autocomplete="off" autocapitalize="none" spellcheck="false"')}${field('display_name','显示名称','','required maxlength="40"')}${field('password','新管理员密码','','type="password" required minlength="8" maxlength="256" autocomplete="new-password"')}${field('confirm_password','确认新密码','','type="password" required minlength="8" maxlength="256" autocomplete="new-password"')}${field('current_password','你的当前登录密码','','type="password" required maxlength="256" autocomplete="current-password"')}<p class="help">提交成功后账号立即生效，无需运行助手任务或发布代码。</p><p class="form-error" id="create-admin-error" role="alert"></p><button type="submit" class="button primary">创建管理员</button></form>`);
  const form=$('#create-admin-form');let pending=false;
  form.addEventListener('submit',async event=>{
   event.preventDefault();event.stopImmediatePropagation();if(pending||!form.reportValidity())return;
   pending=true;const button=$('button[type=submit]',form);button.disabled=true;$('#create-admin-error').textContent='';
   try{const result=await api('/admin/accounts',{method:'POST',body:Object.fromEntries(new FormData(form))});form.reset();toast('管理员 '+result.account.username+' 已创建');if(token===generation&&$('#dialog').open){$('#dialog').close();}}
   catch(error){if(token===generation&&form.isConnected&&$('#dialog').open)$('#create-admin-error').textContent=error.message;}
   finally{pending=false;button.disabled=false;}
  });
 }
 document.addEventListener('click',event=>{if(event.target.closest('[data-admin-accounts]'))open().catch(error=>toast(error.message,true));});
 document.querySelector('#dialog').addEventListener('close',()=>{generation++;document.querySelector('#create-admin-form')?.reset();});
 return {open};
})();
