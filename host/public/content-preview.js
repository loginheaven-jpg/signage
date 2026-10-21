'use strict';
(() => {
  const dialog = document.getElementById('contentPreviewDialog'), image = document.getElementById('contentPreviewImage'), video = document.getElementById('contentPreviewVideo');
  const error = document.getElementById('contentPreviewError');
  function release() {
    image.removeAttribute('src'); image.hidden = true; image.alt = '';
    video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true;
    error.hidden = true;
  }
  window.openContentPreview = (id, fromTrash = false) => {
    const file = (fromTrash ? trashData.items : contentFiles).find(item => item.id === id);
    if (!file) return;
    release();
    document.getElementById('contentPreviewName').textContent = file.originalName;
    const media = String(file.mimeType).startsWith('video') ? video : image;
    if (media === image) image.alt = file.originalName;
    media.hidden = false; media.src = fromTrash ? file.url : '/uploads/' + encodeURIComponent(file.filename);
    dialog.showModal();
  };
  image.onerror = video.onerror = () => { if (dialog.open) error.hidden = false; };
  function close() { release(); dialog.close(); }
  document.getElementById('contentPreviewClose').onclick = close;
  dialog.addEventListener('cancel', release);
  dialog.addEventListener('close', () => { if (!dialog.open) release(); });
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) close();
  });
})();
