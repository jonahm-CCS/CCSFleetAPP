import http from 'node:http';
import {AsyncLocalStorage} from 'node:async_hooks';
import {accessConfig,createAccess} from './access.mjs';
import {importBackup,startBackups,restoreAtStartup} from './hosted-storage.mjs';
import {connectDrivers,planDriverLinks} from './driver-links.mjs';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync,existsSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve,dirname,extname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setupReconciliation} from './reconciliation.mjs';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
export function isPathInside(base,file,pathApi={relative,isAbsolute,sep}) {
 const rel=pathApi.relative(base,file);
 return rel!=='' && rel!=='..' && !rel.startsWith('..'+pathApi.sep) && !pathApi.isAbsolute(rel);
}
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const FIELDS=['section','unitNumber','vin','year','make','model','plate','plateState','location','region','ownership','registrationExpiry','insuranceExpiry','odometer','odometerDate','fuelProvider','fuelCard','tollTag','condition','operationalState','lastOilChange','lastOilMileage','pmDueDate','pmDueMiles','tireCondition','mechanicalNotes','notes'];
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
 for(const k of ['registrationExpiry','insuranceExpiry','odometerDate','lastOilChange','pmDueDate'])if(v[k])requireThat(/^\d{4}-\d{2}-\d{2}$/.test(v[k])&&!isNaN(Date.parse(v[k]))&&new Date(v[k]).toISOString().slice(0,10)===v[k],`Invalid ${k} date.`);
 for(const k of ['year','odometer','lastOilMileage','pmDueMiles'])if(v[k])requireThat(Number.isFinite(Number(v[k]))&&Number(v[k])>=0&&(!['year'].includes(k)||Number.isInteger(Number(v[k]))&&Number(v[k])>=1900&&Number(v[k])<=2100),`Invalid ${k}.`);
 requireThat(['Unknown','Available','Maintenance','Out of service','Disposed'].includes(v.operationalState||'Unknown'),'Invalid operational status.');
 v.operationalState=v.operationalState||'Unknown';v.condition=v.condition||'Unknown';v.driver=old.driver||'';v.id=old.id||randomUUID();v.createdAt=old.createdAt||now();v.updatedAt=now();v.version=(old.version||0)+1;
 v.checks=old.checks||{};v.verificationStatus=old.verificationStatus||'Not yet verified';
 if(FIELDS.some(k=>String(v[k]??'')!==String(old[k]??''))){v.verificationStatus='Not yet verified';v.checks={};v.verifiedAt='';v.verifiedBy='';}
 return v;
}
export function createApp({dataDir=resolve(ROOT,'data'),port=3000,env=process.env}={}){
 const config=accessConfig(env),requestContext=new AsyncLocalStorage();
 mkdirSync(dataDir,{recursive:true});const db=new DatabaseSync(resolve(dataDir,'fleet.sqlite'));db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records(kind TEXT,id TEXT,payload TEXT NOT NULL,PRIMARY KEY(kind,id));CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,time TEXT,action TEXT,vehicleId TEXT,note TEXT,before TEXT,after TEXT);CREATE UNIQUE INDEX IF NOT EXISTS unique_vin ON records(json_extract(payload,'$.vin')) WHERE kind='vehicles' AND json_extract(payload,'$.vin')<>'' AND json_extract(payload,'$.mergedInto') IS NULL;`);
 if(config.hosted)restoreAtStartup(db,dataDir,env.CCS_RESTORE_FILE);
 const access=createAccess(db,config);
 const all=k=>db.prepare('SELECT payload FROM records WHERE kind=? ORDER BY rowid').all(k).map(r=>JSON.parse(r.payload));
 const get=(k,id)=>{const r=db.prepare('SELECT payload FROM records WHERE kind=? AND id=?').get(k,id);if(!r)fail('Record not found.',404);return JSON.parse(r.payload);};
 const put=(k,v)=>{try{db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload').run(k,v.id,JSON.stringify(v));}catch(e){if(e.message.includes('UNIQUE'))fail('That VIN already exists. Open its record or reconcile the duplicate.',409);throw e;}return v;};
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const audit=(action,v,note,before=null)=>db.prepare('INSERT INTO audit(time,action,vehicleId,note,before,after) VALUES(?,?,?,?,?,?)').run(now(),action,v?.id||'',(requestContext.getStore()?.email?'['+requestContext.getStore().email+'] ':'')+note,JSON.stringify(before),JSON.stringify(v));
 if(!config.hosted&&!all('sources').length){const seed=JSON.parse(readFileSync(resolve(ROOT,'data/seed.json')));tx(()=>{for(const kind of ['vehicles','sources','evidence','issues'])for(const item of seed[kind])put(kind,item);audit('Initial import',null,'Five supplied vehicle sources imported. Drivers blank; no records verified.');});}
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
 const reconciliation=setupReconciliation({all,get,put,tx,audit,clean,ROOT});
 const linkDrivers=()=>connectDrivers({all:k=>k==='drivers'?reconciliation.currentDrivers():all(k),put,tx,audit});
 linkDrivers();
 const token=randomBytes(24).toString('hex');
 const version=(old,b)=>requireThat(old.version===b.version,'Record changed in another window. Close and reopen it before saving.',409);
 const active=()=>all('vehicles').filter(v=>!v.mergedInto);
 const uniqueUnit=v=>requireThat(!v.unitNumber||!active().some(x=>x.id!==v.id&&String(x.unitNumber).toUpperCase()===v.unitNumber.toUpperCase()),'That CCS number already exists. Review the duplicate.',409);
 const send=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 const requestBody=async req=>{requireThat(req.headers['content-type']?.split(';')[0]==='application/json','Use application/json.',415);let n=0,chunks=[];for await(const chunk of req){n+=chunk.length;requireThat(n<42*1024*1024,'Upload exceeds 42 MB.',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks));}catch{fail('Invalid JSON.');}};
 const csvCell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
 const uploadJobs=new Map();
 const backups=config.hosted?startBackups(db,dataDir):null;
 const server=http.createServer((req,res)=>requestContext.run({},async()=>{
  try{
   if(req.url==='/healthz'&&req.method==='GET'){db.prepare('SELECT 1').get();send(res,{status:'ok'});return;}
   const host=req.headers.host||'';requireThat(config.hosted?host===config.host:/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host),'Invalid host.',403);
   res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
   if(config.hosted)res.setHeader('Strict-Transport-Security','max-age=31536000');
   res.setHeader('Cache-Control','no-store');
   const origin=config.hosted?config.origin:'http://'+host;
   const url=new URL(req.url,origin);const path=url.pathname;const method=req.method;let b;
   if(await access.route(req,res,url))return;
   const user=access.user(req);
   if(!user){if(path.startsWith('/api/')){send(res,{error:'Sign in with your CCS Google account.',login:'/auth/login'},401);}else{res.writeHead(302,{Location:'/auth/login'});res.end();}return;}
   requestContext.getStore().email=user.email;
   if(config.hosted&&path==='/api/backup')requireThat(user.role==='admin','Administrator access required for database backups.',403);
   if(!['GET','HEAD'].includes(method))requireThat(user.role!=='viewer','Your account has view-only access. Ask an administrator for editor access.',403);
   if(path==='/api/admin/initial-database'&&method==='POST'){
    requireThat(config.hosted&&user.role==='admin','Administrator access required.',403);
    requireThat(req.headers['x-ccs-token']===token&&req.headers.origin===origin,'Refresh setup and retry.',403);
    requireThat(all('vehicles').length===0&&all('uploads').length===0,'Initial database upload is locked once fleet data exists.',409);
    let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;requireThat(size<=512*1024*1024,'Backup exceeds 512 MB.',413);chunks.push(chunk);}
    const bytes=Buffer.concat(chunks);requireThat(bytes.subarray(0,16).toString()==='SQLite format 3\0','Choose the SQLite database backup from Activity & backup.');
    const temp=resolve(dataDir,'incoming-'+randomUUID()+'.sqlite');try{writeFileSync(temp,bytes,{mode:0o600});const result=importBackup(db,temp);setupReconciliation({all,get,put,tx,audit,clean,ROOT});linkDrivers();audit('Hosted migration',null,'Current local database imported by administrator.');backups?.backup();send(res,result);}finally{if(existsSync(temp))unlinkSync(temp);}return;
   }
   if(config.hosted&&!all('vehicles').length&&path==='/'&&method==='GET'){res.writeHead(200,{'Content-Type':'text/html'});res.end(readFileSync(resolve(ROOT,'public/setup.html')));return;}

   if(config.hosted&&!all('vehicles').length&&!['GET','HEAD'].includes(method))fail('An administrator must complete the initial database import first.',409);
   if(!['GET','HEAD'].includes(method)){requireThat(req.headers['x-ccs-token']===token,'Refresh the app and retry.',403);requireThat(!req.headers.origin||req.headers.origin===origin,'Cross-origin request blocked.',403);b=await requestBody(req);requireThat(b&&typeof b==='object'&&!Array.isArray(b),'Object required.');}
   if(path==='/api/bootstrap'&&method==='GET'){send(res,{user,hosted:config.hosted,setupRequired:config.hosted&&!all('vehicles').length,driverLinkChecks:planDriverLinks(active(),reconciliation.currentDrivers()),insuranceComparison:reconciliation.insuranceReport(),token,vehicles:active(),drivers:reconciliation.currentDrivers(),driverEvidence:all('driverEvidence'),assignmentEvidence:all('assignmentEvidence'),sourceTypes:reconciliation.sourceTypes,uploads:all('uploads').map(u=>({id:u.id,sourceId:u.sourceId,filename:u.filename,uploadedAt:u.uploadedAt,acceptedAt:u.acceptedAt,status:u.status})),initialCCAvailable:existsSync(resolve(ROOT,'data/initial-cc-export.csv')),sources:all('sources'),evidence:all('evidence'),issues:all('issues'),documents:all('documents').map(({base64,...d})=>d),audit:db.prepare('SELECT id,time,action,vehicleId,note FROM audit ORDER BY id DESC LIMIT 300').all()});return;}
   if(path==='/api/source-upload/jobs'&&method==='POST'){
    const id=randomUUID();uploadJobs.set(id,{id,status:'processing'});send(res,{id,status:'processing'},202);
    setImmediate(()=>reconciliation.preview(b).then(result=>uploadJobs.set(id,{id,status:'complete',result})).catch(e=>{uploadJobs.set(id,{id,status:'failed',error:e.status?e.message:'Comparison failed. Check the launch window for details.'});console.error(e);}));
    const expiry=setTimeout(()=>uploadJobs.delete(id),60*60*1000);expiry.unref();return;
   }
   const job=path.match(/^\/api\/source-upload\/jobs\/([^/]+)$/);if(job&&method==='GET'){requireThat(uploadJobs.has(job[1]),'Upload session unavailable. The server may have restarted; check pending uploads before retrying.',404);send(res,uploadJobs.get(job[1]));return;}
   if(path==='/api/source-upload/preview'&&method==='POST'){send(res,await reconciliation.preview(b));return;}
   if(path==='/api/source-upload/commit'&&method==='POST'){const result=reconciliation.commit(b);result.autoLinked=linkDrivers();send(res,result);return;}
   const up=path.match(/^\/api\/source-upload\/([^/]+)(?:\/(download))?$/);
   if(up&&method==='GET'){const u=get('uploads',up[1]);if(up[2]){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${u.filename}"`});res.end(Buffer.from(u.base64,'base64'));}else send(res,reconciliation.publicPreview(u));return;}
   if(path==='/api/driver-register'&&method==='POST'){
    fail('The Driver Register is maintained only through the CC upload in Source Comparison.',403);
   }
   if(path==='/api/vehicles'&&method==='POST'){const v=clean(b);uniqueUnit(v);tx(()=>{put('vehicles',v);audit('Create',v,'Manual vehicle record created.');});linkDrivers();send(res,get('vehicles',v.id),201);return;}
   const vm=path.match(/^\/api\/vehicles\/([^/]+)(?:\/(verify|merge|driver|section))?$/);
   if(vm){const old=get('vehicles',vm[1]);requireThat(!old.mergedInto,'This record was merged.',409);version(old,b||{});
    if(method==='PUT'&&!vm[2]){const v=clean(b,old);if(String(v.unitNumber)!==String(old.unitNumber))uniqueUnit(v);tx(()=>{put('vehicles',v);audit('Edit',v,b.note||'Master record updated; verification reset.',old);});linkDrivers();send(res,get('vehicles',v.id));return;}
    if(method==='POST'&&vm[2]==='section'){
     requireThat(['','Services','Valet','Sales'].includes(b.section),'Choose Services, Valet, Sales, or leave section blank.');
     const v={...old,section:b.section,sectionSource:'Manual',version:old.version+1,updatedAt:now()};
     tx(()=>{put('vehicles',v);audit('CCS section',v,b.section?`Section set to ${b.section}.`:'CCS section cleared.',old);});send(res,v);return;
    }
    if(method==='POST'&&vm[2]==='driver'){
     requireThat(typeof b.driver==='string'&&b.driver.trim().length<=120,'Driver name must be 120 characters or fewer.');
     let driver=b.driver.trim(),driverId='';if(b.driverId){const d=get('drivers',b.driverId);driver=d.name;driverId=d.id;}else if(driver){const hits=all('drivers').filter(d=>d.name.trim().toUpperCase()===driver.toUpperCase());requireThat(hits.length<=1,'Multiple registered drivers share that name. Select the correct driver.');if(hits.length)driverId=hits[0].id;}requireThat(!driver||driver.length>=2,'Enter the driver’s first and last name.');
     const v={...old,driver,driverId,version:old.version+1,updatedAt:now()};
     tx(()=>{put('vehicles',v);audit('Driver assignment',v,driver?`Driver set to ${driver}.`:'Driver assignment removed.',old);});send(res,v);return;
    }
    if(method==='POST'&&vm[2]==='verify'){
     requireThat(typeof b.reviewer==='string'&&b.reviewer.trim().length>=2,'Enter reviewer name.');requireThat(typeof b.note==='string'&&b.note.trim().length>=10,'Describe the verification evidence (10+ characters).');
     const checks=Object.fromEntries(CHECKS.map(k=>[k,b.checks?.[k]===true]));const complete=CHECKS.every(k=>checks[k]);
     if(checks.identity)requireThat(old.vin&&old.plate,'VIN and plate are required to verify identity.');if(checks.location)requireThat(old.location,'Record the current location first.');if(checks.ownership)requireThat(old.ownership,'Record the ownership / lease details first.');
     for(const k of ['registration','insurance'])if(checks[k])requireThat(old[k+'Expiry']&&old[k+'Expiry']>=now().slice(0,10),`Record a current ${k} expiry before verifying.`);
     if(checks.condition)requireThat(old.condition&&old.condition!=='Unknown','Record condition before verifying.');
     if(complete)requireThat(!all('issues').some(i=>i.vehicleId===old.id&&i.status==='Open'),'Resolve open review items before completing verification.');
     const v={...old,checks,verifiedBy:b.reviewer.trim(),verifiedAt:complete?now():'',verificationNote:b.note.trim(),verificationStatus:complete?'Verified':'In progress',version:old.version+1,updatedAt:now()};tx(()=>{put('vehicles',v);audit('Verification',v,b.reviewer+': '+b.note,old);});send(res,v);return;
    }
    if(method==='POST'&&vm[2]==='merge'){
     const target=get('vehicles',b.targetId);version(target,{version:b.targetVersion});requireThat(target.id!==old.id&&!target.mergedInto,'Choose a different active destination.');requireThat(typeof b.note==='string'&&b.note.length>=10,'Explain why these records describe the same vehicle.');
     requireThat(!old.driver||!target.driver||old.driver===target.driver,'These records have different drivers. Reconcile assignments before merging.',409);
     tx(()=>{put('vehicles',{...old,mergedInto:target.id,version:old.version+1});for(const kind of ['evidence','issues','documents'])for(const e of all(kind).filter(e=>e.vehicleId===old.id))put(kind,{...e,vehicleId:target.id,originalVehicleId:old.id});const next={...target,driver:target.driver||old.driver||'',driverId:target.driverId||old.driverId||'',checks:{},verificationStatus:'Not yet verified',version:target.version+1,updatedAt:now()};put('vehicles',next);audit('Merge',next,`${old.vin||old.model} merged into ${target.vin||target.model}. ${b.note}`,old);});send(res,{ok:true});return;
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
   if(path==='/api/backup'&&method==='GET'){const p=resolve(dataDir,'backup-'+randomUUID()+'.sqlite');try{db.prepare('VACUUM INTO ?').run(p);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="CCS-fleet-backup.sqlite"'});res.end(readFileSync(p));}finally{if(existsSync(p))unlinkSync(p);}return;}
   if(path.startsWith('/api/'))fail('Endpoint not found.',404);
   requireThat(method==='GET'||method==='HEAD','Method not allowed.',405);const rel=path==='/'?'index.html':decodeURIComponent(path).slice(1);const file=resolve(ROOT,'public',rel);requireThat(isPathInside(resolve(ROOT,'public'),file),'Invalid path.',403);if(!existsSync(file))fail('File not found.',404);const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.csv':'text/csv'};res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':config.hosted?'private, no-store':'no-cache'});res.end(method==='HEAD'?'':readFileSync(file));
  }catch(e){if(!res.headersSent)send(res,{error:e.status?e.message:'Unexpected server error. Check the server console.'},e.status||500);else res.end();if(!e.status)console.error(e);}
 }));return {server,db,close:()=>{backups?.stop();return new Promise(r=>server.close(()=>{db.close();r();}));}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const port=Number(process.env.PORT||3000);const app=createApp({dataDir:process.env.CCS_DATA_DIR?resolve(process.env.CCS_DATA_DIR):undefined,port});app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`Port ${port} is already in use. Close the other copy or set PORT to another number.`:e);process.exit(1);});app.server.listen(port,accessConfig(process.env).hosted?'0.0.0.0':'127.0.0.1',()=>console.log('CCS Fleet is ready on port '+port));
 process.on('SIGINT',async()=>{await app.close();process.exit();});process.on('SIGTERM',async()=>{await app.close();process.exit();});
}
