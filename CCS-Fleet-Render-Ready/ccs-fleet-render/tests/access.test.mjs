import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync,sign} from 'node:crypto';import {verifyGoogleToken,accessConfig} from '../server/access.mjs';
test('Google token verification checks signature, company domain, audience, expiry and nonce',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const key={...publicKey.export({format:'jwk'}),kid:'test'};const fetcher=async()=>({ok:true,json:async()=>({keys:[key]})});const cfg={clientId:'client',domain:'example.test'};const valid={iss:'https://accounts.google.com',aud:'client',exp:Date.now()/1000+300,iat:Date.now()/1000,nonce:'nonce',hd:'example.test',email:'user@example.test',email_verified:true,sub:'user'};
 const jwt=claims=>{const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const data=b({alg:'RS256',kid:'test'})+'.'+b(claims);return data+'.'+sign('RSA-SHA256',Buffer.from(data),privateKey).toString('base64url');};
 assert.equal((await verifyGoogleToken(jwt(valid),cfg,'nonce',fetcher)).email,'user@example.test');
 for(const changed of [{hd:'other.test'},{aud:'other'},{nonce:'wrong'},{exp:0},{email_verified:false},{iss:'https://evil.example'},{email:'user@other.test'}])await assert.rejects(verifyGoogleToken(jwt({...valid,...changed}),cfg,'nonce',fetcher));
 const tampered=jwt(valid).split('.');tampered[1]=Buffer.from(JSON.stringify({...valid,email:'admin@example.test'})).toString('base64url');await assert.rejects(verifyGoogleToken(tampered.join('.'),cfg,'nonce',fetcher));
 assert.throws(()=>accessConfig({NODE_ENV:'production'}),/requires/);
});
