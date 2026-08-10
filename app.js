const DEMO_PRODUCTS = [
  { sku:'ONEBLADE-2724', name:'Philips OneBlade QP2724', channel:'Allegro', units:126, price:119, cost:70, commission:11.2, ads:8.1, shipping:4.2, returns:2.6 },
  { sku:'AIRFRY-9252', name:'Philips Airfryer HD9252', channel:'Allegro', units:54, price:429, cost:286, commission:40.3, ads:17.4, shipping:9.5, returns:12.1 },
  { sku:'LEGO-42151', name:'LEGO Technic Bugatti', channel:'Empik', units:43, price:229, cost:151, commission:27.5, ads:7.2, shipping:6.4, returns:3.1 },
  { sku:'XIAOMI-BUDS5', name:'Xiaomi Redmi Buds 5', channel:'Allegro', units:187, price:149, cost:89, commission:13.8, ads:5.1, shipping:4.1, returns:1.8 },
  { sku:'BRAUN-BT5420', name:'Braun Beard Trimmer 5', channel:'Empik', units:68, price:189, cost:118, commission:22.7, ads:13.6, shipping:5.5, returns:4.2 },
  { sku:'TEFAL-GC3050', name:'Tefal OptiGrill GC3050', channel:'Allegro', units:39, price:479, cost:341, commission:45.1, ads:35.8, shipping:11.2, returns:14.5 },
  { sku:'ORALB-IO3', name:'Oral-B iO Series 3', channel:'Empik', units:92, price:289, cost:202, commission:34.7, ads:20.4, shipping:6.2, returns:9.5 },
  { sku:'LOGI-MX3S', name:'Logitech MX Master 3S', channel:'Allegro', units:61, price:419, cost:286, commission:39.4, ads:12.2, shipping:5.9, returns:5.1 },
  { sku:'SAMSUNG-T7', name:'Samsung SSD T7 1TB', channel:'Empik', units:47, price:399, cost:304, commission:47.9, ads:18.5, shipping:5.7, returns:4.4 },
  { sku:'DYSON-V8', name:'Dyson V8 Advanced', channel:'Allegro', units:29, price:1299, cost:1035, commission:122.1, ads:96.4, shipping:18.3, returns:31.2 }
];

const state = { products: loadProducts(), period: 30, view: 'overview', apiMode: false, integrationData: null };
const money = new Intl.NumberFormat('pl-PL', { style:'currency', currency:'PLN', maximumFractionDigits:0 });
const moneyExact = new Intl.NumberFormat('pl-PL', { style:'currency', currency:'PLN', minimumFractionDigits:2 });
const $ = selector => document.querySelector(selector);
const h = value => String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));

function loadProducts() {
  try { return JSON.parse(localStorage.getItem('profitpilot-products')) || structuredClone(DEMO_PRODUCTS); }
  catch { return structuredClone(DEMO_PRODUCTS); }
}

function calculate(product) {
  const revenue = product.units * product.price;
  const costsPerUnit = product.cost + product.commission + product.ads + product.shipping + product.returns;
  const costs = product.units * costsPerUnit;
  const profit = revenue - costs;
  const margin = revenue ? profit / revenue * 100 : 0;
  return { ...product, revenue, costs, profit, margin, profitPerUnit: product.price - costsPerUnit };
}

function scaledProducts() {
  const scale = state.period / 30;
  return state.products.map(p => calculate({...p, units: Math.max(1, Math.round(p.units * scale))}));
}

function getStatus(p) { return p.margin < 0 ? 'loss' : p.margin < 8 ? 'risk' : 'healthy'; }
function statusLabel(status) { return status === 'loss' ? 'Убыток' : status === 'risk' ? 'Низкая маржа' : 'Здоровый'; }
function pluralRu(number, one, few, many) { const n=Math.abs(number)%100; const n1=n%10; return n>10&&n<20?many:n1>1&&n1<5?few:n1===1?one:many; }

function recommendationFor(p) {
  const status = getStatus(p);
  if (status === 'healthy') return null;
  const targetMargin = .15;
  const costsPerUnit = p.cost + p.commission + p.ads + p.shipping + p.returns;
  const targetPrice = costsPerUnit / (1 - targetMargin);
  const increase = Math.max(0, targetPrice - p.price);
  const adShare = p.ads / p.price;
  let title = `Поднять цену ${p.name}`;
  let description = `Текущая прибыль ${moneyExact.format(p.profitPerUnit)} с единицы. Цена ${moneyExact.format(targetPrice)} вернёт маржу к 15%.`;
  let action = `Цена → ${moneyExact.format(targetPrice)}`;
  let potential = increase * p.units;
  let type = status === 'loss' ? 'danger' : 'warning';
  if (adShare > .09) {
    const saving = p.ads * .3;
    title = `Снизить расходы на рекламу`;
    description = `${p.name}: реклама забирает ${(adShare*100).toFixed(1)}% цены. Сократите ставку примерно на 30%.`;
    action = 'Проверить рекламу';
    potential = saving * p.units;
  }
  return { sku:p.sku, title, description, action, potential, type, channel:p.channel };
}

function recommendations() { return scaledProducts().map(recommendationFor).filter(Boolean).sort((a,b) => b.potential-a.potential); }

function renderMetrics() {
  const products = scaledProducts();
  const total = products.reduce((a,p) => ({ revenue:a.revenue+p.revenue, profit:a.profit+p.profit, units:a.units+p.units }), {revenue:0,profit:0,units:0});
  const margin = total.revenue ? total.profit/total.revenue*100 : 0;
  const cards = [
    ['Выручка', money.format(total.revenue), '+7,4% к прошлому периоду', false],
    ['Чистая прибыль', money.format(total.profit), total.profit >= 0 ? '+3,1% к прошлому периоду' : 'Требует внимания', total.profit < 0],
    ['Маржа', `${margin.toFixed(1)}%`, margin >= 15 ? 'В здоровом диапазоне' : 'Ниже цели 15%', margin < 15],
    ['Продано товаров', total.units.toLocaleString('pl-PL'), `${products.length} активных SKU`, false]
  ];
  $('#metrics').innerHTML = cards.map(c => `<article class="metric-card"><span class="metric-label">${c[0]}</span><strong class="metric-value">${c[1]}</strong><span class="metric-change ${c[3]?'negative':''}">${c[2]}</span></article>`).join('');
}

function renderChart() {
  const products = scaledProducts();
  const totalRevenue = products.reduce((a,p)=>a+p.revenue,0);
  const totalProfit = products.reduce((a,p)=>a+p.profit,0);
  const labels = state.period === 7 ? ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'] : ['1','5','10','15','20','25','30'];
  const factors = [.10,.135,.12,.16,.145,.18,.16];
  const revenues = factors.map((f,i)=>totalRevenue*f*(.92 + ((i*7)%5)/20));
  const profits = factors.map((f,i)=>totalProfit*f*(.86 + ((i*3)%4)/20));
  const max = Math.max(...revenues, 1) * 1.08;
  const w=700,h=210,pad=28;
  const points = values => values.map((v,i)=>`${pad+i*((w-pad*2)/(values.length-1))},${h-pad-(v/max)*(h-pad*2)}`).join(' ');
  const area = `${pad},${h-pad} ${points(revenues)} ${w-pad},${h-pad}`;
  const grid = [0,.25,.5,.75,1].map(v=>`<line class="grid-line" x1="${pad}" y1="${h-pad-v*(h-pad*2)}" x2="${w-pad}" y2="${h-pad-v*(h-pad*2)}"/>`).join('');
  const xlabels = labels.map((l,i)=>`<text class="axis-label" x="${pad+i*((w-pad*2)/(labels.length-1))}" y="${h-4}" text-anchor="middle">${l}</text>`).join('');
  $('#profitChart').innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bdd4c6" stop-opacity=".55"/><stop offset="1" stop-color="#bdd4c6" stop-opacity="0"/></linearGradient></defs>${grid}<polygon points="${area}" fill="url(#area)"/><polyline points="${points(revenues)}" fill="none" stroke="#9fbbaa" stroke-width="3"/><polyline points="${points(profits)}" fill="none" stroke="#236b4c" stroke-width="3"/>${xlabels}</svg>`;
}

function renderHealth() {
  const products=scaledProducts(); const counts={healthy:0,risk:0,loss:0}; products.forEach(p=>counts[getStatus(p)]++);
  const n=products.length||1; const green=counts.healthy/n*100; const amber=(counts.healthy+counts.risk)/n*100;
  $('#healthChart').style.background=`conic-gradient(var(--green) 0 ${green}%, var(--amber) ${green}% ${amber}%, var(--red) ${amber}% 100%)`;
  $('#healthChart').innerHTML=`<div class="health-center"><strong>${products.length}</strong><span>товаров</span></div>`;
  const rows=[['#236b4c','Здоровая маржа',counts.healthy],['#d58b20','Низкая маржа',counts.risk],['#bd4b42','Убыточные',counts.loss]];
  $('#healthLegend').innerHTML=rows.map(r=>`<div class="health-row"><i style="background:${r[0]}"></i><span>${r[1]}</span><b>${r[2]}</b></div>`).join('');
}

function recRow(r) { return `<div class="recommendation-row"><span class="rec-icon ${r.type}">${r.type==='danger'?'!':'↗'}</span><div class="rec-copy"><strong>${h(r.title)}</strong><span>${h(r.description)}</span></div><div class="rec-impact"><strong>+${money.format(r.potential)}</strong><span>потенциал / мес.</span></div><button class="action-button" data-toast="Действие сохранено в план">${h(r.action)}</button></div>`; }

function renderRecommendations() {
  const recs=recommendations();
  $('#navAlertCount').textContent=recs.length;
  $('#topRecommendations').innerHTML=recs.slice(0,3).map(recRow).join('') || '<p class="empty">Отлично — критических проблем не найдено.</p>';
  const potential=recs.reduce((a,r)=>a+r.potential,0);
  $('#totalPotential').textContent=`+${money.format(potential)}`;
  $('#recommendationHeadline').textContent=recs.length ? `Нашли ${recs.length} ${pluralRu(recs.length,'возможность','возможности','возможностей')} роста` : 'Каталог выглядит здоровым';
  $('#allRecommendations').innerHTML=recs.map(r=>`<article class="recommendation-card"><div class="rec-card-top"><span class="rec-icon ${r.type}">${r.type==='danger'?'!':'↗'}</span><span class="channel ${r.channel==='Empik'?'empik':''}">${h(r.channel)}</span></div><h3>${h(r.title)}</h3><p>${h(r.description)}</p><div class="rec-card-bottom"><div><small>Ожидаемый эффект</small><strong>+${money.format(r.potential)} / мес.</strong></div><button class="action-button" data-toast="Рекомендация добавлена в план">${h(r.action)}</button></div></article>`).join('');
}

function renderTable() {
  const query=$('#productSearch').value.toLowerCase(); const channel=$('#channelFilter').value;
  const rows=scaledProducts().filter(p=>(channel==='all'||p.channel===channel)&&(p.name.toLowerCase().includes(query)||p.sku.toLowerCase().includes(query)));
  $('#productsTable').innerHTML=rows.map(p=>{const s=getStatus(p); return `<tr><td class="product-cell"><strong>${h(p.name)}</strong><span>${h(p.sku)}</span></td><td><span class="channel ${p.channel==='Empik'?'empik':''}">${h(p.channel)}</span></td><td>${p.units}</td><td>${money.format(p.revenue)}</td><td>${money.format(p.costs)}</td><td class="${p.profit>=0?'money-positive':'money-negative'}">${money.format(p.profit)}</td><td>${p.margin.toFixed(1)}%</td><td><span class="status-badge ${s==='risk'?'warning':s==='loss'?'danger':''}">● ${statusLabel(s)}</span></td></tr>`}).join('') || '<tr><td colspan="8">Ничего не найдено</td></tr>';
}

function renderAll() { renderMetrics(); renderChart(); renderHealth(); renderRecommendations(); renderTable(); }

function setView(view) {
  state.view=view; document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`${view}View`)); document.querySelectorAll('.nav-item[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  const copy={overview:['Доброе утро, Лео','Вот что происходит с прибылью вашего магазина.'],products:['Экономика товаров','Продажи, затраты и реальная прибыль по каждому SKU.'],recommendations:['Рекомендации Profit AI','Приоритетные действия для роста прибыли.'],integrations:['Интеграции','Подключите маркетплейсы и управляйте доступом к данным.']}[view]; $('#pageTitle').textContent=copy[0]; $('#pageSubtitle').textContent=copy[1];
}

function parseCSV(text) {
  const lines=text.trim().split(/\r?\n/).filter(Boolean); if(lines.length<2) throw new Error('Файл не содержит данных');
  const delimiter=(lines[0].match(/;/g)||[]).length>(lines[0].match(/,/g)||[]).length?';':',';
  const parseLine=line=>{const out=[];let cell='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===delimiter&&!quoted){out.push(cell.trim());cell='';}else cell+=c;}out.push(cell.trim());return out;};
  const headers=parseLine(lines.shift()).map(h=>h.toLowerCase()); const required=['sku','name','channel','units','price','cost','commission','ads','shipping','returns'];
  if(required.some(h=>!headers.includes(h))) throw new Error(`Нужны колонки: ${required.join(', ')}`);
  return lines.map(line=>{const cells=parseLine(line);const row=Object.fromEntries(headers.map((h,i)=>[h,cells[i]]));const item={sku:row.sku,name:row.name,channel:row.channel};required.slice(3).forEach(k=>item[k]=Number(String(row[k]).replace(',','.')));if(!item.sku||!item.name||required.slice(3).some(k=>!Number.isFinite(item[k]))) throw new Error(`Ошибка в строке SKU ${item.sku||'без SKU'}`);if(!['Allegro','Empik'].includes(item.channel)) throw new Error(`Неизвестный канал у SKU ${item.sku}: нужен Allegro или Empik`);return item;});
}

async function refreshFromServer() {
  const response = await fetch('/api/products?days=30');
  if (!response.ok) throw new Error('Не удалось получить товары с сервера');
  state.products = (await response.json()).products;
  renderAll();
}

async function refreshIntegration() {
  if (!state.apiMode) return;
  const response = await fetch('/api/integrations');
  if (!response.ok) return;
  const data = await response.json();
  state.integrationData = data;
  const allegro = data.integrations.find(item => item.provider === 'Allegro');
  const empik = data.integrations.find(item => item.provider === 'Empik');
  const allegroConnected = allegro?.status === 'connected';
  const empikConnected = empik?.status === 'connected';
  const connectedCount = Number(allegroConnected) + Number(empikConnected);
  $('#integrationTitle').textContent = connectedCount ? `${connectedCount} ${pluralRu(connectedCount,'канал подключён','канала подключены','каналов подключено')}` : 'Сервер подключён';
  $('#integrationText').textContent = connectedCount ? 'Интеграции готовы к синхронизации' : 'Настройте Allegro и Empik';
  $('#integrationDot').classList.remove('offline');
  $('#navIntegrationCount').textContent = connectedCount;
  $('#allegroRedirectUri').textContent = data.allegroRedirectUri;
  updateMarketplaceCard('allegro', allegro, data.allegroConfigured);
  updateMarketplaceCard('empik', empik, true);
}

function updateMarketplaceCard(provider, integration, configured) {
  const connected=integration?.status==='connected';
  const prefix=provider==='allegro'?'allegro':'empik';
  const card=$(`#${prefix}Card`); const badge=$(`#${prefix}Badge`); const account=$(`#${prefix}Account`); const primary=$(`#${prefix}Primary`); const disconnect=$(`#${prefix}Disconnect`);
  card.classList.toggle('connected',connected); badge.classList.toggle('connected',connected); badge.textContent=connected?'Подключено':provider==='allegro'&&!configured?'Нужна настройка':'Не подключено';
  account.hidden=!connected; if(connected) account.querySelector('strong').textContent=integration.accountName||'Аккаунт продавца';
  disconnect.hidden=!connected;
  if(provider==='allegro') primary.textContent=connected?'Переподключить Allegro':configured?'Подключить Allegro':'Настроить Allegro';
  else primary.textContent=connected?'Обновить ключ Empik':'Подключить Empik';
}

async function postJson(url, body={}) {
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const result=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(result.error||'Не удалось выполнить действие'); return result;
}

function setButtonBusy(button,busy,label) { button.disabled=busy; if(busy){button.dataset.label=button.textContent;button.textContent=label;}else if(button.dataset.label){button.textContent=button.dataset.label;delete button.dataset.label;} }

function importFile(file) {
  if(!file)return;
  const reader=new FileReader();
  reader.onload=async()=>{
    try {
      const parsed=parseCSV(reader.result);
      if (state.apiMode) {
        const response=await fetch('/api/import/csv',{method:'POST',headers:{'Content-Type':'text/csv; charset=utf-8'},body:reader.result});
        const result=await response.json();
        if(!response.ok) throw new Error(result.error||'Ошибка импорта');
        await refreshFromServer();
        showToast(`Импортировано строк: ${result.imported}`);
      } else {
        state.products=parsed; localStorage.setItem('profitpilot-products',JSON.stringify(state.products)); renderAll();
        showToast(`Импортировано товаров: ${state.products.length}`);
      }
      $('#importDialog').close();
    } catch(e) { showToast(e.message); }
  };
  reader.readAsText(file);
}
function showToast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>el.classList.remove('show'),2800);}

document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.go)));
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>document.getElementById(b.dataset.close).close()));
document.addEventListener('click',e=>{const b=e.target.closest('[data-toast]');if(b)showToast(b.dataset.toast);});
$('#openIntegrations').addEventListener('click',()=>setView('integrations'));
$('#allegroPrimary').addEventListener('click',()=>{if(state.integrationData?.allegroConfigured) location.href='/api/auth/allegro'; else $('#allegroDialog').showModal();});
$('#empikPrimary').addEventListener('click',()=>$('#empikDialog').showModal());
$('#copyRedirect').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#allegroRedirectUri').textContent);showToast('Redirect URI скопирован');}catch{showToast('Скопируйте Redirect URI вручную');}});
$('#allegroForm').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('[type="submit"]');setButtonBusy(button,true,'Сохраняем…');try{const form=new FormData(e.currentTarget);await postJson('/api/integrations/allegro/config',{clientId:form.get('clientId'),clientSecret:form.get('clientSecret'),userAgent:form.get('userAgent'),environment:form.get('environment')});$('#allegroDialog').close();await refreshIntegration();showToast('Приложение Allegro настроено');location.href='/api/auth/allegro';}catch(error){showToast(error.message);setButtonBusy(button,false);}});
$('#empikForm').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('[type="submit"]');setButtonBusy(button,true,'Проверяем ключ…');try{const form=new FormData(e.currentTarget);const result=await postJson('/api/integrations/empik/connect',{accountName:form.get('accountName'),apiKey:form.get('apiKey')});$('#empikDialog').close();e.currentTarget.reset();await refreshIntegration();showToast(`Empik подключён: ${result.accountName}`);}catch(error){showToast(error.message);}finally{setButtonBusy(button,false);}});
$('#allegroDisconnect').addEventListener('click',async()=>{try{await postJson('/api/integrations/Allegro/disconnect');await refreshIntegration();showToast('Allegro отключён');}catch(error){showToast(error.message);}});
$('#empikDisconnect').addEventListener('click',async()=>{try{await postJson('/api/integrations/Empik/disconnect');await refreshIntegration();showToast('Empik отключён');}catch(error){showToast(error.message);}});
$('#periodSelect').addEventListener('change',e=>{state.period=Number(e.target.value);renderAll();});
$('#productSearch').addEventListener('input',renderTable); $('#channelFilter').addEventListener('change',renderTable);
$('#importButton').addEventListener('click',()=>$('#importDialog').showModal()); $('#dropZone').addEventListener('click',()=>$('#csvInput').click()); $('#csvInput').addEventListener('change',e=>importFile(e.target.files[0]));
['dragenter','dragover'].forEach(evt=>$('#dropZone').addEventListener(evt,e=>{e.preventDefault();e.currentTarget.classList.add('drag');})); ['dragleave','drop'].forEach(evt=>$('#dropZone').addEventListener(evt,e=>{e.preventDefault();e.currentTarget.classList.remove('drag');})); $('#dropZone').addEventListener('drop',e=>importFile(e.dataTransfer.files[0]));
$('#resetDemo').addEventListener('click',async()=>{try{if(state.apiMode){await fetch('/api/demo/reset',{method:'POST'});await refreshFromServer();}else{state.products=structuredClone(DEMO_PRODUCTS);localStorage.removeItem('profitpilot-products');renderAll();}showToast('Демо-данные восстановлены');}catch{showToast('Не удалось сбросить данные');}});
$('#downloadTemplate').addEventListener('click',()=>{const csv='sku,name,channel,units,price,cost,commission,ads,shipping,returns\nTEST-001,Название товара,Allegro,10,119.99,70,11,5,4,2';const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='profitpilot-template.csv';a.click();URL.revokeObjectURL(a.href);});

async function initialize() {
  renderAll();
  try {
    const health=await fetch('/api/health',{cache:'no-store'});
    if(!health.ok) throw new Error();
    state.apiMode=true;
    await refreshFromServer();
    await refreshIntegration();
  } catch {
    $('#integrationTitle').textContent='Демо-режим';
    $('#integrationText').textContent='Данные хранятся в браузере';
    $('#integrationDot').classList.add('offline');
  }
  const integration=new URLSearchParams(location.search).get('integration');
  if(integration){setView('integrations');history.replaceState({},'',location.pathname);}
  if(integration==='connected') showToast('Allegro успешно подключён');
  if(integration==='error') showToast('Не удалось подключить Allegro');
}

initialize();
