import JSZip from 'jszip';
import xml from 'xml-js';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const bad=message=>{throw Object.assign(new Error(message),{status:400});};
const arr=x=>x===undefined?[]:Array.isArray(x)?x:[x];
const text=x=>typeof x==='string'?x:x?String(x._text??x._cdata??''):'';
const doc=s=>xml.xml2js(s,{compact:true});
const norm=s=>String(s??'').trim();
export const sourceTypes={
 samsara:{title:'Samsara vehicle equipment',accept:'.csv',label:'Upload Samsara CSV'},
 fleet:{title:'Fleet Sheet',accept:'.xlsx',label:'Upload Excel (.xlsx)'},
 bancorp:{title:'Bancorp portfolio',accept:'.xlsx',label:'Upload Excel (.xlsx)'},
 moventum:{title:'Moventum / Union',accept:'.xlsx',label:'Upload Excel (.xlsx)'},
 emc:{title:'EMC vehicle insurance',accept:'.docx,.pdf',label:'Upload PDF / Word'},
 balance:{title:'Accounting assets',accept:'.xlsx',label:'Upload Excel (.xlsx)'},
 driverSystem:{title:'Driver system register',accept:'.csv',label:'Upload driver CSV (.csv)'},
 cc:{title:'CC data export · drivers & vehicles',accept:'.csv',label:'Upload CSV (.csv)'},
 drivers:{title:'Insured driver list',accept:'.csv,.xlsx,.docx,.pdf',label:'Upload CSV / Excel / PDF / Word'}
};
export function readCSV(input){const rows=[];let row=[],cell='',quote=false;input=input.replace(/^\uFEFF/,'');for(let i=0;i<input.length;i++){let c=input[i];if(c==='"'){if(quote&&input[i+1]==='"'){cell+='"';i++;}else quote=!quote;}else if(c===','&&!quote){row.push(cell);cell='';}else if(c==='\n'&&!quote){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}if(quote)bad('The CSV contains an unclosed quote.');if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}return rows.filter(r=>r.some(c=>c.trim()));}
async function unzip(buffer){let zip;try{zip=await JSZip.loadAsync(buffer);}catch{bad('This file is not a readable Office document.');}let size=0,count=0;for(const e of Object.values(zip.files)){if(e.dir)continue;size+=e._data?.uncompressedSize||0;count++;}if(size>100*1024*1024||count>5000)bad('Document expands beyond the 100 MB / 5,000-entry limit.');return zip;}
export async function readXLSX(buffer){
 const z=await unzip(buffer);const get=async p=>z.file(p)?z.file(p).async('string'):'';
 const shared=arr(doc(await get('xl/sharedStrings.xml')||'<sst/>').sst?.si).map(si=>text(si.t)||arr(si.r).map(r=>text(r.t)).join(''));
 const book=doc(await get('xl/workbook.xml'));const rels=arr(doc(await get('xl/_rels/workbook.xml.rels')).Relationships?.Relationship);const result=[];
 for(const sh of arr(book.workbook?.sheets?.sheet)){
  const rel=rels.find(r=>r._attributes?.Id===sh._attributes?.['r:id']);if(!rel)continue;let path=rel._attributes.Target.replace(/^\//,'');if(!path.startsWith('xl/'))path='xl/'+path;
  const content=await get(path);if(!content)continue;const sheet=doc(content),rows=[];
  for(const r of arr(sheet.worksheet?.sheetData?.row)){
   const cells=[];for(const c of arr(r.c)){const a=c._attributes||{},letters=(a.r||'A1').replace(/\d/g,'');let n=0;for(const ch of letters)n=n*26+ch.charCodeAt(0)-64;let value=text(c.v);if(a.t==='s')value=shared[Number(value)]||'';if(a.t==='inlineStr')value=text(c.is?.t)||arr(c.is?.r).map(x=>text(x.t)).join('');cells[n-1]=value;}
   rows.push({row:Number(r._attributes?.r)||rows.length+1,cells});
  }result.push({name:sh._attributes?.name||'Sheet',rows});
 }if(!result.length)bad('No readable Excel worksheets found.');return result;
}
const isoDate=x=>{if(!x)return '';if(/^\d+(\.\d+)?$/.test(String(x))&&Number(x)>20000&&Number(x)<100000)return new Date(Date.UTC(1899,11,30)+Number(x)*86400000).toISOString().slice(0,10);const m=String(x).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);return m?`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`:String(x).slice(0,10);};
function mappedRows(sheet,required){const idx=sheet.rows.findIndex(r=>required.every(h=>r.cells.some(c=>norm(c).toLowerCase()===h.toLowerCase())));if(idx<0)return [];const headers=sheet.rows[idx].cells.map(norm);return sheet.rows.slice(idx+1).filter(r=>r.cells.some(c=>norm(c))).map(r=>({row:r.row,raw:Object.fromEntries(headers.map((h,i)=>[h,norm(r.cells[i])]).filter(([h])=>h))}));}
function vehicleRow(raw,fields,locator,extra={}){const safe={...fields};for(const k of ['year','odometer'])if(safe[k]!==undefined&&String(safe[k]).trim()!==''&&Number.isFinite(Number(safe[k])))safe[k]=String(Number(safe[k]));safe.vin=norm(safe.vin).toUpperCase().replace(/\s/g,'');return {kind:'vehicle',fields:safe,raw,locator,...extra};}
function ccRows(rows){const headers=rows[0]?.map(norm)||[];for(const h of ['Name','File Number','Role','VIN','License Plate #'])if(!headers.includes(h))bad(`CC export must include the ${h} column.`);
 return rows.slice(1).map((r,i)=>{const raw=Object.fromEntries(headers.map((h,j)=>[h,norm(r[j])]));if(!raw.Name)return null;return {kind:'driver',locator:`CSV row ${i+2}`,raw,fields:{name:raw.Name,employeeId:raw['File Number'],phone:raw.Phone,email:raw.Email,market:raw.Market,role:raw.Role,city:raw.City,state:raw.State,onboardingCompleted:raw['Onboarding Completed'],canDrive:raw['Can Drive'],drivesCCS:raw['Drives CCS Vehicle'],reportedVin:raw.VIN.toUpperCase().replace(/\s/g,''),reportedPlate:raw['License Plate #']}};}).filter(Boolean);}
async function recognize(images){const {createWorker}=await import('tesseract.js');const worker=await createWorker('eng',1,{langPath:resolve(ROOT,'vendor/ocr'),gzip:false,cacheMethod:'none'});let out='';try{for(let i=0;i<images.length;i++){const r=await worker.recognize(images[i]);out+=`\nIMAGE ${i+1}\n`+r.data.text;}}finally{await worker.terminate();}return out;}
async function pdfText(buffer){
 // PDF text extraction does not require drawing or any native canvas dependency.
 if(!globalThis.DOMMatrix)globalThis.DOMMatrix=class DOMMatrix {constructor(){this.a=this.d=1;this.b=this.c=this.e=this.f=0;}};
 const {getDocument,OPS}=await import('pdfjs-dist/legacy/build/pdf.mjs');const pdf=await getDocument({data:new Uint8Array(buffer),standardFontDataUrl:resolve(ROOT,'node_modules/pdfjs-dist/standard_fonts')+'/',useSystemFonts:false,isEvalSupported:false,disableFontFace:true}).promise;let output='';
 try{if(pdf.numPages>250)bad('Limit a source PDF to 250 pages.');for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n),content=await page.getTextContent();let pageText=content.items.map(x=>(x.str||'')+(x.hasEOL?'\n':' ')).join('');
 if(pageText.replace(/\s/g,'').length<20){const op=await page.getOperatorList(),images=[];for(let i=0;i<op.fnArray.length;i++)if(op.fnArray[i]===OPS.paintImageXObject){const obj=await new Promise((resolve,reject)=>{let timer=setTimeout(()=>reject(Error('PDF image extraction timed out.')),15000);page.objs.get(op.argsArray[i][0],v=>{clearTimeout(timer);resolve(v);});});if(obj?.data&&obj.width*obj.height<=18000000){const {PNG}=await import('pngjs');const png=new PNG({width:obj.width,height:obj.height});let d=obj.data;if(d.length===obj.width*obj.height*3){for(let p=0,q=0;p<d.length;p+=3,q+=4){png.data[q]=d[p];png.data[q+1]=d[p+1];png.data[q+2]=d[p+2];png.data[q+3]=255;}}else if(d.length===obj.width*obj.height*4)png.data=Buffer.from(d);else if(d.length===obj.width*obj.height){for(let p=0,q=0;p<d.length;p++,q+=4){png.data[q]=png.data[q+1]=png.data[q+2]=d[p];png.data[q+3]=255;}}else if(d.length===Math.ceil(obj.width/8)*obj.height){const stride=Math.ceil(obj.width/8);for(let y=0;y<obj.height;y++)for(let x=0;x<obj.width;x++){const n=(y*obj.width+x)*4,g=(d[y*stride+(x>>3)]>>(7-(x%8)))&1;png.data[n]=png.data[n+1]=png.data[n+2]=g?255:0;png.data[n+3]=255;}}else continue;images.push(PNG.sync.write(png));}}
 if(images.length)pageText=await recognize(images);else bad(`PDF page ${n} has no extractable text or supported image. Upload the original Word/Excel file instead.`);}
 output+=`\nPAGE ${n}\n`+pageText;}}finally{await pdf.destroy();}return output;
}
export async function parseSource(sourceId,filename,buffer){
 if(sourceId==='emc'){try{const cached=JSON.parse(readFileSync(resolve(ROOT,'data/emc-original-cache.json')));if(fileHash(buffer)===cached.hash)return {rows:cached.rows,warnings:['Byte-identical to the originally supplied EMC document. Retained transcription reused; report is dated September 25, 2026. Re-uploading an unchanged file does not make its report date current.']};}catch{}}
 const config=sourceTypes[sourceId];if(!config)bad('Unknown source.');const ext=extname(filename).toLowerCase();if(!config.accept.split(',').includes(ext))bad(`Use ${config.accept} for ${config.title}.`);
 if(sourceId==='driverSystem'){
  const rows=readCSV(buffer.toString('utf8')),headers=rows.shift()||[],normalize=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const aliases={name:['name','drivername','fullname'],employeeId:['employeenumber','employeeid','filenumber','employee'],email:['email','emailaddress'],phone:['phone','phonenumber'],market:['market','region'],city:['city'],state:['state'],systemRole:['role','jobtitle','position'],canDrive:['candrive'],onboardingCompleted:['onboardingcompleted']};
  const mapping=Object.fromEntries(Object.entries(aliases).map(([k,names])=>[k,headers.findIndex(h=>names.includes(normalize(h)))]));if(mapping.name<0)bad('Driver system CSV needs a Name, Driver Name or Full Name column. Use the driver-register template.');
  return {rows:rows.filter(r=>norm(r[mapping.name])).map((r,i)=>({kind:'driver',locator:`CSV row ${i+2}`,fields:Object.fromEntries(Object.entries(mapping).filter(([k,n])=>n>=0).map(([k,n])=>[k,norm(r[n])])),raw:Object.fromEntries(Object.entries(mapping).filter(([k,n])=>n>=0).map(([k,n])=>[k,norm(r[n])]))})),warnings:[]};
 }
 if(sourceId==='samsara'){
  const table=readCSV(buffer.toString('utf8')),headers=(table.shift()||[]).map(x=>x.trim());
  for(const key of ['deviceId','assetType','serial','licensePlate','vehicleInfo_vin'])if(!headers.includes(key))bad('Samsara CSV is missing '+key+'. Use the vehicle assets export.');
  const rows=[];let skipped=0;
  table.forEach((r,i)=>{if(r.length!==headers.length)bad('Samsara CSV row '+(i+2)+' has an incorrect number of columns.');const raw=Object.fromEntries(headers.map((h,n)=>[h,norm(r[n])]));if(raw.assetType.toLowerCase()!=='vehicle'){skipped++;return;}const fields={vin:raw.vehicleInfo_vin.toUpperCase().replace(/\s/g,''),plate:raw.licensePlate,deviceId:raw.deviceId,serial:raw.serial,deviceName:raw.deviceName||'',product:raw.productShortName||''};rows.push({kind:'samsara',fields,raw:{...fields},locator:'CSV row '+(i+2)});});
  if(!rows.length)bad('No vehicle rows found in this Samsara file.');return {rows,warnings:[`${skipped} non-vehicle rows ignored. Equipment presence only; driver notes, location and training are not used to change registry values.`]};
 }
 if(sourceId==='cc')return {rows:ccRows(readCSV(buffer.toString('utf8'))),warnings:[]};
 if(ext==='.xlsx'){
 const sheets=await readXLSX(buffer),rows=[];
 if(sourceId==='fleet'){
  const sheet=sheets.find(s=>s.name==='Vehicle Inventory')||sheets[0];for(const {raw,row} of mappedRows(sheet,['VIN'])){if(!raw.VIN)continue;const section={'Service':'Services','Services':'Services','Valet Trash':'Valet','Valet':'Valet','Sales':'Sales'}[raw['Service Level']]||'';
   const fields={vin:raw.VIN,unitNumber:raw['Vehicle Number'],plate:raw['Current Plate Number'],plateState:raw['Plate State'],year:raw['Model Year'],make:raw.Make,model:raw.Model,ownership:raw['Vehicle Owner'],registrationExpiry:isoDate(raw['Renewal Date']),odometer:raw['Estimated Odometer'],odometerDate:isoDate(raw['Estimated Odometer Date']),section};rows.push(vehicleRow(fields,fields,`${sheet.name} row ${row}`));}
  const disposed=sheets.find(s=>s.name==='Disposed Of');if(disposed)for(const r of disposed.rows){if(!/^[A-HJ-NPR-Z0-9]{17}$/i.test(r.cells[1]||''))continue;const fields={vin:r.cells[1],plate:r.cells[2],plateState:r.cells[3],make:r.cells[5],model:r.cells[6],year:r.cells[7],ownership:r.cells[10],operationalState:'Disposed'};rows.push(vehicleRow(fields,fields,`Disposed Of row ${r.row}`));}
 }else if(sourceId==='bancorp')for(const sheet of sheets)for(const {raw,row} of mappedRows(sheet,['VIN/Serial Number'])){if(!raw['VIN/Serial Number'])continue;const parts=raw['Asset Description'].split(' ');rows.push(vehicleRow(raw,{vin:raw['VIN/Serial Number'],plate:raw['Plate Number'],plateState:raw['Plate State'],registrationExpiry:isoDate(raw['Plate Expiration Date']),ownership:'Bancorp, Lease',year:parts.shift(),make:parts.shift(),model:parts.join(' ')},`${sheet.name} row ${row}`));}
 else if(sourceId==='moventum')for(const sheet of sheets)for(const {raw,row} of mappedRows(sheet,['VIN','Unit'])){if(!raw.VIN)continue;const {Driver,...safe}=raw;rows.push(vehicleRow(safe,{vin:raw.VIN,plate:raw['Plate #'],plateState:raw.State,registrationExpiry:isoDate(raw['Plate Exp.']),ownership:'Union, Lease',year:raw.Year,make:raw.Make,model:raw.Model},`${sheet.name} row ${row}`));}
 else if(sourceId==='balance')for(const sheet of sheets)for(const r of sheet.rows){const label=norm(r.cells[0]),m=label.match(/VIN#\s*([A-Z0-9]+)/i);if(m)rows.push({kind:'accounting',fields:{vinSuffix:m[1]},raw:{description:label,amount:r.cells[1]},locator:`${sheet.name} row ${r.row}`});}
 else if(sourceId==='drivers'){for(const sheet of sheets)for(const {raw,row} of mappedRows(sheet,['Name']))if(raw.Name)rows.push({kind:'insuredDriver',fields:{name:raw.Name,employeeId:raw['File Number']||'',email:raw.Email||''},raw:{name:raw.Name,state:raw.State||''},locator:`${sheet.name} row ${row}`});}
 if(!rows.length)bad(`No recognized ${config.title} records. Upload the same report layout as the supplied source.`);return {rows,warnings:[]};
 }
 if(ext==='.csv'){
 const rows=readCSV(buffer.toString('utf8')),headers=rows.shift()||[];const ni=headers.findIndex(h=>h.toLowerCase()==='name');if(ni<0)bad('Driver CSV must have a Name column.');return {rows:rows.filter(r=>r[ni]).map((r,i)=>({kind:'insuredDriver',fields:{name:r[ni]},raw:{name:r[ni]},locator:`CSV row ${i+2}`})),warnings:[]};
 }
 let extracted='';if(ext==='.docx'){
 const z=await unzip(buffer),main=await z.file('word/document.xml')?.async('string');if(main)extracted=main.replace(/<\/w:p>/g,'\n').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&');
 const imgs=Object.values(z.files).filter(f=>/^word\/media\/.+\.(png|jpe?g|bmp)$/i.test(f.name));if(imgs.length){if(imgs.length>50)bad('Limit a Word source to 50 images.');extracted+='\n'+await recognize(await Promise.all(imgs.map(f=>f.async('nodebuffer'))));}
 }else extracted=await pdfText(buffer);
 if(sourceId==='emc'){
 const rows=[];for(const [i,line] of extracted.split('\n').entries()){
  const m=line.match(/\b(19\d{2}|20\d{2})\s+(.+?)\s*[-~–]\s*([A-Z0-9 }{)]+)$/i);if(!m)continue;let vin=m[3].toUpperCase().replace(/\s/g,'');if(!vin||vin.length<15||vin.length>20)continue;
  // OCR never repairs VIN letters/check digits or invents a full VIN.
  rows.push(vehicleRow({text:line,extraction:'Text/OCR: review required'},{vin,year:m[1],make:m[2].split(' ')[0],model:m[2].split(' ').slice(1).join(' ')},`Extracted line ${i+1}`,{ocr:true}));
 }if(!rows.length)bad('No vehicle VIN rows were extracted. Use the original Word/PDF report with readable vehicle descriptions and VINs.');return {rows,warnings:['Text/OCR values require review. Invalid or uncertain VINs are blocked; no characters are silently repaired.'],extractedText:extracted};
 }
 const names=extracted.split('\n').map(norm).filter(s=>/^[A-Za-z][A-Za-z ,.'-]{4,80}$/.test(s)&&!/(name|license|driver list|insured|page|state|date|policy)/i.test(s));if(!names.length)bad('No reliable driver-name rows extracted. Use CSV or Excel with a Name column.');return {rows:names.map((name,i)=>({kind:'insuredDriver',fields:{name},raw:{name,extraction:'Text/OCR: review required'},locator:`Name candidate ${i+1}`})),warnings:['Driver names extracted from document text must be reviewed.']};
}
export function fileHash(buffer){return createHash('sha256').update(buffer).digest('hex');}
