import {DatabaseSync} from 'node:sqlite';import {mkdirSync,readdirSync,unlinkSync,existsSync,readFileSync} from 'node:fs';import {resolve} from 'node:path';import {randomUUID,createHash} from 'node:crypto';
export function importBackup(db,path,{allowExisting=false}={}){
 if(!allowExisting&&db.prepare("SELECT count(*) n FROM records WHERE kind IN ('vehicles','drivers','uploads')").get().n)throw Object.assign(Error('Initial setup is locked because fleet data already exists.'),{status:409});
 const source=new DatabaseSync(path,{readOnly:true});try{
  if(source.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('The SQLite backup failed integrity checks.');
  const records=source.prepare('SELECT kind,id,payload FROM records').all();if(!records.some(r=>r.kind==='vehicles'))throw Error('No vehicle records found. Use the full database backup from Activity & backup.');
  for(const r of records){const p=JSON.parse(r.payload);if(!p||typeof p!=='object'||p.id!==r.id)throw Error('Invalid record in backup.');}
  const audit=source.prepare('SELECT time,action,vehicleId,note,before,after FROM audit ORDER BY id').all();
  db.exec('BEGIN IMMEDIATE');try{db.exec('DELETE FROM records;DELETE FROM audit;');const put=db.prepare('INSERT INTO records(kind,id,payload) VALUES(?,?,?)');for(const r of records)put.run(r.kind,r.id,r.payload);const log=db.prepare('INSERT INTO audit(time,action,vehicleId,note,before,after) VALUES(?,?,?,?,?,?)');for(const a of audit)log.run(a.time,a.action,a.vehicleId,a.note,a.before,a.after);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  return {records:records.length,vehicles:records.filter(r=>r.kind==='vehicles').length};
 }finally{source.close();}
}
export function startBackups(db,dataDir){
 const dir=resolve(dataDir,'backups');mkdirSync(dir,{recursive:true});
 function backup(){if(!db.prepare("SELECT count(*) n FROM records WHERE kind='vehicles'").get().n)return;const day=new Date().toISOString().slice(0,10);if(readdirSync(dir).some(n=>n.startsWith(day)))return;const target=resolve(dir,day+'-'+randomUUID()+'.sqlite');try{db.prepare('VACUUM INTO ?').run(target);}catch(e){if(existsSync(target))unlinkSync(target);throw e;}const files=readdirSync(dir).filter(n=>/^\d{4}-\d{2}-\d{2}-.+\.sqlite$/.test(n)).sort().reverse();for(const n of files.slice(14))unlinkSync(resolve(dir,n));}
 function safe(){try{backup();}catch(e){console.error('Scheduled SQLite backup failed:',e.message);}}
 safe();const timer=setInterval(safe,3600000);timer.unref();return {stop:()=>clearInterval(timer),backup:safe};
}

export function restoreAtStartup(db,dataDir,filename){
 if(!filename)return;
 const path=resolve(dataDir,filename);if(!path.startsWith(resolve(dataDir)+'/')||path===resolve(dataDir,'fleet.sqlite'))throw Error('Restore source must be a separate backup file under CCS_DATA_DIR.');
 const digest=createHash('sha256').update(readFileSync(path)).digest('hex');db.exec('CREATE TABLE IF NOT EXISTS completed_restores(hash TEXT PRIMARY KEY,time TEXT NOT NULL)');if(db.prepare('SELECT hash FROM completed_restores WHERE hash=?').get(digest))return;
 const backupDir=resolve(dataDir,'recovery');mkdirSync(backupDir,{recursive:true});db.prepare('VACUUM INTO ?').run(resolve(backupDir,'before-restore-'+randomUUID()+'.sqlite'));
 importBackup(db,path,{allowExisting:true});db.prepare('INSERT INTO completed_restores VALUES(?,?)').run(digest,new Date().toISOString());console.log('Requested SQLite backup restored. Remove CCS_RESTORE_FILE from the environment.');
}
