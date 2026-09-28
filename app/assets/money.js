(function(root){
'use strict';
const S=typeof module!=='undefined'&&module.exports?require('./schedule.js'):root.Schedule;
const labels={salary:'Зарплата',advance:'Аванс',bonus:'Премия',vacation:'Отпускные',sick:'Больничные'};
const rateKeys={Р:'work',Д:'daily',Н:'night',С:'full'};
function parseAmount(value){
  if(typeof value!=='string')throw Error('Введите сумму выплаты.');
  const text=value.replace(/[\s\u00a0\u202f]/g,'').replace(',','.');
  if(!/^\d{1,11}(?:\.\d{1,2})?$/.test(text))throw Error('Введите сумму в рублях, например 48500 или 48500,50.');
  const [rubles,kopecks='']=text.split('.'),amount=Number(rubles)*100+Number((kopecks+'00').slice(0,2));
  if(!Number.isSafeInteger(amount)||amount<1||amount>1000000000000)throw Error('Сумма должна быть от 0,01 до 10 миллиардов рублей.');
  return amount;
}
function formatAmount(amountKopecks){
  if(!Number.isSafeInteger(amountKopecks))throw Error('Неверная сумма.');
  return new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',minimumFractionDigits:amountKopecks%100?2:0,maximumFractionDigits:2}).format(amountKopecks/100);
}
function monthPayments(profile,year,month){
  const prefix=S.iso(year,month,1).slice(0,7);return ((profile&&profile.money&&profile.money.payments)||[]).filter(item=>item.date.slice(0,7)===prefix).slice().sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id));
}
function monthTotal(profile,year,month){return monthPayments(profile,year,month).reduce((sum,item)=>sum+item.amountKopecks,0);}
function rateFor(money,type,extra=false){
  if(!money)return 0;
  const rates=money.shiftRatesKopecks||{},key=extra?'extra':rateKeys[type],custom=key&&rates[key];
  if(!key)return 0;
  return Number.isSafeInteger(custom)?custom:(money.shiftRateKopecks||0);
}
function monthForecast(profile,year,month){
  return S.profileMonth(profile,year,month).reduce((sum,day)=>sum+rateFor(profile&&profile.money,day.type,day.extra),0);
}
function dateForDay(year,month,day){
  let last=31;while(last>28){try{S.day(S.iso(year,month,last));break;}catch(_){last--;}}return S.iso(year,month,Math.min(day,last));
}
function nextPayday(money,from){
  S.day(from);if(!money)return null;const start=from.split('-').map(Number),candidates=[];
  for(let offset=0;offset<14;offset++){
    const index=start[1]-1+offset,year=start[0]+Math.floor(index/12),month=index%12+1;if(year>9999)break;
    for(const [type,day] of [['salary',money.salaryDay],['advance',money.advanceDay]])if(day!==null){const date=dateForDay(year,month,day);if(date>=from)candidates.push({date,type});}
    for(const window of (money.payWindows||[])){const endDate=dateForDay(year,month,window.to);if(endDate>=from)candidates.push({date:endDate,type:window.type});}
    if(candidates.length)break;
  }
  return candidates.sort((a,b)=>a.date.localeCompare(b.date)||a.type.localeCompare(b.type))[0]||null;
}
const api={labels,parseAmount,formatAmount,monthPayments,monthTotal,rateFor,monthForecast,dateForDay,nextPayday};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Money=api;
})(typeof globalThis!=='undefined'?globalThis:this);
