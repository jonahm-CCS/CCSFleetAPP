const vin=s=>String(s||'').trim().toUpperCase().replace(/\s/g,'');
const plate=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const name=s=>String(s||'').trim().replace(/\s+/g,' ').toUpperCase();
export function planDriverLinks(vehicles,drivers){
 const vs=vehicles.filter(v=>!v.mergedInto&&v.operationalState!=='Disposed');
 const plans=drivers.map(d=>{
  const dv=vin(d.reportedVin),dp=plate(d.reportedPlate),result={driverId:d.id,vehicleId:'',reason:''};
  if(!dv&&!dp)return {...result,reason:'No VIN or plate reported'};
  const completeVIN=/^[A-HJ-NPR-Z0-9]{17}$/.test(dv);
  const byVIN=completeVIN?vs.filter(v=>vin(v.vin)===dv):[],byPlate=dp?vs.filter(v=>plate(v.plate)===dp):[];
  const candidates=completeVIN&&dp?byVIN.filter(v=>byPlate.includes(v)):completeVIN?byVIN:byPlate;
  if(candidates.length!==1||byVIN.length>1||byPlate.length>1)return {...result,reason:byVIN.length||byPlate.length?'Conflicting or duplicate VIN / plate; review required':'No vehicle matches reported VIN / plate'};
  return {...result,vehicleId:candidates[0].id,warning:!completeVIN?'Linked by unique plate; driver VIN needs confirmation':''};
 });
 for(const p of plans){if(!p.vehicleId)continue;const v=vs.find(v=>v.id===p.vehicleId),d=drivers.find(d=>d.id===p.driverId);
  if(plans.filter(x=>x.vehicleId===p.vehicleId).length>1)p.reason='Multiple drivers report this vehicle; review required';
  else if((v.driverId&&v.driverId!==d.id)||(v.driver&&name(v.driver)!==name(d.name)))p.reason='Vehicle already assigned to another driver; review required';
  else if(vs.some(x=>x.id!==v.id&&(x.driverId===d.id||x.driver&&name(x.driver)===name(d.name))))p.reason='Driver already assigned to another vehicle; review required';
 }
 return plans;
}
export function connectDrivers({all,put,tx,audit}){
 const vs=all('vehicles'),ds=all('drivers'),plans=planDriverLinks(vs,ds);let linked=0;
 tx(()=>{for(const p of plans){if(p.reason||!p.vehicleId)continue;const old=vs.find(v=>v.id===p.vehicleId),d=ds.find(d=>d.id===p.driverId);if(old.driverId===d.id&&old.driver===d.name)continue;
 const v={...old,driverId:d.id,driver:d.name,version:(old.version||0)+1,updatedAt:new Date().toISOString()};put('vehicles',v);audit('Automatic driver link',v,'Unique matching reported VIN / plate linked the Driver Register and Vehicle Register.',old);linked++;
 }});return linked;
}
