'use strict';
window.CameraDecorationEditor = class {
  constructor({canvas,onChange,onMessage}) {
    this.canvas=canvas;this.onChange=onChange;this.onMessage=onMessage;this.items=[];this.boxes=[];this.selected=null;this.active=false;this.visible=false;this.frame=0;
    this.controls={text:document.getElementById('decorationText'),color:document.getElementById('decorationColor'),size:document.getElementById('decorationSize'),rotate:document.getElementById('rotateDecoration'),remove:document.getElementById('removeDecoration')};
    for(const button of document.querySelectorAll('[data-add-decoration]'))button.onclick=()=>this.add(button.dataset.addDecoration);
    this.controls.text.oninput=()=>this.edit({text:Array.from(this.controls.text.value).slice(0,24).join('')});
    this.controls.color.onchange=()=>this.edit({color:this.controls.color.value});
    this.controls.size.oninput=()=>this.edit({size:Number(this.controls.size.value)/100});
    this.controls.rotate.onclick=()=>{const item=this.current();if(item)this.edit({rotation:(item.rotation+15)%360});};
    this.controls.remove.onclick=()=>{if(!this.selected)return;this.items=this.items.filter(item=>item.id!==this.selected);this.selected=null;this.changed(true);};
    canvas.onpointerdown=event=>this.pointerDown(event);
    canvas.onpointermove=event=>this.pointerMove(event);
    canvas.onkeydown=event=>{
      if(!this.active)return;const item=this.current();if(!item)return;
      if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();this.controls.remove.click();return;}
      if(event.key==='Escape'){event.preventDefault();this.selected=null;this.renderControls();this.schedule();return;}
      const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
      if(delta){event.preventDefault();const step=event.shiftKey?0.05:0.01;this.edit({x:Math.max(0.04,Math.min(0.96,item.x+delta[0]*step)),y:Math.max(0.04,Math.min(0.96,item.y+delta[1]*step))});}
    };
    const finish=()=>{this.drag=null;};canvas.onpointerup=finish;canvas.onpointercancel=finish;canvas.onlostpointercapture=finish;
    this.observer=new ResizeObserver(()=>this.schedule());this.observer.observe(canvas.parentElement);
  }
  current(){return this.items.find(item=>item.id===this.selected);}
  reset(items){this.items=window.CameraBeauty.normalizeEffects({decorations:items}).decorations||[];this.selected=null;this.drag=null;this.controls.text.value='';return this.items;}
  refresh({visible,active,image}){
    this.visible=visible;this.active=active;this.image=image?{width:image.width,height:image.height}:null;this.canvas.hidden=!visible;this.canvas.tabIndex=active?0:-1;
    this.canvas.style.pointerEvents=active?'auto':'none';this.renderControls();this.schedule();
  }
  renderControls(){
    const item=this.current(),enabled=this.active&&!!item;
    for(const button of document.querySelectorAll('[data-add-decoration]'))button.disabled=!this.active||this.items.length>=8;
    this.controls.text.disabled=!enabled||!['text','speech'].includes(item?.type);
    if(document.activeElement!==this.controls.text)this.controls.text.value=item?.text||'';
    this.controls.text.placeholder=item?['text','speech'].includes(item.type)?'짧은 문구 (24자)':'하트·별은 사진에서 옮기세요':'사진의 꾸미기를 눌러 선택';
    for(const key of ['color','size','rotate','remove'])this.controls[key].disabled=!enabled;
    this.controls.color.value=item?.color||'#cf5270';this.controls.size.value=Math.round((item?.size||0.12)*100);
    document.getElementById('decorationCount').textContent=this.items.length+'/8';
    document.getElementById('decorationSelection').textContent=item?({heart:'하트',star:'별',speech:'말풍선',text:'문구'}[item.type])+' 선택됨':'사진에서 끌어서 옮기세요';
  }
  add(type){
    if(!this.active||this.items.length>=8)return;
    const id=crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    const item={id,type,text:type==='speech'?'반가워요!':type==='text'?'오늘도 행복하게':'',x:0.5+(this.items.length%3-1)*0.12,y:0.76-(this.items.length%3)*0.08,size:type==='text'?0.09:0.13,rotation:0,color:type==='star'?'#d1a535':'#cf5270'};
    this.items.push(item);this.selected=item.id;this.changed(true);this.onMessage('사진에서 끌어 위치를 옮기고, 아래에서 크기와 문구를 바꿔 보세요.');
  }
  edit(values){const item=this.current();if(!this.active||!item)return;Object.assign(item,values);this.changed(false);}
  changed(baseNeeded){this.onChange(this.items,baseNeeded);this.renderControls();this.schedule();}
  schedule(){if(!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;this.draw();});}
  draw(){
    if(!this.visible||!this.image)return;
    const rect=this.canvas.parentElement.getBoundingClientRect(),w=rect.width,h=rect.height,ratio=Math.min(2,devicePixelRatio||1);
    if(w<=0||h<=0)return;
    const pw=Math.round(w*ratio),ph=Math.round(h*ratio);
    if(this.canvas.width!==pw)this.canvas.width=pw;if(this.canvas.height!==ph)this.canvas.height=ph;
    const ctx=this.canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);
    const scale=Math.min(w/this.image.width,h/this.image.height);
    this.bounds={x:(w-this.image.width*scale)/2,y:(h-this.image.height*scale)/2,width:this.image.width*scale,height:this.image.height*scale};
    this.boxes=window.CameraBeauty.drawDecorations(ctx,this.items,this.bounds);
    const selected=this.active&&this.boxes.find(box=>box.id===this.selected);
    if(selected){ctx.save();ctx.translate(selected.x,selected.y);ctx.rotate(selected.rotation);ctx.strokeStyle='#245344';ctx.lineWidth=1.5;ctx.setLineDash([4,3]);ctx.strokeRect(-selected.width/2-5,-selected.height/2-5,selected.width+10,selected.height+10);ctx.restore();}
  }
  pointerDown(event){
    if(!this.active||!this.bounds)return;
    const rect=this.canvas.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
    const box=[...this.boxes].reverse().find(box=>{const dx=x-box.x,dy=y-box.y,c=Math.cos(box.rotation),s=Math.sin(box.rotation);return Math.abs(dx*c+dy*s)<=box.width/2+12&&Math.abs(-dx*s+dy*c)<=box.height/2+12;});
    this.selected=box?.id||null;this.renderControls();this.schedule();
    if(!box)return;
    const item=this.current();this.drag={id:item.id,x,y,originX:item.x,originY:item.y,halfWidth:box.width/2,halfHeight:box.height/2};
    this.canvas.setPointerCapture(event.pointerId);event.preventDefault();
  }
  pointerMove(event){
    if(!this.active||!this.drag||!this.bounds)return;
    const item=this.current();if(!item)return;
    const rect=this.canvas.getBoundingClientRect(),b=this.bounds,dx=(event.clientX-rect.left-this.drag.x)/b.width,dy=(event.clientY-rect.top-this.drag.y)/b.height;
    const marginX=Math.max(0.04,Math.min(0.45,this.drag.halfWidth/b.width)),marginY=Math.max(0.04,Math.min(0.45,this.drag.halfHeight/b.height));
    item.x=Math.max(marginX,Math.min(1-marginX,this.drag.originX+dx));item.y=Math.max(marginY,Math.min(1-marginY,this.drag.originY+dy));
    this.onChange(this.items,false);this.schedule();event.preventDefault();
  }
  close(){cancelAnimationFrame(this.frame);this.frame=0;this.visible=false;this.active=false;this.image=null;this.bounds=null;this.boxes=[];this.drag=null;this.items=[];this.selected=null;this.canvas.hidden=true;this.canvas.width=this.canvas.height=1;}
};
