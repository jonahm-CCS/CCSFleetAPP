import http from 'node:http';
import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createApp} from '../server/index.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
function config(dir){return {CCS_HOSTED:'true',CCS_DATA_DIR:dir,CCS_BASE_URL:'https://fleet.example.test',CCS_ALLOWED_DOMAIN:'example.test',CCS_ADMIN_EMAILS:'admin@example.test',CCS_EDITOR_EMAILS:'editor@example.test',GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret'};}
function fixture(path){const db=new DatabaseSync(path);db.exec('CREATE TABLE records(kind TEXT,id TEXT,payload TEXT,PRIMARY KEY(kind,id));CREATE TABLE audit(id INTEGER PRIMARY KEY,time TEXT,action TEXT,vehicleId TEXT,note TEXT,before TEXT,after TEXT)');for(const [kind,payload]of [['vehicles',{id:'vehicle',vin:'1N6ED1CLXTN608649',unitNumber:'1',driver:'',section:'Services',version:1,operationalState:'Available'}],['sources',{id:'fleet',name:'Fleet Sheet'}],['documents',{id:'doc',vehicleId:'vehicle',filename:'test.txt',base64:'YWJj',bytes:3}]])db.prepare('INSERT INTO records VALUES(?,?,?)').run(kind,payload.id,JSON.stringify(payload));db.close();}
test('hosted access fails closed, enforces roles, imports once and persists across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ccs-hosted-')),env=config(dir);assert.throws(()=>createApp({dataDir:dir,env:{RENDER:'true'}}),/requires/);let app=createApp({dataDir:dir,env});
 async function start(){await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+app.server.address().port;}let base=await start();
 const request=(path,{user,method='GET',body,origin='https://fleet.example.test',token,host='fleet.example.test'}={})=>new Promise((resolve,reject)=>{const req=http.request(base+path,{method,headers:{Host:host,...(user?{Cookie:'__Host-ccs-session='+user}:{}),...(body?{'Content-Type':'application/json',Origin:origin,'X-CCS-Token':token||''}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,json:async()=>JSON.parse(text),text:async()=>text,headers:{get:k=>{const value=res.headers[k.toLowerCase()];return Array.isArray(value)?value.join(','):value;}}});});});req.on('error',reject);req.end(body?typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body):undefined);});

 function session(id){app.db.prepare('INSERT INTO web_sessions VALUES(?,?,?)').run(hash(id),JSON.stringify({email:id+'@example.test',sub:id}),Date.now()+60000);}
 try{
  assert.equal((await request('/api/bootstrap')).status,401);assert.equal((await request('/evidence/image1.png')).status,302);assert.equal((await request('/healthz',{host:'internal-health'})).status,200);assert.equal((await request('/api/bootstrap',{host:'evil.example'})).status,403);
  for(const id of ['admin','editor','viewer'])session(id);
  const boot=await(await request('/api/bootstrap',{user:'admin'})).json();assert.equal(boot.setupRequired,true);assert.equal(boot.vehicles.length,0);
  assert.equal((await request('/api/vehicles',{user:'viewer',method:'POST',token:boot.token,body:{model:'blocked'}})).status,403);
  assert.equal((await request('/api/backup',{user:'viewer'})).status,403);
  const file=join(dir,'fixture.sqlite');fixture(file);const bytes=readFileSync(file);
  assert.equal((await request('/api/admin/initial-database',{user:'editor',method:'POST',token:boot.token,body:bytes})).status,403);
  assert.equal((await request('/api/admin/initial-database',{user:'admin',method:'POST',token:boot.token,origin:'https://evil.example',body:bytes})).status,403);
  const imported=await request('/api/admin/initial-database',{user:'admin',method:'POST',token:boot.token,body:bytes});assert.equal(imported.status,200,await imported.text());
  assert.equal((await request('/api/admin/initial-database',{user:'admin',method:'POST',token:boot.token,body:bytes})).status,409);
  const live=await(await request('/api/bootstrap',{user:'viewer'})).json();assert.equal(live.vehicles.length,1);assert.equal(live.documents.length,1);assert.equal(live.user.role,'viewer');assert.ok(readdirSync(join(dir,'backups')).length);
  assert.equal((await request('/api/vehicles/vehicle/section',{user:'editor',method:'POST',token:live.token,body:{version:1,section:'Sales'}})).status,200);
  await app.close();app=createApp({dataDir:dir,env});base=await start();const again=await(await request('/api/bootstrap',{user:'admin'})).json();assert.equal(again.vehicles[0].section,'Sales');assert.equal(again.documents.length,1);assert.equal(again.setupRequired,false);assert.ok(again.audit.some(a=>a.note.includes('editor@example.test')));
  assert.equal((await request('/auth/callback?code=bad&state=bad',{user:'admin'})).status,403);
  const login=await request('/auth/login');assert.equal(login.status,302);assert.match(login.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);assert.match(login.headers.get('location'),/code_challenge/);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('startup recovery preserves a safety backup and is not reapplied on later restarts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ccs-restore-')),env=config(dir);fixture(join(dir,'restore.sqlite'));env.CCS_RESTORE_FILE='restore.sqlite';let app=createApp({dataDir:dir,env});
 try{assert.equal(JSON.parse(app.db.prepare("SELECT payload FROM records WHERE kind='vehicles'").get().payload).unitNumber,'1');app.db.prepare("UPDATE records SET payload=json_set(payload,'$.unitNumber','2') WHERE kind='vehicles'").run();assert.equal(readdirSync(join(dir,'recovery')).length,1);await app.close();app=createApp({dataDir:dir,env});assert.equal(JSON.parse(app.db.prepare("SELECT payload FROM records WHERE kind='vehicles'").get().payload).unitNumber,'2');assert.equal(readdirSync(join(dir,'recovery')).length,1);}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
