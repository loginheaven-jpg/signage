// Shared by the Electron and web players. A socket send is not a display receipt.
(function (root) {
  function create(options) {
    const entries = new Map();
    let sequence = Promise.resolve();
    function report(id, status) { options.send({ type: 'live_result', photoId: id, status }); }
    function load(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        const timer = setTimeout(() => finish(new Error('image timeout')), 8000);
        function finish(error) {
          clearTimeout(timer);
          img.onload = img.onerror = null;
          if (error) { img.src = ''; reject(error); } else resolve();
        }
        img.onload = () => finish();
        img.onerror = () => finish(new Error('image download failed'));
        img.src = url;
      });
    }
    return {
      ready() {
        options.send({ type: 'live_ready', seen: Array.from(entries).filter(([, e]) => e.status === 'displayed').map(([id]) => id).slice(-100) });
      },
      receive(photo, show) {
        if (!photo || !photo.id) return;
        const old = entries.get(photo.id);
        if (old && old.status !== 'image_error') {
          if (old.status === 'displayed') report(photo.id, 'displayed');
          return;
        }
        const entry = { status: 'loading' };
        entries.set(photo.id, entry);
        if (entries.size > 100) entries.delete(entries.keys().next().value);
        // Download concurrently; commit to the display in arrival order.
        const loaded = (async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            if (entries.get(photo.id) !== entry) return false;
            try { await load(options.url(photo.url)); return true; }
            catch (e) { if (attempt < 2) await new Promise(r => setTimeout(r, 1000)); }
          }
          return false;
        })();
        sequence = sequence.then(async () => {
          const ok = await loaded;
          if (entries.get(photo.id) !== entry) return;
          if (!ok) { entry.status = 'image_error'; report(photo.id, 'image_error'); return; }
          entry.status = 'ready';
          show(photo);
        }).catch(() => { entry.status = 'image_error'; report(photo.id, 'image_error'); });
      },
      bind(img, photo) {
        img.onload = () => {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const entry = entries.get(photo.id);
            if (!entry || !img.isConnected || !options.visible(img)) return;
            entry.status = 'displayed';
            report(photo.id, 'displayed');
          }));
        };
        img.onerror = () => {
          const entry = entries.get(photo.id);
          if (entry) { entry.status = 'image_error'; report(photo.id, 'image_error'); }
        };
      },
      remove(id) { entries.delete(id); },
      clear() { entries.clear(); sequence = Promise.resolve(); }
    };
  }
  root.LiveDelivery = { create };
})(typeof window !== 'undefined' ? window : globalThis);
