/* All assets are bundled; no backend and no outgoing requests. */
'use strict';
const $=id=>document.getElementById(id), S=Schedule;
const classes={'Р':'work','В':'off','Д':'daily','Н':'night','С':'full','О':'vacation','Б':'sick'};
const store=Profiles.createStore({storage:{getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value)}});
let config=null,cycle=[],viewYear,viewMonth,chosen,editingId=null,baseline='',pending=null;
let commonYear,commonMonth,commonIds=new Set(),importText=null;
let currentPage='calendar',sheetReturn={},avatarTarget=null,avatarBusy=false;
let salaryYear,salaryMonth,editingPaymentId=null;
function todayISO(){const d=new Date();return S.iso(d.getFullYear(),d.getMonth()+1,d.getDate());}
function pretty(iso,opts){return new Date(S.day(iso)*86400000).toLocaleDateString('ru-RU',Object.assign({timeZone:'UTC'},opts));}
function error(text){$('error').textContent=text;$('error').hidden=!text;}
function setDate(date){S.day(date);chosen=date;[viewYear,viewMonth]=date.split('-').map(Number);$('lookup-date').value=date;render();}
function render(){
  const now=todayISO();
  $('profile-title').textContent=config.name;
  $('lookup-error').hidden=true;$('lookup-error').textContent='';
  const t=S.typeAt(config,now,cycle);
  $('today-summary').textContent='';const b=document.createElement('strong');b.textContent=S.names[t]+(Object.prototype.hasOwnProperty.call(config.overrides,now)?' ★':'');$('today-summary').append(b,pretty(now,{day:'numeric',month:'long',weekday:'long'}));
  $('month-title').textContent=pretty(S.iso(viewYear,viewMonth,1),{month:'long',year:'numeric'});
  $('prev').disabled=viewYear===1&&viewMonth===1;$('next').disabled=viewYear===9999&&viewMonth===12;
  const grid=$('grid');grid.textContent='';
  const start=(new Date(S.day(S.iso(viewYear,viewMonth,1))*86400000).getUTCDay()+6)%7;
  for(let i=0;i<start;i++){const e=document.createElement('span');e.setAttribute('aria-hidden','true');grid.append(e);}
  const days=S.profileMonth(config,viewYear,viewMonth),paymentDates=new Set(((config.money&&config.money.payments)||[]).map(item=>item.date));
  for(const {date,type,overridden,extra} of days){
    const btn=document.createElement('button');btn.type='button';btn.className='day '+classes[type]+(date===now?' today':'')+(date===chosen?' chosen':'');
    btn.dataset.date=date;btn.setAttribute('aria-label',pretty(date,{day:'numeric',month:'long',year:'numeric'})+': '+S.names[type]+(overridden?' — исключение':'')+(paymentDates.has(date)?' — есть выплата':''));btn.setAttribute('aria-pressed',String(date===chosen));
    if(date===now)btn.setAttribute('aria-current','date');
    const num=document.createElement('span');num.textContent=Number(date.slice(-2));const lab=document.createElement('small');lab.textContent=type;btn.append(num,lab);const rate=Money.rateFor(config.money,type,extra);if(rate&&type!=='В'&&type!=='О'&&type!=='Б'){const earned=document.createElement('small');earned.className='day-earning';earned.textContent=Money.formatAmount(rate).replace(' ₽',' ₽');earned.setAttribute('aria-label','Заработок за смену: '+Money.formatAmount(rate));btn.append(earned);}if(extra){const badge=document.createElement('span');badge.className='extra-badge';badge.textContent='+';badge.setAttribute('aria-label','\u0414\u043e\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u044c\u043d\u0430\u044f \u0441\u043c\u0435\u043d\u0430');btn.append(badge);}else if(overridden){const badge=document.createElement('span');badge.className='exception-badge';badge.textContent='★';badge.setAttribute('aria-hidden','true');btn.append(badge);btn.classList.add('overridden');}if(paymentDates.has(date)){const money=document.createElement('span');money.className='payment-badge';money.textContent='₽';money.setAttribute('aria-hidden','true');btn.append(money);}
    btn.onclick=()=>{chosen=date;$('lookup-date').value=date;render();openSheet('day-sheet','override-type');};grid.append(btn);
  }
  const n=S.counts(days),forecast=days.reduce((sum,day)=>sum+Money.rateFor(config.money,day.type,day.extra),0);$('month-stats').textContent='Работа: '+n.work+' · Отдых: '+n.off+(n.vacation?' · Отпуск: '+n.vacation:'')+(n.sick?' · Больничный: '+n.sick:'')+(forecast?' · Прогноз: '+Money.formatAmount(forecast):'');
  const overridden=Object.prototype.hasOwnProperty.call(config.overrides,chosen),extra=!!config.extraShifts&&!!config.extraShifts[chosen],actual=S.typeAt(config,chosen,cycle);
  $('selected').textContent=pretty(chosen,{day:'numeric',month:'long',year:'numeric',weekday:'short'})+' — '+S.names[actual].toLowerCase()+(overridden?' · ★ исключение':'');
  $('override-type').value=actual;$('override-status').textContent='';
  $('override-info').textContent=pretty(chosen,{day:'numeric',month:'long',year:'numeric'})+'. По циклу: '+S.names[S.at(cycle,config.anchor,chosen)].toLowerCase()+'.'+(overridden?' Назначено исключение.':' Исключения нет.');
  $('override-fields').disabled=store.status.blocked||!!pending;$('override-reset').disabled=!overridden;$('extra-shift-toggle').checked=extra;$('extra-shift-toggle').disabled=store.status.blocked||!!pending;
  const legend=$('legend');legend.textContent='';
  for(const type of [...new Set(cycle.concat(days.map(d=>d.type)))]){const e=document.createElement('span'),dot=document.createElement('i');dot.className='dot '+classes[type];e.append(dot,S.names[type]);legend.append(e);}
  $('cycle-info').textContent='Цикл: '+cycle.length+' дн. · Начало: '+pretty(config.anchor,{day:'numeric',month:'long',year:'numeric'})+'. Повторяется вперёд и назад от этой даты.';
  renderDayPayments();
  $('result').hidden=false;if($('cycle-short'))$('cycle-short').textContent='Цикл '+config.pattern;
}
function activate(c){const next=S.parse(c.pattern);S.day(c.anchor);config=c;cycle=next;setDate(todayISO());}
function draft(){return {name:$('profile-name').value,pattern:$('pattern').value,anchor:$('anchor').value};}
function dirty(){return JSON.stringify(draft())!==baseline;}
function refreshControls(){
  const state=store.getState(),blocked=store.status.blocked;
  $('settings-fields').disabled=blocked||!!pending;
  $('override-fields').disabled=blocked||!!pending;
  for(const id of ['backup-export','backup-import','backup-replace','backup-cancel'])$(id).disabled=blocked||!!pending;
  $('add-profile').disabled=blocked||!!pending;
  $('delete-profile').disabled=blocked||!!pending||editingId===null;
  $('delete-profile').hidden=editingId===null;
  $('profile-select').disabled=!!pending||state.profiles.length===0;
  $('cancel-add').hidden=editingId!==null||state.profiles.length===0;
  $('cancel-add').disabled=!!pending;
  $('recover-data').hidden=!store.status.recovery;$('recover-data').disabled=!!pending;
  $('storage-message').textContent=store.status.message;$('storage-message').hidden=!store.status.message;
}
function profileOptions(){
  const select=$('profile-select'),state=store.getState();select.textContent='';
  if(editingId===null){const option=document.createElement('option');option.value='';option.textContent=state.profiles.length?'Новый человек (не сохранён)':'Пока нет сохранённых людей';select.appendChild(option);}
  for(const p of state.profiles){const option=document.createElement('option');option.value=p.id;option.textContent=p.name;select.appendChild(option);}
  select.value=editingId||'';refreshControls();refreshCommonPeople();
}
function showProfile(id){
  const state=store.getState(),p=state.profiles.find(p=>p.id===id);
  editingId=p?p.id:null;config=null;cycle=[];
  $('profile-name').value=p?p.name:(state.profiles.length?'':'Я');
  $('pattern').value=p?p.pattern:'';$('anchor').value=p?p.anchor:'';
  baseline=JSON.stringify(draft());error('');$('lookup-error').hidden=true;
  $('settings-title').textContent=p?'Редактировать профиль':'Новый человек';
  $('template-select').value=p?p.pattern:'';previewPattern();
  $('save-status').textContent=store.status.blocked?'Режим восстановления: сохранение заблокировано.':p?'Сохранённый график этого человека.':'Введи имя, цикл и дату его первого дня. Профиль появится после сохранения.';
  $('result').hidden=true;if(p)activate(p);profileOptions();renderPeople();renderSalary();
}
function runAction(action){try{action();}catch(e){error(e.message);notify('Действие не выполнено: '+e.message);$('save-status').textContent='Действие не выполнено. Поля ввода сохранены для повторной попытки.';refreshControls();if(!$('profile-editor').hidden)$('error').scrollIntoView({block:'center'});}}
function ask(text,label,action,focusId){
  pending={action,focusId};$('confirmation-text').textContent=text;$('confirm-accept').textContent=label;
  $('confirmation').hidden=false;refreshControls();$('confirmation').scrollIntoView({block:'center'});$('confirm-cancel').focus();
}
function guarded(action,focusId){
  if(dirty())ask('Есть несохранённые изменения. Отбросить их и продолжить?','Отбросить изменения',action,focusId);
  else runAction(action);
}
function closeConfirmation(){const p=pending;pending=null;$('confirmation').hidden=true;refreshControls();return p;}
$('confirm-cancel').onclick=()=>{const p=closeConfirmation();if(p&&$(p.focusId))$(p.focusId).focus();};
$('confirm-accept').onclick=()=>{const p=closeConfirmation();if(p)runAction(p.action);};
$('confirmation').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();$('confirm-cancel').click();}});
$('profile-select').onchange=()=>{
  const id=$('profile-select').value;$('profile-select').value=editingId||'';if(!id||id===editingId)return;
  guarded(()=>{if(!store.status.blocked)store.select(id);showProfile(id);},'profile-select');
};
$('add-profile').onclick=()=>guarded(()=>{showProfile(null);openSheet('profile-editor','profile-name');},'add-profile');
$('cancel-add').onclick=()=>guarded(()=>showProfile(store.getState().activeId),'cancel-add');
$('delete-profile').onclick=()=>{
  const p=store.getState().profiles.find(p=>p.id===editingId);if(!p)return;
  ask('Удалить человека «'+p.name+'» и его график?'+(dirty()?' Его несохранённые изменения тоже будут потеряны.':'')+' Это действие нельзя отменить.','Удалить',()=>{store.remove(p.id);showProfile(store.getState().activeId);hideSheet('profile-editor');notify('Профиль удалён с устройства.');},'delete-profile');
};
$('recover-data').onclick=()=>ask('Сохранить исходные данные отдельной резервной копией и продолжить с доступными профилями? Повреждённые записи останутся в резервной копии.','Восстановить',()=>{store.recover();showProfile(store.getState().activeId);},'recover-data');
$('settings').onsubmit=e=>{
  e.preventDefault();error('');if(pending)return;
  try{
    const p=store.save(editingId,draft());showProfile(p.id);$('save-status').textContent='Профиль и график сохранены на устройстве.';
    if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();
    hideSheet('profile-editor');navigate('calendar');notify('Профиль и график сохранены.');
  }catch(e){error(e.message);$('save-status').textContent='Изменения не сохранены. Проверь поля или повтори попытку.';$('result').hidden=true;}
};
function markDraft(){
  $('save-status').textContent=dirty()?'Есть несохранённые изменения. Нажми «Сохранить профиль», чтобы сохранить.':config?'Сохранённый график этого человека.':'';
  previewPattern();error('');
}
for(const id of ['profile-name','pattern','anchor'])$(id).addEventListener('input',markDraft);
for(const btn of document.querySelectorAll('[data-pattern]'))btn.onclick=()=>{$('pattern').value=btn.dataset.pattern;markDraft();};
function shiftMonth(n){let y=viewYear,m=viewMonth+n;if(m<1){m=12;y--;}if(m>12){m=1;y++;}if(y<1||y>9999)return;viewYear=y;viewMonth=m;chosen=S.iso(y,m,1);$('lookup-date').value=chosen;render();}
$('prev').onclick=()=>shiftMonth(-1);$('next').onclick=()=>shiftMonth(1);$('today').onclick=()=>setDate(todayISO());
$('lookup-date').onchange=()=>{try{setDate($('lookup-date').value);}catch(e){$('lookup-error').textContent=e.message;$('lookup-error').hidden=false;}};
function refreshCommonPeople(){
  const profiles=store.getState().profiles,box=$('common-people');box.textContent='';
  commonIds=new Set([...commonIds].filter(id=>profiles.some(p=>p.id===id)));
  for(const p of profiles){
    const label=document.createElement('label'),input=document.createElement('input'),name=document.createElement('span');
    label.className='person-check'+(commonIds.has(p.id)?' checked':'');input.type='checkbox';input.value=p.id;input.checked=commonIds.has(p.id);name.textContent=p.name;
    input.onchange=()=>{if(input.checked)commonIds.add(p.id);else commonIds.delete(p.id);label.classList.toggle('checked',input.checked);renderCommon();};label.append(input,avatar(p),name);box.append(label);
  }
  renderCommon();
}
function renderCommon(){
  $('common-title').textContent=pretty(S.iso(commonYear,commonMonth,1),{month:'long',year:'numeric'});
  $('common-month').value=S.iso(commonYear,commonMonth,1).slice(0,7);
  $('common-prev').disabled=commonYear===1&&commonMonth===1;$('common-next').disabled=commonYear===9999&&commonMonth===12;
  const list=$('common-days');list.textContent='';const profiles=store.getState().profiles.filter(p=>commonIds.has(p.id));renderSharedGrid([]);
  if(profiles.length<2){$('common-status').textContent=store.getState().profiles.length<2?'Добавь и сохрани минимум двух людей, затем отметь их для сравнения.':'Выберите минимум двух людей выше — общие выходные появятся здесь.';return;}
  const dates=S.commonDays(profiles,commonYear,commonMonth);renderSharedGrid(dates);
  $('common-status').textContent=dates.length?'Общих свободных дней: '+dates.length+'.':'В этом месяце общих свободных дней нет.';
  for(const date of dates){const item=document.createElement('li');item.dataset.commonDate=date;item.textContent=pretty(date,{day:'numeric',month:'short',weekday:'short'});list.append(item);}
}
function shiftCommon(n){
  let y=commonYear,m=commonMonth+n;if(m<1){m=12;y--;}if(m>12){m=1;y++;}if(y<1||y>9999)return;commonYear=y;commonMonth=m;renderCommon();
}
function backupMessage(message,failed){
  navigate('more');$('backup-panel').open=true;$('backup-status').hidden=!message;$('backup-status').textContent=message;$('backup-status').classList.toggle('failure',!!failed);
}
function clearImport(){importText=null;$('backup-preview').hidden=true;$('backup-names').textContent='';$('backup-counts').textContent='';}
function receiveImport(text){
  if(pending){backupMessage('Сначала закройте текущее подтверждение, затем снова откройте файл.',true);return;}
  clearImport();
  try{
    const preview=store.previewImport(text);importText=text;
    $('backup-counts').textContent='Людей: '+preview.profileCount+'. Исключений: '+preview.overrideCount+'. Выплат: '+preview.paymentCount+'.';
    for(const name of preview.names){const li=document.createElement('li');li.textContent=name;$('backup-names').append(li);}
    $('backup-preview').hidden=false;backupMessage('Файл проверен. Пока ничего не изменено.',false);
    $('backup-preview').scrollIntoView({block:'center'});$('backup-cancel').focus();
  }catch(e){backupMessage('Импорт не выполнен: '+e.message+' Текущие данные не изменены.',true);}
}
function initializeFeatures(){
  [commonYear,commonMonth]=todayISO().split('-').map(Number);
  [salaryYear,salaryMonth]=todayISO().split('-').map(Number);
  $('common-prev').onclick=()=>shiftCommon(-1);$('common-next').onclick=()=>shiftCommon(1);
  $('common-month').onchange=()=>{
    try{const value=$('common-month').value;if(!/^\d{4}-\d{2}$/.test(value))throw Error('Выберите месяц.');S.day(value+'-01');[commonYear,commonMonth]=value.split('-').map(Number);renderCommon();}
    catch(e){$('common-days').textContent='';$('common-status').textContent=e.message;}
  };
  function override(type){
    if(!config||pending||dirty())return;
    try{config=store.setOverride(config.id,chosen,type);render();renderCommon();refreshControls();$('override-status').textContent=type===null?'Исключение удалено. День снова по циклу.':'Исключение сохранено. Цикл не изменён.';}
    catch(e){$('override-status').textContent=e.message;}
  }
  $('override-save').onclick=()=>override($('override-type').value);$('override-reset').onclick=()=>override(null);$('extra-shift-toggle').onchange=()=>{try{if(!config||pending||dirty())return;config=store.setExtraShift(config.id,chosen,$('extra-shift-toggle').checked);render();renderCommon();refreshControls();$('override-status').textContent=$('extra-shift-toggle').checked?'\u0414\u043e\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u044c\u043d\u0430\u044f \u0441\u043c\u0435\u043d\u0430 \u0434\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u0430.':'\u0414\u043e\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u044c\u043d\u0430\u044f \u0441\u043c\u0435\u043d\u0430 \u0443\u0431\u0440\u0430\u043d\u0430.';}catch(e){$('override-status').textContent=e.message;render();}};
  $('override-type').onchange=()=>{$('override-status').textContent='Выбранный тип ещё не сохранён. Нажми «Сохранить день».';};
  // This is the entire native contract. Native may only fetch the string and deliver
  // safely JSON-quoted callbacks; no unrestricted JavascriptInterface is used.
  window.BackupUI={
    exportJSON:()=>store.exportJSON(),
    onExportResult:(ok,message)=>backupMessage(message||(ok?'Резервная копия сохранена в файл.':'Экспорт отменён или не выполнен.'),!ok),
    receiveImport,
    onImportError:message=>{clearImport();backupMessage(message||'Импорт отменён. Данные не изменены.',true);}
  };
  const native=()=>navigator.userAgent.includes('ShiftCalendarAndroid');
  $('backup-export').onclick=()=>{
    if(pending)return;
    try{
      const text=window.BackupUI.exportJSON();
      if(native()){backupMessage('Выберите, куда сохранить файл. Несохранённые изменения не экспортируются.',false);location.href='https://appassets.androidplatform.net/backup-export';return;}
      const url=URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'})),a=document.createElement('a');
      a.href=url;a.download='my-schedule-'+todayISO()+'.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
      backupMessage('Файл передан браузеру для сохранения. Проверьте загрузки. Несохранённые изменения не экспортируются.',false);
    }catch(e){backupMessage('Экспорт не выполнен: '+e.message,true);}
  };
  $('backup-import').onclick=()=>{
    if(pending)return;clearImport();backupMessage('',false);
    if(native()){location.href='https://appassets.androidplatform.net/backup-import';return;}
    $('backup-file').value='';$('backup-file').click();
  };
  $('backup-file').onchange=()=>{
    const file=$('backup-file').files[0];if(!file)return;
    if(file.size>Profiles.MAX_BACKUP_BYTES){window.BackupUI.onImportError('Файл больше 2 МиБ. Текущие данные не изменены.');return;}
    const reader=new FileReader();
    reader.onerror=()=>window.BackupUI.onImportError('Не удалось прочитать файл. Текущие данные не изменены.');
    reader.onload=()=>{try{receiveImport(new TextDecoder('utf-8',{fatal:true}).decode(reader.result));}catch(_){window.BackupUI.onImportError('Файл должен быть JSON в кодировке UTF-8. Текущие данные не изменены.');}};
    reader.readAsArrayBuffer(file);
  };
  $('backup-cancel').onclick=()=>{if(pending)return;clearImport();backupMessage('Импорт отменён. Данные не изменены.',false);};
  $('backup-replace').onclick=()=>{
    if(importText===null||pending)return;
    const text=importText;
    ask('ЗАМЕНИТЬ все текущие профили и исключения данными из файла? Несохранённые изменения будут отброшены. Перед заменой будет сохранена резервная копия текущих данных на устройстве.','Заменить все данные',()=>{
      try{store.replaceImport(text);clearImport();commonIds.clear();showProfile(store.getState().activeId);backupMessage('Импорт завершён. Предыдущие данные сохранены отдельно на устройстве.',false);}
      catch(e){backupMessage('Импорт не выполнен: '+e.message+' Текущие данные не изменены.',true);}
    },'backup-replace');
  };
}
initializeFeatures();
initializePremium();
showProfile(store.getState().activeId);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&config&&!$('result').hidden)render();});

// Premium presentation only: the existing store, UTC calendar and backup contract stay authoritative.
function notify(text){$('global-status').textContent=text;$('global-status').hidden=!text;}
function navigate(page){
  currentPage=page;const titles={calendar:'Мой график',people:'Люди',together:'Вместе',salary:'Зарплата',more:'Ещё'};
  for(const name of Object.keys(titles))$('page-'+name).hidden=name!==page;
  $('screen-title').textContent=titles[page];
  for(const button of document.querySelectorAll('[data-page]')){if(button.dataset.page===page)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  if(page==='salary')renderSalary();
  window.scrollTo(0,0);
}
function openSheet(id,focusId){sheetReturn[id]=document.activeElement;$(id).hidden=false;document.body.classList.add('modal-open');if(focusId)$(focusId).focus();}
function hideSheet(id){$(id).hidden=true;const focus=sheetReturn[id];if(focus&&document.contains(focus))focus.focus();syncModal();}
function syncModal(){document.body.classList.toggle('modal-open',Array.from(document.querySelectorAll('.overlay')).some(el=>!el.hidden));}
function topSheet(){return ['confirmation','payment-editor','profile-editor','day-sheet'].map($).find(el=>!el.hidden);}
function closeEditor(){
  const done=()=>{showProfile(store.getState().activeId);hideSheet('profile-editor');};
  if(dirty())ask('Отменить несохранённые изменения профиля? Сохранённый график останется прежним.','Отменить изменения',done,'close-editor');else done();
}
function avatar(p){const el=document.createElement('span');el.className='avatar';el.setAttribute('aria-hidden','true');if(p.avatar){const image=document.createElement('img');image.src=p.avatar;image.alt='';image.onerror=()=>{el.textContent=p.name.slice(0,1).toUpperCase();};el.append(image);}else el.textContent=p.name.slice(0,1).toUpperCase();return el;}
function renderPeople(){
  const state=store.getState();$('profile-chips').textContent='';$('people-cards').textContent='';$('empty-state').hidden=state.profiles.length>0;
  for(const p of state.profiles){
    const chip=document.createElement('button');chip.className='chip'+(state.activeId===p.id?' active':'');chip.dataset.person=p.id;chip.setAttribute('aria-pressed',String(state.activeId===p.id));const name=document.createElement('span');name.textContent=p.name;chip.append(avatar(p),name);
    chip.onclick=()=>guarded(()=>{if(!store.status.blocked)store.select(p.id);showProfile(p.id);},'profile-chips');$('profile-chips').append(chip);
    const card=document.createElement('article');card.className='card person-card';card.dataset.personCard=p.id;
    const row=document.createElement('div');row.className='person-main';const info=document.createElement('div');info.className='person-info';const h=document.createElement('h2');h.textContent=p.name;const detail=document.createElement('p');detail.textContent=p.pattern;info.append(h,detail);
    const edit=document.createElement('button');edit.className='person-edit';edit.textContent='✎ Изменить';edit.setAttribute('aria-label','Изменить профиль '+p.name);edit.disabled=store.status.blocked;edit.onclick=()=>editProfile(p.id);row.append(avatar(p),info,edit);card.append(row);
    const actions=document.createElement('div');actions.className='photo-actions';const photo=document.createElement('button');photo.textContent=p.avatar?'Заменить фото':'Добавить фото';photo.setAttribute('aria-label',photo.textContent+': '+p.name);photo.disabled=store.status.blocked||avatarBusy;photo.onclick=()=>chooseAvatar(p.id);actions.append(photo);
    if(p.avatar){const remove=document.createElement('button');remove.textContent='Убрать фото';remove.disabled=store.status.blocked||avatarBusy;remove.onclick=()=>ask('Удалить аватарку «'+p.name+'»? Сам профиль и график сохранятся.','Убрать фото',()=>{store.setAvatar(p.id,null);showProfile(state.activeId);notify('Аватарка удалена.');},'people-cards');actions.append(remove);}
    card.append(actions);$('people-cards').append(card);
  }
  const plus=document.createElement('button');plus.className='chip';plus.textContent='+';plus.setAttribute('aria-label','Добавить человека');plus.disabled=store.status.blocked;plus.onclick=()=>$('add-profile').click();$('profile-chips').append(plus);
}
function paydayInput(id){const value=$(id).value.trim();if(!value)return null;const day=Number(value);if(!Number.isInteger(day)||day<1||day>31)throw Error('Число выплаты должно быть от 1 до 31.');return day;}
function optionalRate(id){const value=$(id).value.trim().replace(',','.');return value?Money.parseAmount(value):null;}
function shiftSalary(n){let y=salaryYear,m=salaryMonth+n;if(m<1){m=12;y--;}if(m>12){m=1;y++;}if(y<1||y>9999)return;salaryYear=y;salaryMonth=m;renderSalary();}
function renderSalary(){
  if(!$('salary-profile-chips'))return;const state=store.getState(),profiles=state.profiles,box=$('salary-profile-chips');box.textContent='';
  for(const p of profiles){const chip=document.createElement('button');chip.className='chip'+(p.id===state.activeId?' active':'');chip.setAttribute('aria-pressed',String(p.id===state.activeId));chip.append(avatar(p),document.createTextNode(p.name));chip.onclick=()=>{if(!store.status.blocked)store.select(p.id);showProfile(p.id);navigate('salary');};box.append(chip);}
  const profile=profiles.find(p=>p.id===state.activeId);$('salary-empty').hidden=!!profile;$('salary-content').hidden=!profile;if(!profile)return;
  const money=profile.money||{salaryDay:null,advanceDay:null,payments:[]},payments=Money.monthPayments(profile,salaryYear,salaryMonth);
  $('salary-title').textContent=pretty(S.iso(salaryYear,salaryMonth,1),{month:'long',year:'numeric'});$('salary-prev').disabled=salaryYear===1&&salaryMonth===1;$('salary-next').disabled=salaryYear===9999&&salaryMonth===12;
  $('salary-total').textContent=Money.formatAmount(Money.monthTotal(profile,salaryYear,salaryMonth));const forecast=Money.monthForecast(profile,salaryYear,salaryMonth);const byType={};for(const item of payments)byType[item.type]=(byType[item.type]||0)+item.amountKopecks;
  $('salary-breakdown').textContent=(payments.length?Object.entries(byType).map(([type,total])=>Money.labels[type]+': '+Money.formatAmount(total)).join(' · '):'В этом месяце выплат пока нет.')+(forecast?' · Прогноз по сменам: '+Money.formatAmount(forecast):'');
  const nearest=Money.nextPayday(money,todayISO());$('nearest-payday').textContent=nearest?'Ближайшая плановая выплата: '+Money.labels[nearest.type].toLowerCase()+' — '+pretty(nearest.date,{day:'numeric',month:'long'}):'Укажи плановые дни зарплаты и аванса ниже.';
  $('salary-day').value=money.salaryDay===null?'':money.salaryDay;$('advance-day').value=money.advanceDay===null?'':money.advanceDay;const shiftRateField=$('shift-rate');if(shiftRateField)shiftRateField.value=money.shiftRateKopecks?String(money.shiftRateKopecks/100):'';const rates=money.shiftRatesKopecks||{};for(const key of ['work','daily','night','full','extra']){const rateField=$('rate-'+key);if(rateField)rateField.value=Number.isSafeInteger(rates[key])?String(rates[key]/100):'';}
  renderPayWindows(money);
  const list=$('payment-list');list.textContent='';for(const item of payments){const card=document.createElement('button');card.className='card payment-card';card.dataset.payment=item.id;card.setAttribute('aria-label','Изменить выплату: '+Money.labels[item.type]+' '+Money.formatAmount(item.amountKopecks));const info=document.createElement('span'),type=document.createElement('strong'),date=document.createElement('small'),amount=document.createElement('b');type.textContent=Money.labels[item.type];date.textContent=pretty(item.date,{day:'numeric',month:'long'})+(item.note?' · '+item.note:'');amount.textContent=Money.formatAmount(item.amountKopecks);info.append(type,date);card.append(info,amount);card.onclick=()=>openPayment(item.id,item.date);list.append(card);}
  $('add-payment').disabled=store.status.blocked;$('save-paydays').disabled=store.status.blocked;
}
function renderDayPayments(){
  if(!$('day-payments'))return;const box=$('day-payments');box.textContent='';if(!config)return;const payments=((config.money&&config.money.payments)||[]).filter(item=>item.date===chosen);
  for(const item of payments){const button=document.createElement('button');button.className='day-payment';button.textContent=Money.labels[item.type]+': '+Money.formatAmount(item.amountKopecks);button.onclick=()=>openPayment(item.id,item.date);box.append(button);}
  $('add-payment-day').disabled=store.status.blocked;
}
function openPayment(id,date){
  if(!config)return;editingPaymentId=id;const payment=id&&config.money?config.money.payments.find(item=>item.id===id):null;$('payment-title').textContent=payment?'Изменить выплату':'Новая выплата';$('payment-date').value=payment?payment.date:(date||todayISO());$('payment-amount').value=payment?(payment.amountKopecks/100).toFixed(payment.amountKopecks%100?2:0):'';$('payment-type').value=payment?payment.type:'salary';$('payment-note').value=payment?payment.note:'';$('delete-payment').hidden=!payment;$('payment-error').hidden=true;$('payment-error').textContent='';openSheet('payment-editor');
}
function closePayment(){editingPaymentId=null;hideSheet('payment-editor');}
function editProfile(id){guarded(()=>{if(!store.status.blocked)store.select(id);showProfile(id);openSheet('profile-editor','profile-name');},'people-cards');}
function previewPattern(){
  if(!$('pattern-preview'))return;
  try{const cycle=S.parse($('pattern').value),groups=[];for(const type of cycle){const last=groups[groups.length-1];if(last&&last.type===type)last.n++;else groups.push({type,n:1});}
    $('pattern-preview').textContent=groups.slice(0,12).map(g=>g.n+' × '+S.names[g.type].toLowerCase()).join(' → ')+(groups.length>12?' → …':'')+'. Повтор: '+cycle.length+' дн.';
  }catch(e){$('pattern-preview').textContent=$('pattern').value?e.message:'Выбери шаблон или введи свой цикл.';}
}
function renderSharedGrid(dates){
  if(!$('common-grid'))return;const grid=$('common-grid');grid.textContent='';const first=S.iso(commonYear,commonMonth,1),pad=(new Date(S.day(first)*86400000).getUTCDay()+6)%7,set=new Set(dates);
  for(let i=0;i<pad;i++)grid.append(document.createElement('span'));
  for(const d of S.month(['В'],first,commonYear,commonMonth)){const cell=document.createElement('span');cell.className='common-day'+(set.has(d.date)?' shared':'');cell.textContent=Number(d.date.slice(-2));cell.dataset.date=d.date;cell.setAttribute('aria-label',pretty(d.date,{day:'numeric',month:'long'})+(set.has(d.date)?' — общий выходной':''));grid.append(cell);}
  const next=dates.find(d=>d>=todayISO());$('nearest-common').textContent=next?'Ближайший общий выходной в этом месяце: '+pretty(next,{day:'numeric',month:'long'}):dates.length?'В выбранном месяце будущих общих выходных нет.':'';
}
function chooseAvatar(id){
  if(avatarBusy||pending)return;avatarTarget=id;avatarBusy=true;renderPeople();notify('Выбери фотографию. Она будет обрезана по центру и уменьшена до аватарки.');
  if(navigator.userAgent.includes('ShiftCalendarAndroid')){location.href='https://appassets.androidplatform.net/avatar-import';return;}
  $('avatar-file').value='';$('avatar-file').click();
}
function avatarDone(){avatarBusy=false;avatarTarget=null;renderPeople();}
function initializePremium(){
  for(const b of document.querySelectorAll('[data-page]'))b.onclick=()=>{if(!topSheet())navigate(b.dataset.page);};
  $('open-more').onclick=()=>navigate('more');$('empty-add').onclick=()=>$('add-profile').click();$('edit-active').onclick=()=>{if(config)editProfile(config.id);};
  $('close-editor').onclick=closeEditor;$('close-day').onclick=()=>hideSheet('day-sheet');
  $('close-payment').onclick=closePayment;$('salary-prev').onclick=()=>shiftSalary(-1);$('salary-next').onclick=()=>shiftSalary(1);$('add-payment').onclick=()=>openPayment(null,todayISO());$('add-payment-day').onclick=()=>openPayment(null,chosen);
  $('save-paydays').onclick=()=>{try{if(!config)throw Error('Сначала выбери человека.');config=store.setPaydays(config.id,paydayInput('salary-day'),paydayInput('advance-day'));const field=$('shift-rate'),raw=field?field.value.trim().replace(',','.'):'',rate=raw?Money.parseAmount(raw):0;config=store.setShiftRate(config.id,rate);$('paydays-status').textContent='Плановые дни выплат и ставка сохранены.';renderSalary();render();}catch(e){$('paydays-status').textContent=e.message;}};
  $('save-rates').onclick=()=>{try{if(!config)throw Error('\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0432\u044b\u0431\u0435\u0440\u0438 \u0447\u0435\u043b\u043e\u0432\u0435\u043a\u0430.');const rates={};for(const key of ['work','daily','night','full','extra']){const value=optionalRate('rate-'+key);if(value!==null)rates[key]=value;}config=store.setShiftRates(config.id,rates);$('paydays-status').textContent='\u0421\u0442\u0430\u0432\u043a\u0438 \u043f\u043e \u0442\u0438\u043f\u0430\u043c \u0441\u043c\u0435\u043d \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u044b.';renderSalary();render();}catch(e){$('paydays-status').textContent=e.message;}};
  $('add-pay-window').onclick=()=>addPayWindowRow({type:'salary',from:1,to:10});
  $('save-pay-windows').onclick=()=>{try{const rows=Array.from($('pay-windows').children).map(row=>({type:row.querySelector('select').value,from:Number(row.querySelector('[data-from]').value),to:Number(row.querySelector('[data-to]').value)}));config=store.setPayWindows(config.id,rows);renderSalary();$('paydays-status').textContent='Периоды выплат сохранены.';}catch(e){$('paydays-status').textContent=e.message;}};
  $('payment-form').onsubmit=e=>{e.preventDefault();try{if(!config)throw Error('Сначала выбери человека.');const payment=store.savePayment(config.id,editingPaymentId,{date:$('payment-date').value,amountKopecks:Money.parseAmount($('payment-amount').value),type:$('payment-type').value,note:$('payment-note').value});salaryYear=Number(payment.date.slice(0,4));salaryMonth=Number(payment.date.slice(5,7));config=store.getState().profiles.find(p=>p.id===config.id);closePayment();render();renderSalary();notify('Выплата сохранена на устройстве.');}catch(e){$('payment-error').textContent=e.message;$('payment-error').hidden=false;}};
  $('delete-payment').onclick=()=>{if(!config||!editingPaymentId)return;const id=editingPaymentId;ask('Удалить эту выплату? Это действие нельзя отменить.','Удалить выплату',()=>{config=store.removePayment(config.id,id);closePayment();render();renderSalary();notify('Выплата удалена.');},'delete-payment');};
  $('template-select').onchange=()=>{if($('template-select').value){$('pattern').value=$('template-select').value;markDraft();}};
  $('pattern').addEventListener('input',()=>{$('template-select').value=$('pattern').value;});
  let theme='dark';try{if(localStorage.getItem('shift-calendar-theme')==='light')theme='light';}catch(_){}
  document.body.classList.toggle('light',theme==='light');$('theme-select').value=theme;
  $('theme-select').onchange=()=>{document.body.classList.toggle('light',$('theme-select').value==='light');if(navigator.userAgent.includes('ShiftCalendarAndroid'))location.href='https://appassets.androidplatform.net/theme-'+$('theme-select').value;try{localStorage.setItem('shift-calendar-theme',$('theme-select').value);}catch(_){notify('Тема изменена, но не сохранена: нет доступа к хранилищу.');}};
  const observer=new MutationObserver(syncModal);for(const el of document.querySelectorAll('.overlay')){observer.observe(el,{attributes:true,attributeFilter:['hidden']});el.addEventListener('click',e=>{if(e.target===el)window.PremiumUI.handleBack();});}
  document.addEventListener('keydown',e=>{
    const modal=topSheet();if(!modal)return;
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();window.PremiumUI.handleBack();}
    if(e.key==='Tab'){const controls=Array.from(modal.querySelectorAll('button,input,select,summary,a')).filter(el=>!el.disabled&&el.getClientRects().length);const first=controls[0],last=controls[controls.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
  },true);
  window.PremiumUI={handleBack:()=>{if(pending){$('confirm-cancel').click();return true;}if(!$('payment-editor').hidden){closePayment();return true;}if(!$('profile-editor').hidden){closeEditor();return true;}if(!$('day-sheet').hidden){hideSheet('day-sheet');return true;}if(currentPage!=='calendar'){navigate('calendar');return true;}return false;}};
  window.AvatarUI={receiveImage:data=>{const id=avatarTarget;try{if(!id)throw Error('Выбери человека и фотографию заново.');if(pending)throw Error('Сначала закрой подтверждение и выбери фото снова.');store.setAvatar(id,data);showProfile(store.getState().activeId);notify('Аватарка сохранена на устройстве.');}catch(e){notify('Фото не сохранено: '+e.message);}finally{avatarDone();}},onError:message=>{notify(message||'Выбор фото отменён.');avatarDone();}};
  $('avatar-file').addEventListener('cancel',()=>window.AvatarUI.onError('Выбор фото отменён.'));
  $('avatar-file').onchange=()=>{
    const file=$('avatar-file').files[0];if(!file){window.AvatarUI.onError('Выбор фото отменён.');return;}
    if(file.size>10*1024*1024||!['image/jpeg','image/png','image/webp'].includes(file.type)){window.AvatarUI.onError('Выбери JPEG, PNG или WebP до 10 МиБ.');return;}
    const reader=new FileReader();reader.onerror=()=>window.AvatarUI.onError('Не удалось прочитать фото.');reader.onload=()=>{const image=new Image();image.onerror=()=>window.AvatarUI.onError('Не удалось открыть изображение.');image.onload=()=>{try{if(!image.width||!image.height||image.width*image.height>80000000)throw Error('Слишком большое изображение.');const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;const c=canvas.getContext('2d');c.fillStyle='#e4e9e3';c.fillRect(0,0,256,256);const size=Math.min(image.width,image.height);c.drawImage(image,(image.width-size)/2,(image.height-size)/2,size,size,0,0,256,256);window.AvatarUI.receiveImage(canvas.toDataURL('image/jpeg',.8));}catch(e){window.AvatarUI.onError(e.message);}};image.src=reader.result;};reader.readAsDataURL(file);
  };
}

function renderPayWindows(money){
  $('pay-windows').textContent='';
  for(const w of money.payWindows||[])addPayWindowRow(w);
}
function addPayWindowRow(w){
  const row=document.createElement('fieldset');row.className='pay-window';
  const legend=document.createElement('legend');legend.textContent='Период выплаты';row.append(legend);
  const select=document.createElement('select');select.setAttribute('aria-label','Вид плановой выплаты');
  for(const type of ['salary','advance','bonus']){const option=document.createElement('option');option.value=type;option.textContent=Money.labels[type];select.append(option);}select.value=w.type;row.append(select);
  for(const [key,title] of [['from','С какого числа'],['to','По какое число']]){const label=document.createElement('label');label.textContent=title;const input=document.createElement('input');input.type='number';input.min=1;input.max=31;input.inputMode='numeric';input.value=w[key];input.dataset[key]='';label.append(input);row.append(label);}
  const remove=document.createElement('button');remove.type='button';remove.className='secondary wide';remove.textContent='Удалить период';remove.onclick=()=>row.remove();row.append(remove);$('pay-windows').append(row);
}
