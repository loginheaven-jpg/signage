// 회귀 시나리오에서 새 메뉴·선택창을 실제 버튼으로 연다. 앱 상태를 직접 바꾸지 않는다.
async function closeDialogs(page){
 for(let i=0;i<5;i++){
  const opened=page.locator('dialog[open]');if(!await opened.count())return;
  const dialog=opened.last(),id=await dialog.getAttribute('id');
  const close=dialog.locator('[data-close-dialog], #closeBeauty, #closeCamera, #closeFolders, #closeSites').first();
  await close.click();await page.locator('#'+id).waitFor({state:'hidden'});
 }
}
async function menu(page){if(!await page.locator('#moreDialog').isVisible()){await closeDialogs(page);await page.locator('#moreMenu').click();}}
async function location(page){if(await page.locator('#setup').isVisible()||await page.locator('#locationDialog').isVisible())return;await closeDialogs(page);await page.locator('#quickEvent').click();}
async function options(page){if(await page.locator('#optionsDialog').isVisible())return;await closeDialogs(page);if(await page.locator('#reviewOptions').isVisible())await page.locator('#reviewOptions').click();else{await menu(page);await page.locator('#menuOptions').click();}await page.locator('#optionsDialog').waitFor();}
async function status(page){if(await page.locator('#statusDialog').isVisible())return;await closeDialogs(page);await page.locator('#moreMenu').click();await page.locator('#menuHistory').click();await page.locator('#statusDialog').waitFor();}
async function share(page){if(await page.locator('#shareDialog').isVisible())return;await closeDialogs(page);if(await page.locator('#showShare').isVisible())await page.locator('#showShare').click();else{await menu(page);await page.locator('#menuShare').click();}await page.locator('#shareDialog').waitFor();}
async function reveal(page,selector){
 if(selector.startsWith('[data-mode')){if(!await page.locator('#purpose').isVisible()){await menu(page);await page.locator('#changePurpose').click();await page.locator('#purpose').waitFor();}}
 else if(['#changePurpose','#changeSettings'].includes(selector))await menu(page);
 else if(['#chooseFolder','#reloadFolders','#year','#yearFolder','#eventName','#eventDate','#saveLocation'].includes(selector))await location(page);
 else if(selector==='#refreshHistory')await status(page);
 else if(selector.startsWith('[data-mail-cancel')||selector.startsWith('[data-withdraw')||selector.startsWith('[data-cancel'))await status(page);
 else if(['#sharePhotos','#withdrawBatch','#cancelBatch','#cancelBatchMail'].includes(selector))await share(page);
 else if(['#email','#clearEmail','#message','#keepMessage'].includes(selector)||selector.startsWith('#emailSuggestion'))await options(page);
 else if(['#home','#send','#shoot','#shootVideo','#choose','#discard','#reviewAdd'].includes(selector))await closeDialogs(page);
}
async function click(page,selector){
 await reveal(page,selector);
 if(selector==='#chooseSite'&&!await page.locator('#setup').isVisible()){await page.locator('#quickMonitor').click();await page.locator('#siteDialog').waitFor();return;}
 if(selector==='#continueResume'){await page.locator('#work').waitFor();if(!await page.locator('#continueResume').isVisible())return;}
 const locator=page.locator(selector),details=locator.locator('xpath=ancestor::details[1]');
 if(await details.count()&&!await details.evaluate(el=>el.open))await details.locator('summary').click();
 await locator.click();
 if(selector==='#saveLocation'&&await page.locator('#locationDialog').isVisible())await page.locator('#locationDialog').waitFor({state:'hidden'});
}
async function fill(page,selector,value){await reveal(page,selector);const locator=page.locator(selector),details=locator.locator('xpath=ancestor::details[1]');if(await details.count()&&!await details.evaluate(el=>el.open))await details.locator('summary').click();await locator.fill(value);}
module.exports={click,fill,closeDialogs,location,options,status,share};
