/* Local visual editor shared by guides and travel records. No persistent drafts. */
const TravelEditor=(()=>{
 let current=null,loading=null;
 const vendor='/static/vendor/jodit-4.15.7/';
 function assets(){
  if(loading)return loading;
  loading=Promise.all([new Promise((resolve,reject)=>{
   const link=document.createElement('link');link.rel='stylesheet';link.href=vendor+'jodit.min.css';link.onload=resolve;link.onerror=()=>reject(Error('编辑器样式加载失败'));document.head.append(link);
  }),new Promise((resolve,reject)=>{
   const script=document.createElement('script');script.src=vendor+'jodit.min.js';script.onload=resolve;script.onerror=()=>reject(Error('编辑器加载失败'));document.head.append(script);
  })]).catch(error=>{loading=null;throw error;});return loading;
 }
 function owns(ctx){return current===ctx&&ctx.textarea.isConnected;}
 function serialized(ctx,html){
  const doc=new DOMParser().parseFromString(html,'text/html');
  for(const image of doc.querySelectorAll('img')){
   let src=image.getAttribute('src')||'';
   const temporary=src.match(/^\/api\/admin\/html-imports\/[a-f0-9]{32}\/images\/([a-f0-9]{32}\.webp)$/);
   if(temporary)src='/media/'+temporary[1];
   src=src.replace(/^(\/media\/[a-f0-9]{32}\.webp)\?w=(640|1280)$/,'$1');image.setAttribute('src',src);
   for(const attr of ['loading','decoding','width','height','style','srcset'])image.removeAttribute(attr);
  }
  return doc.body.innerHTML;
 }
 function sync(ctx=current){
  if(!ctx||!ctx.ready||ctx.mode!=='visual')return;
  const html=serialized(ctx,ctx.editor.value);
  ctx.textarea.value=html===ctx.baseline?ctx.original:html;
 }
 function changed(ctx){if(!owns(ctx)||!ctx.ready)return;const before=ctx.textarea.value;sync(ctx);if(ctx.textarea.value!==before)ctx.onChange();}
 function destroy(){const ctx=current;current=null;if(!ctx)return;ctx.editor?.destruct();document.body.classList.remove('editor-focused');}
 async function mount(textarea,options){
  destroy();
  const ctx={textarea,...options,original:textarea.value,ready:false,pending:true,uploading:false,mode:'visual'};current=ctx;
  const wrap=document.createElement('div');wrap.className='travel-editor';textarea.before(wrap);wrap.append(textarea);ctx.wrap=wrap;
  wrap.insertAdjacentHTML('afterbegin',`<div class="travel-editor-bar"><div class="travel-editor-tabs" role="group" aria-label="正文编辑方式"><button type="button" data-writing="visual" aria-pressed="true">可视化编辑</button><button type="button" data-writing="source" aria-pressed="false">源码</button></div><button type="button" data-writing="focus">专注写作</button></div><p class="travel-editor-tip" role="status">正在打开编辑器…</p><div class="travel-editor-mount"></div>`);
  ctx.tip=wrap.querySelector('.travel-editor-tip');ctx.host=wrap.querySelector('.travel-editor-mount');textarea.hidden=true;
  textarea.addEventListener('input',()=>{if(owns(ctx)&&ctx.mode==='source')ctx.onChange();});
  wrap.querySelector('.travel-editor-bar').addEventListener('click',async event=>{
   const action=event.target.closest('[data-writing]')?.dataset.writing;if(!action||!owns(ctx))return;
   if(action==='focus'){wrap.classList.toggle('is-focused');document.body.classList.toggle('editor-focused',wrap.classList.contains('is-focused'));event.target.textContent=wrap.classList.contains('is-focused')?'退出专注':'专注写作';return;}
   if(ctx.pending||ctx.uploading||action===ctx.mode)return;
   try{
    if(action==='source'){sync(ctx);ctx.mode='source';ctx.editor.container.hidden=true;textarea.hidden=false;textarea.focus();ctx.tip.textContent='可编辑 Markdown 或 HTML 源码，切回可视化查看排版。';}
    else{
     ctx.pending=true;const source=textarea.value;const result=await ctx.preview(source);if(!owns(ctx))return;
     ctx.ready=false;ctx.editor.value=result.html;ctx.original=source;ctx.baseline=serialized(ctx,ctx.editor.value);ctx.mode='visual';ctx.ready=true;ctx.editor.container.hidden=false;textarea.hidden=true;ctx.tip.textContent='直接点击文字或表格修改；选中文字可设置格式。修改后记得保存。';
    }
    for(const button of wrap.querySelectorAll('[data-writing=source],[data-writing=visual]'))button.setAttribute('aria-pressed',String(button.dataset.writing===ctx.mode));
   }catch(error){toast(error.message,true);}finally{ctx.pending=false;}
  });
  try{
   const [,result]=await Promise.all([assets(),options.html!==undefined?Promise.resolve({html:options.html}):ctx.preview(ctx.original)]);
   if(!owns(ctx))return;
   const cells=Jodit.defaultOptions.popup.cells.filter(item=>typeof item!=='string'&&!['valign','align'].includes(item.name));
   ctx.host.innerHTML='<textarea aria-label="可视化正文"></textarea>';
   const buttons=['undo','redo','|','paragraph','bold','italic','ul','ol','|','link','table',
    {name:'site-image',icon:'image',tooltip:'从素材库插入图片',exec:()=>{remember();ctx.pickImage();}},
    {name:'site-upload',icon:'upload',tooltip:'上传图片',exec:()=>{remember();ctx.fileInput.click();}}];
   ctx.editor=Jodit.make(ctx.host.firstChild,{
    language:'zh_cn',height:560,minHeight:360,width:'100%',toolbarAdaptive:false,toolbarSticky:false,
    buttons,buttonsMD:buttons,buttonsSM:buttons,buttonsXS:buttons,showCharsCounter:false,showWordsCounter:false,showXPathInStatusbar:false,
    saveModeInStorage:false,asyncStorage:{defaultProvider:'memory'},defaultMode:1,spellcheck:false,
    enter:'p',useSearch:false,askBeforePasteHTML:false,askBeforePasteFromWord:false,defaultActionOnPaste:'insert_as_html',
    disablePlugins:['source','file','video','iframe','image','image-properties','image-processor','paste-storage','drag-and-drop','drag-and-drop-element','resizer','resize-cells','color','font','class-span','speech-recognize','ai-assistant','about','powered-by-jodit','search'],
    cleanHTML:{removeEmptyElements:false,fillEmptyParagraph:false,replaceOldTags:{b:'strong',i:'em'},collapseEmptyValueToEmptyString:true,removeEventAttributes:true,safeJavaScriptLink:true,denyTags:'script,style,iframe,object,embed,form,input,button,textarea,select,link,meta'},
    popup:{cells:Jodit.atom(cells),img:Jodit.atom([])},controls:{paragraph:{list:Jodit.atom({p:'正文',h2:'大标题',h3:'小标题',h4:'小节标题',blockquote:'引用'})}},
    placeholder:'从一段文字、一张图片或一张行程表开始…',editorClassName:'prose'
   });
   ctx.editor.value=result.html;ctx.baseline=serialized(ctx,ctx.editor.value);ctx.ready=true;ctx.pending=false;
   ctx.editor.editor.setAttribute('aria-label','正文可视化编辑区');ctx.editor.editor.setAttribute('role','textbox');ctx.editor.editor.setAttribute('aria-multiline','true');
   ctx.editor.e.on('change',()=>changed(ctx));
   ctx.tip.textContent='直接点击文字或表格修改；选中文字可设置格式。修改后记得保存。';
   ctx.fileInput=document.createElement('input');ctx.fileInput.type='file';ctx.fileInput.accept='.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp';ctx.fileInput.multiple=true;ctx.fileInput.hidden=true;wrap.append(ctx.fileInput);
   ctx.fileInput.addEventListener('change',()=>upload(ctx,[...ctx.fileInput.files]));
   for(const type of ['paste','drop'])ctx.editor.editor.addEventListener(type,event=>{
    const files=[...(event.clipboardData||event.dataTransfer)?.files||[]];if(!files.length)return;
    event.preventDefault();event.stopImmediatePropagation();remember();upload(ctx,files);
   },true);
  }catch(error){
   if(!owns(ctx))return;ctx.mode='source';textarea.hidden=false;ctx.host.hidden=true;ctx.tip.textContent=error.message+'，仍可使用源码编辑，已填写内容会保留。';toast(ctx.tip.textContent,true);
  }finally{ctx.pending=false;}
 }
 function remember(){const ctx=current;if(ctx?.ready&&ctx.mode==='visual')ctx.bookmark=ctx.editor.s.save();}
 function insertImage(url){const ctx=current;if(!ctx)return false;
  if(ctx.mode==='source'){ctx.textarea.setRangeText('\n\n![旅行图片]('+url+')\n\n',ctx.textarea.selectionStart,ctx.textarea.selectionEnd,'end');ctx.onChange();return true;}
  if(!ctx.ready)return false;
  if(ctx.bookmark){ctx.editor.s.restore();ctx.bookmark=null;}
  ctx.editor.s.insertHTML('<p><img src="'+esc(ctx.imageURL?ctx.imageURL(url):url)+'" alt="旅行图片"></p>');changed(ctx);return true;
 }
 async function upload(ctx,files){
  if(!owns(ctx)||ctx.uploading)return;ctx.uploading=true;const errors=[];let count=0;
  try{for(const [i,file] of files.entries()){
   if(!owns(ctx))break;ctx.tip.textContent=`正在上传 ${i+1} / ${files.length}：${file.name}`;
   try{if(file.size>50*1024*1024)throw Error('图片不能超过 50 MB');const form=new FormData();form.append('image',file);const result=await api('/upload',{method:'POST',body:form});if(owns(ctx)){insertImage(result.url);count++;}}
   catch(error){errors.push(file.name+'：'+error.message);}
  }}finally{ctx.uploading=false;ctx.fileInput.value='';if(owns(ctx)){ctx.tip.textContent=`已插入 ${count} 张图片，保存后完成存档。`+(errors.length?' 未完成：'+errors.join('；'):'');if(errors.length)toast('部分图片未上传，请查看编辑器提示。',true);}}
 }
 async function replace(body){const ctx=current;if(!ctx)return;
  if(ctx.mode==='source'){ctx.textarea.value=body;ctx.onChange();return;}
  ctx.pending=true;
  try{const result=await ctx.preview(body);if(!owns(ctx))return;ctx.ready=false;ctx.editor.value=result.html;ctx.original=body;ctx.textarea.value=body;ctx.baseline=serialized(ctx,ctx.editor.value);ctx.ready=true;ctx.onChange();}finally{ctx.pending=false;}
 }
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&current?.wrap.classList.contains('is-focused')&&!document.querySelector('dialog[open]')){current.wrap.querySelector('[data-writing=focus]').click();}});
 return {preload:()=>assets().catch(()=>{}),mount,destroy,sync,replace,remember,insertImage,get busy(){return !!(current?.pending||current?.uploading);}};
})();
