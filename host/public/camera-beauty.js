'use strict';
// 사진과 얼굴 좌표는 외부로 보내지 않는다. 모델은 같은 서버에서 필요할 때만 읽는다.
window.CameraBeauty = (() => {
  let detector;
  async function landmarks(canvas) {
    if (!detector) {
      const pending = (async () => {
        const { FaceLandmarker, FilesetResolver } = await import('/vendor/mediapipe/vision_bundle.mjs');
        return FaceLandmarker.createFromOptions(await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm'), {
          baseOptions: { modelAssetPath: '/vendor/mediapipe/face_landmarker.task', delegate: 'CPU' },
          runningMode: 'IMAGE', numFaces: 8, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5
        });
      })().catch(error => { if(detector===pending)detector=null; throw error; });
      detector=pending;
    }
    const model = await detector;
    const small = document.createElement('canvas'), scale = Math.min(1, 768 / Math.max(canvas.width, canvas.height));
    small.width = Math.round(canvas.width * scale); small.height = Math.round(canvas.height * scale);
    small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
    try { return model.detect(small).faceLandmarks; }
    finally { small.width=small.height=1; }
  }
  async function bitmapOptions(file) {
    const bytes=new DataView(await file.slice(0,512*1024).arrayBuffer());let width=0,height=0;
    if(bytes.byteLength>=24&&bytes.getUint32(0)===0x89504e47){width=bytes.getUint32(16);height=bytes.getUint32(20);}
    else if(bytes.byteLength>=4&&bytes.getUint16(0)===0xffd8){
      let offset=2;
      while(offset+9<bytes.byteLength){
        if(bytes.getUint8(offset)!==0xff)break;
        const marker=bytes.getUint8(offset+1),length=bytes.getUint16(offset+2);
        if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){height=bytes.getUint16(offset+5);width=bytes.getUint16(offset+7);break;}
        if(length<2)break;offset+=length+2;
      }
    }
    const options={imageOrientation:'from-image'};
    if(width&&height&&Math.max(width,height)>2048){
      let orientation=1;try{orientation=await window.exifr?.orientation(file)||1;}catch{}
      if(orientation>=5)[width,height]=[height,width];
      const scale=2048/Math.max(width,height);
      Object.assign(options,{resizeWidth:Math.max(1,Math.round(width*scale)),resizeHeight:Math.max(1,Math.round(height*scale)),resizeQuality:'high'});
    }
    return options;
  }
  async function decode(file) {
    let image;
    try { image = await createImageBitmap(file, await bitmapOptions(file)); }
    catch {
      const url = URL.createObjectURL(file);
      try { image = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = url; }); }
      finally { URL.revokeObjectURL(url); }
    }
    try {
      const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally { image.close?.(); if(image instanceof HTMLImageElement)image.removeAttribute('src'); }
  }
  const oval = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
  const features = [
    [33,160,158,133,153,144], [362,385,387,263,373,380],
    [70,63,105,66,107,55,65,52,53,46], [336,296,334,293,300,276,283,282,295,285],
    [61,40,37,0,267,270,291,321,314,17,84,91]
  ];
  function polygon(ctx, points, indices, width, height, expand = 1) {
    const p = indices.map(i => [points[i].x * width, points[i].y * height]);
    const cx = p.reduce((a,v) => a + v[0], 0) / p.length, cy = p.reduce((a,v) => a + v[1], 0) / p.length;
    ctx.beginPath(); p.forEach(([x,y], i) => ctx[i ? 'lineTo' : 'moveTo'](cx+(x-cx)*expand, cy+(y-cy)*expand)); ctx.closePath(); ctx.fill();
  }
  function featherInside(alpha, w, h, feather) {
    const distance=new Uint16Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const p=y*w+x;
      if(alpha[p*4+3])distance[p]=Math.min(feather,x?distance[p-1]+1:1,y?distance[p-w]+1:1);
    }
    for(let y=h-1;y>=0;y--)for(let x=w-1;x>=0;x--){
      const p=y*w+x;
      if(distance[p]){
        distance[p]=Math.min(distance[p],x<w-1?distance[p+1]+1:1,y<h-1?distance[p+w]+1:1);
        const t=distance[p]/feather;alpha[p*4+3]*=t*t*(3-2*t);
      }
    }
  }
  function skinMask(faces,w,h) {
    const alpha=new Uint8ClampedArray(w*h*4);
    for(const face of faces){
      const xs=oval.map(i=>face[i].x*w), ys=oval.map(i=>face[i].y*h);
      const faceWidth=Math.max(...xs)-Math.min(...xs);
      const left=Math.max(0,Math.floor(Math.min(...xs))-2), top=Math.max(0,Math.floor(Math.min(...ys))-2);
      const right=Math.min(w,Math.ceil(Math.max(...xs))+2), bottom=Math.min(h,Math.ceil(Math.max(...ys))+2);
      const width=right-left, height=bottom-top;
      if(width<=0||height<=0)continue;
      const mask=document.createElement('canvas');mask.width=width;mask.height=height;
      const m=mask.getContext('2d',{willReadFrequently:true});m.fillStyle='#fff';
      m.translate(-left,-top);polygon(m,face,oval,w,h);
      const outer=m.getImageData(0,0,width,height).data;
      // 얼굴 전체 윤곽을 사용한다. 안쪽의 좁은 띠 대신 얼굴 너비 10%에 걸쳐 완만하게 섞는다.
      featherInside(outer,width,height,Math.max(8,Math.round(faceWidth*0.10)));
      m.resetTransform();m.clearRect(0,0,width,height);m.fillRect(0,0,width,height);
      m.translate(-left,-top);m.globalCompositeOperation='destination-out';
      for(const f of features)polygon(m,face,f,w,h,1.12);
      const detail=m.getImageData(0,0,width,height).data;
      // 눈·입 주변은 별도의 짧은 완충 폭으로 섞어 윤곽선과 피부 사이의 띠를 줄인다.
      featherInside(detail,width,height,Math.max(3,Math.round(faceWidth*0.025)));
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const local=(y*width+x)*4+3,global=((y+top)*w+x+left)*4+3;
        alpha[global]=Math.max(alpha[global],Math.round(outer[local]*detail[local]/255));
      }
    }
    return alpha;
  }
  async function prepare(file, options = {}) {
    const checkCancelled=()=>{if(options.signal?.aborted)throw new DOMException('편집 취소','AbortError');};
    checkCancelled();
    const canvas = options.canvas || await decode(file), faces = await landmarks(canvas);
    checkCancelled();
    if (!faces.length) throw new Error('얼굴을 찾지 못했습니다. 정면에 가까운 사진을 사용하거나 원본으로 진행해 주세요.');
    const w = canvas.width, h = canvas.height, ctx = canvas.getContext('2d', { willReadFrequently: true });
    const alpha=skinMask(faces,w,h);
    const source=ctx.getImageData(0,0,w,h), smooth=new Uint8ClampedArray(source.data);
    // 색 차이가 큰 경계는 섞지 않는 양방향 필터. 눈·입·눈썹은 마스크에서 제외한다.
    const data=source.data, range=new Float32Array(766);
    const faceWidth=Math.max(...faces.map(face=>(Math.max(...oval.map(i=>face[i].x))-Math.min(...oval.map(i=>face[i].x)))*w));
    const radius=Math.max(3,Math.min(12,Math.round(faceWidth*0.025))), spatial=[];
    for(let d=-radius;d<=radius;d++)spatial.push(Math.exp(-d*d/(2*(radius*0.55)**2)));
    for(let i=0;i<range.length;i++)range[i]=Math.exp(-i*i/(2*65*65));
    let input=data;
    for(const horizontal of [true,false]) {
      const output=horizontal?smooth:new Uint8ClampedArray(smooth);
      for(let y=radius;y<h-radius;y++) {
        for(let x=radius;x<w-radius;x++) {
          const i=(y*w+x)*4;if(!alpha[i+3])continue;
          let weight=0,r=0,g=0,b=0;
          for(let d=-radius;d<=radius;d++){
            const j=i+(horizontal?d:d*w)*4;
            const diff=Math.abs(input[i]-input[j])+Math.abs(input[i+1]-input[j+1])+Math.abs(input[i+2]-input[j+2]);
            const a=spatial[d+radius]*range[diff];weight+=a;r+=input[j]*a;g+=input[j+1]*a;b+=input[j+2]*a;
          }
          output[i]=r/weight;output[i+1]=g/weight;output[i+2]=b/weight;
        }
        if(y%80===0){await new Promise(resolve=>setTimeout(resolve,0));checkCancelled();}
      }
      input=output;
    }
    const retouched=input;
    for(let i=0;i<data.length;i+=4){
      if(!alpha[i+3])continue;
      const luminance=(0.2126*input[i]+0.7152*input[i+1]+0.0722*input[i+2])/255;
      // 검정·흰색은 유지하면서 피부 중간 밝기와 그늘을 올린다.
      const lift=32*4*luminance*(1-luminance)*(1.15-0.45*luminance);
      for(let c=0;c<3;c++)retouched[i+c]=data[i+c]+0.96*(input[i+c]-data[i+c])+lift;
    }
    return {canvas,source,retouched,alpha,faces:faces.length};
  }
  function paint(prepared, strength) {
    const {canvas,source,retouched,alpha}=prepared;
    const amount=Math.max(0,Math.min(100,Number(strength)||0))/100;
    if(prepared.paintStrength===amount)return canvas;
    const pixels=prepared.pixels||(prepared.pixels=new ImageData(new Uint8ClampedArray(source.data),canvas.width,canvas.height));
    if(!amount)pixels.data.set(source.data);
    else for(let i=0;i<pixels.data.length;i+=4){
      if(!alpha[i+3])continue;
      const a=alpha[i+3]/255*amount;
      for(let c=0;c<3;c++)pixels.data[i+c]=source.data[i+c]+a*(retouched[i+c]-source.data[i+c]);
    }
    canvas.getContext('2d').putImageData(pixels,0,0);prepared.paintStrength=amount;return canvas;
  }
  function normalizeEffects(value = {}) {
    const effects={color:['warm','pastel','film','mono'].includes(value?.color)?value.color:'none',frame:['white','polaroid','confetti','film','event'].includes(value?.frame)?value.frame:'none'};
    if(effects.frame==='event')effects.event={title:Array.from(String(value.event?.title??'함께한 오늘')).slice(0,32).join(''),date:/^\d{4}-\d{2}-\d{2}$/.test(value.event?.date)?value.event.date:'',...(/^[a-f0-9-]{36}$/.test(value.event?.templateId||'')?{templateId:value.event.templateId}:{})};
    const decorations=(Array.isArray(value?.decorations)?value.decorations:[]).slice(0,8).filter(item=>item&&['heart','star','speech','text'].includes(item.type)).map((item,index)=>({
      id:String(item.id||'item-'+index).slice(0,80),type:item.type,text:Array.from(String(item.text||'')).slice(0,24).join(''),
      x:Math.max(0.04,Math.min(0.96,Number.isFinite(item.x)?item.x:0.5)),y:Math.max(0.04,Math.min(0.96,Number.isFinite(item.y)?item.y:0.75)),
      size:Math.max(0.05,Math.min(0.24,Number(item.size)||0.12)),rotation:Math.max(-360,Math.min(360,Number(item.rotation)||0)),
      color:['#cf5270','#d1a535','#245344','#ffffff'].includes(item.color)?item.color:'#cf5270'
    })).filter(item=>item.type!=='text'||item.text.trim());
    if(decorations.length)effects.decorations=decorations;
    return effects;
  }
  // 미리보기에서는 화면 크기의 투명 레이어에, 저장 시에는 최종 사진에 같은 도형을 그린다.
  function drawDecorations(ctx, items, bounds) {
    const boxes=[];
    for(const item of items||[]){
      if(item.type==='text'&&!String(item.text||'').trim())continue;
      const size=Math.min(bounds.width,bounds.height)*item.size,x=bounds.x+item.x*bounds.width,y=bounds.y+item.y*bounds.height,rotation=item.rotation*Math.PI/180;
      let width=size,height=size;
      ctx.save();ctx.translate(x,y);ctx.rotate(rotation);ctx.fillStyle=item.color;ctx.textAlign='center';ctx.textBaseline='middle';
      if(item.type==='heart'){
        ctx.scale(size,size);ctx.beginPath();ctx.moveTo(0,0.42);ctx.bezierCurveTo(-0.9,-0.12,-0.36,-0.73,0,-0.26);ctx.bezierCurveTo(0.36,-0.73,0.9,-0.12,0,0.42);ctx.fill();
      }else if(item.type==='star'){
        ctx.beginPath();for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,r=size*(i%2?0.23:0.5);ctx[i?'lineTo':'moveTo'](Math.cos(a)*r,Math.sin(a)*r);}ctx.closePath();ctx.fill();
      }else{
        const text=String(item.text||'');
        let fontSize=size*(item.type==='speech'?0.45:0.7);ctx.font='600 '+fontSize+'px system-ui,sans-serif';
        const maxWidth=bounds.width*0.82,padding=item.type==='speech'?size*0.55:size*0.16;
        const natural=ctx.measureText(text).width;
        if(natural+padding>maxWidth){fontSize*=Math.max(0.1,(maxWidth-padding)/natural);ctx.font='600 '+fontSize+'px system-ui,sans-serif';}
        width=ctx.measureText(text).width+padding;height=fontSize*(item.type==='speech'?2.0:1.5);
        if(item.type==='speech'){
          const l=-width/2,t=-height/2,r=height*0.2;ctx.fillStyle='#ffffff';ctx.strokeStyle=item.color;ctx.lineWidth=Math.max(1,size*0.035);
          ctx.beginPath();ctx.moveTo(l+r,t);ctx.arcTo(l+width,t,l+width,t+height,r);ctx.arcTo(l+width,t+height,l,t+height,r);ctx.lineTo(-width*0.12,t+height);ctx.lineTo(-width*0.25,t+height+size*0.2);ctx.lineTo(-width*0.22,t+height);ctx.arcTo(l,t+height,l,t,r);ctx.arcTo(l,t,l+width,t,r);ctx.closePath();ctx.fill();ctx.stroke();
          height+=size*0.2;
        }else{ctx.strokeStyle=item.color==='#ffffff'?'#245344':'#ffffff';ctx.lineWidth=Math.max(2,fontSize*0.13);ctx.lineJoin='round';ctx.strokeText(text,0,0);}
        ctx.fillStyle=item.color;ctx.fillText(text,0,0);
      }
      ctx.restore();boxes.push({id:item.id,x,y,width:Math.max(width,24),height:Math.max(height,24),rotation});
    }
    return boxes;
  }
  function compose(base, effects = {}) {
    const canvas=document.createElement('canvas');canvas.width=base.width;canvas.height=base.height;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(base,0,0);
    if(['warm','pastel','film','mono'].includes(effects.color)){
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height), data=pixels.data;
      for(let i=0;i<data.length;i+=4){
        const r=data[i],g=data[i+1],b=data[i+2];
        if(effects.color==='warm'){data[i]=r*1.055+4;data[i+1]=g*1.015+1;data[i+2]=b*0.93;}
        if(effects.color==='pastel'){data[i]=(r-128)*0.86+144;data[i+1]=(g-128)*0.86+142;data[i+2]=(b-128)*0.86+145;}
        if(effects.color==='film'){
          data[i]=((r*0.85+g*0.12+b*0.03)-128)*1.06+136;
          data[i+1]=((r*0.06+g*0.90+b*0.04)-128)*1.02+130;
          data[i+2]=((r*0.06+g*0.14+b*0.80)-128)*0.96+125;
        }
        if(effects.color==='mono'){const gray=0.2126*r+0.7152*g+0.0722*b;data[i]=data[i+1]=data[i+2]=gray;}
      }
      ctx.putImageData(pixels,0,0);
    }
    if(['white','polaroid','confetti','film','event'].includes(effects.frame)){
      const border=Math.max(8,Math.round(Math.min(canvas.width,canvas.height)*(effects.frame==='confetti'?0.07:0.045)));
      const footer=effects.frame==='polaroid'?border*3:effects.frame==='event'?Math.round(border*4.5):0;
      const framed=document.createElement('canvas');framed.width=canvas.width+border*2;framed.height=canvas.height+border*2+footer;
      const f=framed.getContext('2d');f.fillStyle=effects.frame==='polaroid'?'#fff8ec':effects.frame==='event'?'#f0f5ec':effects.frame==='confetti'?'#fff4e8':effects.frame==='film'?'#25322d':'#ffffff';f.fillRect(0,0,framed.width,framed.height);f.drawImage(canvas,border,border);
      if(effects.frame==='event'&&effects.frameImage){f.drawImage(effects.frameImage,0,0,framed.width,framed.height);f.drawImage(canvas,border,border);f.fillStyle='#f0f5eceb';f.fillRect(border,border+canvas.height,canvas.width,footer);}
      if(effects.frame==='confetti'){
        const colors=['#d87579','#dda84c','#71a69b','#9b8abd'];
        for(let i=0;i<24;i++){
          f.fillStyle=colors[i%colors.length];const x=border+(canvas.width*(i+0.5)/24), y=i%2?border*0.35:framed.height-border*0.35;
          f.save();f.translate(x,y);f.rotate(i*0.8);f.fillRect(-border*0.06,-border*0.15,border*0.12,border*0.3);f.restore();
        }
        for(let i=0;i<12;i++)for(const x of [border*0.4,framed.width-border*0.4]){
          f.fillStyle=colors[(i+1)%colors.length];f.beginPath();f.arc(x,border+canvas.height*(i+0.5)/12,border*0.09,0,Math.PI*2);f.fill();
        }
      }
      if(effects.frame==='film'){
        f.fillStyle='#f1e7cd';
        for(let y=border*0.4;y<framed.height-border*0.2;y+=border*1.1)for(const x of [border*0.22,framed.width-border*0.78])f.fillRect(x,y,border*0.56,border*0.6);
      }
      if(effects.frame==='event'){
        const event=normalizeEffects(effects).event;
        f.fillStyle='#244b3c';f.textAlign='center';f.textBaseline='middle';f.font='600 '+Math.round(border*1.35)+'px system-ui,sans-serif';f.fillText(event.title,framed.width/2,border+canvas.height+footer*0.38,canvas.width*0.92);
        f.font='500 '+Math.round(border)+'px system-ui,sans-serif';f.fillText((event.date?event.date.replaceAll('-','.')+' · ':'')+'YEBOM',framed.width/2,border+canvas.height+footer*0.72,canvas.width*0.92);
      }else if(footer){f.fillStyle='#244b3c';f.textAlign='center';f.textBaseline='middle';f.font='500 '+Math.round(border*0.7)+'px system-ui,sans-serif';f.fillText('오늘의 한 컷 · YEBOM',framed.width/2,border+canvas.height+footer*0.55,canvas.width);}
      const scale=Math.min(1,2048/Math.max(framed.width,framed.height));canvas.width=Math.round(framed.width*scale);canvas.height=Math.round(framed.height*scale);
      ctx.drawImage(framed,0,0,canvas.width,canvas.height);
      framed.width=framed.height=1;
    }
    drawDecorations(ctx,normalizeEffects(effects).decorations,{x:0,y:0,width:canvas.width,height:canvas.height});
    return canvas;
  }
  async function exportPhoto(canvas, original) {
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.94));
    if(!blob)throw new Error('보정 사진을 만들지 못했습니다. 원본으로 진행하거나 다시 시도해 주세요.');
    return new File([blob], original.name.replace(/\.[^.]+$/,'')+'_꾸미기.jpg',{type:'image/jpeg',lastModified:original.lastModified});
  }
  async function file(prepared, strength, original, effects) {
    const canvas=compose(paint(prepared,strength),effects);
    try{return await exportPhoto(canvas,original);}finally{canvas.width=canvas.height=1;}
  }
  async function releaseDetector() {
    const pending=detector;detector=null;
    if(pending)try{(await pending).close();}catch{}
  }
  return { decode,prepare,paint,compose,exportPhoto,file,releaseDetector,normalizeEffects,drawDecorations };
})();
