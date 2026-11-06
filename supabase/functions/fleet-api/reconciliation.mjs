import {descriptiveFields,currentEvidence} from './review-policy.mjs';
import {Buffer} from 'node:buffer';
import {planDriverLinks} from './driver-links.mjs';
import {driverNameMatches,compareInsurance} from './insurance-drivers.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {parseSource,sourceTypes,fileHash} from './source-parsers.mjs';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const normalized=s=>String(s??'').trim().replace(/\s+/g,' ').toUpperCase();
const plate=s=>normalized(s).replace(/[^A-Z0-9]/g,'');
const unit=s=>/^\d+$/.test(normalized(s))?normalized(s).replace(/^0+(?=\d)/,''):normalized(s);
const validVin=s=>/^[A-HJ-NPR-Z0-9]{17}$/.test(s);
const fail=(m,status=400)=>{throw Object.assign(new Error(m),{status});};
const now=()=>new Date().toISOString();
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function setupReconciliation({all,get,put,tx,audit,clean,ROOT}){
 for(const [id,c] of Object.entries(sourceTypes))if(!all('sources').some(s=>s.id===id))put('sources',{id,name:c.title,status:'Awaiting upload',rowCount:0,note:id==='cc'?'CC system export is used to check driver identity, role, VIN and plate.':'Source-specific monthly comparison.'});
 const vehicles=()=>all('vehicles').filter(v=>!v.mergedInto);
 const fingerprint=()=>hash({v:all('vehicles').map(v=>[v.id,v.version]),d:all('drivers').map(d=>[d.id,d.version]),ignored:all('ignoredDiscrepancies').map(i=>[i.id,i.active])});
 const findDrivers=f=>all('drivers').filter(d=>f.employeeId&&normalized(d.employeeId)===normalized(f.employeeId)||f.email&&normalized(d.email)===normalized(f.email)||f.name&&normalized(d.name)===normalized(f.name));
 function currentDrivers(){const cc=all('sources').find(s=>s.id==='cc'),services=all('sources').find(s=>s.id==='services');const ids=new Set(all('driverEvidence').filter(e=>e.sourceId==='cc'&&e.uploadId===cc?.lastAcceptedUploadId||e.sourceId==='services'&&e.uploadId===services?.lastAcceptedUploadId).map(e=>e.driverId));return all('drivers').filter(d=>(ids.has(d.id)||d.manualAdded)&&!d.archived);}

 function insuranceReport(){const source=all('sources').find(s=>s.id==='drivers');if(!source?.lastAcceptedUploadId&&!source?.pendingUploadId)return null;const u=all('uploads').find(u=>u.id===(source.lastAcceptedUploadId||source.pendingUploadId));if(!u)return all('baseline')[0]?.insuranceComparison||null;const report=compareInsurance(currentDrivers(),u.rows,source.lastAcceptedUploadId?u.overrides:{});const ids=new Set(report.matchedIds);for(const e of all('driverEvidence').filter(e=>e.sourceId==='drivers'&&e.automatic&&e.active!==false&&e.uploadId===source.pendingUploadId))ids.add(e.driverId);return {...report,matchedIds:[...ids],add:report.add.filter(d=>!ids.has(d.id)),filename:u.filename};}
 const assetSources=['bancorp','moventum','balance'];
 function syncAssetCoverage(){
  const sources=all('sources'),refs=all('evidence'),uploads=all('uploads');
  const present=id=>refs.some(e=>e.active!==false&&e.vehicleId===id&&assetSources.includes(e.sourceId)&&(!sources.find(s=>s.id===e.sourceId)?.lastAcceptedUploadId||e.uploadId===sources.find(s=>s.id===e.sourceId).lastAcceptedUploadId||e.automatic&&e.uploadId===sources.find(s=>s.id===e.sourceId)?.pendingUploadId));
  for(const issue of all('issues').filter(i=>i.status==='Open'&&i.field==='sourcePresence'&&!i.assetCoverage)){
   if(assetSources.includes(uploads.find(u=>u.id===issue.uploadId)?.sourceId))put('issues',{...issue,status:'Resolved',resolution:'Replaced by combined Bancorp / Moventum / asset coverage check.',resolvedAt:now()});
  }
  for(const v of vehicles()){
   const id='asset-coverage-'+v.id,old=all('issues').find(i=>i.id===id),missing=v.operationalState!=='Disposed'&&!present(v.id);
   if(missing&&(!old||old.status==='Resolved'&&!old.acknowledged))put('issues',{id,vehicleId:v.id,field:'sourcePresence',assetCoverage:true,message:'No lease or accounting asset source',details:'Not found in Bancorp, Moventum or the asset list. At least one source is required; multiple sources are allowed.',status:'Open'});
   if(!missing&&old&&(old.status!=='Resolved'||old.acknowledged))put('issues',{...old,status:'Resolved',resolution:'Vehicle has an asset source or is disposed.',acknowledged:false,resolvedAt:now()});
  }
 }
 const ignoreKey=(sourceId,row)=>hash({sourceId,kind:row.kind,targetId:row.targetId,changes:row.changes,...(row.kind==='assignment'?{reportedVin:row.fields.reportedVin,reportedPlate:row.fields.reportedPlate}:{})});
 function rememberIgnoredIssues(items){
  for(const uploadId of new Set(items.map(i=>i.uploadId).filter(Boolean))){
   const upload=all('uploads').find(u=>u.id===uploadId);if(!upload)continue;
   for(const row of upload.rows||[]){if(!row.targetId||!row.changes?.length||row.kind!=='vehicle')continue;
    if(row.changes.every(d=>all('issues').some(i=>i.uploadId===uploadId&&i.vehicleId===row.targetId&&i.field===d.field&&i.status==='Ignored')))put('ignoredDiscrepancies',{id:ignoreKey(upload.sourceId,row),sourceId:upload.sourceId,targetId:row.targetId,kind:row.kind,changes:row.changes,ignoredAt:now()});
   }
  }
 }
 const driverKeys=['name','employeeId','phone','email','market','role','systemRole','city','state','onboardingCompleted','canDrive','drivesCCS','reportedVin','reportedPlate'];
 function sameValue(k,a,b){if(['year','odometer','lastOilMileage','pmDueMiles'].includes(k)&&String(a??'').trim()!==''&&Number.isFinite(Number(a))&&Number.isFinite(Number(b)))return Number(a)===Number(b);if(['plate','reportedPlate'].includes(k))return plate(a)===plate(b);return normalized(a)===normalized(b);}
 function differences(existing,fields,keys){return keys.filter(k=>!existing||!descriptiveFields.has(k)).filter(k=>fields[k]!==undefined&&String(fields[k]).trim()!==''&&!sameValue(k,existing?.[k]??'',fields[k])).map(field=>({field,before:existing?.[field]??'',after:String(fields[field]).trim()}));}
 function buildPlan(upload,overrides={}){
  const rows=[],warn=[...(upload.warnings||[])],vs=vehicles(),ds=all('drivers'),seen=new Map();
  for(let i=0;i<upload.parsed.length;i++){
   const input=upload.parsed[i],key='row-'+i,o=overrides[key]||{};const f={...input.fields};if(input.kind==='vehicle'&&!['bancorp','moventum'].includes(upload.sourceId)){const hit=vs.filter(v=>v.vin===f.vin);if(hit.length===1&&all('evidence').some(e=>e.vehicleId===hit[0].id&&['bancorp','moventum'].includes(e.sourceId)&&currentEvidence(e,all('sources')))){for(const k of ['registrationExpiry','plate','plateState'])delete f[k];}}
   if(o.vin!==undefined&&input.kind==='vehicle'){f.vin=normalized(o.vin).replace(/\s/g,'');}
   const row={key,kind:input.kind,locator:input.locator,fields:f,raw:input.raw,targetId:'',targetVersion:0,changes:[],message:'',status:'',candidates:[],ocr:!!input.ocr};
   let candidates=[];
   if(input.kind==='driver'||input.kind==='insuredDriver'){
    if(!f.name){row.status='blocked';row.message='Driver name missing.';rows.push(row);continue;}
    candidates=input.kind==='insuredDriver'?currentDrivers().filter(d=>driverNameMatches(d,f.name)):(upload.sourceId==='services'?ds.filter(d=>driverNameMatches(d,f.name)):findDrivers(f));if(o.targetId){const chosen=(input.kind==='insuredDriver'?currentDrivers():ds).find(d=>d.id===o.targetId);if(!chosen)fail('Selected driver no longer exists.');candidates=[chosen];}
    if(candidates.length>1){row.status='blocked';row.message='Driver identifiers match more than one existing driver. Select the correct record and recheck.';row.candidates=candidates.map(d=>({id:d.id,label:d.name+' · '+(d.employeeId||'No employee number')}));}
    else if(candidates.length===1){const d=candidates[0];row.targetId=d.id;row.targetVersion=d.version;row.changes=input.kind==='insuredDriver'?[]:differences(d,f,driverKeys);row.status=row.changes.length?'changes':'matched';row.message=input.kind==='insuredDriver'?'Name listed in supplied insurance source; this does not approve driving.':'Existing driver matched; no duplicate will be created.';}
    else{row.status=input.kind==='insuredDriver'?'unmatched':'new';row.message=input.kind==='insuredDriver'?'Not in the current CC roster. Candidate for removal from insurance; no Driver Register record will be created.':'New driver candidate. Approval required to add.';}
    const identities=[f.employeeId?'driver-id:'+normalized(f.employeeId):'',f.email?'driver-email:'+normalized(f.email):'',f.name?'driver-name:'+normalized(f.name):''].filter(Boolean);
    if(identities.some(k=>seen.has(k))){row.status='blocked';row.message='Repeated driver name, employee number or email in this upload. Only the first row can be accepted.';}else for(const k of identities)seen.set(k,key);
    rows.push(row);
    if(input.kind==='driver'&&upload.sourceId==='cc'&&(f.reportedVin||f.reportedPlate)){
     const a={key:'assignment-'+i,kind:'assignment',locator:input.locator,driverKey:key,driverName:f.name,fields:{driver:f.name,reportedVin:f.reportedVin,reportedPlate:f.reportedPlate},raw:input.raw,targetId:'',targetVersion:0,changes:[],status:'',message:'',candidates:[]};
     const ao=overrides[a.key]||{};const byVin=validVin(f.reportedVin)?vs.filter(v=>v.vin===f.reportedVin):[];const byPlate=f.reportedPlate?vs.filter(v=>plate(v.plate)===plate(f.reportedPlate)):[];
     let matches=[...new Map([...byVin,...byPlate].map(v=>[v.id,v])).values()];
     if(ao.targetId){matches=vs.filter(v=>v.id===ao.targetId);a.manuallyMatched=true;}
     if(matches.length===1){const v=matches[0];a.targetId=v.id;a.targetVersion=v.version;a.changes=normalized(v.driver)!==normalized(f.name)?[{field:'driver',before:v.driver||'',after:f.name}]:[];if(!a.changes.length&&(!v.driverId||row.targetId&&v.driverId!==row.targetId))a.changes=[{field:'Driver Register link',before:v.driverId?'Different registered driver':'Not linked',after:f.name+' · '+(f.employeeId||'registered identity')}];a.status=a.changes.length?'changes':'matched';
      const mismatch=(validVin(f.reportedVin)&&v.vin!==f.reportedVin)||(f.reportedPlate&&plate(v.plate)!==plate(f.reportedPlate));a.message=mismatch?'VIN or plate differs from this truck. Review the identifiers below before approving the assignment.':'Vehicle matched. Approval records the driver assignment.';
      a.checks=[{field:'VIN',existing:v.vin,reported:f.reportedVin},{field:'Plate',existing:v.plate,reported:f.reportedPlate}];
      if(mismatch&&!ao.targetId){a.status='blocked';a.message='VIN / plate discrepancy. Choose the confirmed truck and recheck before assigning.';a.candidates=matches.map(v=>({id:v.id,label:(v.unitNumber||'No CCS number')+' · '+v.vin+' · '+v.plate}));}
     }else{a.status='blocked';a.message=matches.length?'VIN and plate identify different vehicles. Select the correct truck and recheck.':'No confirmed vehicle match. Select an existing truck after checking the identifiers; CC uploads never create trucks.';a.candidates=matches.map(v=>({id:v.id,label:(v.unitNumber||'No CCS number')+' · '+v.vin+' · '+v.plate}));}
     if(row.status==='blocked'){a.status='blocked';a.message='Driver row is blocked. Resolve that identity first.';}
     rows.push(a);
    }
    continue;
   }
   if(input.kind==='samsara'){
    const byVin=validVin(f.vin)?vs.filter(v=>v.vin===f.vin):[],byPlate=f.plate?vs.filter(v=>plate(v.plate)===plate(f.plate)):[];
    candidates=validVin(f.vin)?byVin:byPlate;
    const conflict=byPlate.length>1||byVin.length>1||validVin(f.vin)&&byPlate.some(v=>v.vin&&v.vin!==f.vin)||byVin.length===1&&f.plate&&byVin[0].plate&&plate(f.plate)!==plate(byVin[0].plate);
    if(o.targetId){candidates=vs.filter(v=>v.id===o.targetId);row.manuallyMatched=true;}
    if(!f.serial||!f.deviceId){row.status='blocked';row.message='Device ID or serial missing; equipment needs confirmation.';}
    else if(candidates.length===1&&(!conflict||o.targetId)){row.targetId=candidates[0].id;row.targetVersion=candidates[0].version;row.status='matched';row.match=o.targetId?'Confirmed Samsara equipment':byVin.length?'Exact VIN':'Unique plate';row.message='Samsara device '+f.serial+' listed for this vehicle. Registry values stay unchanged.';}
    else{row.status=conflict?'blocked':'unmatched';row.message=conflict?'Conflicting VIN / plate. Select the confirmed vehicle and recheck.':'No unique registry vehicle matched. Review the identity; Samsara does not create vehicles.';}
    const identity='samsara-device:'+f.deviceId;if(seen.has(identity)){row.status='blocked';row.targetId='';row.message='Repeated device ID in this upload; review required.';}else seen.set(identity,key);
    row.checks=[{field:'Device serial',existing:'',reported:f.serial},{field:'Plate',existing:row.targetId?candidates[0].plate:'',reported:f.plate}];rows.push(row);continue;
   }
   if(input.kind==='accounting'){
    candidates=vs.filter(v=>v.vin&&v.vin.endsWith(f.vinSuffix));if(o.targetId)candidates=vs.filter(v=>v.id===o.targetId);
    if(candidates.length===1){row.targetId=candidates[0].id;row.targetVersion=candidates[0].version;row.status='matched';row.message=o.targetId?'Manually matched accounting reference.':'Possible VIN-suffix match; accounting does not establish ownership.';row.match=o.targetId?'Manually confirmed suffix':f.vinSuffix.length>=4?'Confirmed accounting match':'Possible suffix match';if(all('evidence').some(e=>e.vehicleId===row.targetId&&e.match==='Confirmed accounting match'&&e.confirmedVin===candidates[0].vin&&String(e.raw?.vinSuffix||e.fields?.vinSuffix||'').toUpperCase()===String(f.vinSuffix).toUpperCase()))row.match='Confirmed accounting match';}
    else{row.status='unmatched';row.message=candidates.length?'Ambiguous accounting suffix. Choose the confirmed existing vehicle.':'No full-VIN match. Kept as an accounting reference; no truck will be created.';row.candidates=candidates.map(v=>({id:v.id,label:(v.unitNumber||'No CCS number')+' · '+v.vin}));}
    rows.push(row);continue;
   }
   f.vin=normalized(f.vin).replace(/\s/g,'');
   if(!validVin(f.vin)){row.status='blocked';row.message='Invalid or OCR-uncertain VIN. Correct it against the source and recheck. No truck will be created.';rows.push(row);continue;}
   const exact=vs.filter(v=>v.vin===f.vin),byOther=vs.filter(v=>f.unitNumber&&unit(v.unitNumber)===unit(f.unitNumber)||f.plate&&plate(v.plate)===plate(f.plate)||v.vin&&v.vin!==f.vin&&v.vin.endsWith(f.vin.slice(-6)));
   candidates=[...new Map([...exact,...byOther].map(v=>[v.id,v])).values()];
   if(o.targetId){candidates=vs.filter(v=>v.id===o.targetId);row.manuallyMatched=true;}
   if(candidates.length>1||!exact.length&&candidates.length&&!o.targetId){row.status='blocked';row.message='Possible duplicate or conflicting VIN / plate / vehicle number. Choose an existing truck and recheck.';row.candidates=candidates.map(v=>({id:v.id,label:(v.unitNumber||'No CCS number')+' · '+v.vin+' · '+v.plate}));}
   else if(candidates.length){const v=candidates[0];row.targetId=v.id;row.targetVersion=v.version;row.changes=differences(v,f,Object.keys(f).filter(k=>!['driver','driverId'].includes(k)));row.status=row.changes.length?'changes':'matched';row.message='Existing truck matched. Review discrepancies before changing the master.';}
   else{row.status='new';row.changes=differences(null,f,Object.keys(f));row.message='New full-VIN candidate. Approval required; duplicates are checked again when saving.';}
   const identities=['vin:'+f.vin,f.unitNumber?'unit:'+unit(f.unitNumber):'',f.plate?'plate:'+plate(f.plate):''].filter(Boolean);
   if(identities.some(k=>seen.has(k))){row.status='blocked';row.message='Repeated VIN, plate or vehicle number within this upload. Resolve the repeated identity before accepting more than one row.';}else for(const k of identities)seen.set(k,key);
   rows.push(row);
  }
  for(const row of rows)if(row.status==='changes'&&all('ignoredDiscrepancies').some(i=>i.id===ignoreKey(upload.sourceId,row)&&i.active!==false)){row.status='ignored';row.message+=' Previously ignored; existing values retained.';}
  const assignmentGroups=new Map();for(const row of rows.filter(r=>r.kind==='assignment'&&r.targetId&&r.status!=='blocked')){if(!assignmentGroups.has(row.targetId))assignmentGroups.set(row.targetId,[]);assignmentGroups.get(row.targetId).push(row);}for(const group of assignmentGroups.values())if(group.length>1)for(const row of group){row.assignmentConflict=true;row.message+=' Multiple CC drivers report this truck. Approve at most one assignment.';}
  const previousSource=get('sources',upload.sourceId);const activeEvidence=all('evidence').filter(e=>e.sourceId===upload.sourceId&&(!previousSource.lastAcceptedUploadId||e.uploadId===previousSource.lastAcceptedUploadId)),incomingVins=new Set(upload.parsed.map(r=>r.fields.vin).filter(Boolean));
  const missingVehicleIds=[...new Set(activeEvidence.filter(e=>e.match==='Exact VIN'&&!incomingVins.has(e.reportedVin||e.fields?.vin)).map(e=>e.vehicleId))].filter(id=>vs.some(v=>v.id===id));
  const incomingDrivers=new Set(rows.filter(r=>r.kind==='driver'&&r.targetId).map(r=>r.targetId));const missingDriverIds=['cc','services','driverSystem'].includes(upload.sourceId)?currentDrivers().filter(d=>(upload.sourceId==='services'?d.isServiceDriver:!d.isServiceDriver)&&!incomingDrivers.has(d.id)).map(d=>d.id):[];
  return {insuranceComparison:upload.sourceId==='drivers'?compareInsurance(currentDrivers(),rows,overrides):undefined,rows,warnings:warn,missingVehicleIds:['cc','driverSystem','drivers'].includes(upload.sourceId)?[]:missingVehicleIds,missingDriverIds};
 }
 function saveAutomaticMatches(upload){
  for(const kind of ['evidence','driverEvidence'])for(const e of all(kind).filter(e=>e.uploadId===upload.id&&e.automatic))put(kind,{...e,active:false});
  // Approved source priorities: existing unique records update without exception clicks.
  for(const row of upload.rows){
   if(row.status!=='changes'||!row.targetId||row.manuallyMatched)continue;
   if(['bancorp','moventum'].includes(upload.sourceId)&&row.kind==='vehicle'){
    const old=get('vehicles',row.targetId),patch={};
    for(const d of row.changes){if(!['registrationExpiry','plate','plateState'].includes(d.field))continue;
     if(d.field==='registrationExpiry'&&(!/^\d{4}-\d{2}-\d{2}$/.test(d.after)||!Number.isFinite(Date.parse(d.after))||new Date(d.after).toISOString().slice(0,10)!==d.after))continue;
     if(d.field==='plate'&&vehicles().some(v=>v.id!==old.id&&plate(v.plate)===plate(d.after)))continue;
     patch[d.field]=d.after;
    }
    if(Object.keys(patch).length){const next={...old,...patch,checks:{},verificationStatus:'Not yet verified',version:old.version+1,updatedAt:now()};put('vehicles',next);audit('Lease source priority',next,upload.filename+': authoritative plate / registration update.',old);row.changes=row.changes.filter(d=>!Object.hasOwn(patch,d.field));}
   }
   if(upload.sourceId==='cc'&&row.kind==='driver'){
    const old=get('drivers',row.targetId);if(old.archived)continue;
    const next={...old,...Object.fromEntries(row.changes.map(d=>[d.field,d.after])),version:old.version+1,updatedAt:now()};
    if(findDrivers(next).some(d=>d.id!==old.id))continue;put('drivers',next);for(const v of vehicles().filter(v=>v.driverId===next.id))put('vehicles',{...v,driver:next.name,version:v.version+1,updatedAt:now()});audit('CC source priority',null,next.name+': current CC details applied.');row.changes=[];
   }
   if(!row.changes.length){row.status='matched';row.message='Updated from the authoritative source automatically.';row.targetVersion=get(row.kind==='driver'?'drivers':'vehicles',row.targetId).version;}
  }
  const activeIds=new Set(currentDrivers().map(d=>d.id)),openIssues=all('issues').filter(i=>i.status==='Open'),uploadSources=new Map(all('uploads').map(u=>[u.id,u.sourceId]));
  for(const row of upload.rows){
   const safe=row.status==='matched'&&row.targetId&&!row.manuallyMatched&&!upload.overrides?.[row.key]?.targetId&&!row.assignmentConflict&&(['vehicle','driver','insuredDriver','samsara'].includes(row.kind)||row.kind==='accounting'&&row.match==='Confirmed accounting match')&&(row.kind!=='driver'||activeIds.has(row.targetId));
   row.automatic=!!safe;if(!safe)continue;
   const record={id:'source-'+upload.id+'-'+row.key,uploadId:upload.id,sourceId:upload.sourceId,locator:row.locator,fields:row.fields,raw:{...row.raw,...(row.kind==='accounting'?row.fields:{})},automatic:true,active:true,recordedAt:now()};
   if(['driver','insuredDriver'].includes(row.kind))put('driverEvidence',{...record,driverId:row.targetId});
   else {put('evidence',{...record,vehicleId:row.targetId,reportedVin:row.fields.vin||'',match:['samsara','accounting'].includes(row.kind)?row.match:'Exact VIN',...(row.kind==='accounting'?{confirmedVin:get('vehicles',row.targetId).vin}:{})});for(const issue of openIssues.filter(i=>i.vehicleId===row.targetId&&i.status==='Open'&&(i.sourceId===upload.sourceId||uploadSources.get(i.uploadId)===upload.sourceId)&&(i.field==='sourcePresence'||i.after!==undefined&&sameValue(i.field,get('vehicles',row.targetId)[i.field],i.after)&&sameValue(i.field,row.fields[i.field],i.after))))put('issues',{...issue,status:'Resolved',resolution:'Exact source match automatically confirmed.',resolvedAt:now()});}
  }
  const plans=planDriverLinks(vehicles().map(v=>({...v,driver:'',driverId:''})),currentDrivers().map(d=>({...d,assignmentOverride:false})));
  for(const row of upload.rows.filter(r=>r.kind==='assignment')){
   const driverRow=upload.rows.find(r=>r.key===row.driverKey),plan=plans.find(p=>p.driverId===driverRow?.targetId);
   if(!driverRow?.automatic||!plan?.vehicleId||plan.reason||plan.ignored||row.assignmentConflict||row.manuallyMatched||!['changes','matched'].includes(row.status)||row.targetId!==plan.vehicleId)continue;
   const v=get('vehicles',plan.vehicleId),d=get('drivers',driverRow.targetId);if(d.isServiceDriver||v.section==='Services'||v.isServiceVehicle)continue;
   if(v.driverId!==d.id||v.driver!==d.name){for(const other of vehicles().filter(x=>x.id!==v.id&&x.driverId===d.id))put('vehicles',{...other,driver:'',driverId:'',version:other.version+1,updatedAt:now()});const next={...v,driverId:d.id,driver:d.name,version:v.version+1,updatedAt:now()};put('vehicles',next);audit('Automatic driver link',next,'Unique CC VIN / plate matched without an identity conflict.',v);}
   row.status='matched';row.changes=[];row.automatic=true;row.message='Unique driver / vehicle match connected automatically.';
  }
  upload.fingerprint=fingerprint();put('uploads',upload);
 }
 async function preview({sourceId,filename,base64,overrides={},uploadId,initial=false,extractedText}){
  let upload;
  if(sourceId==='driverSystem')fail('The Driver Register is controlled only by the CC upload. Use CC data export.');
  if(uploadId){upload=get('uploads',uploadId);if(upload.status==='Accepted')fail('This upload was already accepted. Upload the next report to compare again.',409);}
  else{
   if(initial){sourceId='cc';filename='data-export_2026-10-15T12-53-46.csv';const p=resolve(ROOT,'data/initial-cc-export.csv');if(!existsSync(p))fail('The supplied CC export is unavailable. Choose the CSV file.');base64=readFileSync(p).toString('base64');}
   if(!sourceTypes[sourceId]||typeof filename!=='string'||typeof base64!=='string')fail('Choose a source and a file.');const bytes=Buffer.from(base64,'base64');if(!bytes.length||bytes.length>30*1024*1024)fail('Source uploads must be between 1 byte and 30 MB.');
   const parsed=await parseSource(sourceId,filename,bytes,extractedText);if(parsed.rows.length>5000)fail('Limit a source report to 5,000 parsed records.');
   upload={id:randomUUID(),sourceId,filename:filename.replace(/[^\w. ()-]/g,'_').slice(0,180),base64,hash:fileHash(bytes),parsed:parsed.rows,warnings:parsed.warnings,extractedText:parsed.extractedText||'',uploadedAt:now(),status:'Pending review'};
  }
  if(upload.sourceId==='driverSystem')fail('Use CC data export to maintain the Driver Register.');
  if(upload.sourceId==='drivers'&&!get('sources','cc').lastAcceptedUploadId)fail('Accept a CC roster before comparing insurance drivers.');
  const sourceBefore=get('sources',upload.sourceId);if(sourceBefore.lastAcceptedHash===upload.hash&&!upload.warnings.includes('File content is identical to the last accepted upload. Check the report date before treating it as a new monthly report.'))upload.warnings.push('File content is identical to the last accepted upload. Check the report date before treating it as a new monthly report.');
  const plan=buildPlan(upload,overrides);upload={...upload,...plan,overrides,fingerprint:fingerprint(),previewedAt:now()};
  tx(()=>{put('uploads',upload);const source=get('sources',upload.sourceId);put('sources',{...source,lastUploadedAt:upload.uploadedAt,lastFilename:upload.filename,pendingUploadId:upload.id,status:'Pending review'});saveAutomaticMatches(upload);syncAssetCoverage();});
  const noExceptions=upload.rows.length>0&&upload.rows.every(r=>r.automatic||r.kind==='assignment'&&r.status==='matched'&&!r.assignmentConflict)&&!upload.missingVehicleIds.length&&!upload.missingDriverIds.length;
  if(noExceptions){commit({uploadId:upload.id,confirmed:true});upload=get('uploads',upload.id);upload.automaticallyAccepted=true;put('uploads',upload);audit('Automatic source match',null,`${upload.filename}: all rows matched without changes.`);}
  return publicPreview(upload);
 }
 function publicPreview(u){return {automaticallyAccepted:!!u.automaticallyAccepted,automaticCount:u.rows.filter(r=>r.automatic).length,insuranceComparison:u.sourceId==='drivers'?compareInsurance(currentDrivers(),u.rows,u.overrides):undefined,id:u.id,sourceId:u.sourceId,filename:u.filename,uploadedAt:u.uploadedAt,rows:u.rows,warnings:u.warnings,missingVehicleIds:u.missingVehicleIds,missingDriverIds:u.missingDriverIds,overrides:u.overrides,status:u.status};}
 const newDriver=f=>({id:randomUUID(),...Object.fromEntries(driverKeys.map(k=>[k,String(f[k]||'').trim()])),version:1,createdAt:now(),updatedAt:now()});
 function commit({uploadId,decisions={},confirmed}){
  if(get('uploads',uploadId).sourceId==='driverSystem')fail('Only CC may maintain the Driver Register.');if(confirmed!==true)fail('Confirm the discrepancy review before saving.');const upload=get('uploads',uploadId);if(upload.status==='Accepted')fail('Upload already accepted.',409);if(upload.fingerprint!==fingerprint())fail('Saved records changed after this preview. Click Recheck before confirming.',409);
  if(get('sources',upload.sourceId).pendingUploadId!==upload.id)fail('A newer upload exists for this source. Review the latest upload.',409);
  const counts={driversAdded:0,vehiclesAdded:0,changed:0,evidence:0,kept:0},driverTargets=new Map();
  const acceptedAssignments=new Set();for(const row of upload.rows.filter(r=>r.kind==='assignment'&&decisions[r.key]==='apply')){if(acceptedAssignments.has(row.targetId))fail('Two selected assignments target the same truck. Approve one driver per vehicle.');acceptedAssignments.add(row.targetId);}
  tx(()=>{
   for(const row of upload.rows){
    const action=decisions[row.key]||(row.status==='ignored'?'ignore':'keep');if(!['keep','apply','add','ignore'].includes(action))fail('Invalid review decision.');if(row.status==='blocked'&&action!=='keep')fail(`Resolve ${row.locator} before applying it.`);
    if(action==='ignore'&&(!row.targetId||!row.changes.length||row.status==='blocked'))fail('Only matched discrepancies can be ignored.');
    if(row.status==='ignored'&&action!=='ignore')put('ignoredDiscrepancies',{id:ignoreKey(upload.sourceId,row),active:false});
    if(action==='ignore'){put('ignoredDiscrepancies',{id:ignoreKey(upload.sourceId,row),sourceId:upload.sourceId,targetId:row.targetId,kind:row.kind,changes:row.changes,ignoredAt:now()});counts.ignored=(counts.ignored||0)+1;audit('Ignore source discrepancies',null,`${upload.filename}: ${row.locator} ignored; saved values retained.`);}
    let target=row.targetId?(row.kind==='driver'||row.kind==='insuredDriver'?get('drivers',row.targetId):get('vehicles',row.targetId)):null;
    if(row.kind==='driver'){
     if(!target&&action==='add'){
      if(findDrivers(row.fields).length)fail('Driver identifiers now match an existing record. Recheck instead of adding a duplicate.',409);
      target=newDriver(row.fields);put('drivers',target);counts.driversAdded++;audit('Driver import',null,`${target.name} (${target.employeeId}) created after review.`);
     }else if(target&&action==='apply'){
      const next={...target,...Object.fromEntries(row.changes.map(d=>[d.field,d.after])),version:target.version+1,updatedAt:now()};
      if(findDrivers(next).some(d=>d.id!==target.id))fail('Changing driver identifiers would duplicate another driver. Recheck.',409);put('drivers',next);if(next.name!==target.name)for(const v of vehicles().filter(v=>v.driverId===next.id))put('vehicles',{...v,driver:next.name,version:v.version+1,updatedAt:now()});audit('Driver update',null,`${target.name}: ${row.changes.map(d=>d.field).join(', ')} approved.`);target=next;counts.changed++;
     }
     if(target){if(upload.sourceId==='services'&&!target.isServiceDriver){target={...target,isServiceDriver:true,version:target.version+1,updatedAt:now()};put('drivers',target);}if(upload.sourceId==='cc'&&target.manualAdded){target={...target,manualAdded:false,version:target.version+1,updatedAt:now()};put('drivers',target);}driverTargets.set(row.key,target);put('driverEvidence',{id:'source-'+upload.id+'-'+row.key,driverId:target.id,sourceId:upload.sourceId,uploadId:upload.id,locator:row.locator,fields:row.fields,raw:row.raw,recordedAt:now()});counts.evidence++;}else counts.kept++;
     continue;
    }
    if(row.kind==='insuredDriver'){
     if(target){put('driverEvidence',{id:'source-'+upload.id+'-'+row.key,driverId:target.id,sourceId:upload.sourceId,uploadId:upload.id,locator:row.locator,fields:row.fields,raw:row.raw,recordedAt:now()});counts.evidence++;}continue;
    }
    if(row.kind==='assignment'){
     const d=driverTargets.get(row.driverKey);
     if(d&&action==='ignore')put('drivers',{...d,ignoredAssignment:{vin:d.reportedVin,plate:d.reportedPlate},version:d.version+1,updatedAt:now()});
     if(d&&action==='apply'&&d.ignoredAssignment)put('drivers',{...d,ignoredAssignment:null,version:d.version+1,updatedAt:now()});
     if(target&&action==='apply'){
      if(d?.isServiceDriver||target.section==='Services'||target.isServiceVehicle)fail('Services uses pooled vehicles, not fixed driver assignments.');
      if(d?.archived)fail('Restore this archived driver before assigning a vehicle.');
      if(!d)fail(`Approve adding or matching ${row.driverName} before applying their vehicle assignment.`);
      target={...target,driver:d.name,driverId:d.id,version:target.version+1,updatedAt:now()};put('vehicles',target);audit('Reviewed assignment',target,`${d.name} assigned after CC VIN / plate review.`);counts.changed++;
     }
     if(target&&d)put('assignmentEvidence',{id:randomUUID(),driverId:d.id,vehicleId:target.id,uploadId:upload.id,sourceId:upload.sourceId,locator:row.locator,fields:row.fields});continue;
    }
    if(row.kind==='samsara'){
     if(target&&row.status==='matched'){put('evidence',{id:'source-'+upload.id+'-'+row.key,vehicleId:target.id,sourceId:'samsara',uploadId:upload.id,locator:row.locator,fields:row.fields,raw:row.raw,reportedVin:row.manuallyMatched?'':row.fields.vin,match:row.match});counts.evidence++;}continue;
    }
    if(row.kind==='accounting'){
     if(target){put('evidence',{id:'source-'+upload.id+'-'+row.key,vehicleId:target.id,sourceId:upload.sourceId,uploadId:upload.id,locator:row.locator,fields:{},raw:{...row.raw,...row.fields},reportedVin:'',...(row.match==='Confirmed accounting match'?{confirmedVin:target.vin}:{}),match:row.match||'Possible suffix match'});counts.evidence++;}continue;
    }
    if(!target&&action==='add'){
     if(!validVin(row.fields.vin))fail('A valid full VIN is required.');if(vehicles().some(v=>v.vin===row.fields.vin||row.fields.unitNumber&&unit(v.unitNumber)===unit(row.fields.unitNumber)||row.fields.plate&&plate(v.plate)===plate(row.fields.plate)))fail('A VIN, plate or vehicle number already matches an existing truck. Recheck.',409);
     target=clean({...row.fields,operationalState:row.fields.operationalState||'Unknown'});put('vehicles',target);counts.vehiclesAdded++;audit('Reviewed vehicle import',target,`${upload.filename}: new vehicle approved.`);
    }else if(target&&action==='apply'){
     const next=clean({...target,...Object.fromEntries(row.changes.map(d=>[d.field,d.after]))},target);
     if(vehicles().some(v=>v.id!==target.id&&(next.vin&&v.vin===next.vin||next.unitNumber&&unit(v.unitNumber)===unit(next.unitNumber)||next.plate&&plate(v.plate)===plate(next.plate))))fail('Applying this change would duplicate an existing VIN, plate or vehicle number. Recheck.',409);
     put('vehicles',next);audit('Reviewed source update',next,`${upload.filename}: ${row.changes.map(d=>d.field).join(', ')} approved.`,target);target=next;counts.changed++;
    }
    if(target){
     if(upload.sourceId==='services'){target={...target,section:'Services',isServiceVehicle:true,serviceVehicleNumber:row.fields.serviceVehicleNumber,version:target.version+1,updatedAt:now()};put('vehicles',target);}
     put('evidence',{id:'source-'+upload.id+'-'+row.key,vehicleId:target.id,sourceId:upload.sourceId,uploadId:upload.id,locator:row.locator,fields:row.fields,raw:row.raw,reportedVin:row.fields.vin,match:row.fields.vin===target.vin?'Exact VIN':'Manually matched; VIN differs'});counts.evidence++;
     for(const issue of all('issues').filter(i=>i.vehicleId===target.id&&i.status==='Open'&&i.message==='Reviewed upload differs from master'&&all('uploads').find(u=>u.id===i.uploadId)?.sourceId===upload.sourceId)){put('issues',{...issue,status:action==='ignore'?'Ignored':'Resolved',resolution:action==='ignore'?'Discrepancies explicitly ignored.':'Superseded by the latest accepted comparison.',resolvedAt:now()});}
     const remains=differences(target,row.fields,Object.keys(row.fields));if(remains.length&&action!=='ignore'){for(const d of remains)put('issues',{id:randomUUID(),vehicleId:target.id,field:d.field,message:'Reviewed upload differs from master',details:`${upload.filename}: ${d.field} reports ${d.after}; kept ${d.before}`,status:'Open',before:d.before,after:d.after,sourceId:upload.sourceId,uploadId:upload.id});put('vehicles',{...target,checks:{},verificationStatus:'Not yet verified',version:target.version+1});}
    }else{
     const exact=vehicles().filter(v=>v.vin===row.fields.vin);
     if(row.status==='blocked'&&exact.length===1){put('evidence',{id:randomUUID(),vehicleId:exact[0].id,sourceId:upload.sourceId,uploadId:upload.id,locator:row.locator,fields:row.fields,raw:row.raw,reportedVin:row.fields.vin,match:'Exact VIN; identifier conflict',needsReview:true});put('issues',{id:randomUUID(),vehicleId:exact[0].id,field:'identity',message:'Upload identifiers need review',details:row.message,status:'Open',uploadId:upload.id});counts.evidence++;}
     counts.kept++;
    }
   }
   for(const id of (assetSources.includes(upload.sourceId)?[]:upload.missingVehicleIds))put('issues',{id:randomUUID(),vehicleId:id,field:'sourcePresence',message:'Not present in latest source upload',details:`Not found in ${upload.filename}; no vehicle was deleted or disposed automatically.`,status:'Open',uploadId:upload.id});
   put('uploads',{...upload,status:'Accepted',acceptedAt:now(),decisions,counts});const s=get('sources',upload.sourceId);put('sources',{...s,status:'Loaded',lastAcceptedAt:now(),lastAcceptedUploadId:upload.id,lastAcceptedHash:upload.hash,pendingUploadId:'',rowCount:upload.parsed.length,name:s.name,lastFilename:upload.filename,lastUploadedAt:upload.uploadedAt});audit('Source review',null,`${upload.filename} accepted: ${JSON.stringify(counts)}. Existing values changed only for approved rows.`);
   syncAssetCoverage();
  });return counts;
 }
 return {preview,commit,publicPreview,sourceTypes,currentDrivers,insuranceReport,syncAssetCoverage,rememberIgnoredIssues};
}
