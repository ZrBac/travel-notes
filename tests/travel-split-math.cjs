const assert=require('node:assert/strict'),M=require('../static/travel-split-math.js');
let d=M.demo(),r=M.calculate(d);
assert.equal(r.capacity,900000);assert.equal(r.expected.total,1530000);assert.equal(r.expected.reimbursement,900000);assert.deepEqual(r.expected.net,Array(9).fill(70000));assert.deepEqual(r.worst.net,Array(9).fill(120000));assert.deepEqual(r.none.net,Array(9).fill(220000));
d.conservativeClaim='6000';r=M.calculate(d);assert.equal(r.worst.ownTotal,1380000);assert.equal(r.worst.maxPerson,153334);
d=M.blank();r=M.calculate(d);assert.equal(r.expected.reimbursement,0);assert.deepEqual(r.expected.net,Array(9).fill(0));
d.expenses[0].price='100';d.expenses[0].upper='150';r=M.calculate(d);assert.equal(r.expected.reimbursement,270000);assert.equal(r.worst.reimbursement,0);assert.deepEqual(r.expected.net,Array(9).fill(0));
d.expenses[0].eligible=false;r=M.calculate(d);assert.equal(r.expected.reimbursement,0);
// One participant cannot receive a negative bill; unused benefit is redistributed.
d=M.demo();d.members=d.members.slice(0,3);d.expenses=[{id:'e',name:'测试',price:'0.10',upper:'0.10',quantity:'1',perPerson:false,eligible:true,participants:['p1','p2']}];d.expectedClaim='0.08';d.conservativeClaim='0';r=M.calculate(d);assert.deepEqual(r.expected.costs,[5,5,0]);assert.deepEqual(r.expected.benefits,[4,4,0]);assert.deepEqual(r.expected.net,[1,1,0]);
d.expenses[0].price='0.01';d.expenses[0].upper='0.01';r=M.calculate(d);assert.deepEqual(r.expected.costs,[1,0,0]);assert.deepEqual(r.expected.net,[0,0,0]);
for(const change of [d=>d.expenses[0].upper='1',d=>d.members[0].cap='-1',d=>d.expenses[0].quantity='1.5',d=>d.expenses[0].participants=[],d=>d.expenses[0].participants=['missing'],d=>d.expenses[0].participants=['p1','p1'],d=>d.expectedClaim='NaN',d=>d.conservativeClaim='10000',d=>d.members[1].id='p1',d=>d.expenses[0].price='1.001']){d=M.demo();change(d);assert.throws(()=>M.calculate(d));}
// Deterministic varied groups: every cent is conserved and no one is paid to travel.
for(let k=1;k<=120;k++){
 d=M.blank();d.expectedClaim=String(k%20);d.conservativeClaim='0';d.expenses[0].price=(k/100).toFixed(2);d.expenses[0].upper=(k/50).toFixed(2);d.expenses[0].perPerson=false;d.expenses[0].participants=d.members.slice(0,k%9+1).map(m=>m.id);r=M.calculate(d);
 for(const s of [r.expected,r.worst,r.none]){assert.equal(s.costs.reduce((a,b)=>a+b,0),s.total);assert.equal(s.benefits.reduce((a,b)=>a+b,0),s.reimbursement);assert.equal(s.net.reduce((a,b)=>a+b,0),s.ownTotal);assert.ok(s.net.every(Number.isSafeInteger));assert.ok(s.net.every(n=>n>=0));assert.ok(s.reimbursement<=s.eligible&&s.reimbursement<=r.capacity);}
}
console.log('PASS: nine-person shared reimbursement, conservative scenarios, eligible caps, subset costs, validation and cent conservation');
