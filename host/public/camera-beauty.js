'use strict';
// 사진과 얼굴 좌표는 외부로 보내지 않는다. 모델은 같은 서버에서 필요할 때만 읽는다.
window.CameraBeauty = (() => {
  let detector;
  async function landmarks(canvas) {
    if (!detector) detector = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import('/vendor/mediapipe/vision_bundle.mjs');
      return FaceLandmarker.createFromOptions(await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm'), {
        baseOptions: { modelAssetPath: '/vendor/mediapipe/face_landmarker.task', delegate: 'CPU' },
        runningMode: 'IMAGE', numFaces: 8, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5
      });
    })().catch(error => { detector = null; throw error; });
    const model = await detector;
    const small = document.createElement('canvas'), scale = Math.min(1, 768 / Math.max(canvas.width, canvas.height));
    small.width = Math.round(canvas.width * scale); small.height = Math.round(canvas.height * scale);
    small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
    return model.detect(small).faceLandmarks;
  }
  async function decode(file) {
    let image;
    try { image = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
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
    } finally { image.close?.(); }
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
  async function prepare(file) {
    const canvas = await decode(file), faces = await landmarks(canvas);
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
        if(y%80===0)await new Promise(resolve=>setTimeout(resolve,0));
      }
      input=output;
    }
    const retouched=new Uint8ClampedArray(data);
    for(let i=0;i<data.length;i+=4){
      if(!alpha[i+3])continue;
      const luminance=(0.2126*input[i]+0.7152*input[i+1]+0.0722*input[i+2])/255;
      // 검정·흰색은 유지하면서 피부 중간 밝기와 그늘을 올린다.
      const lift=32*4*luminance*(1-luminance)*(1.15-0.45*luminance);
      for(let c=0;c<3;c++)retouched[i+c]=data[i+c]+0.96*(input[i+c]-data[i+c])+lift;
    }
    return {canvas,source,smooth:input,retouched,alpha,faces:faces.length};
  }
  function paint(prepared, strength) {
    const {canvas,source,retouched,alpha}=prepared, pixels=new ImageData(new Uint8ClampedArray(source.data),canvas.width,canvas.height);
    const amount=Math.max(0,Math.min(100,Number(strength)||0))/100;
    if(amount)for(let i=0;i<pixels.data.length;i+=4){
      if(!alpha[i+3])continue;
      const a=alpha[i+3]/255*amount;
      for(let c=0;c<3;c++)pixels.data[i+c]=source.data[i+c]+a*(retouched[i+c]-source.data[i+c]);
    }
    canvas.getContext('2d').putImageData(pixels,0,0);return canvas;
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
    if(['white','polaroid'].includes(effects.frame)){
      const border=Math.max(8,Math.round(Math.min(canvas.width,canvas.height)*0.045));
      const footer=effects.frame==='polaroid'?border*3:0;
      const framed=document.createElement('canvas');framed.width=canvas.width+border*2;framed.height=canvas.height+border*2+footer;
      const f=framed.getContext('2d');f.fillStyle=effects.frame==='polaroid'?'#fff8ec':'#ffffff';f.fillRect(0,0,framed.width,framed.height);f.drawImage(canvas,border,border);
      if(footer){f.fillStyle='#244b3c';f.textAlign='center';f.textBaseline='middle';f.font='500 '+Math.round(border*0.7)+'px system-ui,sans-serif';f.fillText('오늘의 한 컷 · YEBOM',framed.width/2,border+canvas.height+footer*0.55,canvas.width);}
      const scale=Math.min(1,2048/Math.max(framed.width,framed.height));canvas.width=Math.round(framed.width*scale);canvas.height=Math.round(framed.height*scale);
      ctx.drawImage(framed,0,0,canvas.width,canvas.height);
    }
    return canvas;
  }
  async function exportPhoto(canvas, original) {
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.94));
    if(!blob)throw new Error('보정 사진을 만들지 못했습니다. 원본으로 진행하거나 다시 시도해 주세요.');
    return new File([blob], original.name.replace(/\.[^.]+$/,'')+'_꾸미기.jpg',{type:'image/jpeg',lastModified:original.lastModified});
  }
  async function file(prepared, strength, original, effects) { return exportPhoto(compose(paint(prepared,strength),effects),original); }
  return { decode,prepare,paint,compose,exportPhoto,file };
})();
