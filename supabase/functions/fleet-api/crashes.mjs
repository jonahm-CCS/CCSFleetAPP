import {randomUUID} from 'node:crypto';
const fail=m=>{throw Object.assign(new Error(m),{status:400});};
const date=(value,label,required=false)=>{if(!value&&!required)return '';if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail('Enter a valid '+label+'.');return value;};
const text=(value,label,required=false)=>{if(value===undefined)value='';if(typeof value!=='string'||value.trim().length>5000||(required&&value.trim().length<3))fail('Enter '+label+' (3–5,000 characters).');return value.trim();};
export function updateCrash(old,body){
 const history=(old.crashHistory||[]).map(x=>({...x})),stamp=new Date().toISOString();
 let record;
 if(body.action==='record'){
  if(old.operationalState==='Disposed')fail('Restore the vehicle before starting a crash repair.');
  if(history.some(x=>x.status!=='Complete'))fail('This vehicle already has an active crash repair. Update that record.');
  record={id:randomUUID(),createdAt:stamp,status:'In repair'};history.push(record);
 }else if(['update','complete'].includes(body.action)){
  record=history.find(x=>x.id===body.crashId);if(!record||record.status==='Complete')fail('Choose an active crash repair.');
 }else fail('Choose record, update or complete.');
 if(body.action==='complete'){
  record.completedDate=date(body.completedDate,'repair completion date',true);if(record.completedDate<record.crashDate)fail('Completion cannot be before the crash date.');
  record.completionNote=text(body.completionNote,'a repair completion note',true);record.status='Complete';record.completedAt=stamp;
 }else{
  record.crashDate=date(body.crashDate,'crash date',true);record.description=text(body.description,'a crash description',true);
  record.repairShop=text(body.repairShop,'repair shop');record.claimNumber=text(body.claimNumber,'claim number');record.repairNotes=text(body.repairNotes,'repair notes');record.expectedReturn=date(body.expectedReturn,'expected return date');
  if(record.expectedReturn&&record.expectedReturn<record.crashDate)fail('Expected return cannot be before the crash date.');
 }
 record.updatedAt=stamp;
 const active=history.some(x=>x.status!=='Complete');
 return {...old,crashHistory:history,crashRepairActive:active,operationalState:old.operationalState==='Disposed'?'Disposed':active?'Out of service':body.action==='complete'?'Unknown':old.operationalState,condition:body.action==='record'?'Needs attention':old.condition,checks:{},verificationStatus:'Not yet verified',version:old.version+1,updatedAt:stamp};
}
