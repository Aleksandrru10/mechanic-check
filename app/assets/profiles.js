/* Transactional v3 state. Legacy raw keys are never changed by migration.
 * Damaged/future data is read-only until explicit, backed-up recovery.
 * Imports validate every record before preview and again before replacement. */
(function(root){
'use strict';
const S=typeof module!=='undefined'&&module.exports?require('./schedule.js'):root.Schedule;
const KEY='shift-calendar-v3',V2_KEY='shift-calendar-v2',LEGACY_KEY='shift-calendar-v1',BACKUP_PREFIX='shift-calendar-recovery-',PREIMPORT_PREFIX='shift-calendar-pre-import-';
const APPLICATION_ID='ru.sash.shiftcalendar',BACKUP_SCHEMA=1,MAX_BACKUP_BYTES=2*1024*1024;
const PAYMENT_TYPES=['salary','advance','bonus','vacation','sick'];
function copy(value){return JSON.parse(JSON.stringify(value));}
function empty(){return {version:3,profiles:[],activeId:null};}
function object(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function fields(value,keys){if(!object(value)||Object.keys(value).length!==keys.length||!keys.every(k=>Object.prototype.hasOwnProperty.call(value,k)))throw Error('Неверные поля данных.');}
function validateName(name){
  if(typeof name!=='string'||!name.trim()||name.trim().length>60||/[\u0000-\u001f\u007f]/.test(name))throw Error('Введите имя от 1 до 60 символов без управляющих знаков.');
  return name.trim();
}
function validateSchedule(p){
  if(!object(p)||typeof p.pattern!=='string'||typeof p.anchor!=='string')throw Error('Неверный формат графика.');
  S.parse(p.pattern);S.day(p.anchor);
}
function validId(id){return typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);}
function validateOverrides(overrides){
  if(!object(overrides))throw Error('Неверный формат исключений.');
  for(const [date,type] of Object.entries(overrides)){
    S.day(date);if(typeof type!=='string'||!Object.prototype.hasOwnProperty.call(S.names,type))throw Error('Неверный тип исключения: '+date+'.');
  }
  return copy(overrides);
}
function validateExtraShifts(extraShifts){
  if(!object(extraShifts))throw Error('Неверный формат дополнительных смен.');
  for(const [date,value] of Object.entries(extraShifts)){
    S.day(date);if(value!==true)throw Error('Неверная дополнительная смена: '+date+'.');
  }
  return copy(extraShifts);
}
function validateAvatar(value){
  if(typeof value!=='string'||value.length>100000||!/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value)||value.slice(23).length%4!==0)throw Error('Неверная или слишком большая аватарка. Выберите фото заново.');
  return value;
}
function validatePayday(value){if(value!==null&&(!Number.isInteger(value)||value<1||value>31))throw Error('День выплаты должен быть от 1 до 31.');return value;}
function validateShiftRates(value){
  if(!object(value))throw Error('Неверный формат ставок смен.');
  const allowed=['work','daily','night','full','extra'];if(Object.keys(value).some(k=>!allowed.includes(k)))throw Error('Неверный тип ставки смены.');
  const result={};for(const key of allowed)if(Object.prototype.hasOwnProperty.call(value,key)){const rate=value[key];if(!Number.isSafeInteger(rate)||rate<0||rate>1000000000000)throw Error('Неверная ставка смены.');result[key]=rate;}
  return result;
}
function validatePayment(value){
  fields(value,['id','date','amountKopecks','type','note']);
  if(!validId(value.id))throw Error('Неверный ID выплаты.');S.day(value.date);
  if(!Number.isSafeInteger(value.amountKopecks)||value.amountKopecks<1||value.amountKopecks>1000000000000)throw Error('Сумма выплаты должна быть от 0,01 до 10 миллиардов рублей.');
  if(!PAYMENT_TYPES.includes(value.type))throw Error('Неверный вид выплаты.');
  if(typeof value.note!=='string'||value.note.length>120||/[\u0000-\u001f\u007f]/.test(value.note))throw Error('Комментарий должен быть не длиннее 120 символов без управляющих знаков.');
  return {id:value.id,date:value.date,amountKopecks:value.amountKopecks,type:value.type,note:value.note.trim()};
}
function validateMoney(value){
  if(!object(value)||Object.keys(value).some(k=>!['salaryDay','advanceDay','payments','shiftRateKopecks','shiftRatesKopecks','payWindows'].includes(k))||Object.keys(value).length<3)throw Error('Неверный формат выплат.');
  validatePayday(value.salaryDay);validatePayday(value.advanceDay);
  const shiftRate=Object.prototype.hasOwnProperty.call(value,'shiftRateKopecks')?value.shiftRateKopecks:0;
  if(!Number.isSafeInteger(shiftRate)||shiftRate<0||shiftRate>1000000000000)throw Error('Неверная ставка за смену.');
  if(!Array.isArray(value.payments))throw Error('Неверный формат выплат.');const ids=new Set(),payments=value.payments.map(item=>{const payment=validatePayment(item);if(ids.has(payment.id))throw Error('Повторяющийся ID выплаты.');ids.add(payment.id);return payment;});
  const result={salaryDay:value.salaryDay,advanceDay:value.advanceDay,payments};if(shiftRate)result.shiftRateKopecks=shiftRate;if(value.shiftRatesKopecks!==undefined){const rates=validateShiftRates(value.shiftRatesKopecks);if(Object.keys(rates).length)result.shiftRatesKopecks=rates;}if(value.payWindows!==undefined){if(!Array.isArray(value.payWindows)||value.payWindows.length>24)throw Error('Неверные периоды выплат.');result.payWindows=value.payWindows.map(w=>{if(!object(w)||!['salary','advance','bonus'].includes(w.type)||!Number.isInteger(w.from)||!Number.isInteger(w.to)||w.from<1||w.to>31||w.from>w.to)throw Error('Неверный диапазон выплаты.');return {type:w.type,from:w.from,to:w.to};});}return result;
}
function validateProfile(p,version){
  fields(p,version===2?['id','name','pattern','anchor']:['id','name','pattern','anchor','overrides'].concat(Object.prototype.hasOwnProperty.call(p,'extraShifts')?['extraShifts']:[]).concat(Object.prototype.hasOwnProperty.call(p,'avatar')?['avatar']:[]).concat(Object.prototype.hasOwnProperty.call(p,'money')?['money']:[]));
  if(version!==2&&Object.prototype.hasOwnProperty.call(p,'avatar'))validateAvatar(p.avatar);
  if(version!==2&&Object.prototype.hasOwnProperty.call(p,'extraShifts'))validateExtraShifts(p.extraShifts);
  if(version!==2&&Object.prototype.hasOwnProperty.call(p,'money'))validateMoney(p.money);
  validateSchedule(p);
  if(!validId(p.id))throw Error('Неверный ID человека.');
  if(validateName(p.name)!==p.name)throw Error('Имя содержит пробелы по краям.');
  const result={id:p.id,name:p.name,pattern:p.pattern,anchor:p.anchor,overrides:version===2?{}:validateOverrides(p.overrides)};
  if(version!==2&&Object.prototype.hasOwnProperty.call(p,'extraShifts')){const extra=validateExtraShifts(p.extraShifts);if(Object.keys(extra).length)result.extraShifts=extra;}
  if(version!==2&&p.avatar)result.avatar=p.avatar;if(version!==2&&Object.prototype.hasOwnProperty.call(p,'money'))result.money=validateMoney(p.money);return result;
}
function validateState(value,version=3){
  fields(value,['version','profiles','activeId']);
  if(value.version!==version||!Array.isArray(value.profiles))throw Error('Неизвестная версия или формат данных.');
  const ids=new Set(),names=new Set(),profiles=value.profiles.map(p=>{
    const q=validateProfile(p,version),name=q.name.toLowerCase();
    if(ids.has(q.id)||names.has(name))throw Error('Повторяющийся ID или имя человека.');ids.add(q.id);names.add(name);return q;
  });
  if(profiles.length?!ids.has(value.activeId):value.activeId!==null)throw Error('Неверный активный профиль.');
  return {version:3,profiles,activeId:value.activeId};
}
function envelope(state){return {applicationId:APPLICATION_ID,schema:BACKUP_SCHEMA,state};}
function bounded(text){
  if(typeof text!=='string')throw Error('Резервная копия должна быть текстом JSON.');
  if(text.length>MAX_BACKUP_BYTES||new TextEncoder().encode(text).length>MAX_BACKUP_BYTES)throw Error('Файл больше 2 МиБ. Выберите меньшую резервную копию.');
  return text;
}
function parseJSON(text){
  let value;
  try{value=JSON.parse(text);}catch(_){throw Error('Файл не является корректным JSON.');}
  // JSON.parse keeps only the last duplicate member. Reject ambiguity before
  // accepting state, especially two exceptions for the same (possibly escaped) date.
  // Syntax is already validated; this iterative scan only tracks object keys.
  const tokens=/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]]/g,stack=[];let match;
  while((match=tokens.exec(text))!==null){
    const token=match[0];
    if(token==='{')stack.push(new Set());
    else if(token==='[')stack.push(null);
    else if(token==='}'||token===']')stack.pop();
    else{
      let end=tokens.lastIndex;while(/\s/.test(text.charAt(end))&&end<text.length)end++;
      if(text.charAt(end)===':'){
        const key=JSON.parse(token),keys=stack[stack.length-1];
        if(keys.has(key))throw Error('JSON содержит повторяющееся поле: '+key+'.');
        keys.add(key);
      }
    }
  }
  return value;
}
function parseBackup(text){
  bounded(text);const value=parseJSON(text);
  fields(value,['applicationId','schema','state']);
  if(value.applicationId!==APPLICATION_ID||value.schema!==BACKUP_SCHEMA)throw Error('Это не поддерживаемая резервная копия «Мой график».');
  return validateState(value.state);
}
function randomId(){
  if(root.crypto&&root.crypto.getRandomValues){const parts=new Uint32Array(4);root.crypto.getRandomValues(parts);return 'p-'+Array.from(parts,n=>n.toString(16)).join('-');}
  return 'p-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2);
}
function createStore(options){
  const storage=options.storage,generateId=options.id||randomId;
  let state=empty(),sourceRaw=null,sourceKey=null;
  const status={message:'',blocked:false,recovery:false};
  function uniqueId(){for(let i=0;i<100;i++){const id=generateId();if(validId(id)&&!state.profiles.some(p=>p.id===id))return id;}throw Error('Не удалось создать уникальный ID. Повторите попытку.');}
  function persist(next){try{storage.setItem(KEY,JSON.stringify(next));}catch(_){throw Error('Не удалось сохранить на устройстве. Изменения не сохранены; повторите попытку.');}}
  function ready(){if(status.blocked)throw Error('Сначала восстановите данные или повторите запуск. Исходные данные не изменены.');}
  function commit(next){ready();persist(next);state=next;status.message='';return copy(state);}
  function backup(prefix,raw){
    for(let i=0;i<100;i++){const key=prefix+generateId()+'-'+i;if(storage.getItem(key)===null){storage.setItem(key,raw);return key;}}
    throw Error('Нет свободного имени резервной копии.');
  }
  function damage(total){
    status.blocked=true;status.recovery=true;
    status.message='Сохранённые данные повреждены или имеют неизвестный формат. Доступно профилей: '+state.profiles.length+' из '+total+'. Исходные данные не изменены. Можно просматривать доступные графики. Для дальнейшего сохранения нажмите «Восстановить»: сначала будет создана резервная копия исходных данных.';
  }
  function load(){
    let raw=null;
    try{for(const key of [KEY,V2_KEY,LEGACY_KEY]){raw=storage.getItem(key);if(raw!==null){sourceKey=key;break;}}}catch(_){status.blocked=true;status.message='Не удалось прочитать данные устройства. Сохранение заблокировано, чтобы не затереть прежние графики. Закройте и откройте приложение для повторной попытки.';return;}
    if(raw===null)return;sourceRaw=raw;
    let parsed;try{parsed=parseJSON(raw);}catch(_){damage(0);return;}
    if(sourceKey===LEGACY_KEY){
      try{validateSchedule(parsed);const migrated={id:uniqueId(),name:'Я',pattern:parsed.pattern,anchor:parsed.anchor,overrides:{}};state={version:3,profiles:[migrated],activeId:migrated.id};}catch(_){damage(0);return;}
    }else{
      const version=sourceKey===V2_KEY?2:3;
      try{state=validateState(parsed,version);}catch(_){
        const records=parsed&&Array.isArray(parsed.profiles)?parsed.profiles:[];
        for(const p of records){try{const q=validateProfile(p,version);if(state.profiles.some(x=>x.id===q.id||x.name.toLowerCase()===q.name.toLowerCase()))continue;state.profiles.push(q);}catch(_){/* Raw record retained for explicit recovery. */}}
        state.activeId=state.profiles.some(p=>p.id===parsed.activeId)?parsed.activeId:((state.profiles.length?state.profiles[0].id:null));damage(records.length);return;
      }
    }
    if(sourceKey===KEY)return;
    try{persist(state);status.message=sourceKey===LEGACY_KEY?'Прежний график перенесён в профиль «Я». Резервная копия сохранена.':'Профили перенесены в версию 1.2. Исходные данные v2 сохранены на устройстве.';}
    catch(e){status.message=e.message+' Прежние графики показаны, исходная копия сохранена. Нажмите «Показать календарь» для повторного сохранения.';}
  }
  load();
  return {
    status,getState:()=>copy(state),
    save(id,draft){
      ready();const name=validateName(draft&&draft.name);validateSchedule(draft);
      const old=state.profiles.find(p=>p.id===id);
      if(id!==null&&!old)throw Error('Профиль не найден.');
      if(state.profiles.some(p=>p.id!==id&&p.name.toLowerCase()===name.toLowerCase()))throw Error('Такое имя уже есть. Выберите другое имя.');
      const p={id:id===null?uniqueId():id,name,pattern:draft.pattern.trim(),anchor:draft.anchor,overrides:old?copy(old.overrides):{}},next=copy(state);
      if(old&&old.extraShifts)p.extraShifts=copy(old.extraShifts);
      if(old&&old.avatar)p.avatar=old.avatar;
      if(old&&old.money)p.money=copy(old.money);
      if(id===null)next.profiles.push(p);else next.profiles[next.profiles.findIndex(q=>q.id===id)]=p;
      next.activeId=p.id;commit(next);return copy(p);
    },
    select(id){ready();if(!state.profiles.some(p=>p.id===id))throw Error('Профиль не найден.');const next=copy(state);next.activeId=id;return commit(next);},
    remove(id){
      ready();if(!state.profiles.some(p=>p.id===id))throw Error('Профиль не найден.');
      const next=copy(state);next.profiles=next.profiles.filter(p=>p.id!==id);if(next.activeId===id)next.activeId=(next.profiles.length?next.profiles[0].id:null);return commit(next);
    },
    setOverride(id,date,type){
      ready();if(typeof date!=='string')throw Error('Неверная дата.');S.day(date);
      if(type!==null&&(typeof type!=='string'||!Object.prototype.hasOwnProperty.call(S.names,type)))throw Error('Выберите тип дня.');
      const next=copy(state),p=next.profiles.find(p=>p.id===id);if(!p)throw Error('Профиль не найден.');
      if(type===null)delete p.overrides[date];else {p.overrides[date]=type;if(p.extraShifts)delete p.extraShifts[date];}
      commit(next);return copy(p);
    },
    setExtraShift(id,date,enabled){
      ready();if(typeof date!=='string')throw Error('Неверная дата.');S.day(date);if(typeof enabled!=='boolean')throw Error('Неверное состояние дополнительной смены.');
      const next=copy(state),p=next.profiles.find(p=>p.id===id);if(!p)throw Error('Профиль не найден.');
      if(enabled){if(!p.extraShifts)p.extraShifts={};p.extraShifts[date]=true;delete p.overrides[date];}
      else if(p.extraShifts){delete p.extraShifts[date];if(!Object.keys(p.extraShifts).length)delete p.extraShifts;}
      commit(next);return copy(p);
    },
    setAvatar(id,value){ready();const next=copy(state),p=next.profiles.find(p=>p.id===id);if(!p)throw Error('Профиль не найден.');if(value===null)delete p.avatar;else p.avatar=validateAvatar(value);commit(next);return copy(p);},
    setPaydays(id,salaryDay,advanceDay){
      ready();validatePayday(salaryDay);validatePayday(advanceDay);const next=copy(state),p=next.profiles.find(p=>p.id===id);if(!p)throw Error('Профиль не найден.');
      const savedWindows=p.money&&p.money.payWindows,savedRates=p.money&&p.money.shiftRatesKopecks;const payments=p.money?copy(p.money.payments):[];const shiftRateKopecks=p.money&&p.money.shiftRateKopecks||0;if(salaryDay===null&&advanceDay===null&&!payments.length&&!shiftRateKopecks&&!savedWindows&&!savedRates)delete p.money;else {p.money={salaryDay,advanceDay,payments};if(shiftRateKopecks)p.money.shiftRateKopecks=shiftRateKopecks;if(savedRates)p.money.shiftRatesKopecks=copy(savedRates);if(savedWindows)p.money.payWindows=copy(savedWindows);}commit(next);return copy(p);
    },
    setShiftRate(id,shiftRateKopecks){
      ready();if(!Number.isSafeInteger(shiftRateKopecks)||shiftRateKopecks<0||shiftRateKopecks>1000000000000)throw Error('Неверная ставка за смену.');const next=copy(state),p=next.profiles.find(p=>p.id===id);if(!p)throw Error('Профиль не найден.');const money=p.money||{salaryDay:null,advanceDay:null,payments:[],shiftRateKopecks:0};money.shiftRateKopecks=shiftRateKopecks;p.money=money;commit(next);return copy(p);
    },
    setShiftRates(id,shiftRatesKopecks){
      ready();const rates=validateShiftRates(shiftRatesKopecks);const next=copy(state),p=next.profiles.find(p=>p.id===id);if(!p)throw Error('Профиль не найден.');const money=p.money||{salaryDay:null,advanceDay:null,payments:[]};if(Object.keys(rates).length)money.shiftRatesKopecks=rates;else delete money.shiftRatesKopecks;p.money=money;commit(next);return copy(p);
    },
    setPayWindows(id,payWindows){
      ready();if(!Array.isArray(payWindows)||payWindows.length>24)throw Error('Неверные периоды выплат.');const next=copy(state),p=next.profiles.find(p=>p.id===id);if(!p)throw Error('Профиль не найден.');const money=p.money||{salaryDay:null,advanceDay:null,payments:[]};money.payWindows=payWindows.map(w=>{if(!object(w)||!['salary','advance','bonus'].includes(w.type)||!Number.isInteger(w.from)||!Number.isInteger(w.to)||w.from<1||w.to>31||w.from>w.to)throw Error('Неверный диапазон выплаты.');return {type:w.type,from:w.from,to:w.to};});p.money=money;commit(next);return copy(p);
    },
    savePayment(id,paymentId,draft){
      ready();const next=copy(state),p=next.profiles.find(p=>p.id===id);if(!p)throw Error('Профиль не найден.');const money=p.money||{salaryDay:null,advanceDay:null,payments:[]};let nextId=paymentId;
      if(paymentId===null){for(let i=0;i<100;i++){const candidate=generateId();if(validId(candidate)&&!money.payments.some(item=>item.id===candidate)){nextId=candidate;break;}}if(nextId===null)throw Error('Не удалось создать выплату. Повторите попытку.');}
      else if(!money.payments.some(item=>item.id===paymentId))throw Error('Выплата не найдена.');
      const payment=validatePayment({id:nextId,date:draft&&draft.date,amountKopecks:draft&&draft.amountKopecks,type:draft&&draft.type,note:draft&&draft.note}),index=money.payments.findIndex(item=>item.id===nextId);
      if(index<0)money.payments.push(payment);else money.payments[index]=payment;money.payments.sort((a,b)=>a.date===b.date?a.id.localeCompare(b.id):a.date.localeCompare(b.date));p.money=money;commit(next);return copy(payment);
    },
    removePayment(id,paymentId){
      ready();const next=copy(state),p=next.profiles.find(p=>p.id===id);if(!p||!p.money||!p.money.payments.some(item=>item.id===paymentId))throw Error('Выплата не найдена.');
      p.money.payments=p.money.payments.filter(item=>item.id!==paymentId);if(p.money.salaryDay===null&&p.money.advanceDay===null&&!p.money.payments.length&&!p.money.shiftRateKopecks&&!p.money.shiftRatesKopecks&&!p.money.payWindows)delete p.money;commit(next);return copy(p);
    },
    exportJSON(){ready();return bounded(JSON.stringify(envelope(validateState(state)),null,2));},
    previewImport(text){
      ready();const next=parseBackup(text);
      return {profileCount:next.profiles.length,overrideCount:next.profiles.reduce((sum,p)=>sum+Object.keys(p.overrides).length,0),paymentCount:next.profiles.reduce((sum,p)=>sum+(p.money?p.money.payments.length:0),0),names:next.profiles.map(p=>p.name)};
    },
    replaceImport(text){
      ready();const next=parseBackup(text);
      // The pre-import snapshot must be durable before the single primary write.
      // A failed primary write may leave an extra backup but NEVER changes memory.
      try{backup(PREIMPORT_PREFIX,JSON.stringify(envelope(state)));}catch(_){throw Error('Не удалось сохранить резервную копию перед импортом. Текущие данные не изменены. Освободите место и повторите.');}
      commit(next);status.message='Резервная копия импортирована. Предыдущие данные сохранены отдельно на устройстве.';return copy(state);
    },
    recover(){
      if(!status.recovery)throw Error('Восстановление недоступно.');
      try{backup(BACKUP_PREFIX+sourceKey+'-',sourceRaw);persist(state);}catch(_){throw Error('Не удалось сохранить резервную копию и восстановленные данные. Исходные данные не изменены; повторите попытку.');}
      status.blocked=false;status.recovery=false;status.message='Доступные профили восстановлены. Исходные данные сохранены отдельной резервной копией на устройстве.';return copy(state);
    }
  };
}
const api={KEY,V2_KEY,LEGACY_KEY,BACKUP_PREFIX,PREIMPORT_PREFIX,APPLICATION_ID,BACKUP_SCHEMA,MAX_BACKUP_BYTES,PAYMENT_TYPES,validateState,parseBackup,createStore};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Profiles=api;
})(typeof globalThis!=='undefined'?globalThis:this);
