import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(ROOT, 'data');

async function loadEnvFile() {
  try {
    const source = await readFile(join(ROOT, '.env'), 'utf8');
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

await loadEnvFile();
const PORT = Number(process.env.PORT || 8080);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const MAX_BODY = 5 * 1024 * 1024;

await mkdir(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'profitpilot.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('Allegro','Empik')),
    units REAL NOT NULL DEFAULT 0,
    price REAL NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    commission REAL NOT NULL DEFAULT 0,
    ads REAL NOT NULL DEFAULT 0,
    shipping REAL NOT NULL DEFAULT 0,
    returns_cost REAL NOT NULL DEFAULT 0,
    imported_at TEXT NOT NULL,
    UNIQUE(sku, channel)
  );
  CREATE TABLE IF NOT EXISTS integrations (
    provider TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'disconnected',
    account_name TEXT,
    access_token TEXT,
    refresh_token TEXT,
    config_json TEXT,
    expires_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    code_verifier TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_encrypted TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

function ensureColumn(table, column, definition) {
  const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(item=>item.name);
  if(!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('integrations','config_json','TEXT');
ensureColumn('oauth_states','code_verifier','TEXT');

const demoProducts = [
  ['ONEBLADE-2724','Philips OneBlade QP2724','Allegro',126,119,70,11.2,8.1,4.2,2.6],
  ['AIRFRY-9252','Philips Airfryer HD9252','Allegro',54,429,286,40.3,17.4,9.5,12.1],
  ['LEGO-42151','LEGO Technic Bugatti','Empik',43,229,151,27.5,7.2,6.4,3.1],
  ['XIAOMI-BUDS5','Xiaomi Redmi Buds 5','Allegro',187,149,89,13.8,5.1,4.1,1.8],
  ['BRAUN-BT5420','Braun Beard Trimmer 5','Empik',68,189,118,22.7,13.6,5.5,4.2],
  ['TEFAL-GC3050','Tefal OptiGrill GC3050','Allegro',39,479,341,45.1,35.8,11.2,14.5],
  ['ORALB-IO3','Oral-B iO Series 3','Empik',92,289,202,34.7,20.4,6.2,9.5],
  ['LOGI-MX3S','Logitech MX Master 3S','Allegro',61,419,286,39.4,12.2,5.9,5.1],
  ['SAMSUNG-T7','Samsung SSD T7 1TB','Empik',47,399,304,47.9,18.5,5.7,4.4],
  ['DYSON-V8','Dyson V8 Advanced','Allegro',29,1299,1035,122.1,96.4,18.3,31.2]
];

const upsertProduct = db.prepare(`
  INSERT INTO products (sku,name,channel,units,price,cost,commission,ads,shipping,returns_cost,imported_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(sku,channel) DO UPDATE SET
    name=excluded.name, units=excluded.units, price=excluded.price, cost=excluded.cost,
    commission=excluded.commission, ads=excluded.ads, shipping=excluded.shipping,
    returns_cost=excluded.returns_cost, imported_at=excluded.imported_at
`);

function seedDemo(force = false) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
  if (count && !force) return;
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    if (force) db.exec('DELETE FROM products');
    for (const row of demoProducts) upsertProduct.run(...row, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
seedDemo();

function rowsForPeriod(days = 30) {
  const scale = Math.max(1, Math.min(365, Number(days) || 30)) / 30;
  return db.prepare('SELECT sku,name,channel,units,price,cost,commission,ads,shipping,returns_cost AS returns FROM products ORDER BY name').all()
    .map(row => calculate({ ...row, units: Math.max(1, Math.round(row.units * scale)) }));
}

function calculate(p) {
  const unitCosts = p.cost + p.commission + p.ads + p.shipping + p.returns;
  const revenue = p.units * p.price;
  const costs = p.units * unitCosts;
  const profit = revenue - costs;
  return { ...p, revenue, costs, profit, margin: revenue ? profit / revenue * 100 : 0, profitPerUnit: p.price - unitCosts };
}

function getStatus(p) { return p.margin < 0 ? 'loss' : p.margin < 8 ? 'risk' : 'healthy'; }

function recommendations(products) {
  return products.map(p => {
    const status = getStatus(p);
    if (status === 'healthy') return null;
    const unitCosts = p.cost + p.commission + p.ads + p.shipping + p.returns;
    const targetPrice = unitCosts / .85;
    const adShare = p.ads / p.price;
    const adRecommendation = adShare > .09;
    return {
      sku: p.sku,
      channel: p.channel,
      type: status === 'loss' ? 'danger' : 'warning',
      title: adRecommendation ? 'Снизить расходы на рекламу' : `Поднять цену ${p.name}`,
      description: adRecommendation
        ? `${p.name}: реклама забирает ${(adShare * 100).toFixed(1)}% цены. Сократите ставку примерно на 30%.`
        : `Текущая прибыль ${p.profitPerUnit.toFixed(2)} zł с единицы. Цена ${targetPrice.toFixed(2)} zł вернёт маржу к 15%.`,
      action: adRecommendation ? 'Проверить рекламу' : `Цена → ${targetPrice.toFixed(2)} zł`,
      potential: adRecommendation ? p.ads * .3 * p.units : Math.max(0, targetPrice - p.price) * p.units
    };
  }).filter(Boolean).sort((a,b) => b.potential - a.potential);
}

function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw badRequest('Файл не содержит данных');
  const delimiter = (lines[0].match(/;/g)||[]).length > (lines[0].match(/,/g)||[]).length ? ';' : ',';
  const parseLine = line => {
    const out=[]; let cell=''; let quoted=false;
    for(let i=0;i<line.length;i++) { const c=line[i]; if(c==='"') { if(quoted&&line[i+1]==='"'){cell+='"';i++;}else quoted=!quoted; } else if(c===delimiter&&!quoted){out.push(cell.trim());cell='';}else cell+=c; }
    out.push(cell.trim()); return out;
  };
  const headers = parseLine(lines.shift()).map(value => value.toLowerCase());
  const required = ['sku','name','channel','units','price','cost','commission','ads','shipping','returns'];
  if (required.some(key => !headers.includes(key))) throw badRequest(`Нужны колонки: ${required.join(', ')}`);
  if (lines.length > 10000) throw badRequest('В одном файле допускается до 10 000 строк');
  return lines.map((line, index) => {
    const cells = parseLine(line);
    const row = Object.fromEntries(headers.map((key,i) => [key,cells[i]]));
    const item = { sku:row.sku?.slice(0,120), name:row.name?.slice(0,300), channel:row.channel };
    required.slice(3).forEach(key => item[key] = Number(String(row[key]).replace(',','.')));
    if (!item.sku || !item.name || required.slice(3).some(key => !Number.isFinite(item[key]) || item[key] < 0)) throw badRequest(`Ошибка данных в строке ${index + 2}`);
    if (!['Allegro','Empik'].includes(item.channel)) throw badRequest(`Строка ${index + 2}: канал должен быть Allegro или Empik`);
    return item;
  });
}

function badRequest(message) { const error = new Error(message); error.status = 400; return error; }
function json(res, status, data) { const body=JSON.stringify(data); res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'}); res.end(body); }
function redirect(res, location) { res.writeHead(302, { Location: location }); res.end(); }

async function readBody(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size += chunk.length; if(size>MAX_BODY) throw Object.assign(new Error('Файл превышает 5 MB'),{status:413}); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
async function readJson(req) { const body=await readBody(req); try{return JSON.parse(body||'{}');}catch{throw badRequest('Некорректный формат запроса');} }

function encryptionKey() { return createHash('sha256').update(process.env.SESSION_SECRET || 'profitpilot-local-development').digest(); }
function encrypt(value) { if(!value)return null; const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv); const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]); return [iv,cipher.getAuthTag(),encrypted].map(b=>b.toString('base64url')).join('.'); }
function decrypt(value) { if(!value)return null; const [iv,tag,data]=value.split('.').map(v=>Buffer.from(v,'base64url')); const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'); }
function setSetting(key,value) { db.prepare('INSERT INTO settings(key,value_encrypted,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_encrypted=excluded.value_encrypted,updated_at=excluded.updated_at').run(key,encrypt(value),new Date().toISOString()); }
function getSetting(key) { const row=db.prepare('SELECT value_encrypted FROM settings WHERE key=?').get(key); if(!row)return null; try{return decrypt(row.value_encrypted);}catch{return null;} }
function allegroConfig() {
  return {
    clientId:process.env.ALLEGRO_CLIENT_ID||getSetting('allegro.clientId'),
    clientSecret:process.env.ALLEGRO_CLIENT_SECRET||getSetting('allegro.clientSecret'),
    redirectUri:process.env.ALLEGRO_REDIRECT_URI||getSetting('allegro.redirectUri')||`${APP_URL}/api/auth/allegro/callback`,
    environment:process.env.ALLEGRO_ENV||getSetting('allegro.environment')||'production',
    userAgent:process.env.ALLEGRO_USER_AGENT||getSetting('allegro.userAgent')
  };
}
function allegroUrls(environment) { const sandbox=environment==='sandbox'; return {authorize:sandbox?'https://allegro.pl.allegrosandbox.pl/auth/oauth/authorize':'https://allegro.pl/auth/oauth/authorize',token:sandbox?'https://allegro.pl.allegrosandbox.pl/auth/oauth/token':'https://allegro.pl/auth/oauth/token',api:sandbox?'https://api.allegro.pl.allegrosandbox.pl':'https://api.allegro.pl'}; }
async function getAllegroAccessToken() {
  const integration=db.prepare("SELECT * FROM integrations WHERE provider='Allegro' AND status='connected'").get();
  if(!integration) throw badRequest('Allegro не подключён');
  if(integration.expires_at&&new Date(integration.expires_at).getTime()>Date.now()+60000) return decrypt(integration.access_token);
  const config=allegroConfig(); const urls=allegroUrls(config.environment); const refreshToken=decrypt(integration.refresh_token); const basic=Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response=await fetch(urls.token,{method:'POST',headers:{Authorization:`Basic ${basic}`,'Content-Type':'application/x-www-form-urlencoded','User-Agent':config.userAgent},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken})});
  if(!response.ok){db.prepare("UPDATE integrations SET status='expired',updated_at=? WHERE provider='Allegro'").run(new Date().toISOString());throw Object.assign(new Error('Сессия Allegro истекла — подключите аккаунт повторно'),{status:401});}
  const token=await response.json(); const expiresAt=new Date(Date.now()+token.expires_in*1000).toISOString();
  db.prepare("UPDATE integrations SET access_token=?,refresh_token=?,expires_at=?,updated_at=? WHERE provider='Allegro'").run(encrypt(token.access_token),encrypt(token.refresh_token),expiresAt,new Date().toISOString());
  return token.access_token;
}

async function api(req, res, url) {
  const days = Number(url.searchParams.get('days') || 30);
  if (req.method==='GET' && url.pathname==='/api/health') return json(res,200,{ok:true,version:'0.3.0'});
  if (req.method==='GET' && url.pathname==='/api/products') return json(res,200,{products:rowsForPeriod(days)});
  if (req.method==='GET' && url.pathname==='/api/dashboard') {
    const products=rowsForPeriod(days); const totals=products.reduce((a,p)=>({revenue:a.revenue+p.revenue,profit:a.profit+p.profit,units:a.units+p.units}),{revenue:0,profit:0,units:0});
    return json(res,200,{totals:{...totals,margin:totals.revenue?totals.profit/totals.revenue*100:0},products,recommendations:recommendations(products)});
  }
  if (req.method==='POST' && url.pathname==='/api/import/csv') {
    const items=parseCSV(await readBody(req)); const now=new Date().toISOString(); db.exec('BEGIN');
    try { for(const p of items) upsertProduct.run(p.sku,p.name,p.channel,p.units,p.price,p.cost,p.commission,p.ads,p.shipping,p.returns,now); db.exec('COMMIT'); }
    catch(error){db.exec('ROLLBACK');throw error;}
    return json(res,200,{ok:true,imported:items.length});
  }
  if (req.method==='POST' && url.pathname==='/api/demo/reset') { seedDemo(true); return json(res,200,{ok:true}); }
  if (req.method==='GET' && url.pathname==='/api/integrations') {
    const saved=db.prepare('SELECT provider,status,account_name AS accountName,expires_at AS expiresAt,updated_at AS updatedAt FROM integrations').all();
    const map=Object.fromEntries(saved.map(row=>[row.provider,row]));
    const config=allegroConfig();
    return json(res,200,{integrations:[map.Allegro||{provider:'Allegro',status:'disconnected'},map.Empik||{provider:'Empik',status:'disconnected'}],allegroConfigured:Boolean(config.clientId&&config.clientSecret&&config.userAgent),allegroRedirectUri:config.redirectUri,empikApiUrl:process.env.EMPIK_API_URL||'https://marketplace.empik.com'});
  }
  if (req.method==='POST' && url.pathname==='/api/integrations/allegro/config') {
    const body=await readJson(req); const clientId=String(body.clientId||'').trim(); const clientSecret=String(body.clientSecret||'').trim(); const userAgent=String(body.userAgent||'').trim(); const environment=body.environment==='sandbox'?'sandbox':'production';
    if(clientId.length<8||clientSecret.length<8) throw badRequest('Укажите корректные Client ID и Client Secret приложения Allegro');
    if(!/^ProfitPilot\/\d+(?:\.\d+){1,3} \(\+https:\/\/[^\s]+\)$/.test(userAgent)) throw badRequest('Вставьте User-Agent из генератора Allegro в формате ProfitPilot/0.3.0 (+https://...)');
    setSetting('allegro.clientId',clientId); setSetting('allegro.clientSecret',clientSecret); setSetting('allegro.userAgent',userAgent); setSetting('allegro.environment',environment); setSetting('allegro.redirectUri',`${APP_URL}/api/auth/allegro/callback`);
    return json(res,200,{ok:true,redirectUri:`${APP_URL}/api/auth/allegro/callback`});
  }
  if (req.method==='POST' && url.pathname==='/api/integrations/empik/connect') {
    const body=await readJson(req); const apiKey=String(body.apiKey||'').trim(); const label=String(body.accountName||'Sklep Empik').trim().slice(0,120); const base=(process.env.EMPIK_API_URL||'https://marketplace.empik.com').replace(/\/$/,'');
    if(apiKey.length<12) throw badRequest('Вставьте корректный ключ API Empik');
    let response;
    try { response=await fetch(`${base}/api/account`,{headers:{Authorization:apiKey,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(12000)}); }
    catch { throw Object.assign(new Error('Не удалось соединиться с API Empik'),{status:502}); }
    if(response.status===401||response.status===403) throw badRequest('Empik отклонил ключ API. Создайте новый ключ в кабинете продавца.');
    if(!response.ok) throw Object.assign(new Error(`API Empik ответило кодом ${response.status}`),{status:502});
    let account; try{account=await response.json();}catch{throw Object.assign(new Error('Empik вернул неожиданный ответ вместо данных магазина'),{status:502});}
    if(!account||typeof account!=='object'||Array.isArray(account)) throw Object.assign(new Error('Не удалось подтвердить аккаунт Empik'),{status:502});
    const accountName=String(account.shop_name||account.name||account.email||label).slice(0,120);
    db.prepare(`INSERT INTO integrations(provider,status,account_name,access_token,config_json,updated_at) VALUES('Empik','connected',?,?,?,?) ON CONFLICT(provider) DO UPDATE SET status='connected',account_name=excluded.account_name,access_token=excluded.access_token,config_json=excluded.config_json,updated_at=excluded.updated_at`).run(accountName,encrypt(apiKey),JSON.stringify({base}),new Date().toISOString());
    return json(res,200,{ok:true,accountName});
  }
  const disconnectMatch=url.pathname.match(/^\/api\/integrations\/(Allegro|Empik)\/disconnect$/);
  if(req.method==='POST'&&disconnectMatch) {
    db.prepare(`INSERT INTO integrations(provider,status,updated_at) VALUES(?,'disconnected',?) ON CONFLICT(provider) DO UPDATE SET status='disconnected',account_name=NULL,access_token=NULL,refresh_token=NULL,expires_at=NULL,updated_at=excluded.updated_at`).run(disconnectMatch[1],new Date().toISOString());
    return json(res,200,{ok:true});
  }
  if (req.method==='GET' && url.pathname==='/api/auth/allegro') {
    const config=allegroConfig(); if(!config.clientId||!config.clientSecret) throw badRequest('Najpierw skonfiguruj aplikację Allegro w sekcji Integracje');
    const state=randomUUID(); const verifier=randomBytes(48).toString('base64url'); const challenge=createHash('sha256').update(verifier).digest('base64url');
    db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(Date.now()-600000); db.prepare('INSERT INTO oauth_states(state,provider,code_verifier,created_at) VALUES(?,?,?,?)').run(state,'Allegro',encrypt(verifier),Date.now());
    const urls=allegroUrls(config.environment); const params=new URLSearchParams({response_type:'code',client_id:config.clientId,redirect_uri:config.redirectUri,state,code_challenge_method:'S256',code_challenge:challenge});
    return redirect(res,`${urls.authorize}?${params}`);
  }
  if (req.method==='GET' && url.pathname==='/api/auth/allegro/callback') {
    const code=url.searchParams.get('code'); const state=url.searchParams.get('state'); const saved=db.prepare('SELECT * FROM oauth_states WHERE state=? AND provider=?').get(state,'Allegro');
    if(!code||!saved||Date.now()-saved.created_at>600000) return redirect(res,'/?integration=error'); db.prepare('DELETE FROM oauth_states WHERE state=?').run(state);
    const config=allegroConfig(); const urls=allegroUrls(config.environment); const basic=Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const response=await fetch(urls.token,{method:'POST',headers:{Authorization:`Basic ${basic}`,'Content-Type':'application/x-www-form-urlencoded','User-Agent':config.userAgent},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:config.redirectUri,code_verifier:decrypt(saved.code_verifier)})});
    if(!response.ok) return redirect(res,'/?integration=error'); const token=await response.json(); const expiresAt=new Date(Date.now()+token.expires_in*1000).toISOString();
    let accountName='Konto Allegro'; try{const me=await fetch(`${urls.api}/me`,{headers:{Authorization:`Bearer ${token.access_token}`,Accept:'application/vnd.allegro.public.v1+json','User-Agent':config.userAgent}});if(me.ok){const profile=await me.json();accountName=profile.login||profile.email||accountName;}}catch{}
    db.prepare(`INSERT INTO integrations(provider,status,account_name,access_token,refresh_token,config_json,expires_at,updated_at) VALUES('Allegro','connected',?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET status='connected',account_name=excluded.account_name,access_token=excluded.access_token,refresh_token=excluded.refresh_token,config_json=excluded.config_json,expires_at=excluded.expires_at,updated_at=excluded.updated_at`).run(accountName,encrypt(token.access_token),encrypt(token.refresh_token),JSON.stringify({environment:config.environment}),expiresAt,new Date().toISOString());
    return redirect(res,'/?integration=connected');
  }
  return false;
}

const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.csv':'text/csv; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
async function staticFile(req,res,url) {
  const requested=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
  const publicFiles=new Set(['index.html','app.js','styles.css','sample-data.csv']);
  const safe=normalize(requested).replace(/^(\.\.[/\\])+/, '');
  if(!publicFiles.has(safe)) return false;
  const path=join(ROOT,safe);
  if(!path.startsWith(ROOT)||!existsSync(path)) return false;
  const body=await readFile(path); res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Content-Length':body.length,'Cache-Control':'no-cache'}); res.end(body); return true;
}

const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,APP_URL);
    if(url.pathname.startsWith('/api/')) { const handled=await api(req,res,url); if(handled===false) json(res,404,{error:'Маршрут не найден'}); return; }
    if(await staticFile(req,res,url)) return;
    json(res,404,{error:'Файл не найден'});
  } catch(error) { console.error(error); if(!res.headersSent) json(res,error.status||500,{error:error.status?error.message:'Внутренняя ошибка сервера'}); else res.end(); }
});

server.listen(PORT,'127.0.0.1',()=>console.log(`ProfitPilot: ${APP_URL}`));

process.on('SIGINT',()=>{db.close();server.close(()=>process.exit(0));});
