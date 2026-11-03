// Preserves only data actually included in the published snapshot.
export function seedFromSnapshot(snapshot){
 const s=structuredClone(snapshot),records=Object.fromEntries(['vehicles','drivers','sources','evidence','issues','driverEvidence','assignmentEvidence','documents','uploads'].map(k=>[k,s[k]||[]]));
 const source=records.sources.find(s=>s.id==='drivers');
 if(source?.lastAcceptedUploadId&&s.insuranceComparison){
  const rows=records.driverEvidence.filter(e=>e.sourceId==='drivers'&&e.uploadId===source.lastAcceptedUploadId).map((e,i)=>({key:'baseline-'+i,fields:e.fields,locator:e.locator}));
  rows.push(...[...(s.insuranceComparison.remove||[]),...(s.insuranceComparison.review||[])].map((r,i)=>({key:'unmatched-'+i,fields:{name:r.name},locator:r.locator})));
  records.uploads.push({id:source.lastAcceptedUploadId,sourceId:'drivers',filename:source.lastFilename,rows,parsed:[],warnings:['Comparison restored from published evidence. Original file was not included.'],overrides:{},status:'Accepted',uploadedAt:source.lastUploadedAt,acceptedAt:source.lastAcceptedAt,snapshotOnly:true});
 }
 for(const v of records.vehicles)v.version??=1;
 return {records,audit:[{id:'migration',time:new Date().toISOString(),action:'Shared storage migration',vehicleId:'',note:'Initialized from published snapshot '+s.publishedAt+'. Original source files and prior audit history were not included.'}]};
}
