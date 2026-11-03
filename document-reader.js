// Browser extraction keeps OCR off the shared database server.
let worker;
async function ocr(image){
 if(!worker){await import('https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js');worker=await globalThis.Tesseract.createWorker('eng');}
 return (await worker.recognize(image)).data.text;
}
export async function extractDocumentText(filename,base64){
 const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));let text='';
 try{
 if(/\.docx$/i.test(filename)){
  const {default:JSZip}=await import('https://esm.sh/jszip@3.10.1');const zip=await JSZip.loadAsync(bytes);
  const entries=Object.values(zip.files);if(entries.length>5000||entries.reduce((n,f)=>n+(f._data?.uncompressedSize||0),0)>100*1024*1024)throw Error('Document exceeds extraction limits.');
  const xml=await zip.file('word/document.xml')?.async('string');
  if(xml){const document=new DOMParser().parseFromString(xml,'application/xml');text=[...document.getElementsByTagName('w:p')].map(p=>p.textContent).join('\n');}
  const images=entries.filter(f=>/^word\/media\/.+\.(png|jpe?g|bmp)$/i.test(f.name));if(images.length>50)throw Error('Limit Word documents to 50 images.');
  for(const image of images)text+='\n'+await ocr(new Blob([await image.async('uint8array')]));
 }else{
  const pdfjs=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@5.6.205/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@5.6.205/build/pdf.worker.mjs';
  const pdf=await pdfjs.getDocument({data:bytes,isEvalSupported:false}).promise;
  try{if(pdf.numPages>250)throw Error('Limit PDFs to 250 pages.');
   for(let n=1;n<=pdf.numPages;n++){
    const page=await pdf.getPage(n);const content=await page.getTextContent();let value=content.items.map(x=>(x.str||'')+(x.hasEOL?'\n':' ')).join('');
    if(value.replace(/\s/g,'').length<20){let viewport=page.getViewport({scale:1.5});if(viewport.width*viewport.height>18000000)viewport=page.getViewport({scale:1.5*Math.sqrt(18000000/(viewport.width*viewport.height))});const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;value=await ocr(canvas);canvas.width=canvas.height=1;}
    text+='\nPAGE '+n+'\n'+value;
   }
  }finally{await pdf.destroy();}
 }
 if(!text.trim())throw Error('No readable text found. Use the original CSV or Excel report.');return text;
 }finally{if(worker){await worker.terminate();worker=null;}}
}
