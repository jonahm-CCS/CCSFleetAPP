const vin=s=>String(s||'').toUpperCase().replace(/\s/g,'');
const plate=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const validVin=s=>/^[A-HJ-NPR-Z0-9]{17}$/.test(s||'');
const date=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
export const descriptiveFields=new Set(['model','make','year','ownership']);
export function currentEvidence(e,sources){const s=sources.find(s=>s.id===e.sourceId);return e.active!==false&&(!s?.lastAcceptedUploadId||e.uploadId===s.lastAcceptedUploadId||e.automatic&&e.uploadId===s.pendingUploadId);}
export function applyReviewPolicy({all,put,audit}){
 const stamp=new Date().toISOString(),sources=all('sources'),evidence=all('evidence'),vehicles=all('vehicles').filter(v=>!v.mergedInto),issues=all('issues');
 let updated=0,confirmed=0,closed=0;const authority=new Map();
 const close=(i,note)=>{put('issues',{...i,status:'Resolved',resolution:note,resolvedAt:stamp,reviewPolicy:true});closed++;};
 for(const v of vehicles){
  const refs=evidence.filter(e=>e.vehicleId===v.id&&['bancorp','moventum'].includes(e.sourceId)&&currentEvidence(e,sources)&&!e.needsReview&&vin(e.reportedVin||e.fields?.vin)===vin(v.vin)&&/Exact VIN|Confirmed/i.test(e.match||''));
  const rank=e=>{const s=sources.find(s=>s.id===e.sourceId);return e.uploadId===s?.pendingUploadId?s?.lastUploadedAt||'':s?.lastAcceptedAt||s?.asOf||'';};
  refs.sort((a,b)=>rank(b).localeCompare(rank(a)));const patch={},used={};
  for(const field of ['registrationExpiry','plate','plateState']){
   const available=refs.filter(e=>String(e.fields?.[field]||'').trim());if(!available.length)continue;
   const latest=available.filter(e=>rank(e)===rank(available[0]));const values=[...new Set(latest.map(e=>field==='plate'?plate(e.fields[field]):String(e.fields[field]).trim().toUpperCase()))];
   if(values.length!==1)continue;const value=String(available[0].fields[field]).trim();
   if(field==='registrationExpiry'&&!date(value))continue;
   if(field==='plate'&&vehicles.some(x=>x.id!==v.id&&plate(x.plate)&&plate(x.plate)===plate(value)&&vin(x.vin)!==vin(v.vin)))continue;
   if(field==='plateState'&&patch.plate===undefined&&available[0].fields.plate&&plate(v.plate)!==plate(available[0].fields.plate))continue;
   used[field]={sourceId:available[0].sourceId,uploadId:available[0].uploadId||'',value};
   if((field==='plate'?plate(v[field])!==plate(value):String(v[field]||'')!==value))patch[field]=value;
  }
  authority.set(v.id,used);
  if(Object.keys(patch).length){const next={...v,...patch,leaseAuthority:{...(v.leaseAuthority||{}),...used},checks:{},verificationStatus:'Not yet verified',version:v.version+1,updatedAt:stamp};put('vehicles',next);audit('Lease source priority',next,'Latest lease report applied: '+Object.keys(patch).join(', '),v);updated++;}
 }
 const confirmedVehicles=new Set();
 for(const e of evidence.filter(e=>e.sourceId==='balance'&&currentEvidence(e,sources))){
  const suffix=vin(e.raw?.vinSuffix||e.fields?.vinSuffix||String(e.raw?.description||'').match(/VIN#\s*([A-Z0-9]+)/i)?.[1]);
  const candidates=vehicles.filter(v=>validVin(v.vin)&&suffix.length>=4&&v.vin.endsWith(suffix));
  if(candidates.length!==1||candidates[0].id!==e.vehicleId||e.needsReview||e.reportedVin&&vin(e.reportedVin)!==vin(candidates[0].vin))continue;
  confirmedVehicles.add(e.vehicleId);
  if(e.match!=='Confirmed accounting match'||e.confirmedVin!==candidates[0].vin){put('evidence',{...e,match:'Confirmed accounting match',confirmedVin:candidates[0].vin,confirmedAt:stamp,confirmation:'Unique VIN suffix approved under source policy'});confirmed++;}
 }
 const seen=new Set();
 for(const i of issues.filter(i=>i.status==='Open').reverse()){
  const v=vehicles.find(v=>v.id===i.vehicleId);if(!v)continue;
  if(i.field==='accounting'&&confirmedVehicles.has(v.id)){close(i,'Unique accounting VIN suffix confirmed under the approved source policy.');continue;}
  if(descriptiveFields.has(i.field)&&validVin(v.vin)){close(i,'Description-only difference retained as source evidence; VIN identity controls the match.');continue;}
  if(authority.get(v.id)?.[i.field]&&['Sources disagree','Reviewed upload differs from master'].includes(i.message)){close(i,'Superseded by the latest authoritative leasing-company '+i.field+'.');continue;}
  const hasAsset=evidence.some(e=>e.vehicleId===v.id&&['bancorp','moventum','balance'].includes(e.sourceId)&&currentEvidence(e,sources));
  if(i.field==='inventory'&&hasAsset){close(i,'Vehicle is tracked by a lease or accounting source; absence from the old Fleet Sheet needs no separate review.');continue;}
  if(i.field==='unitNumber'&&v.serviceVehicleNumber){close(i,'Services vehicle number is recorded in its dedicated source.');continue;}
  const signature=[i.vehicleId,i.field,i.message,i.details].join('|');if(seen.has(signature)){close(i,'Duplicate of an existing review item.');continue;}seen.add(signature);
 }
 if(confirmed||closed)audit('Review cleanup',null,`${confirmed} accounting references confirmed; ${closed} redundant or superseded reviews closed.`);
 return {vehiclesUpdated:updated,accountingReferencesConfirmed:confirmed,reviewsClosed:closed};
}
