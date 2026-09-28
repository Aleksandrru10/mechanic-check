/* Pure calendar arithmetic: integer UTC days, independent of DST and device timezone. */
(function(root){
'use strict';
const MAX=3660;
const names={'Р':'Рабочий день','Д':'Дневная смена','Н':'Ночная смена','В':'Выходной','С':'Суточная смена','О':'Отпуск','Б':'Больничный'};
function parse(raw){
  const s=String(raw).trim().toUpperCase();
  if(!s || s.length>16000)throw Error('Введите график: например, 2/2 или Д Н В В.');
  let out=[];
  function add(t,n){if(!Number.isSafeInteger(n)||n<1||out.length+n>MAX)throw Error('Каждый блок — от 1 дня, весь цикл — не более 3660 дней.');for(let i=0;i<n;i++)out.push(t);}
  if(s.includes('/')){
    if(!/^\d+(?:\s*\/\s*\d+)+$/.test(s))throw Error('Числовой график пишется так: 2/2, 5/2 или 2/1/3/2.');
    let ns=s.split('/').map(Number);
    // Confirmed 14-day alternating schedule; old even-block meanings never change.
    if(ns.length===3&&ns[0]===2&&ns[1]===2&&ns[2]===3)ns=[2,2,3,2,2,3];
    if(ns.length%2)throw Error('Чередуйте рабочие и выходные блоки: например, 2/2 или 2/1/3/2.');
    ns.forEach((n,i)=>add(i%2?'В':'Р',n));
  }else{
    const aliases={'РАБОТА':'Р','РАБОЧИЙ':'Р','ДЕНЬ':'Д','ДНЕВНАЯ':'Д','НОЧЬ':'Н','НОЧНАЯ':'Н','ВЫХОДНОЙ':'В','ВЫХОДНЫЕ':'В','ОТДЫХ':'В','СУТКИ':'С','СУТОЧНАЯ':'С'};
    const tokens=s.split(/[\s,;→>\-]+/).filter(Boolean);
    for(const word of tokens){
      const w=aliases[word]||word;
      if(!/^(?:[РДНВС](?:\d+)?)+$/.test(w))throw Error('Используйте Р — работа, Д — день, Н — ночь, В — выходной, С — сутки. Например: Д Н В В.');
      const re=/([РДНВС])(\d*)/g;let m;while((m=re.exec(w))!==null)add(m[1],m[2]?Number(m[2]):1);
    }
  }
  if(!out.length)throw Error('Добавьте хотя бы один день в цикл.');
  return out;
}
function day(iso){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))throw Error('Выберите дату.');
  const [y,m,d]=iso.split('-').map(Number);
  if(y<1||y>9999)throw Error('Год должен быть от 1 до 9999.');
  const date=new Date(0);date.setUTCHours(0,0,0,0);date.setUTCFullYear(y,m-1,d);
  if(date.getUTCFullYear()!==y||date.getUTCMonth()!==m-1||date.getUTCDate()!==d)throw Error('Такой даты не существует.');
  return date.getTime()/86400000;
}
function at(c,anchor,date){const n=day(date)-day(anchor);return c[((n%c.length)+c.length)%c.length];}
function iso(y,m,d){return String(y).padStart(4,'0')+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');}
function month(c,anchor,y,m){
  day(iso(y,m,1));const ds=new Date(0);ds.setUTCFullYear(y,m,0);const count=ds.getUTCDate();
  return Array.from({length:count},(_,i)=>{const date=iso(y,m,i+1);return {date,type:at(c,anchor,date)};});
}
function actual(profile,date,c){
  day(date);
  return profile.overrides&&Object.prototype.hasOwnProperty.call(profile.overrides,date)?profile.overrides[date]:at(c||parse(profile.pattern),profile.anchor,date);
}
function typeAt(profile,date,c){
  day(date);
  return profile.extraShifts&&profile.extraShifts[date]?'Р':actual(profile,date,c);
}
function profileMonth(profile,y,m){
  const c=parse(profile.pattern);
  return month(c,profile.anchor,y,m).map(d=>({date:d.date,type:typeAt(profile,d.date,c),baseType:d.type,overridden:!!profile.overrides&&Object.prototype.hasOwnProperty.call(profile.overrides,d.date),extra:!!profile.extraShifts&&!!profile.extraShifts[d.date]}));
}
function counts(days){
  const result={work:0,off:0,vacation:0,sick:0};
  for(const d of days){if('РДНС'.includes(d.type))result.work++;else if(d.type==='В')result.off++;else if(d.type==='О')result.vacation++;else if(d.type==='Б')result.sick++;}
  return result;
}
function commonDays(profiles,y,m){
  if(profiles.length<2||new Set(profiles.map(p=>p.id)).size!==profiles.length)throw Error('Выберите хотя бы двух разных людей.');
  const calendars=profiles.map(p=>profileMonth(p,y,m));
  return calendars[0].filter((_,i)=>calendars.every(days=>days[i].type==='В'||days[i].type==='О')).map(d=>d.date);
}
const api={parse,day,at,month,iso,names,actual,typeAt,profileMonth,counts,commonDays};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Schedule=api;
})(typeof globalThis!=='undefined'?globalThis:this);
