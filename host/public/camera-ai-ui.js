'use strict';
window.CameraAIEditor = class {
  constructor({api,getBlob,getInput,onResult,onDiscard,onFrame,onRefresh}) {
    Object.assign(this,{api,getBlob,getInput,onResult,onDiscard,onFrame,onRefresh});
    this.epoch=0;this.busy=false;this.loadingFrame=false;this.frameImage=null;this.frameId='';this.config=null;
    document.getElementById('aiGenerate').onclick=()=>this.run();
    document.getElementById('aiCancel').onclick=()=>this.cancel();
    document.getElementById('aiDiscard').onclick=()=>this.onDiscard();
    document.getElementById('aiEffect').onchange=()=>this.refresh(this.view);
    document.getElementById('aiConsent').onchange=()=>this.refresh(this.view);
    document.getElementById('eventFrameTemplate').onchange=event=>this.selectFrame(event.target.value);
  }
  message(text){document.getElementById('aiState').textContent=text;}
  async open(templateId='') {
    this.close();const epoch=this.epoch;this.opened=true;this.config=null;
    document.getElementById('aiConsent').checked=false;
    this.message('AI 연결을 확인하고 있습니다…');this.refresh(this.view);
    try {
      const config=await this.api('ai/config');if(epoch!==this.epoch)return;
      this.config=config;const select=document.getElementById('eventFrameTemplate');select.replaceChildren(new Option('기본 행사 프레임',''));
      for(const frame of config.frames)select.add(new Option(frame.name,frame.id));
      if(templateId&&!config.frames.some(f=>f.id===templateId))select.add(new Option('저장한 프레임 확인 필요',templateId));
      select.value=templateId;
      this.message(config.enabled?'효과를 고르고 생성하세요. 오늘 남은 생성 '+config.remaining+'회':'AI 연결 준비 중입니다. 기존 필터와 저장한 행사 프레임은 사용할 수 있습니다.');
      if(templateId)await this.selectFrame(templateId);
    }catch {if(epoch===this.epoch)this.message('AI 연결을 확인하지 못했습니다. 기본 꾸미기는 계속 사용할 수 있습니다.');}
    finally{if(epoch===this.epoch)this.onRefresh();}
  }
  refresh(view={}) {
    this.view=view;const el=id=>document.getElementById(id),frame=el('aiEffect').value==='frame';
    el('aiThemeRow').hidden=!frame;el('aiConsentRow').hidden=frame;
    el('aiGenerate').textContent=frame?'프레임 생성·보관 (AI 1회)':'AI 사진 생성 (1회)';
    el('aiGenerate').disabled=!this.config?.enabled||this.config.remaining<=0||this.busy||this.loadingFrame||view.locked||!view.photoReady||(!frame&&!el('aiConsent').checked);
    el('aiEffect').disabled=this.busy||view.locked;el('aiTheme').disabled=this.busy||view.locked;
    el('aiCancel').hidden=!this.busy;el('aiDiscard').hidden=!view.applied;el('aiDiscard').disabled=this.busy||view.locked;
    el('eventFrameTemplate').disabled=this.busy||this.loadingFrame||view.locked||!this.config;
  }
  async selectFrame(id) {
    const epoch=this.epoch;this.loadingFrame=true;this.onRefresh();
    try {
      let image=null;
      if(id){const blob=await this.getBlob('/live/api/camera/ai/frames/'+id+'/image');image=await createImageBitmap(blob);}
      if(epoch!==this.epoch){image?.close();return;}
      this.frameImage?.close();this.frameImage=image;this.frameId=id;this.onFrame(id);
    }catch {if(epoch===this.epoch)this.message('행사 프레임을 불러오지 못했습니다. 프레임 탭에서 기본 프레임을 골라 계속할 수 있습니다.');}
    finally{if(epoch===this.epoch){this.loadingFrame=false;this.onRefresh();}}
  }
  async run() {
    if(document.getElementById('aiGenerate').disabled)return;
    const kind=document.getElementById('aiEffect').value,theme=document.getElementById('aiTheme').value.trim();
    if(kind==='frame'&&!theme){this.message('만들 프레임의 분위기를 적어 주세요. 예: 가을 음악회, 꽃과 음표');return;}
    const epoch=this.epoch,controller=new AbortController();this.controller=controller;this.busy=true;this.job=null;this.onRefresh();
    this.message(kind==='frame'?'행사 장식을 만들고 있습니다. 사진은 전송하지 않습니다…':'AI 사진을 만들고 있습니다. 잠시 기다려 주세요…');
    try {
      const body=new FormData();body.append('kind',kind);body.append('requestId',crypto.randomUUID?crypto.randomUUID():uuid());
      if(kind==='frame')body.append('theme',theme);
      else {body.append('consent','yes');const input=await this.getInput();if(epoch!==this.epoch||controller.signal.aborted)return;body.append('photo',input,input.name);}
      // 접수 응답을 받기 전 취소되더라도 같은 ID로 서버 작업을 중단할 수 있다.
      this.job=body.get('requestId');
      let result=await this.api('ai/jobs',{method:'POST',body,signal:controller.signal});
      const deadline=Date.now()+125000;
      while(result.status==='working'){
        await new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);resolve();};const abort=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);reject(new Error('cancelled'));};const timer=setTimeout(done,1200);controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();});
        if(Date.now()>deadline)throw new Error('AI 작업 시간이 길어졌습니다. 잠시 후 다시 시도해 주세요.');
        result=await this.api('ai/jobs/'+this.job,{signal:controller.signal});
      }
      if(epoch!==this.epoch||controller.signal.aborted)return;
      if(result.status!=='done')throw new Error(result.error||'AI 작업을 중단했습니다.');
      if(kind==='frame'){
        this.config.frames.push(result.frame);document.getElementById('eventFrameTemplate').add(new Option(result.frame.name,result.frame.id));document.getElementById('eventFrameTemplate').value=result.frame.id;
        await this.selectFrame(result.frame.id);
        this.message('행사 프레임을 보관했습니다. 다음 사진에서도 프레임 탭에서 추가 AI 호출 없이 다시 사용할 수 있습니다.');
      }else{
        const blob=await this.getBlob('/live/api/camera/ai/jobs/'+this.job+'/image',controller.signal);
        if(epoch!==this.epoch||controller.signal.aborted)return;
        await this.onResult(new File([blob],'AI_'+kind+'.jpg',{type:'image/jpeg'}),kind,()=>epoch===this.epoch&&!controller.signal.aborted);
        if(epoch!==this.epoch)return;
        this.message('AI 결과입니다. 원본과 비교한 뒤 아래 버튼으로 적용하세요. 얼굴과 행사 내용도 확인해 주세요.');
      }
    }catch(error){if(epoch===this.epoch)this.message(controller.signal.aborted?'AI 작업을 취소했습니다. 기존 사진은 유지됩니다.':error.message);}
    finally{
      if(epoch===this.epoch){this.busy=false;this.controller=null;this.job=null;try{const config=await this.api('ai/config');if(epoch===this.epoch)this.config=config;}catch{}if(epoch===this.epoch)this.onRefresh();}
    }
  }
  cancel(){this.controller?.abort();if(this.job)this.api('ai/jobs/'+this.job+'/cancel',{method:'POST'}).catch(()=>{});}
  close(){this.cancel();this.epoch++;this.opened=false;this.busy=false;this.loadingFrame=false;this.frameImage?.close();this.frameImage=null;this.frameId='';this.job=null;}
};
