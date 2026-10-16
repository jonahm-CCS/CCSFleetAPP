import {randomBytes,createHash,createPublicKey,verify} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const fail=(message,status=403)=>{throw Object.assign(Error(message),{status});};
const list=s=>String(s||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
const cookie=(name,value,age=28800)=>`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const cookies=req=>Object.fromEntries(String(req.headers.cookie||'').split(';').map(s=>s.trim().split('=')));
export function accessConfig(env){
 const hosted=env.CCS_HOSTED==='true'||env.RENDER==='true'||env.NODE_ENV==='production';if(!hosted)return {hosted:false};
 for(const k of ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','CCS_ALLOWED_DOMAIN','CCS_ADMIN_EMAILS','CCS_DATA_DIR'])if(!env[k])throw Error(`Hosted startup requires ${k}.`);
 const base=new URL(env.CCS_BASE_URL||env.RENDER_EXTERNAL_URL||(()=>{throw Error('Hosted startup requires CCS_BASE_URL or RENDER_EXTERNAL_URL.');})());if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('CCS_BASE_URL must be an HTTPS origin, with no path.');
 const domain=env.CCS_ALLOWED_DOMAIN.toLowerCase().trim(),admins=list(env.CCS_ADMIN_EMAILS),editors=list(env.CCS_EDITOR_EMAILS);
 if(!admins.length||[...admins,...editors].some(email=>email.split('@')[1]!==domain))throw Error('Administrator and editor emails must belong to CCS_ALLOWED_DOMAIN.');
 return {hosted,origin:base.origin,host:base.host,domain,admins,editors,clientId:env.GOOGLE_CLIENT_ID,clientSecret:env.GOOGLE_CLIENT_SECRET};
}
export async function verifyGoogleToken(token,config,nonce,fetcher=fetch){
 const segments=String(token||'').split('.');if(segments.length!==3)fail('Invalid sign-in token.');
 const header=JSON.parse(Buffer.from(segments[0],'base64url')),claims=JSON.parse(Buffer.from(segments[1],'base64url'));
 if(header.alg!=='RS256'||!header.kid)fail('Invalid sign-in algorithm.');
 const res=await fetcher('https://www.googleapis.com/oauth2/v3/certs',{signal:AbortSignal.timeout(10000)});if(!res.ok)fail('Cannot verify Google sign-in.',503);const jwks=await res.json(),jwk=jwks.keys?.find(k=>k.kid===header.kid&&k.kty==='RSA');
 if(!jwk||!verify('RSA-SHA256',Buffer.from(segments[0]+'.'+segments[1]),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(segments[2],'base64url')))fail('Invalid sign-in signature.');
 if(!['https://accounts.google.com','accounts.google.com'].includes(claims.iss)||claims.aud!==config.clientId||(claims.azp&&claims.azp!==config.clientId)||!Number.isFinite(claims.exp)||claims.exp*1000<=Date.now()||claims.iat*1000>Date.now()+60000||claims.nonce!==nonce||claims.email_verified!==true||claims.hd!==config.domain||String(claims.email).toLowerCase().split('@')[1]!==config.domain||!claims.sub)fail('Use an approved company Google account.');
 return {email:claims.email.toLowerCase(),name:claims.name||claims.email,sub:claims.sub};
}
export function createAccess(db,config){
 if(!config.hosted)return {config,user:()=>({email:'local',role:'admin'}),route:async()=>false};
 db.exec('CREATE TABLE IF NOT EXISTS web_sessions(hash TEXT PRIMARY KEY,payload TEXT NOT NULL,expires INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS web_logins(hash TEXT PRIMARY KEY,payload TEXT NOT NULL,expires INTEGER NOT NULL)');
 const role=email=>config.admins.includes(email)?'admin':config.editors.includes(email)?'editor':'viewer';
 const redirect=(res,url)=>{res.writeHead(302,{Location:url,'Cache-Control':'no-store'});res.end();};
 function user(req){const token=cookies(req)['__Host-ccs-session'];if(!token)return null;const r=db.prepare('SELECT payload FROM web_sessions WHERE hash=? AND expires>?').get(hash(token),Date.now());if(!r)return null;const u=JSON.parse(r.payload);if(u.email.split('@')[1]!==config.domain)return null;return {...u,role:role(u.email)};}
 async function route(req,res,url){
  if(url.pathname==='/auth/login'&&req.method==='GET'){
   db.prepare('DELETE FROM web_sessions WHERE expires<?').run(Date.now());db.prepare('DELETE FROM web_logins WHERE expires<?').run(Date.now());
   const state=secret(),nonce=secret(),verifier=secret();db.prepare('INSERT INTO web_logins VALUES(?,?,?)').run(hash(state),JSON.stringify({nonce,verifier}),Date.now()+600000);
   res.setHeader('Set-Cookie',cookie('__Host-ccs-login',state,600));const dest=new URL('https://accounts.google.com/o/oauth2/v2/auth');dest.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.origin+'/auth/callback',response_type:'code',scope:'openid email profile',state,nonce,hd:config.domain,prompt:'select_account',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();redirect(res,dest.href);return true;
  }
  if(url.pathname==='/auth/callback'&&req.method==='GET'){
   const state=url.searchParams.get('state');if(!state||state!==cookies(req)['__Host-ccs-login'])fail('Sign-in expired. Start again.');const login=db.prepare('SELECT payload FROM web_logins WHERE hash=? AND expires>?').get(hash(state),Date.now());if(!login)fail('Sign-in expired. Start again.');db.prepare('DELETE FROM web_logins WHERE hash=?').run(hash(state));
   if(!url.searchParams.get('code'))fail('Google sign-in was not completed.');const {nonce,verifier}=JSON.parse(login.payload);
   const result=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:url.searchParams.get('code'),client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:config.origin+'/auth/callback',grant_type:'authorization_code',code_verifier:verifier}),signal:AbortSignal.timeout(15000)});if(!result.ok)fail('Google sign-in could not be completed. Please retry.');
   const u=await verifyGoogleToken((await result.json()).id_token,config,nonce),token=secret();db.prepare('INSERT INTO web_sessions VALUES(?,?,?)').run(hash(token),JSON.stringify(u),Date.now()+28800000);res.setHeader('Set-Cookie',[cookie('__Host-ccs-session',token),cookie('__Host-ccs-login','',0)]);redirect(res,'/');return true;
  }
  if(url.pathname==='/auth/logout'&&req.method==='POST'){
   if(req.headers.origin!==config.origin)fail('Cross-origin request blocked.');const value=cookies(req)['__Host-ccs-session'];if(value)db.prepare('DELETE FROM web_sessions WHERE hash=?').run(hash(value));res.setHeader('Set-Cookie',cookie('__Host-ccs-session','',0));redirect(res,'/');return true;
  }
  return false;
 }
 return {config,user,route};
}
