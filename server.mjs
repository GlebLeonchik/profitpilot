import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

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
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'profitpilot.sqlite');
const MAX_BODY = 5 * 1024 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const AUDIT_RETENTION_DAYS = Math.max(30, Math.min(3650, Number(process.env.AUDIT_RETENTION_DAYS || 365)));
const API_RATE_LIMIT = Math.max(60, Math.min(5000, Number(process.env.API_RATE_LIMIT_PER_MINUTE || 240)));
const MAX_RATE_BUCKETS = 10000;
const MAX_ACTIVE_REQUESTS = Math.max(20, Math.min(1000, Number(process.env.MAX_ACTIVE_REQUESTS || 100)));
const SESSION_COOKIE = IS_PRODUCTION ? '__Host-profitpilot_session' : 'profitpilot_session';
const configuredSessionSecret = process.env.SESSION_SECRET || '';
const configuredTokenKey = process.env.TOKEN_ENCRYPTION_KEY || '';

if (IS_PRODUCTION && configuredSessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters in production');
if (IS_PRODUCTION && configuredTokenKey.length < 32) throw new Error('TOKEN_ENCRYPTION_KEY must contain at least 32 characters in production');

const runtimeSessionSecret = configuredSessionSecret || randomBytes(32).toString('base64url');
const runtimeTokenKey = configuredTokenKey || runtimeSessionSecret;
if (!configuredSessionSecret) console.warn('ProfitPilot: using an ephemeral development session secret');
if (!configuredTokenKey) console.warn('ProfitPilot: TOKEN_ENCRYPTION_KEY is not set; development fallback is active');

await mkdir(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const demoProducts = [
  ['ONEBLADE-2724','Philips OneBlade QP2724','Allegro',126,119,70,11.2,8.1,4.2,2.6,116.90],
  ['AIRFRY-9252','Philips Airfryer HD9252','Allegro',54,429,286,40.3,17.4,9.5,12.1,439.00],
  ['LEGO-42151','LEGO Technic Bugatti','Empik',43,229,151,27.5,7.2,6.4,3.1,224.90],
  ['XIAOMI-BUDS5','Xiaomi Redmi Buds 5','Allegro',187,149,89,13.8,5.1,4.1,1.8,152.00],
  ['BRAUN-BT5420','Braun Beard Trimmer 5','Empik',68,189,118,22.7,13.6,5.5,4.2,184.99],
  ['TEFAL-GC3050','Tefal OptiGrill GC3050','Allegro',39,479,341,45.1,35.8,11.2,14.5,469.00],
  ['ORALB-IO3','Oral-B iO Series 3','Empik',92,289,202,34.7,20.4,6.2,9.5,279.00],
  ['LOGI-MX3S','Logitech MX Master 3S','Allegro',61,419,286,39.4,12.2,5.9,5.1,429.00],
  ['SAMSUNG-T7','Samsung SSD T7 1TB','Empik',47,399,304,47.9,18.5,5.7,4.4,389.00],
  ['DYSON-V8','Dyson V8 Advanced','Allegro',29,1299,1035,122.1,96.4,18.3,31.2,1279.00]
];

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function columnsOf(name) {
  return tableExists(name) ? db.prepare(`PRAGMA table_info(${name})`).all().map(column => column.name) : [];
}

function migrateDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memberships (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','admin','analyst')),
      PRIMARY KEY(user_id, organization_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      ip_hash TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organization_settings (
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      setting_key TEXT NOT NULL,
      value_encrypted TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(organization_id, setting_key)
    );
  `);

  const now = new Date().toISOString();
  let legacyOrganization = db.prepare("SELECT id FROM organizations WHERE name='Legacy demo'").get()?.id;
  const oldProductColumns = columnsOf('products');
  if (oldProductColumns.length && !oldProductColumns.includes('organization_id')) {
    if (!legacyOrganization) legacyOrganization = Number(db.prepare('INSERT INTO organizations(name,created_at) VALUES(?,?)').run('Legacy demo', now).lastInsertRowid);
    db.exec(`
      ALTER TABLE products RENAME TO products_legacy;
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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
        market_price REAL,
        market_source TEXT,
        market_updated_at TEXT,
        UNIQUE(organization_id, sku, channel)
      );
    `);
    db.prepare(`INSERT INTO products(id,organization_id,sku,name,channel,units,price,cost,commission,ads,shipping,returns_cost,imported_at,market_price,market_source,market_updated_at)
      SELECT id,?,sku,name,channel,units,price,cost,commission,ads,shipping,returns_cost,imported_at,market_price,market_source,market_updated_at FROM products_legacy`).run(legacyOrganization);
    db.exec('DROP TABLE products_legacy;');
  } else if (!oldProductColumns.length) {
    db.exec(`CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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
      market_price REAL,
      market_source TEXT,
      market_updated_at TEXT,
      UNIQUE(organization_id, sku, channel)
    );`);
  }

  const oldIntegrationColumns = columnsOf('integrations');
  if (oldIntegrationColumns.length && !oldIntegrationColumns.includes('organization_id')) {
    if (!legacyOrganization) legacyOrganization = Number(db.prepare('INSERT INTO organizations(name,created_at) VALUES(?,?)').run('Legacy demo', now).lastInsertRowid);
    db.exec(`
      ALTER TABLE integrations RENAME TO integrations_legacy;
      CREATE TABLE integrations (
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disconnected',
        account_name TEXT,
        access_token TEXT,
        refresh_token TEXT,
        expires_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(organization_id, provider)
      );
    `);
    db.prepare(`INSERT INTO integrations(organization_id,provider,status,account_name,access_token,refresh_token,expires_at,updated_at)
      SELECT ?,provider,status,account_name,access_token,refresh_token,expires_at,updated_at FROM integrations_legacy`).run(legacyOrganization);
    db.exec('DROP TABLE integrations_legacy;');
  } else if (!oldIntegrationColumns.length) {
    db.exec(`CREATE TABLE integrations (
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'disconnected',
      account_name TEXT,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(organization_id, provider)
    );`);
  }

  if (tableExists('oauth_states')) db.exec('DROP TABLE oauth_states;');
  db.exec(`CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY,
    session_hash TEXT NOT NULL,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`);
}

migrateDatabase();
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
db.prepare('DELETE FROM audit_events WHERE created_at < ?').run(new Date(Date.now()-AUDIT_RETENTION_DAYS*24*60*60*1000).toISOString());

const upsertProduct = db.prepare(`
  INSERT INTO products (organization_id,sku,name,channel,units,price,cost,commission,ads,shipping,returns_cost,imported_at,market_price,market_source,market_updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(organization_id,sku,channel) DO UPDATE SET
    name=excluded.name, units=excluded.units, price=excluded.price, cost=excluded.cost,
    commission=excluded.commission, ads=excluded.ads, shipping=excluded.shipping,
    returns_cost=excluded.returns_cost, imported_at=excluded.imported_at,
    market_price=COALESCE(excluded.market_price,products.market_price),
    market_source=COALESCE(excluded.market_source,products.market_source),
    market_updated_at=COALESCE(excluded.market_updated_at,products.market_updated_at)
`);

function seedDemo(organizationId, force = false) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM products WHERE organization_id=?').get(organizationId).count;
  if (count && !force) return;
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    if (force) db.prepare('DELETE FROM products WHERE organization_id=?').run(organizationId);
    for (const row of demoProducts) {
      const [sku,name,channel,units,price,cost,commission,ads,shipping,returns,marketPrice] = row;
      upsertProduct.run(organizationId,sku,name,channel,units,price,cost,commission,ads,shipping,returns,now,marketPrice,'demo',now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function rowsForPeriod(organizationId, days = 30) {
  const scale = Math.max(1, Math.min(365, Number(days) || 30)) / 30;
  return db.prepare(`SELECT id,sku,name,channel,units,price,cost,commission,ads,shipping,returns_cost AS returns,
    market_price AS marketPrice,market_source AS marketSource,market_updated_at AS marketUpdatedAt
    FROM products WHERE organization_id=? ORDER BY name`).all(organizationId)
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
    const targetMargin=.15;
    const targetPrice = unitCosts / (1-targetMargin);
    const adShare = p.ads / p.price;
    const marketPrice=Number(p.marketPrice||0);
    const marketAge=p.marketUpdatedAt?Date.now()-new Date(p.marketUpdatedAt).getTime():Infinity;
    const marketFresh=marketPrice>0&&Number.isFinite(marketAge)&&marketAge<=72*60*60*1000;
    const marketCeiling=marketFresh?marketPrice*.99:0;
    if(adShare > .09) return {
      sku:p.sku,channel:p.channel,type:status==='loss'?'danger':'warning',title:'Снизить расходы на рекламу',
      description:`${p.name}: реклама забирает ${(adShare*100).toFixed(1)}% цены. Сократите ставку примерно на 30%. Рыночный ориентир: ${marketFresh?`${marketPrice.toFixed(2)} zł`:'нет свежих данных'}.`,
      action:'Проверить рекламу',potential:p.ads*.3*p.units,kind:'ads',marketPrice:marketFresh?marketPrice:null
    };
    if(!marketFresh) return {
      sku:p.sku,channel:p.channel,type:'info',kind:marketPrice?'market_stale':'market_missing',title:`Обновить цену рынка для ${p.name}`,
      description:marketPrice?`Последний ориентир ${marketPrice.toFixed(2)} zł устарел. До обновления повышение цены заблокировано.`:'Нет свежей цены сопоставимых предложений. Повышение цены заблокировано, пока рынок не проверен.',
      action:'Указать цену рынка',potential:0,requiresData:true,marketPrice:marketPrice||null
    };
    if(targetPrice<=marketCeiling&&targetPrice>p.price) return {
      sku:p.sku,channel:p.channel,type:status==='loss'?'danger':'warning',kind:'market_safe_price',title:`Осторожно поднять цену ${p.name}`,
      description:`Цена ${targetPrice.toFixed(2)} zł даёт маржу 15% и остаётся ниже рыночного ориентира ${marketPrice.toFixed(2)} zł. Рекомендуемый потолок: ${marketCeiling.toFixed(2)} zł.`,
      action:`Цена → ${targetPrice.toFixed(2)} zł`,potential:(targetPrice-p.price)*p.units,marketPrice,marketCeiling
    };
    const viableCosts=marketCeiling*(1-targetMargin);
    const reduction=Math.max(0,unitCosts-viableCosts);
    return {
      sku:p.sku,channel:p.channel,type:status==='loss'?'danger':'warning',kind:'required_savings',title:'Снижать затраты, а не повышать цену',
      description:`Для маржи 15% нужна цена ${targetPrice.toFixed(2)} zł, но рынок около ${marketPrice.toFixed(2)} zł. Сократите затраты минимум на ${reduction.toFixed(2)} zł с единицы или пересмотрите товар.`,
      action:'Разобрать затраты',potential:reduction*p.units,marketPrice,marketCeiling
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
    if (quoted) throw badRequest('Некорректные кавычки в CSV');
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
    if (!item.sku || !item.name || required.slice(3).some(key => !Number.isFinite(item[key]) || item[key] < 0 || item[key] > 10000000)) throw badRequest(`Ошибка данных в строке ${index + 2}`);
    if (!['Allegro','Empik'].includes(item.channel)) throw badRequest(`Строка ${index + 2}: канал должен быть Allegro или Empik`);
    if(row.market_price!==undefined&&String(row.market_price).trim()!=='') {
      item.marketPrice=Number(String(row.market_price).replace(',','.'));
      if(!Number.isFinite(item.marketPrice)||item.marketPrice<=0||item.marketPrice>10000000) throw badRequest(`Строка ${index + 2}: некорректная market_price`);
    }
    return item;
  });
}

function badRequest(message) { const error = new Error(message); error.status = 400; return error; }
function unauthorized(message = 'Требуется вход') { const error = new Error(message); error.status = 401; return error; }
function forbidden(message = 'Недостаточно прав') { const error = new Error(message); error.status = 403; return error; }
function json(res, status, data, headers={}) {
  const body=JSON.stringify(data);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store',...headers});
  res.end(body);
}
function redirect(res, location, headers={}) { res.writeHead(302, { Location: location, 'Cache-Control':'no-store', ...headers }); res.end(); }

async function readBody(req) {
  const declaredLength=Number(req.headers['content-length']||0);
  if(Number.isFinite(declaredLength)&&declaredLength>MAX_BODY) throw Object.assign(new Error('Файл превышает 5 MB'),{status:413});
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if(size>MAX_BODY) throw Object.assign(new Error('Файл превышает 5 MB'),{status:413});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (type !== 'application/json') throw Object.assign(new Error('Ожидается application/json'), { status: 415 });
  try { return JSON.parse(await readBody(req) || '{}'); }
  catch { throw badRequest('Некорректный JSON'); }
}

function sha256(value) { return createHash('sha256').update(value).digest('base64url'); }
function safeEqual(a,b) {
  const left=Buffer.from(String(a)); const right=Buffer.from(String(b));
  return left.length===right.length && timingSafeEqual(left,right);
}
function hashPassword(password, salt=randomBytes(16).toString('base64url')) {
  const hash=scryptSync(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString('base64url');
  return `scrypt$32768$8$1$${salt}$${hash}`;
}
function verifyPassword(password, encoded) {
  try {
    const [algorithm,n,r,p,salt,expected]=encoded.split('$');
    if(algorithm!=='scrypt') return false;
    const actual=scryptSync(password,salt,64,{N:Number(n),r:Number(r),p:Number(p),maxmem:64*1024*1024}).toString('base64url');
    return safeEqual(actual,expected);
  } catch { return false; }
}
function encryptionKey() { return createHash('sha256').update(runtimeTokenKey).digest(); }
function encrypt(value) {
  if(!value)return null;
  const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),encrypted].map(b=>b.toString('base64url')).join('.');
}
function decrypt(value) {
  if(!value)return null;
  try {
    const [iv,tag,encrypted]=String(value).split('.').map(part=>Buffer.from(part,'base64url'));
    const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8');
  } catch { return null; }
}
function getOrgSetting(organizationId,key) {
  const row=db.prepare('SELECT value_encrypted FROM organization_settings WHERE organization_id=? AND setting_key=?').get(organizationId,key);
  return decrypt(row?.value_encrypted);
}
function setOrgSetting(organizationId,key,value) {
  db.prepare(`INSERT INTO organization_settings(organization_id,setting_key,value_encrypted,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(organization_id,setting_key) DO UPDATE SET value_encrypted=excluded.value_encrypted,updated_at=excluded.updated_at`)
    .run(organizationId,key,encrypt(value),new Date().toISOString());
}
function allegroConfig(organizationId) {
  const clientId=process.env.ALLEGRO_CLIENT_ID||getOrgSetting(organizationId,'allegro.client_id');
  const clientSecret=process.env.ALLEGRO_CLIENT_SECRET||getOrgSetting(organizationId,'allegro.client_secret');
  const environment=process.env.ALLEGRO_ENV||getOrgSetting(organizationId,'allegro.environment')||'production';
  const userAgent=process.env.ALLEGRO_USER_AGENT||getOrgSetting(organizationId,'allegro.user_agent')||'ProfitPilot/0.4';
  const redirectUri=process.env.ALLEGRO_REDIRECT_URI||`${APP_URL}/api/auth/allegro/callback`;
  return {clientId,clientSecret,environment:environment==='sandbox'?'sandbox':'production',userAgent,redirectUri,configured:Boolean(clientId&&clientSecret)};
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie||'').split(';').map(part=>part.trim()).filter(Boolean).map(part=>{
    const i=part.indexOf('='); return i<0?[part,'']:[part.slice(0,i),decodeURIComponent(part.slice(i+1))];
  }));
}
function cookieHeader(token, maxAgeSeconds) {
  const flags=[`${SESSION_COOKIE}=${encodeURIComponent(token)}`,'Path=/','HttpOnly','SameSite=Lax',`Max-Age=${maxAgeSeconds}`];
  if(IS_PRODUCTION) flags.push('Secure');
  return flags.join('; ');
}
function requestIp(req) {
  if (process.env.TRUST_PROXY === '1') return String(req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '';
  return req.socket.remoteAddress || '';
}
function clientFingerprint(value) { return sha256(`${runtimeSessionSecret}:${value}`).slice(0,32); }

function createSession(req,userId,organizationId) {
  const token=randomBytes(32).toString('base64url'); const tokenHash=sha256(token); const csrf=randomBytes(24).toString('base64url'); const now=Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare(`INSERT INTO sessions(token_hash,user_id,organization_id,csrf_token,created_at,expires_at,last_seen_at,ip_hash,user_agent)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(tokenHash,userId,organizationId,csrf,now,now+SESSION_TTL_MS,now,clientFingerprint(requestIp(req)),String(req.headers['user-agent']||'').slice(0,300));
  db.prepare(`DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (
    SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 10
  )`).run(userId,userId);
  return {token,csrf};
}

function getAuth(req) {
  const token=parseCookies(req)[SESSION_COOKIE];
  if(!token) return null;
  const tokenHash=sha256(token);
  const row=db.prepare(`SELECT s.token_hash,s.csrf_token,s.expires_at,s.last_seen_at,u.id AS user_id,u.email,o.id AS organization_id,o.name AS organization_name,m.role
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN organizations o ON o.id=s.organization_id
    JOIN memberships m ON m.user_id=u.id AND m.organization_id=o.id WHERE s.token_hash=?`).get(tokenHash);
  if(!row || row.expires_at<=Date.now()) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash); return null; }
  if(Date.now()-row.last_seen_at>5*60*1000) db.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').run(Date.now(),tokenHash);
  return row;
}

function requireAuth(req) { return req.auth || (()=>{throw unauthorized();})(); }
function requireCsrf(req) {
  const auth=requireAuth(req);
  const supplied=req.headers['x-csrf-token'];
  if(!supplied || !safeEqual(supplied,auth.csrf_token)) throw forbidden('Недействительный CSRF-токен');
}
function requireRole(req,roles) { const auth=requireAuth(req); if(!roles.includes(auth.role)) throw forbidden(); return auth; }

const rateBuckets=new Map();
let rateOperations=0;
function rateLimit(req,key,limit,windowMs,identity=requestIp(req)) {
  const now=Date.now(); const bucketKey=`${key}:${clientFingerprint(identity)}`;
  let bucket=rateBuckets.get(bucketKey);
  if(!bucket||bucket.resetAt<=now) bucket={count:0,resetAt:now+windowMs};
  bucket.count+=1; rateBuckets.set(bucketKey,bucket);
  rateOperations+=1;
  if(rateOperations%250===0||rateBuckets.size>MAX_RATE_BUCKETS) {
    for(const [storedKey,stored] of rateBuckets) if(stored.resetAt<=now) rateBuckets.delete(storedKey);
    while(rateBuckets.size>MAX_RATE_BUCKETS) rateBuckets.delete(rateBuckets.keys().next().value);
  }
  if(bucket.count>limit) {
    const error=new Error('Слишком много запросов. Повторите позже.'); error.status=429; error.retryAfter=Math.ceil((bucket.resetAt-now)/1000); throw error;
  }
}

function audit(auth,action,targetType=null,targetId=null,metadata=null) {
  db.prepare('INSERT INTO audit_events(organization_id,user_id,action,target_type,target_id,metadata,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(auth?.organization_id??null,auth?.user_id??null,action,targetType,targetId,metadata?JSON.stringify(metadata):null,new Date().toISOString());
}

function validateCredentials(body) {
  const email=String(body.email||'').normalize('NFKC').trim().toLowerCase(); const password=String(body.password||'');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254) throw badRequest('Укажите корректный e-mail');
  if(password.length<12||password.length>200) throw badRequest('Пароль должен содержать от 12 до 200 символов');
  const common=new Set(['password123!','qwerty123456','123456789012','profitpilot123']);
  if(common.has(password.toLowerCase())||password.toLowerCase().includes(email.split('@')[0])) throw badRequest('Выберите более уникальный пароль');
  return {email,password};
}

async function authApi(req,res,url) {
  if(req.method==='POST'&&url.pathname==='/api/auth/register') {
    rateLimit(req,'register',5,60*60*1000);
    const body=await readJson(req); const {email,password}=validateCredentials(body);
    const organizationName=String(body.organizationName||'').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,120);
    if(organizationName.length<2) throw badRequest('Укажите название магазина или компании');
    if(db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw Object.assign(new Error('Аккаунт с таким e-mail уже существует'),{status:409});
    const now=new Date().toISOString(); let userId; let organizationId;
    db.exec('BEGIN');
    try {
      userId=Number(db.prepare('INSERT INTO users(email,password_hash,created_at) VALUES(?,?,?)').run(email,hashPassword(password),now).lastInsertRowid);
      organizationId=Number(db.prepare('INSERT INTO organizations(name,created_at) VALUES(?,?)').run(organizationName,now).lastInsertRowid);
      db.prepare("INSERT INTO memberships(user_id,organization_id,role) VALUES(?,?,'owner')").run(userId,organizationId);
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
    seedDemo(organizationId);
    const session=createSession(req,userId,organizationId);
    const auth={user_id:userId,organization_id:organizationId}; audit(auth,'account.registered','organization',String(organizationId));
    return json(res,201,{user:{id:userId,email},organization:{id:organizationId,name:organizationName},csrfToken:session.csrf},{'Set-Cookie':cookieHeader(session.token,SESSION_TTL_MS/1000)});
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/login') {
    rateLimit(req,'login',10,15*60*1000);
    const body=await readJson(req); const email=String(body.email||'').normalize('NFKC').trim().toLowerCase(); const password=String(body.password||'');
    rateLimit(req,'login-account',10,15*60*1000,email);
    const user=db.prepare('SELECT id,email,password_hash FROM users WHERE email=?').get(email);
    const fallback='scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const valid=verifyPassword(password,user?.password_hash||fallback);
    if(!user||!valid) throw unauthorized('Неверный e-mail или пароль');
    const membership=db.prepare(`SELECT m.organization_id,m.role,o.name FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=? ORDER BY m.role='owner' DESC LIMIT 1`).get(user.id);
    if(!membership) throw forbidden('Аккаунт не состоит в организации');
    db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(new Date().toISOString(),user.id);
    const session=createSession(req,user.id,membership.organization_id);
    const auth={user_id:user.id,organization_id:membership.organization_id}; audit(auth,'account.login');
    return json(res,200,{user:{id:user.id,email:user.email},organization:{id:membership.organization_id,name:membership.name},role:membership.role,csrfToken:session.csrf},{'Set-Cookie':cookieHeader(session.token,SESSION_TTL_MS/1000)});
  }
  if(req.method==='GET'&&url.pathname==='/api/auth/me') {
    const auth=requireAuth(req);
    return json(res,200,{user:{id:auth.user_id,email:auth.email},organization:{id:auth.organization_id,name:auth.organization_name},role:auth.role,csrfToken:auth.csrf_token});
  }
  if(req.method==='PATCH'&&url.pathname==='/api/account/profile') {
    requireCsrf(req); const auth=requireRole(req,['owner','admin']); const body=await readJson(req);
    const organizationName=String(body.organizationName||'').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,120);
    if(organizationName.length<2) throw badRequest('Укажите название магазина или компании');
    db.prepare('UPDATE organizations SET name=? WHERE id=?').run(organizationName,auth.organization_id);
    audit(auth,'account.profile.updated','organization',String(auth.organization_id));
    return json(res,200,{ok:true,organization:{id:auth.organization_id,name:organizationName}});
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/logout') {
    requireCsrf(req); const auth=requireAuth(req); db.prepare('DELETE FROM sessions WHERE token_hash=?').run(auth.token_hash); audit(auth,'account.logout');
    return json(res,200,{ok:true},{'Set-Cookie':cookieHeader('',0)});
  }
  if(req.method==='GET'&&url.pathname==='/api/security/sessions') {
    const auth=requireAuth(req);
    const sessions=db.prepare('SELECT token_hash,created_at,last_seen_at,expires_at,user_agent FROM sessions WHERE user_id=? ORDER BY created_at DESC').all(auth.user_id);
    return json(res,200,{sessions:sessions.map(session=>({
      current:session.token_hash===auth.token_hash,
      createdAt:new Date(session.created_at).toISOString(),
      lastSeenAt:new Date(session.last_seen_at).toISOString(),
      expiresAt:new Date(session.expires_at).toISOString(),
      device:session.user_agent||'Unknown device'
    }))});
  }
  if(req.method==='DELETE'&&url.pathname==='/api/security/sessions') {
    requireCsrf(req); const auth=requireAuth(req);
    const result=db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(auth.user_id,auth.token_hash);
    audit(auth,'security.sessions.revoked',null,null,{count:result.changes});
    return json(res,200,{ok:true,revoked:result.changes});
  }
  if(req.method==='PATCH'&&url.pathname==='/api/security/password') {
    requireCsrf(req); rateLimit(req,'password-change',5,60*60*1000);
    const auth=requireAuth(req); const body=await readJson(req);
    const user=db.prepare('SELECT password_hash,email FROM users WHERE id=?').get(auth.user_id);
    if(!verifyPassword(String(body.currentPassword||''),user.password_hash)) throw badRequest('Текущий пароль указан неверно');
    const {password:newPassword}=validateCredentials({email:user.email,password:body.newPassword});
    if(verifyPassword(newPassword,user.password_hash)) throw badRequest('Новый пароль должен отличаться от текущего');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(newPassword),auth.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(auth.user_id,auth.token_hash);
    audit(auth,'security.password.changed');
    return json(res,200,{ok:true});
  }
  return false;
}

async function api(req, res, url) {
  if (req.method==='GET' && url.pathname==='/api/health') return json(res,200,{ok:true,version:'0.4.0'});
  const authHandled=await authApi(req,res,url); if(authHandled!==false) return authHandled;
  const auth=requireAuth(req);
  const days = Number(url.searchParams.get('days') || 30);
  if (req.method==='GET' && url.pathname==='/api/products') return json(res,200,{products:rowsForPeriod(auth.organization_id,days)});
  if (req.method==='POST' && url.pathname==='/api/products') {
    requireCsrf(req); const body=await readJson(req);
    const product={sku:String(body.sku||'').normalize('NFKC').trim().slice(0,120),name:String(body.name||'').normalize('NFKC').trim().slice(0,300),channel:body.channel==='Empik'?'Empik':'Allegro'};
    for(const field of ['units','price','cost','commission','ads','shipping','returns']) {
      product[field]=Number(body[field]||0);
      if(!Number.isFinite(product[field])||product[field]<0||product[field]>10000000) throw badRequest(`Invalid product value: ${field}`);
    }
    if(!product.sku||!product.name) throw badRequest('SKU and product name are required');
    const now=new Date().toISOString();
    try { upsertProduct.run(auth.organization_id,product.sku,product.name,product.channel,product.units,product.price,product.cost,product.commission,product.ads,product.shipping,product.returns,now,null,null,null); }
    catch(error) { if(String(error.message).includes('UNIQUE')) throw Object.assign(new Error('A product with this SKU already exists in the selected channel'),{status:409}); throw error; }
    const saved=db.prepare('SELECT id FROM products WHERE organization_id=? AND sku=? AND channel=?').get(auth.organization_id,product.sku,product.channel);
    audit(auth,'product.created','product',String(saved.id));
    return json(res,201,{ok:true,product:rowsForPeriod(auth.organization_id,30).find(item=>item.id===saved.id)});
  }
  const productMatch=url.pathname.match(/^\/api\/products\/(\d+)$/);
  if(req.method==='DELETE'&&productMatch) {
    requireCsrf(req); const result=db.prepare('DELETE FROM products WHERE id=? AND organization_id=?').run(Number(productMatch[1]),auth.organization_id);
    if(!result.changes) throw Object.assign(new Error('Product not found'),{status:404});
    audit(auth,'product.deleted','product',productMatch[1]); return json(res,200,{ok:true});
  }
  const economicsMatch=url.pathname.match(/^\/api\/products\/(\d+)\/economics$/);
  if(req.method==='PATCH'&&economicsMatch) {
    requireCsrf(req); const body=await readJson(req); const values={};
    for(const field of ['cost','commission','ads','shipping','returns']) { values[field]=Number(body[field]); if(!Number.isFinite(values[field])||values[field]<0||values[field]>10000000) throw badRequest(`Invalid product value: ${field}`); }
    const result=db.prepare('UPDATE products SET cost=?,commission=?,ads=?,shipping=?,returns_cost=?,imported_at=? WHERE id=? AND organization_id=?')
      .run(values.cost,values.commission,values.ads,values.shipping,values.returns,new Date().toISOString(),Number(economicsMatch[1]),auth.organization_id);
    if(!result.changes) throw Object.assign(new Error('Product not found'),{status:404});
    audit(auth,'product.economics.updated','product',economicsMatch[1]); return json(res,200,{ok:true});
  }
  const marketMatch=url.pathname.match(/^\/api\/products\/(\d+)\/market$/);
  if(req.method==='PATCH'&&marketMatch) {
    requireCsrf(req); const body=await readJson(req); const marketPrice=Number(body.marketPrice);
    if(!Number.isFinite(marketPrice)||marketPrice<=0||marketPrice>10000000) throw badRequest('Укажите корректную цену рынка');
    const result=db.prepare("UPDATE products SET market_price=?,market_source='manual',market_updated_at=? WHERE id=? AND organization_id=?")
      .run(marketPrice,new Date().toISOString(),Number(marketMatch[1]),auth.organization_id);
    if(!result.changes) throw Object.assign(new Error('Товар не найден'),{status:404});
    audit(auth,'product.market_price.updated','product',marketMatch[1]);
    return json(res,200,{ok:true});
  }
  if (req.method==='GET' && url.pathname==='/api/dashboard') {
    const products=rowsForPeriod(auth.organization_id,days);
    const totals=products.reduce((a,p)=>({revenue:a.revenue+p.revenue,profit:a.profit+p.profit,units:a.units+p.units}),{revenue:0,profit:0,units:0});
    return json(res,200,{totals:{...totals,margin:totals.revenue?totals.profit/totals.revenue*100:0},products,recommendations:recommendations(products)});
  }
  if (req.method==='POST' && url.pathname==='/api/import/csv') {
    requireCsrf(req); rateLimit(req,`import:${auth.user_id}`,20,60*60*1000);
    const type=String(req.headers['content-type']||'').split(';')[0].trim(); if(type!=='text/csv'&&type!=='application/vnd.ms-excel') throw Object.assign(new Error('Ожидается CSV-файл'),{status:415});
    const items=parseCSV(await readBody(req)); const now=new Date().toISOString(); db.exec('BEGIN');
    try {
      for(const p of items) upsertProduct.run(auth.organization_id,p.sku,p.name,p.channel,p.units,p.price,p.cost,p.commission,p.ads,p.shipping,p.returns,now,p.marketPrice||null,p.marketPrice?'csv':null,p.marketPrice?now:null);
      db.exec('COMMIT');
    } catch(error){db.exec('ROLLBACK');throw error;}
    audit(auth,'products.csv.imported','organization',String(auth.organization_id),{count:items.length});
    return json(res,200,{ok:true,imported:items.length});
  }
  if (req.method==='POST' && url.pathname==='/api/demo/reset') {
    requireCsrf(req); requireRole(req,['owner','admin']); seedDemo(auth.organization_id,true); audit(auth,'products.demo.reset'); return json(res,200,{ok:true});
  }
  if (req.method==='GET' && url.pathname==='/api/integrations') {
    const saved=db.prepare('SELECT provider,status,account_name AS accountName,expires_at AS expiresAt,updated_at AS updatedAt FROM integrations WHERE organization_id=?').all(auth.organization_id);
    const map=Object.fromEntries(saved.map(row=>[row.provider,row]));
    const config=allegroConfig(auth.organization_id);
    return json(res,200,{integrations:[map.Allegro||{provider:'Allegro',status:'disconnected'},map.Empik||{provider:'Empik',status:'disconnected'}],allegroConfigured:config.configured,allegroConfig:{environment:config.environment,userAgent:config.userAgent,redirectUri:config.redirectUri,clientId:config.clientId||'',hasClientSecret:Boolean(config.clientSecret)}});
  }
  if (req.method==='POST' && url.pathname==='/api/integrations/allegro/config') {
    requireCsrf(req); requireRole(req,['owner','admin']); rateLimit(req,`allegro-config:${auth.user_id}`,20,60*60*1000);
    const body=await readJson(req);
    const clientId=String(body.clientId||'').normalize('NFKC').trim();
    const clientSecret=String(body.clientSecret||'').trim();
    const userAgent=String(body.userAgent||'').normalize('NFKC').replace(/[\r\n\0]/g,'').trim();
    const environment=body.environment==='sandbox'?'sandbox':'production';
    if(!/^[A-Za-z0-9_-]{8,200}$/.test(clientId)) throw badRequest('Invalid Allegro Client ID');
    if(clientSecret&&(clientSecret.length<8||clientSecret.length>500)) throw badRequest('Invalid Allegro Client Secret');
    if(!clientSecret&&!getOrgSetting(auth.organization_id,'allegro.client_secret')&&!process.env.ALLEGRO_CLIENT_SECRET) throw badRequest('Allegro Client Secret is required');
    if(userAgent.length<5||userAgent.length>300) throw badRequest('Invalid Allegro User-Agent');
    setOrgSetting(auth.organization_id,'allegro.client_id',clientId);
    if(clientSecret)setOrgSetting(auth.organization_id,'allegro.client_secret',clientSecret);
    setOrgSetting(auth.organization_id,'allegro.user_agent',userAgent);
    setOrgSetting(auth.organization_id,'allegro.environment',environment);
    audit(auth,'integration.config.updated','integration','Allegro',{environment});
    return json(res,200,{ok:true,configured:true,redirectUri:allegroConfig(auth.organization_id).redirectUri});
  }
  if (req.method==='DELETE' && url.pathname==='/api/integrations/allegro') {
    requireCsrf(req); requireRole(req,['owner','admin']);
    db.prepare("DELETE FROM integrations WHERE organization_id=? AND provider='Allegro'").run(auth.organization_id);
    audit(auth,'integration.disconnected','integration','Allegro');
    return json(res,200,{ok:true});
  }
  if (req.method==='POST' && url.pathname==='/api/integrations/empik/config') {
    requireCsrf(req); requireRole(req,['owner','admin']); rateLimit(req,`empik-config:${auth.user_id}`,20,60*60*1000);
    const body=await readJson(req);
    const accountName=String(body.accountName||'').normalize('NFKC').replace(/[\r\n\0]/g,'').trim().slice(0,120);
    const apiKey=String(body.apiKey||'').trim();
    const existing=db.prepare("SELECT access_token FROM integrations WHERE organization_id=? AND provider='Empik'").get(auth.organization_id);
    if(accountName.length<2)throw badRequest('Empik shop name is required');
    if(apiKey&&(apiKey.length<12||apiKey.length>1000))throw badRequest('Invalid Empik API key');
    if(!apiKey&&!existing?.access_token)throw badRequest('Empik API key is required');
    db.prepare(`INSERT INTO integrations(organization_id,provider,status,account_name,access_token,updated_at) VALUES(?,'Empik','configured',?,?,?)
      ON CONFLICT(organization_id,provider) DO UPDATE SET status='configured',account_name=excluded.account_name,access_token=COALESCE(excluded.access_token,integrations.access_token),updated_at=excluded.updated_at`)
      .run(auth.organization_id,accountName,apiKey?encrypt(apiKey):null,new Date().toISOString());
    audit(auth,'integration.config.updated','integration','Empik');
    return json(res,200,{ok:true,status:'configured'});
  }
  if (req.method==='DELETE' && url.pathname==='/api/integrations/empik') {
    requireCsrf(req); requireRole(req,['owner','admin']);
    db.prepare("DELETE FROM integrations WHERE organization_id=? AND provider='Empik'").run(auth.organization_id);
    audit(auth,'integration.disconnected','integration','Empik');
    return json(res,200,{ok:true});
  }
  if (req.method==='GET' && url.pathname==='/api/auth/allegro') {
    const supplied=url.searchParams.get('csrf'); if(!supplied||!safeEqual(supplied,auth.csrf_token)) throw forbidden('Недействительный CSRF-токен');
    const config=allegroConfig(auth.organization_id);
    if(!config.configured) throw badRequest('Сначала настройте ключи приложения Allegro');
    rateLimit(req,`oauth:${auth.user_id}`,10,60*60*1000);
    const state=randomBytes(32).toString('base64url'); db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(Date.now()-600000);
    db.prepare('INSERT INTO oauth_states(state_hash,session_hash,organization_id,provider,created_at) VALUES(?,?,?,?,?)').run(sha256(state),auth.token_hash,auth.organization_id,'Allegro',Date.now());
    const base=config.environment==='sandbox'?'https://allegro.pl.allegrosandbox.pl/auth/oauth/authorize':'https://allegro.pl/auth/oauth/authorize';
    const params=new URLSearchParams({response_type:'code',client_id:config.clientId,redirect_uri:config.redirectUri,state});
    return redirect(res,`${base}?${params}`);
  }
  if (req.method==='GET' && url.pathname==='/api/auth/allegro/callback') {
    const code=url.searchParams.get('code'); const state=url.searchParams.get('state');
    const saved=state?db.prepare("SELECT * FROM oauth_states WHERE state_hash=? AND provider='Allegro'").get(sha256(state)):null;
    if(!code||!saved||saved.session_hash!==auth.token_hash||saved.organization_id!==auth.organization_id||Date.now()-saved.created_at>600000) return redirect(res,'/?integration=error');
    db.prepare('DELETE FROM oauth_states WHERE state_hash=?').run(saved.state_hash);
    const config=allegroConfig(saved.organization_id);
    if(!config.configured)return redirect(res,'/?integration=error');
    const tokenUrl=config.environment==='sandbox'?'https://allegro.pl.allegrosandbox.pl/auth/oauth/token':'https://allegro.pl/auth/oauth/token';
    const basic=Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const response=await fetch(tokenUrl,{method:'POST',headers:{Authorization:`Basic ${basic}`,'Content-Type':'application/x-www-form-urlencoded','User-Agent':config.userAgent},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:config.redirectUri})});
    if(!response.ok) return redirect(res,'/?integration=error');
    const token=await response.json(); const expiresAt=new Date(Date.now()+token.expires_in*1000).toISOString();
    db.prepare(`INSERT INTO integrations(organization_id,provider,status,access_token,refresh_token,expires_at,updated_at) VALUES(?,'Allegro','connected',?,?,?,?)
      ON CONFLICT(organization_id,provider) DO UPDATE SET status='connected',access_token=excluded.access_token,refresh_token=excluded.refresh_token,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
      .run(auth.organization_id,encrypt(token.access_token),encrypt(token.refresh_token),expiresAt,new Date().toISOString());
    audit(auth,'integration.connected','integration','Allegro');
    return redirect(res,'/?integration=connected');
  }
  return false;
}

const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.csv':'text/csv; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
async function staticFile(req,res,url) {
  let requested;
  try { requested=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)); }
  catch { throw badRequest('Некорректный URL'); }
  const publicFiles=new Set(['index.html','app.js','styles.css','sample-data.csv']);
  const safe=normalize(requested).replace(/^(\.\.[/\\])+/, '');
  if(!publicFiles.has(safe)) return false;
  const path=join(ROOT,safe);
  if(!path.startsWith(ROOT)||!existsSync(path)) return false;
  const body=await readFile(path);
  res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Content-Length':body.length,'Cache-Control':'no-cache'});
  res.end(req.method==='HEAD'?undefined:body); return true;
}

function applySecurityHeaders(req,res) {
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Origin-Agent-Cluster','?1');
  res.setHeader('X-Permitted-Cross-Domain-Policies','none');
  if(IS_PRODUCTION) res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
}

const APP_ORIGIN=new URL(APP_URL).origin;
const ALLOWED_ORIGINS=new Set([APP_ORIGIN]);
if(!IS_PRODUCTION) {
  const appUrl=new URL(APP_URL);
  if(['localhost','127.0.0.1'].includes(appUrl.hostname)) {
    const portSuffix=appUrl.port?`:${appUrl.port}`:'';
    ALLOWED_ORIGINS.add(`${appUrl.protocol}//localhost${portSuffix}`);
    ALLOWED_ORIGINS.add(`${appUrl.protocol}//127.0.0.1${portSuffix}`);
  }
}
let activeRequests=0;
const server=http.createServer(async(req,res)=>{
  applySecurityHeaders(req,res);
  req.requestId=randomUUID();
  res.setHeader('X-Request-ID',req.requestId);
  if(activeRequests>=MAX_ACTIVE_REQUESTS) return json(res,503,{error:'Сервер временно перегружен',requestId:req.requestId},{'Retry-After':'1'});
  activeRequests+=1;
  res.once('close',()=>{activeRequests=Math.max(0,activeRequests-1);});
  try {
    const allowedMethods=new Set(['GET','HEAD','POST','PATCH','DELETE']);
    if(!allowedMethods.has(req.method)) return json(res,405,{error:'Метод не разрешён'},{Allow:'GET, HEAD, POST, PATCH, DELETE'});
    if(req.headers['content-length']&&req.headers['transfer-encoding']) throw badRequest('Неоднозначная длина запроса');
    const unsafe=!['GET','HEAD'].includes(req.method);
    const origin=req.headers.origin;
    if(unsafe&&origin&&!ALLOWED_ORIGINS.has(origin)) throw forbidden('Запрос с другого источника отклонён');
    if(unsafe&&req.headers['sec-fetch-site']==='cross-site') throw forbidden('Межсайтовый запрос отклонён');
    const url=new URL(req.url,APP_URL); req.auth=getAuth(req);
    if(url.pathname.startsWith('/api/')) {
      rateLimit(req,'api-global',API_RATE_LIMIT,60*1000);
      const handled=await api(req,res,url);
      if(handled===false) json(res,404,{error:'Маршрут не найден'});
      return;
    }
    rateLimit(req,'static-global',600,60*1000);
    if(await staticFile(req,res,url)) return;
    json(res,404,{error:'Файл не найден'});
  } catch(error) {
    const requestId=req.requestId;
    console.error(`[${requestId}]`,error?.stack||error);
    if(!res.headersSent) {
      const headers=error.retryAfter?{'Retry-After':String(error.retryAfter)}:{};
      json(res,error.status||500,{error:error.status?error.message:'Внутренняя ошибка сервера',requestId},headers);
    } else res.end();
  }
});

server.requestTimeout=15_000;
server.headersTimeout=10_000;
server.keepAliveTimeout=5_000;
server.timeout=15_000;
server.maxRequestsPerSocket=100;
server.maxHeadersCount=100;
server.maxConnections=200;
server.on('clientError',(error,socket)=>{
  if(socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(PORT,'127.0.0.1',()=>console.log(`ProfitPilot: ${APP_URL}`));

function shutdown() { db.close(); server.close(()=>process.exit(0)); }
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
