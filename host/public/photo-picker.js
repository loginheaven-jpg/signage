'use strict';
let pickerLoader;
function loadGooglePicker() {
  if (!pickerLoader) pickerLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onerror = () => reject(new Error('Google 폴더 선택창을 불러오지 못했습니다. 다시 시도해 주세요.'));
    script.onload = () => window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Google Picker를 불러오지 못했습니다.')), timeout: 15000, ontimeout: () => reject(new Error('Google 응답이 지연되고 있습니다. 다시 시도해 주세요.')) });
    document.head.append(script);
  }).catch(e => { pickerLoader = null; throw e; });
  return pickerLoader;
}
document.getElementById('selectFolder').addEventListener('click', async () => {
  const button = document.getElementById('selectFolder');
  button.disabled = true;
  try {
    const [config] = await Promise.all([api('/api/photos/picker/config', { method: 'POST' }), loadGooglePicker()]);
    const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
      .setIncludeFolders(true).setSelectFolderEnabled(true);
    const picker = new google.picker.PickerBuilder()
      .setAppId(config.appId).setDeveloperKey(config.developerKey).setOAuthToken(config.accessToken)
      .setOrigin(location.origin).setLocale('ko').setTitle('사진 보관용 photos 폴더를 선택하세요')
      .addView(view).setCallback(async data => {
        if (data.action !== google.picker.Action.PICKED) return;
        const id = data.docs?.[0]?.id;
        if (id !== config.folderId) { toast('지정한 photos 폴더를 선택해 주세요. 다른 폴더로는 변경되지 않습니다.'); return; }
        button.disabled = true;
        try {
          await api('/api/photos/picker/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId: id }) });
          document.getElementById('folderSelection').hidden = true;
          history.replaceState(null, '', '/photos');
          toast('사진 폴더 연결 완료. 대기 중인 사진을 자동 보관합니다.');
          await load();
        } catch (e) { toast(e.message); }
        finally { button.disabled = false; }
      }).build();
    picker.setVisible(true);
  } catch (e) { toast(e.message); }
  finally { button.disabled = false; }
});
