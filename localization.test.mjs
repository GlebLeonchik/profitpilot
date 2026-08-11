import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const appSource=await readFile(new URL('./app.js',import.meta.url),'utf8');
const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
const serverSource=await readFile(new URL('./server.mjs',import.meta.url),'utf8');

function loadTranslations() {
  const start=appSource.indexOf('const I18N=');
  const end=appSource.indexOf('const $ = selector');
  assert.ok(start>=0&&end>start,'translation block must exist');
  const context={};
  const source=appSource.slice(start,end).replace('const I18N=','globalThis.I18N=');
  vm.runInNewContext(source,context,{timeout:1000});
  return context.I18N;
}

test('overview, products and recommendations have translations in every supported language',()=>{
  const translations=loadTranslations();
  const languages=['pl','en','ru','uk','cs','sk','hu'];
  const htmlKeys=[...html.matchAll(/data-i18n="([^"]+)"/g),...html.matchAll(/data-i18n-placeholder="([^"]+)"/g),...html.matchAll(/data-i18n-aria="([^"]+)"/g),...html.matchAll(/data-i18n-toast="([^"]+)"/g)].map(match=>match[1]);
  const codeKeys=[...appSource.matchAll(/\bt\('([^']+)'\)/g)].map(match=>match[1]);
  const dynamicKeys=['netProfit','unitsSold','previousRevenue','previousProfit','attention','healthyRange','belowTarget','productsWord','healthyMargin','lowMargin','lossMaking','statusLoss','statusRisk','statusHealthy','needsData','marketPriceShort','requiredSavings','potentialMonth','actionSaved','noIssues','forCalculation','expectedImpact','needMarketPrice','fresh','outdated','noData','market','showPassword','hidePassword'];
  for(const language of languages) {
    assert.ok(translations[language],`missing ${language} dictionary`);
    for(const key of new Set([...htmlKeys,...codeKeys,...dynamicKeys])) assert.equal(typeof translations[language][key],'string',`${language}.${key} is missing`);
  }
});

test('dynamic UI no longer contains the known Russian-only fragments',()=>{
  const runtimeSource=appSource.slice(appSource.indexOf('const $ = selector'));
  for(const fragment of ['<span>товаров</span>','data-toast="Действие сохранено в план"',"fresh?'свежая':'устарела'",'>Рынок</button>']) {
    assert.equal(runtimeSource.includes(fragment),false,`Russian-only fragment remains: ${fragment}`);
  }
  for(const fragment of ['CSV report generated','Profile updated','Could not update profile','Sessions ended:','Демо-данные восстановлены','Рыночный ориентир обновлён','Импортировано строк:']) {
    assert.equal(runtimeSource.includes(fragment),false,`hard-coded UI message remains: ${fragment}`);
  }
});

test('password controls and password-change error semantics stay safe',()=>{
  const passwordInputs=(html.match(/type="password"/g)||[]).length;
  const toggles=(html.match(/data-password-toggle/g)||[]).length;
  assert.equal(toggles,passwordInputs,'each password field needs its own visibility toggle');
  assert.match(serverSource,/verifyPassword\(String\(body\.currentPassword\|\|''\),user\.password_hash\)\) throw badRequest/);
  assert.doesNotMatch(serverSource,/verifyPassword\(String\(body\.currentPassword\|\|''\),user\.password_hash\)\) throw unauthorized/);
  assert.match(appSource,/function resetAuthUi\(\)/);
  assert.match(appSource,/authMode='login'/);
});
