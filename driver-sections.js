export const DRIVER_SECTIONS=['Services','Valet','Sales','Admin','Not recorded'];
export function sectionFromCCRole(role){
 const key=String(role||'').toLowerCase().replace(/[^a-z0-9]/g,'');
 if(['districtporter','areamanager','districtmanager','regionalmanager'].includes(key))return 'Valet';
 if(key==='supervisor'||/^(entrylevel|level[123])?technician$/.test(key))return 'Services';
 if(key==='salesteammember')return 'Sales';
 if(key==='admin')return 'Admin';
 return 'Not recorded';
}
export function ccDriverSection(driver,evidence,sources){
 const source=sources.find(s=>s.id==='cc');
 const rows=evidence.filter(e=>e.driverId===driver.id&&e.sourceId==='cc'&&e.active!==false&&(!source?.lastAcceptedUploadId||e.uploadId===source.lastAcceptedUploadId));
 const sections=[...new Set(rows.map(e=>sectionFromCCRole(e.fields?.role||e.raw?.Role)))];
 return sections.length===1?sections[0]:'Not recorded';
}
