import {applyReviewPolicy} from './review-policy.mjs';
import {syncServices} from './services.mjs';
import {Buffer} from 'node:buffer';
import {randomUUID,createHash} from 'node:crypto';
import {extname} from 'node:path';
import {updateCrash} from './crashes.mjs';
import {driverNameMatches} from './insurance-drivers.mjs';
import {connectDrivers,planDriverLinks} from './driver-links.mjs';
import {setupReconciliation} from './reconciliation.mjs';
const ROOT='/tmp';
export const FIELDS=['section','serviceVehicleNumber','unitNumber','vin','year','make','model','plate','plateState','location','region','ownership','registrationExpiry','insuranceExpiry','odometer','odometerDate','fuelProvider','fuelCard','tollTag','condition','operationalState','lastOilChange','lastOilMileage','pmDueDate','pmDueMiles','tireCondition','mechanicalNotes','notes'];
export const CHECKS=['identity','location','ownership','registration','insurance','condition','maintenance','equipment'];
const now=()=>new Date().toISOString();
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const requireThat=(ok,msg,status)=>{if(!ok)fail(msg,status);};
export function parseCSV(text){
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}
 requireThat(!quoted,'Unclosed quote in CSV.');if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}
 const headers=(rows.shift()||[]).map(x=>x.trim().replace(/^\uFEFF/,''));requireThat(headers.includes('vin'),'CSV needs a vin column.');requireThat(new Set(headers).size===headers.length,'Duplicate CSV headers.');requireThat(rows.length<=3000,'Limit CSV to 3,000 rows.');
 return rows.filter(r=>r.some(c=>c.trim())).map((r,i)=>{requireThat(r.length===headers.length,`CSV row ${i+2} has the wrong number of columns.`);return Object.fromEntries(headers.map((h,j)=>[h,r[j].trim()]));});
}
function clean(input,old={}){
 const v={...old};for(const key of FIELDS){if(input[key]!==undefined){requireThat(['string','number'].includes(typeof input[key]),`Invalid ${key}.`);v[key]=String(input[key]).trim();requireThat(v[key].length<5000,`${key} is too long.`);}else if(v[key]===undefined)v[key]='';}
 requireThat(['','Services','Valet','Sales'].includes(v.section),'Choose Services, Valet, Sales, or leave section blank.');
 if(input.section!==undefined&&input.section!==old.section)v.sectionSource='Manual';
 v.vin=v.vin.toUpperCase().replace(/\s/g,'');v.plate=v.plate.toUpperCase();v.plateState=v.plateState.toUpperCase();
 requireThat(!v.vin||/^[A-HJ-NPR-Z0-9]{17}$/.test(v.vin),'VIN must be 17 characters without I, O or Q. Leave an unknown VIN blank.');
 requireThat(v.vin||v.unitNumber||v.model,'Provide a VIN, CCS number, or provisional asset description.');
 for(const k of ['registrationExpiry','insuranceExpiry','odometerDate','lastOilChange','pmDueDate'])if(v[k]&&v[k]!==old[k])requireThat(/^\d{4}-\d{2}-\d{2}$/.test(v[k])&&!isNaN(Date.parse(v[k]))&&new Date(v[k]).toISOString().slice(0,10)===v[k],`Invalid ${k} date.`);
 for(const k of ['year','odometer','lastOilMileage','pmDueMiles'])if(v[k])requireThat(Number.isFinite(Number(v[k]))&&Number(v[k])>=0&&(!['year'].includes(k)||Number.isInteger(Number(v[k]))&&Number(v[k])>=1900&&Number(v[k])<=2100),`Invalid ${k}.`);
 requireThat(['Unknown','Available','Maintenance','Out of service','Disposed'].includes(v.operationalState||'Unknown'),'Invalid operational status.');
 if(old.crashRepairActive&&v.operationalState!=='Disposed')v.operationalState='Out of service';v.operationalState=v.operationalState||'Unknown';v.condition=v.condition||'Unknown';v.driver=old.driver||'';v.id=old.id||randomUUID();v.createdAt=old.createdAt||now();v.updatedAt=now();v.version=(old.version||0)+1;
 v.checks=old.checks||{};v.verificationStatus=old.verificationStatus||'Not yet verified';
 if(FIELDS.some(k=>String(v[k]??'')!==String(old[k]??''))){v.verificationStatus='Not yet verified';v.checks={};v.verifiedAt='';v.verifiedBy='';}
 return v;
}

export async function handleFleet(state,path,method,b){
 const all=k=>structuredClone((state.records[k]||[]).filter(r=>k!=='drivers'||!r.voidedByUpload));
 const get=(k,id)=>{const r=all(k).find(x=>x.id===id);if(!r)fail('Record not found.',404);return r;};
 const put=(k,v)=>{if(k==='vehicles'&&v.vin&&!v.mergedInto&&all(k).some(x=>x.id!==v.id&&!x.mergedInto&&x.vin===v.vin))fail('That VIN already exists.',409);const rows=state.records[k]??=[];const i=rows.findIndex(x=>x.id===v.id);if(i<0)rows.push(structuredClone(v));else rows[i]=structuredClone(v);return v;};
 const tx=fn=>{const before=structuredClone(state);try{return fn();}catch(e){state.records=before.records;state.audit=before.audit;throw e;}};
 const audit=(action,v,note,before=null)=>state.audit.push({id:randomUUID(),time:now(),action,vehicleId:v?.id||'',note,before,after:v});
 let status=200,headers={},body='';
 const res={writeHead:(s,h)=>{status=s;headers={...headers,...h};},end:v=>{body=v;}};
 // One-time, non-destructive section upgrade for existing databases.
 const needsSection=all('vehicles').filter(v=>v.section===undefined);
 if(needsSection.length)tx(()=>{
  const refs=all('evidence'),mapping={'service':'Services','services':'Services','valet trash':'Valet','valet':'Valet','sales':'Sales'};let filled=0;
  for(const old of needsSection){
   const labels=[...new Set(refs.filter(e=>e.vehicleId===old.id&&e.sourceId==='fleet'&&e.match==='Exact VIN').map(e=>mapping[String(e.raw?.['Service Level']||'').toLowerCase().trim()]).filter(Boolean))];
   const section=labels.length===1?labels[0]:'';if(section)filled++;
   put('vehicles',{...old,section,sectionSource:section?'Fleet Sheet / Service Level':'Not recorded',version:old.version+1});
  }
  audit('Section upgrade',null,`${filled} CCS sections populated from explicit Fleet Sheet Service Level labels; other records left blank.`);
 });
 applyReviewPolicy({all,put,audit});
 const reconciliation=setupReconciliation({all,get,put,tx,audit,clean,ROOT});
 const syncPool=()=>syncServices({all,put,audit});syncPool();
 const linkDrivers=()=>connectDrivers({all:k=>k==='drivers'?reconciliation.currentDrivers():all(k),put,tx,audit});

 const token='public-shared';
 const version=(old,b)=>requireThat(old.version===b.version,'Record changed in another window. Close and reopen it before saving.',409);
 const active=()=>all('vehicles').filter(v=>!v.mergedInto);
 const uniqueUnit=v=>requireThat(!v.unitNumber||!active().some(x=>x.id!==v.id&&String(x.unitNumber).toUpperCase()===v.unitNumber.toUpperCase()),'That CCS number already exists. Review the duplicate.',409);
 function assignDriver(vehicleId,driverId,b){
  const target=vehicleId?get('vehicles',vehicleId):null,d=driverId?get('drivers',driverId):null;
  requireThat(!d?.isServiceDriver&&(!target||target.section!=='Services'&&!target.isServiceVehicle),'Services vehicles and drivers use pool placeholders, not permanent assignments.');
  requireThat(!d||!d.archived,'Restore the archived driver before assigning them.');
  requireThat(!target||!target.mergedInto&&target.operationalState!=='Disposed','Choose a current vehicle.');
  const affected=active().filter(v=>target&&v.id===target.id||d&&(v.driverId===d.id||!v.driverId&&driverNameMatches(d,v.driver)));
  const replacing=target&&(target.driverId&&target.driverId!==driverId||target.driver&&!d||target.driver&&d&&!driverNameMatches(d,target.driver));
  const moving=d&&affected.some(v=>v.id!==vehicleId);
  requireThat(!(replacing||moving)||b.confirmAssignment===true,'Confirm replacing or moving the current driver assignment.',409);
  for(const v of affected)if(v.id!==vehicleId)version(v,{version:b.assignmentVersions?.[v.id]});
  for(const v of affected){
   const next={...v,driver:v.id===vehicleId&&d?d.name:'',driverId:v.id===vehicleId&&d?d.id:'',version:v.version+1,updatedAt:now()};
   if(v.driverId&&v.driverId!==driverId){const prior=get('drivers',v.driverId);put('drivers',{...prior,assignmentOverride:true,version:prior.version+1,updatedAt:now()});}
   put('vehicles',next);audit('Driver reassignment',next,'Assignment changed manually; previous assignment retained in history.',v);
  }
  if(d){const latest=get('drivers',d.id);put('drivers',{...latest,assignmentOverride:true,version:latest.version+1,updatedAt:now()});}
 }
 const ccDriverIds=()=>{const source=all('sources').find(s=>s.id==='cc');return new Set(all('driverEvidence').filter(e=>e.sourceId==='cc'&&e.uploadId===source?.lastAcceptedUploadId).map(e=>e.driverId));};
 const ccIdsForFlags=ccDriverIds();
 const driverWithFlags=d=>({...d,inCC:ccIdsForFlags.has(d.id),ccStatus:ccIdsForFlags.has(d.id)?'In CC':'Not in CC'});
 const send=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 const csvCell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
 async function run(){
   if(path==='/api/bootstrap'&&method==='GET'){tx(()=>reconciliation.syncAssetCoverage());send(res,{driverLinkChecks:planDriverLinks(active(),reconciliation.currentDrivers()),insuranceComparison:reconciliation.insuranceReport(),token,vehicles:active(),drivers:reconciliation.currentDrivers().map(driverWithFlags),archivedDrivers:all('drivers').filter(d=>d.archived).map(driverWithFlags),driverEvidence:all('driverEvidence'),assignmentEvidence:all('assignmentEvidence'),sourceTypes:reconciliation.sourceTypes,uploads:all('uploads').map(u=>({id:u.id,sourceId:u.sourceId,filename:u.filename,uploadedAt:u.uploadedAt,acceptedAt:u.acceptedAt,status:u.status,storageAvailable:!!u.storagePath})),initialCCAvailable:false,sources:all('sources'),evidence:all('evidence'),issues:all('issues'),documents:all('documents').map(({base64,...d})=>d),audit:state.audit.slice(-300).reverse()});return;}
   const editDriver=path.match(/^\/api\/drivers\/([^/]+)$/);
   if(editDriver&&method==='PUT'){
    const old=get('drivers',editDriver[1]);version(old,b);const fields={};
    for(const k of ['name','employeeId','role','market','email','phone']){requireThat(typeof b[k]==='string'&&b[k].length<=160,'Invalid '+k+'.');fields[k]=b[k].trim().replace(/\s+/g,' ');}
    requireThat(fields.name.length>=2,'Enter the driver’s full name.');requireThat(!fields.email||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email),'Enter a valid email.');
    const emp=s=>String(s||'').toUpperCase().replace(/^0+(?=\d)/,'');
    requireThat(!all('drivers').some(d=>d.id!==old.id&&(fields.employeeId&&emp(d.employeeId)===emp(fields.employeeId)||fields.email&&String(d.email||'').toLowerCase()===fields.email.toLowerCase()||driverNameMatches(d,fields.name))),'Another driver has that name, employee number, or email.',409);
    tx(()=>{const next={...old,...fields,version:old.version+1,updatedAt:now()};put('drivers',next);
     if(b.vehicleId!==undefined){const target=b.vehicleId?get('vehicles',b.vehicleId):null;if(target)requireThat(b.vehicleVersion===target.version||target.driverId===old.id&&b.vehicleVersion===target.version-1,'Vehicle changed. Refresh and retry.',409);assignDriver(b.vehicleId||'',old.id,b);}
     for(const v of active().filter(v=>v.driverId===old.id))put('vehicles',{...v,driver:next.name,version:v.version+1,updatedAt:now()});
     audit('Driver details edited',null,old.name+': details updated.');});send(res,get('drivers',old.id));return;
   }
   if(path==='/api/drivers/bulk-review'&&method==='POST'){
    requireThat(Array.isArray(b.ids)&&b.ids.length>0&&b.ids.length<=10000&&b.ids.every(id=>typeof id==='string'),'Select drivers.');
    requireThat(['archive','insurance-add','keep'].includes(b.action),'Choose archive, keep active, or mark for insurance addition.');
    requireThat(['not-cc','missing-insurance'].includes(b.context),'Choose a driver review list.');
    requireThat(typeof b.note==='string'&&b.note.trim().length>=3&&b.note.length<=5000,'Enter a review note.');
    const activeIds=new Set(reconciliation.currentDrivers().map(d=>d.id)),ccIds=ccDriverIds(),report=reconciliation.insuranceReport();
    const missingIds=new Set(report?.add.map(d=>d.id)||[]);const items=[...new Set(b.ids)].map(id=>get('drivers',id));
    for(const d of items){version(d,{version:b.versions?.[d.id]});requireThat(activeIds.has(d.id)&&!d.archived,'A selected driver is no longer active. Refresh and retry.',409);requireThat(b.context==='not-cc'?!ccIds.has(d.id):missingIds.has(d.id),'A selected driver is no longer in this comparison list. Refresh and retry.',409);}
    tx(()=>{for(const d of items){const archived=b.action==='archive';put('drivers',{...d,...(archived?{archived:true,archivedAt:now(),archiveNote:b.note.trim(),statusHistory:[...(d.statusHistory||[]),{archived:true,note:b.note.trim(),at:now()}]}:{insuranceAction:b.action==='insurance-add'?'Needs insurance addition':'Keep active; reviewed',insuranceActionAt:now()}),version:d.version+1,updatedAt:now()});
     if(archived)for(const v of active().filter(v=>v.driverId===d.id||!v.driverId&&driverNameMatches(d,v.driver)))put('vehicles',{...v,driver:'',driverId:'',version:v.version+1,updatedAt:now()});
     audit(archived?'Driver archived':'Driver insurance review',null,d.name+': '+b.action+'. '+b.note.trim());}});
    send(res,{ok:true,count:items.length});return;
   }
   const archiveMatch=path.match(/^\/api\/drivers\/([^/]+)\/archive$/);
   if(archiveMatch&&method==='POST'){
    const old=get('drivers',archiveMatch[1]);version(old,b);
    requireThat(typeof b.archived==='boolean','Choose archive or restore.');
    requireThat(typeof b.note==='string'&&b.note.trim().length>=3&&b.note.length<=5000,'Enter a reason (3–5,000 characters).');
    requireThat(!!old.archived!==b.archived,'Driver status changed. Refresh and try again.',409);

    tx(()=>{put('drivers',{...old,archived:b.archived,archivedAt:b.archived?now():old.archivedAt,archiveNote:b.archived?b.note.trim():old.archiveNote,restoredAt:b.archived?old.restoredAt:now(),statusHistory:[...(old.statusHistory||[]),{archived:b.archived,note:b.note.trim(),at:now()}],version:old.version+1,updatedAt:now()});
     if(b.archived)for(const v of active().filter(v=>v.driverId===old.id||!v.driverId&&driverNameMatches(old,v.driver)))put('vehicles',{...v,driver:'',driverId:'',version:v.version+1,updatedAt:now()});
     audit(b.archived?'Driver archived':'Driver restored',null,old.name+': '+b.note.trim());});send(res,{ok:true});return;
   }
   const aliasMatch=path.match(/^\/api\/drivers\/([^/]+)\/aliases$/);
   if(aliasMatch&&method==='POST'){
    const old=get('drivers',aliasMatch[1]);version(old,b);
    requireThat(reconciliation.currentDrivers().some(d=>d.id===old.id),'Driver is not in the current CC roster.',409);
    requireThat(Array.isArray(b.aliases)&&b.aliases.length<=20&&b.aliases.every(x=>typeof x==='string'&&x.trim().length>=2&&x.trim().length<=120),'Enter up to 20 alternate full names.');
    const aliases=[...new Set(b.aliases.map(x=>x.trim().replace(/\s+/g,' ')))];
    requireThat(!aliases.some(name=>reconciliation.currentDrivers().some(d=>d.id!==old.id&&driverNameMatches(d,name))),'An alias matches another current driver. Resolve that identity before saving.',409);
    tx(()=>{put('drivers',{...old,aliases,version:old.version+1,updatedAt:now()});audit('Driver aliases',null,`${old.name}: insurance aliases changed to ${aliases.join('; ')||'(none)'}.`);});
    send(res,{ok:true});return;
   }
   if(path==='/api/issues/confirm'&&method==='POST'){
    requireThat(Array.isArray(b.ids)&&b.ids.length>0&&b.ids.length<=10000&&b.ids.every(id=>typeof id==='string'),'Select review items to confirm.');
    requireThat(typeof b.note==='string'&&b.note.trim().length>=10,'Add a review note (10+ characters).');
    const items=[...new Set(b.ids)].map(id=>get('issues',id));
    requireThat(items.every(i=>i.status==='Open'),'Some selected items changed. Refresh and select again.',409);
    tx(()=>{for(const i of items){put('issues',{...i,status:'Resolved',acknowledged:true,resolution:b.note.trim(),resolvedAt:now()});audit('Bulk review confirmed',get('vehicles',i.vehicleId),`${i.message}: ${b.note.trim()}`);}});
    send(res,{ok:true,confirmed:items.length});return;
   }
   if(path==='/api/issues/ignore'&&method==='POST'){
    requireThat(Array.isArray(b.ids)&&b.ids.length>0&&b.ids.length<=10000&&b.ids.every(id=>typeof id==='string'),'Choose review items to ignore.');
    const items=[...new Set(b.ids)].map(id=>get('issues',id));
    requireThat(items.every(i=>i.status==='Open'),'Review items changed. Refresh and try again.',409);
    tx(()=>{for(const i of items){put('issues',{...i,status:'Ignored',resolution:'Explicitly ignored; existing values retained.',resolvedAt:now()});audit('Ignore review',get('vehicles',i.vehicleId),i.message);}reconciliation.rememberIgnoredIssues(items);});
    send(res,{ok:true,ignored:items.length});return;
   }
   if(path==='/api/source-upload/jobs'&&method==='POST'){const result=await reconciliation.preview(b);send(res,{id:result.id,status:'complete',result});return;}
   if(path==='/api/source-upload/preview'&&method==='POST'){send(res,await reconciliation.preview(b));return;}
   if(path==='/api/source-upload/cancel'&&method==='POST'){send(res,reconciliation.cancelPending(b));return;}
   if(path==='/api/source-upload/commit'&&method==='POST'){const result=reconciliation.commit(b);syncPool();result.autoLinked=linkDrivers();send(res,result);return;}
   const up=path.match(/^\/api\/source-upload\/([^/]+)(?:\/(download))?$/);
   if(up&&method==='GET'){const u=get('uploads',up[1]);if(up[2]){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${u.filename}"`});res.end(Buffer.from(u.base64,'base64'));}else send(res,reconciliation.publicPreview(u));return;}
   if(path==='/api/driver-register'&&method==='POST'){
    const keys=['name','employeeId','email','phone','role','market'];const fields={};
    for(const k of keys){requireThat(b[k]===undefined||typeof b[k]==='string','Invalid '+k+'.');fields[k]=String(b[k]||'').trim().replace(/\s+/g,' ');requireThat(fields[k].length<=160,k+' is too long.');}
    requireThat(fields.name.length>=2,'Enter the driver’s full name.');
    requireThat(!fields.email||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email),'Enter a valid email address.');
    const employee=s=>String(s||'').trim().toUpperCase().replace(/^0+(?=\d)/,'');
    const duplicate=all('drivers').find(d=>fields.employeeId&&employee(d.employeeId)===employee(fields.employeeId)||fields.email&&String(d.email||'').toLowerCase()===fields.email.toLowerCase()||driverNameMatches(d,fields.name));
    requireThat(!duplicate,duplicate?.archived?'This driver is archived. Restore their record instead of adding a duplicate.':'This driver already exists. Search by name, employee number, or email.',409);
    const vehicle=b.vehicleId?get('vehicles',b.vehicleId):null;
    if(vehicle){version(vehicle,{version:b.vehicleVersion});requireThat(!vehicle.mergedInto&&vehicle.operationalState!=='Disposed','Choose a current vehicle.');requireThat(!vehicle.driver&&!vehicle.driverId,'This vehicle already has a driver. Review its assignment before changing it.',409);}
    if(vehicle)requireThat(vehicle.section!=='Services'&&!vehicle.isServiceVehicle,'Services vehicles use a shared driver pool.');
    const d={id:randomUUID(),...fields,manualAdded:true,createdBySource:'Manual entry',reportedVin:vehicle?.vin||'',reportedPlate:vehicle?.plate||'',version:1,createdAt:now(),updatedAt:now()};
    tx(()=>{put('drivers',d);if(vehicle){const next={...vehicle,driver:d.name,driverId:d.id,version:vehicle.version+1,updatedAt:now()};put('vehicles',next);audit('Driver assignment',next,d.name+' assigned when added manually.',vehicle);}audit('Driver added',null,d.name+' added manually; pending CC roster match.');});send(res,d,201);return;
   }
   if(path==='/api/vehicles'&&method==='POST'){const v=clean(b);uniqueUnit(v);tx(()=>{put('vehicles',v);audit('Create',v,'Manual vehicle record created.');});linkDrivers();send(res,get('vehicles',v.id),201);return;}
   const vm=path.match(/^\/api\/vehicles\/([^/]+)(?:\/(verify|merge|driver|section|crashes|confirm-asset))?$/);
   if(vm){const old=get('vehicles',vm[1]);requireThat(!old.mergedInto,'This record was merged.',409);version(old,b||{});
    if(method==='PUT'&&!vm[2]){const v=clean(b,old);if(String(v.unitNumber)!==String(old.unitNumber))uniqueUnit(v);tx(()=>{put('vehicles',v);syncPool();if(b.assignmentDriverId!==undefined)assignDriver(v.id,b.assignmentDriverId,b);audit('Edit',v,b.note||'Master record updated; verification reset.',old);});linkDrivers();send(res,get('vehicles',v.id));return;}
    if(method==='POST'&&vm[2]==='confirm-asset'){
     const source=all('sources').find(s=>s.id==='balance');
     const refs=all('evidence').filter(e=>e.active!==false&&e.vehicleId===old.id&&e.sourceId==='balance'&&(!source?.lastAcceptedUploadId||e.uploadId===source.lastAcceptedUploadId||e.automatic&&e.uploadId===source.pendingUploadId));
     requireThat(refs.length>0,'No accounting reference is linked to this vehicle.');
     requireThat(refs.every(e=>!e.needsReview&&(!e.reportedVin||e.reportedVin===old.vin)),'Resolve the conflicting accounting identifiers first.',409);
     requireThat(refs.every(e=>{const suffix=String(e.raw?.vinSuffix||e.fields?.vinSuffix||e.reportedVin||'').replace(/[^A-Z0-9]/gi,'').toUpperCase();return suffix.length>=6&&old.vin&&old.vin.endsWith(suffix);}), 'The accounting VIN reference does not match this vehicle. Recheck Source Comparison.',409);
     const v={...old,version:old.version+1,updatedAt:now()};
     tx(()=>{for(const e of refs)put('evidence',{...e,match:'Confirmed accounting match',confirmedVin:old.vin,confirmedAt:now()});put('vehicles',v);audit('Accounting match confirmed',v,'User confirmed the linked asset-list VIN reference. Lease and asset overlap is allowed.',old);});send(res,{ok:true});return;
    }
    if(method==='POST'&&vm[2]==='crashes'){const v=updateCrash(old,b);tx(()=>{put('vehicles',v);audit('Crash repair '+b.action,v,b.action==='cancel'?b.cancellationNote:b.action==='complete'?b.completionNote:b.description,old);});send(res,v);return;}
    if(method==='POST'&&vm[2]==='section'){
     requireThat(['','Services','Valet','Sales'].includes(b.section),'Choose Services, Valet, Sales, or leave section blank.');
     const v={...old,section:b.section,sectionSource:'Manual',version:old.version+1,updatedAt:now()};
     tx(()=>{put('vehicles',v);audit('CCS section',v,b.section?`Section set to ${b.section}.`:'CCS section cleared.',old);});send(res,v);return;
    }
    if(method==='POST'&&vm[2]==='driver'){
     requireThat(typeof b.driverId==='string','Select a registered driver or remove the assignment.');
     tx(()=>assignDriver(old.id,b.driverId,b));send(res,get('vehicles',old.id));return;
    }
    if(method==='POST'&&vm[2]==='verify'){
     requireThat(typeof b.reviewer==='string'&&b.reviewer.trim().length>=2,'Enter reviewer name.');requireThat(typeof b.note==='string'&&b.note.trim().length>=10,'Describe the verification evidence (10+ characters).');
     const checks=Object.fromEntries(CHECKS.map(k=>[k,b.checks?.[k]===true]));const complete=CHECKS.every(k=>checks[k]);
     if(checks.identity)requireThat(old.vin&&old.plate,'VIN and plate are required to verify identity.');if(checks.location)requireThat(old.location,'Record the current location first.');if(checks.ownership)requireThat(old.ownership,'Record the ownership / lease details first.');
     for(const k of ['registration','insurance'])if(checks[k])requireThat(old[k+'Expiry']&&old[k+'Expiry']>=now().slice(0,10),`Record a current ${k} expiry before verifying.`);
     if(checks.condition)requireThat(old.condition&&old.condition!=='Unknown','Record condition before verifying.');
     if(complete)requireThat(!old.crashRepairActive,'Complete the crash repair before verifying this vehicle.');
     if(complete)requireThat(!all('issues').some(i=>i.vehicleId===old.id&&i.status==='Open'),'Resolve open review items before completing verification.');
     const v={...old,checks,verifiedBy:b.reviewer.trim(),verifiedAt:complete?now():'',verificationNote:b.note.trim(),verificationStatus:complete?'Verified':'In progress',version:old.version+1,updatedAt:now()};tx(()=>{put('vehicles',v);audit('Verification',v,b.reviewer+': '+b.note,old);});send(res,v);return;
    }
    if(method==='POST'&&vm[2]==='merge'){
     const target=get('vehicles',b.targetId);version(target,{version:b.targetVersion});requireThat(target.id!==old.id&&!target.mergedInto,'Choose a different active destination.');requireThat(typeof b.note==='string'&&b.note.length>=10,'Explain why these records describe the same vehicle.');
     requireThat(!old.driver||!target.driver||old.driver===target.driver,'These records have different drivers. Reconcile assignments before merging.',409);
     tx(()=>{put('vehicles',{...old,mergedInto:target.id,version:old.version+1});for(const kind of ['evidence','issues','documents'])for(const e of all(kind).filter(e=>e.vehicleId===old.id))put(kind,{...e,vehicleId:target.id,originalVehicleId:old.id});const next={...target,crashHistory:[...(target.crashHistory||[]),...(old.crashHistory||[])],crashRepairActive:!!(target.crashRepairActive||old.crashRepairActive),operationalState:target.operationalState==='Disposed'?'Disposed':target.crashRepairActive||old.crashRepairActive?'Out of service':target.operationalState,driver:target.driver||old.driver||'',driverId:target.driverId||old.driverId||'',checks:{},verificationStatus:'Not yet verified',version:target.version+1,updatedAt:now()};put('vehicles',next);audit('Merge',next,`${old.vin||old.model} merged into ${target.vin||target.model}. ${b.note}`,old);});send(res,{ok:true});return;
    }
   }
   const im=path.match(/^\/api\/issues\/([^/]+)$/);if(im&&method==='PUT'){const i=get('issues',im[1]);requireThat(['Resolved','Open'].includes(b.status),'Invalid issue status.');requireThat(typeof b.note==='string'&&b.note.trim().length>=10,'Add a resolution note (10+ characters).');const v=get('vehicles',i.vehicleId);tx(()=>{put('issues',{...i,status:b.status,resolution:b.note,resolvedAt:now()});put('vehicles',{...v,checks:{},verificationStatus:'Not yet verified',version:v.version+1});audit('Review',v,`${i.message}: ${b.note}`);});send(res,{ok:true});return;}
   if(path==='/api/evidence'&&method==='POST'){
    const v=get('vehicles',b.vehicleId);requireThat(!v.mergedInto,'Record merged.');requireThat(typeof b.sourceName==='string'&&b.sourceName.trim(),'Source name required.');requireThat(typeof b.note==='string'&&b.note.length>=3,'Evidence note required.');
    const sid='manual-'+createHash('sha256').update(b.sourceName.trim()).digest('hex').slice(0,12);const e={id:randomUUID(),vehicleId:v.id,sourceId:sid,locator:String(b.locator||'Manual entry'),match:'Manual evidence',fields:{},raw:{note:b.note},reportedVin:v.vin};
    tx(()=>{put('sources',{id:sid,name:b.sourceName,note:'Manually recorded evidence',status:'Loaded'});put('evidence',e);audit('Evidence',v,b.sourceName+': '+b.note);});send(res,e);return;
   }
   if(path.startsWith('/api/import/'))fail('Use the source-specific upload preview and discrepancy approval workflow.',410);
   if(path==='/api/documents'&&method==='POST'){
    const v=get('vehicles',b.vehicleId);requireThat(typeof b.base64==='string'&&typeof b.filename==='string','File required.');const bytes=Buffer.from(b.base64,'base64');requireThat(bytes.length>0&&bytes.length<=5*1024*1024,'File must be 1 byte to 5 MB.');const ext=extname(b.filename).toLowerCase();const ok=ext==='.pdf'&&bytes.subarray(0,5).toString()==='%PDF-'||ext==='.png'&&bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'||['.jpg','.jpeg'].includes(ext)&&bytes.subarray(0,3).toString('hex')==='ffd8ff';requireThat(ok,'Upload a valid PDF, PNG, or JPEG.');
    const d={id:randomUUID(),vehicleId:v.id,filename:b.filename.replace(/[^\w. -]/g,'_').slice(0,150),category:String(b.category||'Other'),base64:bytes.toString('base64'),bytes:bytes.length,createdAt:now()};tx(()=>{put('documents',d);audit('Document',v,d.filename+' attached.');});send(res,{id:d.id},201);return;
   }
   const dm=path.match(/^\/api\/documents\/([^/]+)$/);if(dm&&method==='GET'){const d=get('documents',dm[1]);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${d.filename}"`});res.end(Buffer.from(d.base64,'base64'));return;}
   if(path==='/api/export.csv'&&method==='GET'){res.writeHead(200,{'Content-Type':'text/csv','Content-Disposition':'attachment; filename="CCS-vehicles.csv"'});const fields=[...FIELDS,'driver','verificationStatus'];res.end('\uFEFF'+[fields.join(','),...active().map(v=>fields.map(k=>csvCell(v[k])).join(','))].join('\r\n'));return;}
   if(path==='/api/backup'&&method==='GET'){res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':'attachment; filename="CCS-fleet-shared-backup.json"'});res.end(JSON.stringify({format:'ccs-fleet-shared-v1',exportedAt:now(),state}));return;}

 fail('Endpoint not found.',404);
 }
 await run();
 return {status,headers,body};
}
