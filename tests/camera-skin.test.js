const test = require('node:test');
const assert = require('node:assert/strict');
const core = import('../host/public/camera-skin-core.mjs');

async function fixture() {
  const { OVAL, connectedSkin, skinMasks } = await core;
  const w = 128, h = 160, face = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.35 }));
  OVAL.forEach((id, index) => { const a = -Math.PI / 2 + index / OVAL.length * Math.PI * 2; face[id] = { x: 0.5 + 0.26 * Math.cos(a), y: 0.35 + 0.23 * Math.sin(a) }; });
  const feature = (ids, cx, cy, rx, ry) => ids.forEach((id, index) => { const a = index / ids.length * Math.PI * 2; face[id] = { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }; });
  feature([33,160,158,133,153,144], .4,.29,.05,.02); feature([362,385,387,263,373,380], .6,.29,.05,.02);
  feature([70,63,105,66,107,55,65,52,53,46], .4,.24,.06,.012); feature([336,296,334,293,300,276,283,282,295,285], .6,.24,.06,.012);
  feature([61,40,37,0,267,270,291,321,314,17,84,91], .5,.45,.08,.025);
  const source = new Uint8ClampedArray(w*h*4), probability = new Uint8Array(w*h), bounds = { x: 0, y: 0, width: 1, height: 1 };
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    const p=y*w+x, px=(x+.5)/w, py=(y+.5)/h;
    // 피부색 배경도 피부 확률이 없으면 그대로 남아야 한다.
    source.set([170,120,95,255],p*4);
    const faceSkin=((px-.5)/.26)**2+((py-.35)/.23)**2<1;
    const neck=px>.43&&px<.57&&py>.5&&py<.8, detached=px>.86&&px<.95&&py>.3&&py<.4;
    if(faceSkin||neck||detached)probability[p]=255;
  }
  connectedSkin(probability,w,h,face,bounds);
  const {alpha,tone}=skinMasks([{width:w,height:h,bounds,probability,guide:source}], [face],source,w,h);
  return {w,h,face,source,alpha,tone,probability,at:(x,y)=>Math.floor(y*h)*w+Math.floor(x*w)};
}

test('skin coverage continues over the jaw into connected neck skin; matching background and detached skin remain excluded', async()=>{
  const f=await fixture();
  for(const y of [.54,.58,.62]) { assert.ok(f.tone[f.at(.5,y)]>230,'tone must not stop at the chin');assert.ok(f.alpha[f.at(.5,y)]>220); }
  assert.equal(f.tone[f.at(.9,.35)],0);assert.equal(f.probability[f.at(.9,.35)],0);
  assert.equal(f.tone[f.at(.1,.5)],0);
  assert.equal(f.alpha.byteLength+f.tone.byteLength,2*f.w*f.h,'two compact masks replace the old four-channel mask');
  for(const p of [[.4,.29],[.6,.29],[.5,.45]]) { assert.equal(f.alpha[f.at(...p)],0);assert.equal(f.tone[f.at(...p)],0); }
});

test('separate tone adjustment preserves skin chroma, does not introduce a jaw brightness step, and strength zero is exact',async()=>{
  const {paintSkin}=await core,f=await fixture(),output=new Uint8ClampedArray(f.source);
  paintSkin(f.source,f.source,f.alpha,f.tone,100,output);
  const jaw=[.54,.58,.62].map(y=>{const i=f.at(.5,y)*4;return output[i]-f.source[i];});
  assert.ok(Math.max(...jaw)-Math.min(...jaw)<=1,'no new brightness ring on continuous jaw and neck skin');
  const i=f.at(.5,.54)*4;
  assert.ok(output[i]>f.source[i]);
  assert.ok(Math.abs(output[i]/output[i+1]-f.source[i]/f.source[i+1])<.02,'tone must not wash skin toward gray or white');
  for(let p=0;p<f.w*f.h;p++)if(!f.alpha[p]&&!f.tone[p])assert.deepEqual(output.slice(p*4,p*4+4),f.source.slice(p*4,p*4+4));
  paintSkin(f.source,f.source,f.alpha,f.tone,0,output);assert.deepEqual(output,f.source);
  paintSkin(f.source,f.source,f.alpha,f.tone,100,output);
  paintSkin(f.source,f.source,f.alpha,f.tone,35,output);
  assert.ok(output[i]-f.source[i]<jaw[0]);
});

test('smoothing never samples excluded dark hair or lips into adjacent skin',async()=>{
  const {smoothSkin}=await core,w=32,h=24,source=new Uint8ClampedArray(w*h*4),mask=new Uint8ClampedArray(w*h).fill(255);
  for(let p=0;p<w*h;p++)source.set([170,120,95,255],p*4);
  for(let y=0;y<h;y++){const p=y*w+15;mask[p]=0;source.set([8,7,6,255],p*4);}
  const result=smoothSkin(source,mask,w,h,200);
  assert.deepEqual(result,source,'uniform skin next to a dark excluded feature gains no gray fringe');
});
