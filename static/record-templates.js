// Outlines for actual travel memories. No invented visits, costs or image URLs.
window.RecordTemplates=(()=>{
 const catalog=[
  {id:'day',name:'一日随记',description:'一段路线、几个难忘瞬间、当天美食和实际花费，适合短途或旅行中的一天。'},
  {id:'journey',name:'多日游记',description:'按已填写的开始、结束日期生成逐日手记，再记录计划与实际的差别。请先填好结束日期。'},
  {id:'food',name:'美食记录',description:'记录实际吃过的菜、店铺、照片、口味和账单，留下值得再来的理由。'}
 ];
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const table=(head,rows)=>'<div class="trip-table-wrap"><table><thead><tr>'+head.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(x=>'<td>'+esc(x)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
 function date(value){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))throw Error('请先填写有效的游玩日期。');
  const result=new Date(value+'T00:00:00Z');
  if(!Number.isFinite(result.valueOf())||result.toISOString().slice(0,10)!==value)throw Error('游玩日期无效。');
  return result;
 }
 const photo=caption=>'<blockquote><p>照片位置：'+esc(caption)+'（可插入照片，或在上方相册补充说明；完成后删除此提示。）</p></blockquote>';
 function build(id,values={}){
  if(!catalog.some(t=>t.id===id))throw Error('请选择足迹模板。');
  const start=date(values.start_date),end=values.end_date?date(values.end_date):start;
  if(end<start)throw Error('结束日期不能早于开始日期。');
  if(id==='journey'&&!values.end_date)throw Error('请先填写结束日期，再生成多日游记。');
  const days=Math.round((end-start)/86400000)+1;
  if(days>365)throw Error('多日手记最多生成365天，较长旅行可以分篇记录。');
  const period=values.start_date+(end>start?' — '+values.end_date:'');
  const intro='<div class="trip-overview"><p><strong>'+esc(values.destination||'地点待填写')+' · '+esc(period)+'</strong></p><p>和谁同行：待填写。用一句话记住这趟旅行：待填写。</p></div>';
  const costs='<h2>实际花了多少</h2><p><strong>实际花费：</strong>'+esc(values.actual_cost||'待填写')+'。口径：待写明人数、币种和包含范围。</p>'+table(['项目','实际金额','包含什么／备注'],[['交通','待填写','待填写'],['住宿','待填写','待填写'],['餐饮','待填写','待填写'],['门票／体验','待填写','待填写'],['其他','待填写','待填写'],['合计','待填写','确认分项与总额一致']]);
  const notes='<h2>下次还想再来吗</h2><p><strong>最值得保留的体验：</strong>待填写。</p><p><strong>想调整的一件事：</strong>待填写。</p><p><strong>给同行朋友的真实建议：</strong>待填写，可写排队、体力、天气或实际用时。</p>';
  let body;
  if(id==='day')body=intro+'<h2>这一天怎么过的</h2><p><strong>实际路线：</strong>出发地点 → 去过的地点 → 用餐／休息 → 返回。</p>'+table(['时段','实际去了哪里','最深的印象'],[['上午','待填写','待填写'],['下午','待填写','待填写'],['晚上','待填写','待填写']])+'<h2>最难忘的片刻</h2>'+photo('当天最喜欢的一张风景或合照')+'<p>当时发生了什么、为什么想把它留下：待填写。</p><h2>今天吃了什么</h2>'+photo('菜品与店铺，写清照片对应哪一道菜')+table(['店铺／地点','吃了什么','实际花费与感受'],[['待填写','待填写','待填写']])+costs+notes;
  if(id==='journey'){
   const dates=Array.from({length:days},(_,i)=>new Date(start.valueOf()+i*86400000).toISOString().slice(0,10));
   body=intro+'<h2>这趟旅行，一眼回顾</h2>'+table(['日期','实际地点与主题','住在哪里'],dates.map(d=>[d,'待填写','待填写／当天返程']))+'<h2>每天留下的片刻</h2>'+dates.map((d,i)=>'<div class="trip-day"><h3>D'+(i+1)+'｜'+d+'</h3><p><strong>实际路线：</strong>待填写。</p>'+photo('这一天的照片或美食')+'<p><strong>看见与体验：</strong>待填写。</p><p><strong>吃了什么：</strong>待填写菜品、地点与真实感受。</p><p><strong>一个想记住的细节：</strong>待填写。</p></div>').join('')+'<h2>计划与实际有什么不同</h2>'+table(['原计划','实际情况','以后怎么安排'],[['待填写','待填写','待填写']])+costs+notes;
  }
  if(id==='food'){
   const meal=n=>'<div class="trip-card"><div class="trip-card-copy"><h3>第'+n+'站｜店铺或菜名待填写</h3>'+photo('这家店实际吃过的菜品')+'<p><strong>地点与到店时间：</strong>待填写。</p><p><strong>吃了什么、几个人分享：</strong>待填写。</p><p><strong>味道、份量与忌口：</strong>待填写。</p><p><strong>实际花费、排队与服务：</strong>待填写。</p><p><strong>还会不会再来：</strong>待填写原因。</p></div></div>';
   body=intro+'<h2>吃过的几站</h2><div class="trip-grid">'+meal(1)+meal(2)+'</div><h2>账单与推荐</h2>'+table(['店铺／菜品','人数','实际总额','最值得点／可跳过'],[['待填写','待填写','待填写','待填写'],['待填写','待填写','待填写','待填写']])+'<p><strong>整次餐饮花费：</strong>'+esc(values.actual_cost||'待填写')+'，注明是否含饮料、服务费或其他费用。</p><h2>一句话回味</h2><p>最想向朋友推荐的味道，以及适合谁：待填写。</p>';
  }
  if(body.length>100000)throw Error('模板正文过长，请把旅行分成几篇记录。');
  return body;
 }
 return {catalog,build};
})();
