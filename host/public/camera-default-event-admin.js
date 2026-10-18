'use strict';
(()=>{
  const el=id=>document.getElementById(id);let epoch=0,catalog=null,current=null,writing=false;
  const text=value=>{el('currentEventState').textContent=value;};
  async function api(route,options={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
    try{const response=await fetch('/api/camera/'+route,{...options,cache:'no-store',signal:controller.signal});const data=await response.json();if(!response.ok)throw new Error(data.error||'현재 행사 설정을 확인하지 못했습니다.');return data;}
    finally{clearTimeout(timer);}
  }
  function summary(){el('currentEventSummary').textContent=current?'현재 공통 행사: '+current.year+' / '+current.folderName:'공통 행사 미지정 · 각 폰에서 행사를 선택할 수 있습니다.';}
  async function load(yearId='',eventId='',force=false){
    const sequence=++epoch;el('saveCurrentEvent').disabled=true;el('currentEventFolder').disabled=true;el('reloadCurrentEvents').disabled=true;
    text('기존 행사 폴더를 확인하고 있습니다…');
    try{
      const year=String(el('currentEventYear').value),data=await api('event-folders?'+new URLSearchParams({year,...(yearId?{yearId}:{}),...(force?{refresh:'1'}:{})}));if(sequence!==epoch)return;
      catalog=data;const years=data.years.filter(item=>item.name===year);
      el('currentEventYearFolderLabel').hidden=years.length<2;
      el('currentEventYearFolder').replaceChildren(...(data.ambiguous?[new Option('연도 폴더 선택','')]:[]),...years.map(item=>new Option(item.name+' · '+item.id.slice(-8),item.id)));
      el('currentEventYearFolder').value=data.yearId;
      el('currentEventFolder').replaceChildren(new Option('공통으로 사용할 행사를 선택하세요',''),...data.events.filter(item=>item.writable).map(item=>new Option(item.name,item.id)));
      el('currentEventFolder').value=eventId;el('currentEventFolder').disabled=data.ambiguous;
      text(data.ambiguous?'같은 연도 폴더 중 사용할 폴더를 선택해 주세요.':data.events.length?'지정만으로 폴더를 만들거나 기존 사진을 이동하지 않습니다.':'기존 행사 폴더가 없습니다. 사진 보관함에서 행사를 만든 뒤 선택해 주세요.');
    }catch(error){if(sequence===epoch){catalog=null;text(error.name==='AbortError'?'폴더 확인 시간이 초과되었습니다. 다시 확인해 주세요.':error.message);}}
    finally{if(sequence===epoch){el('reloadCurrentEvents').disabled=false;el('saveCurrentEvent').disabled=writing||!catalog||catalog.ambiguous||!el('currentEventFolder').value;}}
  }
  async function save(clear){
    if(writing)return;writing=true;el('saveCurrentEvent').disabled=true;el('clearCurrentEvent').disabled=true;
    try{
      const event=catalog?.events.find(item=>item.id===el('currentEventFolder').value&&item.writable);
      if(!clear&&!event)throw new Error('기존 행사 폴더를 선택해 주세요.');
      const target=clear?null:{year:String(el('currentEventYear').value),yearId:catalog.yearId,eventId:event.id,eventName:event.name};
      const data=await api('default-event',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({target})});current=data.target;summary();text(clear?'공통 행사를 해제했습니다. 각 폰의 최근 선택은 유지합니다.':'공통 행사를 지정했습니다. 선택한 행사가 없는 폰부터 적용합니다.');
    }catch(error){text(error.message);}
    finally{writing=false;el('clearCurrentEvent').disabled=false;el('saveCurrentEvent').disabled=!catalog||catalog.ambiguous||!el('currentEventFolder').value;}
  }
  async function init(){
    try{current=(await api('default-event')).target;summary();el('currentEventYear').value=current?.year||new Date(Date.now()+9*3600000).getUTCFullYear();await load(current?.yearId||'',current?.eventId||'');}
    catch(error){text(error.message);el('currentEventYear').value=new Date(Date.now()+9*3600000).getUTCFullYear();}
  }
  el('currentEventYear').onchange=()=>load();el('currentEventYearFolder').onchange=()=>load(el('currentEventYearFolder').value);
  el('currentEventFolder').onchange=()=>el('saveCurrentEvent').disabled=writing||!catalog||catalog.ambiguous||!el('currentEventFolder').value;
  el('reloadCurrentEvents').onclick=()=>load(el('currentEventYearFolder').value||'',el('currentEventFolder').value,true);
  el('saveCurrentEvent').onclick=()=>save(false);el('clearCurrentEvent').onclick=()=>save(true);
  init();
})();
