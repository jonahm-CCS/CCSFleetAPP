const money=x=>{const n=Number(String(x??'').replace(/[$,]/g,''));return Number.isFinite(n)&&n>0?n:null;};
const family=v=>String(v.make||'').toLowerCase().replace('chevy','chevrolet')+' '+String(v.model||'').toLowerCase().replace(/king cab.*|tradesman.*|reg cab.*|4x2.*|4wd.*/g,'').trim();
const median=xs=>{xs=[...xs].sort((a,b)=>a-b);return xs.length?Math.round((xs[Math.floor((xs.length-1)/2)]+xs[Math.floor(xs.length/2)])/2):null;};
export function buildAssetValues(vehicles,evidence,sources){
 const source=sources.find(s=>s.id==='balance');const values=new Map();
 for(const v of vehicles){const rows=evidence.filter(e=>e.vehicleId===v.id&&e.sourceId==='balance'&&e.active!==false&&(!source?.lastAcceptedUploadId||e.uploadId===source.lastAcceptedUploadId)&&['Exact VIN','Confirmed accounting match'].includes(e.match));const amounts=[...new Set(rows.map(e=>money(e.raw?.amount??e.fields?.amount)).filter(Boolean))];if(amounts.length===1)values.set(v.id,{amount:amounts[0],estimated:false,basis:'Recorded accounting cost'});}
 const known=vehicles.filter(v=>values.has(v.id)),fleetBase=median(known.map(v=>values.get(v.id).amount));
 for(const v of vehicles)if(!values.has(v.id)){let peers=known.filter(x=>family(x)===family(v)&&String(x.year)===String(v.year));let basis='Same year / model recorded-cost median';if(!peers.length){peers=known.filter(x=>family(x)===family(v));basis='Same model recorded-cost median';}if(!peers.length){basis='Fleet recorded-cost median — no comparable model';}values.set(v.id,{amount:peers.length?median(peers.map(x=>values.get(x.id).amount)):fleetBase,estimated:true,basis});}
 return values;
}
