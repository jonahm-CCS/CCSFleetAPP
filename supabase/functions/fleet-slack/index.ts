import {createClient} from 'npm:@supabase/supabase-js@2.57.4';
import {createHmac,timingSafeEqual,createHash} from 'node:crypto';
import {handleFleet} from '../fleet-api/engine.mjs';
const CHANNEL='C0A65AH12BU';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
Deno.serve(async req=>{
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 try{
 const secret=Deno.env.get('FLEET_SLACK_SIGNING_SECRET');
 if(!secret)return json({error:'Slack connection awaiting setup'},503);
 const raw=await req.text();if(raw.length>1000000)return json({error:'Too large'},413);const ts=req.headers.get('x-slack-request-timestamp')||'',signature=req.headers.get('x-slack-signature')||'';
 if(!/^\d+$/.test(ts)||Math.abs(Date.now()/1000-Number(ts))>300)return json({error:'Invalid timestamp'},401);
 const expected='v0='+createHmac('sha256',secret).update('v0:'+ts+':'+raw).digest('hex');
 if(signature.length!==expected.length||!timingSafeEqual(new TextEncoder().encode(signature),new TextEncoder().encode(expected)))return json({error:'Invalid signature'},401);
 let payload;try{payload=JSON.parse(raw);}catch{return json({error:'Invalid JSON'},400);}
 if(payload.team_id&&payload.team_id!=='T05KD0PN5K9')return json({error:'Wrong workspace'},403);
 if(payload.type==='url_verification')return json({challenge:payload.challenge});
 const e=payload.event;
 if(payload.type!=='event_callback'||e?.type!=='message'||e.channel!==CHANNEL||e.subtype==='message_changed'||e.subtype==='message_deleted'||e.thread_ts&&e.thread_ts!==e.ts)return json({ok:true,ignored:true});
 const text=String(e.text||'').replace(/\*/g,'');
 const type=/An employee has been deactivated\./i.test(text)?'deactivated':/An employee has been activated\./i.test(text)?'activated':/Who is the current driver\?/i.test(text)?'vehicle-check':/Fleet Change of User|New Responsible User/i.test(text)?'driver-swap':'';
 if(!type)return json({ok:true,ignored:true});
 const field=(label:string)=>text.match(new RegExp('^'+label+':[ \t]*(.*)$','mi'))?.[1]?.trim()||'';
 const name=field('Name'),date=field(type==='activated'?'Activated At':'Deactivated At');
 const id=createHash('sha256').update([CHANNEL,e.user||e.bot_id||'unknown',type,name.toLowerCase(),date||e.ts].join('|')).digest('hex');
 const keys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}');
 const db=createClient(Deno.env.get('SUPABASE_URL')!,keys.default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
 for(let attempt=0;attempt<3;attempt++){
 const {data:row,error}=await db.from('fleet_state').select('revision,payload').eq('id',1).single();if(error)return json({error:'Storage unavailable'},503);
 const state=row.payload;state.records.slackEvents??=[];
 if(state.records.slackEvents.some((x:any)=>x.id===id))return json({ok:true,duplicate:true});
 const item:any={id,type,name,text,receivedAt:new Date().toISOString(),messageAt:e.ts,url:`https://ccs-valettrash.slack.com/archives/${CHANNEL}/p${e.ts.replace('.','')}`,status:'Needs review',files:(e.files||[]).map((f:any)=>({id:f.id,name:f.name,permalink:f.permalink}))};
 // Only the verified CCS bot may trigger employee status changes.
 const trusted=e.user==='U0B585HSK28';
 const start=Number(Deno.env.get('FLEET_SLACK_START_TS')||Infinity);
 const ds=state.records.drivers.filter((d:any)=>!d.voidedByUpload&&String(d.name).trim().toLowerCase()===name.toLowerCase());
 if(trusted&&Number(e.ts)>=start&&['activated','deactivated'].includes(type)&&name&&date){
  if(ds.length===1){const d=ds[0];item.driverId=d.id;
   if(Number(e.ts)<=Number(d.lastSlackEmployeeTs||0)||Date.parse(d.updatedAt||'')>Number(e.ts)*1000)item.status='Ignored older notice';
   else {if(!!d.archived!==(type==='deactivated'))await handleFleet(state,`/api/drivers/${d.id}/archive`,'POST',{version:d.version,archived:type==='deactivated',note:`Slack ${type}: ${date}. ${item.url}`});
    const current=state.records.drivers.find((x:any)=>x.id===d.id);current.lastSlackEmployeeTs=e.ts;current.slackAdded=true;item.status='Applied';}
  }else if(!ds.length&&type==='activated'){
   try{const r=await handleFleet(state,'/api/driver-register','POST',{name,role:field('Position'),market:field('Region')});const d=JSON.parse(r.body);item.driverId=d.id;state.records.drivers.find((x:any)=>x.id===d.id).lastSlackEmployeeTs=e.ts;item.status='Applied';}catch{item.status='Needs identity review';}
  }
 }
 state.records.slackEvents.push(item);state.records.slackConnection=[{id:'slack',lastReceivedAt:item.receivedAt,channel:CHANNEL}];
 state.audit.push({id:crypto.randomUUID(),time:item.receivedAt,action:'Slack '+type,vehicleId:'',note:`${name||type}: ${item.status}. ${item.url}`});
 const {error:save}=await db.rpc('fleet_commit',{expected_revision:row.revision,next_payload:state});if(!save)return json({ok:true,status:item.status});if(save.code!=='40001')return json({error:'Save failed'},503);
 }
 return json({error:'Retry delivery'},503);
 }catch{return json({error:'Event processing failed; retry delivery'},503);}
});
