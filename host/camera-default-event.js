'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicJSON, cameraErrorText } = require('./photo-archive');
const { targetInput, fail } = require('./drive-folders');
const { CameraFolderCatalog } = require('./camera-folder-catalog');

// 공통 행사는 명시적으로 선택한 기존 폴더만 사용한다. 지정만으로 폴더를 만들지 않는다.
class CameraDefaultEvent {
  constructor(archive) {
    this.archive=archive;this.file=path.join(archive.root,'camera-default-event.json');this.target=null;
    if(fs.existsSync(this.file)){const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));if(saved.target)this.target=targetInput(saved.target);}
  }
  get(){return this.target?structuredClone(this.target):null;}
  async set(value){
    return this.archive.serialize(async()=>{
      let target=null;
      if(value!==null){
        const input=targetInput(value||{});
        if(!input.eventId)throw fail('기존 행사 폴더를 선택해 주세요.');
        await this.archive.initialize();if(!this.archive.ready)throw fail('교회 보관함 연결을 확인한 뒤 현재 행사를 지정해 주세요.',503);
        const year=await this.archive.folders.year(input.year,input.yearId);
        if(!year)throw fail('선택한 연도 폴더를 찾을 수 없습니다.',409);
        const event=await this.archive.folders.verify(input.eventId,year.id);
        if(event.capabilities?.canAddChildren===false)throw fail('선택한 행사에 사진을 보관할 권한이 없습니다.',403);
        target={...input,yearId:year.id,eventId:event.id,eventName:event.name,folderName:event.name};
      }
      atomicJSON(this.file,{target});this.target=target;return this.get();
    });
  }
  mount(app){
    const catalog=new CameraFolderCatalog(this.archive);
    const safe=fn=>(req,res)=>Promise.resolve().then(()=>fn(req,res)).catch(error=>res.status(error.status||503).json({error:cameraErrorText(error)}));
    // /api 관리자 인증과 동일 출처 검사는 server.js의 공통 미들웨어를 상속한다.
    app.get('/api/camera/default-event',(req,res)=>res.json({target:this.get()}));
    app.get('/api/camera/event-folders',safe(async(req,res)=>res.json(await catalog.get(String(req.query.year||''),String(req.query.yearId||''),req.query.refresh==='1'))));
    app.put('/api/camera/default-event',safe(async(req,res)=>res.json({target:await this.set(req.body?.target)})));
  }
}
module.exports={CameraDefaultEvent};
