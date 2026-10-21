'use strict';
// 한 사진만 미리 준비한다. 편집창이 가져간 결과는 편집창에서 해제한다.
window.CameraBeautyWarmup = class {
  constructor({ idleMs = 60000 } = {}) { this.idleMs = idleMs; this.cached = null; this.timer = null; }
  create(file, canvas = null) {
    const controller = new AbortController(), listeners = new Set();
    const job = { file, canvas, prepared: null, error: null, stage: 'loading', controller };
    const notify = () => { for (const listener of listeners) listener(job); };
    job.subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
    job.dispose = () => {
      controller.abort(); listeners.clear(); clearTimeout(deadline);
      if (job.canvas) job.canvas.width = job.canvas.height = 1;
      job.canvas = null; job.prepared = null;
    };
    const deadline = setTimeout(() => { controller.abort(); job.error = new Error('준비 시간이 길어졌어요. 다시 시도해 주세요.'); job.stage = 'error'; notify(); }, 45000);
    job.base = (async () => {
      const base = canvas || await window.CameraBeauty.decode(file);
      if (controller.signal.aborted) { base.width = base.height = 1; throw new DOMException('편집 취소', 'AbortError'); }
      job.canvas = base; return base;
    })();
    job.ready = job.base.then(base => window.CameraBeauty.prepare(file, {
      canvas: base, signal: controller.signal,
      onProgress(stage) { if (!controller.signal.aborted) { job.stage = stage; notify(); } }
    })).then(prepared => {
      if (controller.signal.aborted) return null;
      job.prepared = prepared; job.stage = 'ready'; notify(); return prepared;
    }).catch(error => {
      if (!controller.signal.aborted) { job.error = error; job.stage = 'error'; notify(); }
      return null;
    }).finally(() => clearTimeout(deadline));
    return job;
  }
  start(file) { this.clear(); const job = this.create(file); this.cached = job; this.touch(); return job; }
  take(file) {
    if (this.cached?.file !== file) { this.clear(); return null; }
    const job = this.cached; this.cached = null; clearTimeout(this.timer); this.timer = null; return job;
  }
  touch() {
    clearTimeout(this.timer);
    if (this.cached) this.timer = setTimeout(() => this.clear(), this.idleMs);
  }
  clear() { clearTimeout(this.timer); this.timer = null; this.cached?.dispose(); this.cached = null; }
};
