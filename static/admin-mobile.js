/* Responsive presentation only: reuse existing forms, validation and save handlers. */
(()=>{
 const main=document.querySelector('#main'),dialog=document.querySelector('#dialog-content');
 const bar=document.createElement('div');bar.className='admin-savebar';bar.hidden=true;
 bar.innerHTML='<span class="admin-save-status" aria-live="polite"></span><button type="button" class="button primary">保存</button>';
 document.querySelector('#admin-shell').append(bar);
 const tabs=document.createElement('nav');tabs.id='admin-mobile-tabs';tabs.setAttribute('aria-label','常用管理功能');
 const pin='<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>';
 const chat='<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11a9 9 0 0 1-9 9H4l-2 2V11a9 9 0 1 1 19 0Z"/><path d="M7 10h10M7 14h6"/></svg>';
 tabs.innerHTML=[['guides',icon('book'),'攻略管理'],['records',pin,'旅行足迹'],['media',icon('image'),'图片素材'],['travel-agent',chat,'旅游助手']].map(([key,image,label])=>`<a href="#${key}">${image}<span>${label}</span></a>`).join('');
 document.querySelector('#admin-shell').append(tabs);

 let frame=0,source=null;
 function enhance(){
  frame=0;
  const view=state.route.split('/')[0],active=['edit','new','trash','import'].includes(view)?'guides':['record-edit','record-new','record-trash'].includes(view)?'records':view;
  for(const link of tabs.querySelectorAll('a')){if(link.hash==='#'+active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
  document.body.classList.toggle('has-admin-tabs',!!state.user);

  for(const table of document.querySelectorAll('#main .table-wrap>table,#dialog-content .table-wrap>table')){
   if(table.closest('.prose,.travel-editor'))continue;
   const headers=[...table.querySelectorAll('thead th')];if(!headers.length)continue;
   table.classList.add('admin-card-table');table.classList.toggle('has-selection',!!table.querySelector('thead input[type=checkbox]'));
   for(const row of table.querySelectorAll('tbody tr'))for(const [index,cell] of [...row.cells].entries()){
    cell.dataset.label=headers[index]?.textContent.trim()||'';
    cell.classList.toggle('card-title',!!cell.querySelector('.title-cell'));
    cell.classList.toggle('card-actions',!!cell.querySelector('.table-actions'));
   }
  }
  const form=main.querySelector('#editor-form,#record-editor-form');
  source=form?.querySelector('button[type=submit]')||null;
  bar.hidden=!source||!state.user;
  document.body.classList.toggle('has-mobile-save',!bar.hidden);
  if(source){const button=bar.querySelector('button');button.disabled=source.disabled||TravelEditor.busy||main.inert;
   button.textContent=source.disabled?'正在处理…':form.id==='record-editor-form'?'保存足迹':'保存攻略';
   bar.querySelector('span').textContent=(state.dirty?'未保存 · ':'当前：')+(statusName[form.elements.status?.value]||'待保存');}
 }
 function schedule(){if(!frame)frame=requestAnimationFrame(enhance);}
 new MutationObserver(schedule).observe(main,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','inert','aria-busy']});
 new MutationObserver(schedule).observe(dialog,{childList:true,subtree:true});
 main.addEventListener('input',schedule);main.addEventListener('change',schedule);
 bar.querySelector('button').addEventListener('click',()=>{if(source?.isConnected&&!source.disabled&&!TravelEditor.busy&&!main.inert)source.click();schedule();});
 document.addEventListener('click',event=>{const sidebar=document.querySelector('.sidebar');if(matchMedia('(max-width:900px)').matches&&sidebar.classList.contains('menu-open')&&!sidebar.contains(event.target))setAdminMenu(false);});
 const keyboard=()=>document.body.classList.toggle('admin-keyboard-open',!!window.visualViewport&&window.innerHeight-window.visualViewport.height>150);
 window.visualViewport?.addEventListener('resize',keyboard);keyboard();schedule();
})();
