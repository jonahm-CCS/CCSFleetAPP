import {createClient} from 'npm:@supabase/supabase-js@2.57.4';
import {Buffer} from 'node:buffer';
import {handleFleet} from './engine.mjs';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type,x-ccs-token,authorization,apikey','Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS','Cache-Control':'no-store'};
const secrets=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}');
const db=createClient(Deno.env.get('SUPABASE_URL')!,secrets.default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{...cors,'Content-Type':'application/json'}});
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 try{
  const path=new URL(req.url).pathname.replace(/^.*\/fleet-api/,'');
  if(path==='/health')return json({ok:true,storage:'Supabase',version:'1.0.0'});
  if(!['GET','POST','PUT'].includes(req.method))return json({error:'Method not allowed'},405);
  let body;
  if(req.method!=='GET'){
   if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Use application/json'},415);
   const reader=req.body?.getReader();const chunks=[];let length=0;
   if(reader)while(true){const r=await reader.read();if(r.done)break;length+=r.value.length;if(length>43*1024*1024){await reader.cancel();return json({error:'Upload exceeds 42 MB'},413);}chunks.push(r.value);}
   try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{return json({error:'Invalid JSON'},400);}
   if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'Object required'},400);
  }
  const {data:row,error}=await db.from('fleet_state').select('revision,payload').eq('id',1).single();
  if(error)throw error;
  const state=row.payload;const before=JSON.stringify(state);
  // Download only the requested stored file; binary files stay out of fleet state.
  const match=path.match(/^\/api\/(?:source-upload\/([^/]+)\/download|documents\/([^/]+))$/);
  if(match&&req.method==='GET'){
   const record=(state.records[match[1]?'uploads':'documents']||[]).find((x:any)=>x.id===(match[1]||match[2]));
   if(!record)return json({error:'File not found'},404);
   if(!record.storagePath)return json({error:'The original file was not included in the published snapshot. Re-upload it in Source Comparison.'},404);
   const {data:file,error:err}=await db.storage.from('fleet-files').download(record.storagePath);if(err)throw err;
   return new Response(file,{headers:{...cors,'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${record.filename}"`}});
  }
  const result=await handleFleet(state,path,req.method,body);
  for(const kind of ['uploads','documents'])for(const record of state.records[kind]||[]){
   if(record.base64){
    const storagePath=kind+'/'+record.id+'/'+record.filename;
    const {error:err}=await db.storage.from('fleet-files').upload(storagePath,Buffer.from(record.base64,'base64'),{contentType:'application/octet-stream',upsert:false});
    if(err)throw err;record.storagePath=storagePath;delete record.base64;
   }
  }
  if(JSON.stringify(state)!==before){
   const {error:saveError}=await db.rpc('fleet_commit',{expected_revision:row.revision,next_payload:state});
   if(saveError){if(saveError.code==='40001')return json({error:'Another employee saved changes. Refresh, reopen this item, and retry. Your changes were not saved.'},409);throw saveError;}
  }
  return new Response(result.body,{status:result.status,headers:{...result.headers,...cors}});
 }catch(e){console.error(e);return json({error:e.status?e.message:'Shared storage request failed. Retry shortly; if it continues, contact the fleet administrator.'},e.status||500);}
});
