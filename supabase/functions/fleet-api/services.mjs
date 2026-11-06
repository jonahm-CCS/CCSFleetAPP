export function syncServices({all,put,audit}){
 const ds=all('drivers'),vs=all('vehicles');
 for(const v of vs.filter(v=>!v.mergedInto)){
  const pool=v.section==='Services'||v.isServiceVehicle;
  const driver=ds.find(d=>d.id===v.driverId||!v.driverId&&v.driver&&d.name.trim().toUpperCase()===v.driver.trim().toUpperCase());
  if(pool&&(v.driver!=='Service Driver'||v.driverId||v.section!=='Services')||!pool&&(driver?.isServiceDriver||v.driver==='Service Driver')){
   put('vehicles',{...v,section:pool?'Services':v.section,driver:pool?'Service Driver':'',driverId:'',version:v.version+1,updatedAt:new Date().toISOString()});
   audit('Services pool',v,'Fixed driver assignment removed. Services vehicle and driver records are tracked as a shared pool.',v);
  }
 }
}
