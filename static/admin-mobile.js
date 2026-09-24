/* Responsive presentation only: reuse existing forms, validation and save handlers. */
(()=>{
 const main=document.querySelector('#main'),dialog=document.querySelector('#dialog-content');
 const bar=document.createElement('div');bar.className='admin-savebar';bar.hidden=true;
 bar.innerHTML='<span class="admin-save-status" aria-live="polite"></span><button type="button" class="button primary">保存</button>';
 document.querySelector('#admin-shell').append(bar);
 let frame=0,source=null;
 function enhance(){
  frame=0;
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
