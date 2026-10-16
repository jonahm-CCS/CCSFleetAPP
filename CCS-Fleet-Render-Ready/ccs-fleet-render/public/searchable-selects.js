// Searchable pickers keep the original select as the source of submitted values.
export const searchKey=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
export const matchesOption=(text,query)=>searchKey(text).includes(searchKey(query));
const enhanced=new WeakSet();let sequence=0;
function enhance(select){
 if(enhanced.has(select)||select.multiple)return;enhanced.add(select);
 const wrap=document.createElement('div');wrap.className='search-picker';select.before(wrap);wrap.append(select);select.classList.add('search-picker-native');select.tabIndex=-1;
 const input=document.createElement('input');input.type='search';input.className='search-picker-input';input.autocomplete='off';input.spellcheck=false;input.placeholder='Type to search…';input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','false');
 const caption=select.getAttribute('aria-label')||select.closest('label')?.firstChild?.textContent?.trim()||'Select an option';input.setAttribute('aria-label',caption+' — type to search');
 const list=document.createElement('div');list.id='picker-options-'+(++sequence);list.className='search-picker-options';list.setAttribute('role','listbox');list.hidden=true;input.setAttribute('aria-controls',list.id);
 const status=document.createElement('small');status.className='search-picker-status';status.setAttribute('role','status');status.hidden=true;
 wrap.append(input,list,status);let open=false,items=[],active=-1;
 const selectedText=()=>select.selectedOptions[0]?.textContent||'';
 function sync(){if(!open)input.value=selectedText();input.disabled=select.disabled;input.required=select.required;input.setAttribute('aria-required',String(select.required));}
 function close(){open=false;list.hidden=true;status.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');input.value=selectedText();}
 function highlight(){[...list.children].forEach((el,i)=>el.classList.toggle('highlighted',i===active));if(items[active]){input.setAttribute('aria-activedescendant',list.children[active].id);list.children[active].scrollIntoView({block:'nearest'});}else input.removeAttribute('aria-activedescendant');}
 function choose(option){select.value=option.value;input.setCustomValidity('');close();select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));}
 function show(query=''){
  open=true;list.hidden=false;status.hidden=false;input.setAttribute('aria-expanded','true');list.replaceChildren();active=-1;
  items=[...select.options].filter(o=>!o.disabled&&!o.parentElement?.disabled&&matchesOption(o.textContent,query));
  for(const [i,option] of items.entries()){const item=document.createElement('div');item.id=list.id+'-'+i;item.className='search-picker-option';item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.selected));item.textContent=option.textContent;item.addEventListener('mousedown',e=>e.preventDefault());item.addEventListener('click',()=>choose(option));list.append(item);}
  status.textContent=items.length?`${items.length} options · choose a result to change the selection`:'No matching options. Try a name, VIN, plate or vehicle number.';
 }
 input.addEventListener('focus',()=>{sync();show();input.select();});
 input.addEventListener('input',()=>{input.setCustomValidity('');show(input.value);});
 input.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(!open)show();active=items.length?(active+(e.key==='ArrowDown'?1:-1)+items.length)%items.length:-1;highlight();}
  else if(e.key==='Enter'&&open){e.preventDefault();if(active>=0)choose(items[active]);else if(items.length===1)choose(items[0]);}
  else if(e.key==='Escape'){e.preventDefault();close();}
 });
 input.addEventListener('blur',()=>setTimeout(close,150));
 select.addEventListener('change',()=>{close();sync();});
 select.addEventListener('invalid',e=>{e.preventDefault();input.focus();input.setCustomValidity('Choose an option from the search results.');input.reportValidity();});
 // An uncommitted query must never be submitted as a new value.
 select.form?.addEventListener('submit',close);
 wrap.addEventListener('pointerenter',sync);sync();
}
function enhanceAll(){document.querySelectorAll('select').forEach(enhance);}
if(typeof document!=='undefined'){
 enhanceAll();new MutationObserver(enhanceAll).observe(document.body,{childList:true,subtree:true});
 // Existing bulk actions may change select.value without firing change.
 document.addEventListener('click',()=>setTimeout(()=>{document.querySelectorAll('.search-picker').forEach(w=>{const input=w.querySelector('.search-picker-input'),select=w.querySelector('select');if(input&&document.activeElement!==input){input.value=select.selectedOptions[0]?.textContent||'';input.disabled=select.disabled;}});},0));
}
