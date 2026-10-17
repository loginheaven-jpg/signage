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
  async function prepare(file) {
    const canvas = await decode(file), faces = await landmarks(canvas);
    if (!faces.length) throw new Error('얼굴을 찾지 못했습니다. 정면에 가까운 사진을 사용하거나 원본으로 진행해 주세요.');
    const w = canvas.width, h = canvas.height, ctx = canvas.getContext('2d', { willReadFrequently: true });
    const mask = document.createElement('canvas'); mask.width=w; mask.height=h;
    const m = mask.getContext('2d', { willReadFrequently: true }); m.fillStyle='#fff';
    for (const face of faces) polygon(m,face,oval,w,h,0.94);
    m.globalCompositeOperation='destination-out';
    for (const face of faces) for (const f of features) polygon(m,face,f,w,h,1.35);
    const alpha=m.getImageData(0,0,w,h).data;
    // 보정 영역 안쪽으로만 경계를 부드럽게 한다. 배경·눈·입술로 효과가 번지지 않는다.
    const feather=Math.max(3,Math.round(Math.max(w,h)/240)), distance=new Uint16Array(w*h);
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
  async function file(prepared, strength, original) {
    const canvas=paint(prepared,strength), blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.94));
    if(!blob)throw new Error('보정 사진을 만들지 못했습니다. 원본으로 진행하거나 다시 시도해 주세요.');
    return new File([blob], original.name.replace(/\.[^.]+$/,'')+'_피부보정.jpg',{type:'image/jpeg',lastModified:original.lastModified});
  }
  return { decode,prepare,paint,file };
})();
