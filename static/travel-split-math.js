/* All money is calculated in integer cents. No reimbursement policy is inferred. */
const TravelSplitMath=(()=>{
 function money(value,label='金额'){
  const text=String(value).trim();if(!/^\d{1,8}(\.\d{1,2})?$/.test(text))throw Error(label+'需要填写非负金额，最多两位小数');
  const [whole,fraction='']=text.split('.');return Number(whole)*100+Number(fraction.padEnd(2,'0'));
 }
 function share(total,indexes,size){
  const amounts=Array(size).fill(0);if(!indexes.length)return amounts;
  const each=Math.floor(total/indexes.length),extra=total%indexes.length;
  indexes.forEach((index,i)=>amounts[index]=each+(i<extra?1:0));return amounts;
 }
 // Equal benefit across the group, capped at each person's own expense share.
 function benefit(total,costs){
  const amounts=costs.map(()=>0);let remaining=total;
  while(remaining){
   const active=costs.map((n,i)=>i).filter(i=>costs[i]>amounts[i]);if(!active.length)throw Error('共享报销不能超过总费用');
   const portions=share(remaining,active,costs.length);let used=0;
   for(const i of active){const n=Math.min(portions[i],costs[i]-amounts[i]);amounts[i]+=n;used+=n;}
   remaining-=used;
  }return amounts;
 }
 function calculate(data){
  if(!data||data.version!==1||!Array.isArray(data.members)||!data.members.length||data.members.length>50||!Array.isArray(data.expenses)||data.expenses.length>200)throw Error('请保留 1～50 位成员，费用最多 200 项');
  const ids=new Set();const members=data.members.map((m,i)=>{
   if(typeof m.id!=='string'||ids.has(m.id)||!m.id||typeof m.name!=='string'||!m.name.trim()||m.name.length>40)throw Error('成员名称不能为空或超过 40 字，成员标识不能重复');
   ids.add(m.id);return {...m,cap:money(m.cap,'第 '+(i+1)+' 位成员的额度')};
  });
  const capacity=members.reduce((sum,m)=>sum+m.cap,0),planned=money(data.expectedClaim,'预计报销总额'),conservative=money(data.conservativeClaim,'保守报销总额');
  if(conservative>planned)throw Error('保守报销总额不能高于预计报销总额');
  const expenses=data.expenses.map((e,i)=>{
   if(typeof e.name!=='string'||!e.name.trim()||e.name.length>80)throw Error('第 '+(i+1)+' 项费用需要名称（最多 80 字）');
   const price=money(e.price,e.name+'的预计单价'),upper=money(e.upper,e.name+'的单价上限');if(upper<price)throw Error(e.name+'：单价上限不能低于预计单价');
   if(!/^\d{1,3}$/.test(String(e.quantity))||Number(e.quantity)<1||Number(e.quantity)>365)throw Error(e.name+'：数量需要为 1～365 的整数');
   if(typeof e.perPerson!=='boolean'||typeof e.eligible!=='boolean'||!Array.isArray(e.participants)||!e.participants.length||new Set(e.participants).size!==e.participants.length||e.participants.some(id=>!ids.has(id)))throw Error(e.name+'：至少选择一位有效的分摊成员');
   const indexes=members.map((m,i)=>i).filter(i=>e.participants.includes(members[i].id)),multiplier=Number(e.quantity)*(e.perPerson?indexes.length:1);
   return {...e,indexes,expected:price*multiplier,maximum:upper*multiplier};
  });
  function scenario(key,claim){
   let total=0,eligible=0;const costs=members.map(()=>0);
   for(const e of expenses){total+=e[key];if(e.eligible)eligible+=e[key];const divided=share(e[key],e.indexes,members.length);divided.forEach((n,i)=>costs[i]+=n);}
   if(!Number.isSafeInteger(total))throw Error('金额过大，请减少费用或数量');
   const reimbursement=Math.min(capacity,eligible,claim),benefits=benefit(reimbursement,costs),net=costs.map((n,i)=>n-benefits[i]);
   return {total,eligible,reimbursement,costs,benefits,net,ownTotal:total-reimbursement,maxPerson:Math.max(...net)};
  }
  return {members,expenses,capacity,planned,conservative,expected:scenario('expected',planned),worst:scenario('maximum',conservative),none:scenario('maximum',0)};
 }
 function blank(){
  const members=Array.from({length:9},(_,i)=>({id:'p'+(i+1),name:'成员 '+(i+1),cap:i<6?'1500':'0'}));
  return {version:1,members,expectedClaim:'9000',conservativeClaim:'0',expenses:[{id:'e1',name:'住宿',price:'0',upper:'0',quantity:'3',perPerson:true,eligible:true,participants:members.map(m=>m.id)}]};
 }
 function demo(){const data=blank();data.conservativeClaim='9000';data.expenses[0].price='400';data.expenses[0].upper='500';data.expenses.push(...[['e2','聚餐','2700','3600'],['e3','交通与游玩','1800','2700']].map(([id,name,price,upper])=>({id,name,price,upper,quantity:'1',perPerson:false,eligible:false,participants:data.members.map(m=>m.id)})));return data;}
 return {money,calculate,blank,demo};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=TravelSplitMath;
