function parts(value){let s=String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();if(s.includes(',')){const [last,...rest]=s.split(',');s=rest.join(' ')+' '+last;}const tokens=s.replace(/[^A-Z\s]/g,'').split(/\s+/).filter(Boolean);return {first:tokens[0]||'',last:tokens.at(-1)||'',middle:tokens.slice(1,-1)};}
export function sameDriverName(a,b){const x=parts(a),y=parts(b);if(!x.first||!x.last)return false;if(x.first!==y.first||x.last!==y.last){if(x.first!==y.last||x.last!==y.first)return false;}if(!x.middle.length||!y.middle.length)return true;return x.middle.length===y.middle.length&&x.middle.every((t,i)=>t===y.middle[i]||(t.length===1||y.middle[i].length===1)&&t[0]===y.middle[i][0]);}
export function compareInsurance(drivers,rows,overrides={}){
 const matched=new Set(),uncertain=new Set(),remove=[],review=[];
 for(const row of rows){const name=row.fields?.name||'';let candidates=drivers.filter(d=>sameDriverName(d.name,name));const target=overrides[row.key]?.targetId;if(target)candidates=drivers.filter(d=>d.id===target);
 if(candidates.length===1)matched.add(candidates[0].id);else if(candidates.length>1){candidates.forEach(d=>uncertain.add(d.id));review.push({name,locator:row.locator});}else remove.push({name,locator:row.locator});}
 return {add:drivers.filter(d=>!matched.has(d.id)&&!uncertain.has(d.id)).map(d=>({id:d.id,name:d.name,employeeId:d.employeeId})),remove,review,matchedIds:[...matched]};
}
