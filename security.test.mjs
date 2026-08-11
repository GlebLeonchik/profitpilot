import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startServer() {
  const dataDir=await mkdtemp(join(tmpdir(),'profitpilot-security-'));
  const port=19000+Math.floor(Math.random()*3000);
  const origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--experimental-sqlite','server.mjs'],{
    cwd:new URL('.',import.meta.url),
    env:{...process.env,PORT:String(port),APP_URL:origin,DATA_DIR:dataDir,SESSION_SECRET:'test-session-secret-with-more-than-32-characters',TOKEN_ENCRYPTION_KEY:'test-token-key-with-more-than-32-characters',ALLEGRO_CLIENT_ID:'',ALLEGRO_CLIENT_SECRET:'',ALLEGRO_ENV:'',ALLEGRO_USER_AGENT:'',ALLEGRO_REDIRECT_URI:''},
    stdio:['ignore','pipe','pipe']
  });
  let stderr=''; child.stderr.on('data',chunk=>{stderr+=chunk;});
  for(let attempt=0;attempt<60;attempt+=1) {
    try { const response=await fetch(`${origin}/api/health`); if(response.ok)return {child,dataDir,origin,getStderr:()=>stderr}; }
    catch {}
    if(child.exitCode!==null) throw new Error(`Server exited early: ${stderr}`);
    await wait(100);
  }
  child.kill('SIGTERM');
  throw new Error(`Server did not start: ${stderr}`);
}

function cookieFrom(response) {
  const raw=response.headers.get('set-cookie');
  assert.ok(raw,'response must set a session cookie');
  return raw.split(';')[0];
}

async function register(origin,email,organizationName) {
  const response=await fetch(`${origin}/api/auth/register`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email,password:'A-unique-test-password-123!',organizationName})
  });
  assert.equal(response.status,201);
  const body=await response.json();
  return {cookie:cookieFrom(response),csrf:body.csrfToken,body};
}

test('security boundary: authentication, CSRF and tenant isolation',async t=>{
  const runtime=await startServer();
  t.after(async()=>{
    runtime.child.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>runtime.child.once('exit',resolve)),wait(2000)]);
    await rm(runtime.dataDir,{recursive:true,force:true});
  });

  const publicResponse=await fetch(`${runtime.origin}/api/products`);
  assert.equal(publicResponse.status,401);
  assert.match(publicResponse.headers.get('content-security-policy')||'',/frame-ancestors 'none'/);
  assert.equal(publicResponse.headers.get('x-content-type-options'),'nosniff');

  const alternateLoopbackOrigin=runtime.origin.replace('127.0.0.1','localhost');
  const loopbackRegistration=await fetch(`${runtime.origin}/api/auth/register`,{
    method:'POST',headers:{'Content-Type':'application/json',Origin:alternateLoopbackOrigin},
    body:JSON.stringify({email:'loopback@example.test',password:'A-unique-test-password-123!',organizationName:'Loopback shop'})
  });
  assert.equal(loopbackRegistration.status,201);
  const foreignOrigin=await fetch(`${runtime.origin}/api/auth/register`,{
    method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},
    body:JSON.stringify({email:'foreign@example.test',password:'A-unique-test-password-123!',organizationName:'Foreign shop'})
  });
  assert.equal(foreignOrigin.status,403);

  const first=await register(runtime.origin,'owner-one@example.test','First shop');
  const second=await register(runtime.origin,'owner-two@example.test','Second shop');

  const allegroConfigWithoutCsrf=await fetch(`${runtime.origin}/api/integrations/allegro/config`,{
    method:'POST',headers:{Cookie:first.cookie,'Content-Type':'application/json'},
    body:JSON.stringify({clientId:'client_first_12345',clientSecret:'secret-first-12345',userAgent:'ProfitPilot security test',environment:'sandbox'})
  });
  assert.equal(allegroConfigWithoutCsrf.status,403);
  const allegroConfigResponse=await fetch(`${runtime.origin}/api/integrations/allegro/config`,{
    method:'POST',headers:{Cookie:first.cookie,'Content-Type':'application/json','X-CSRF-Token':first.csrf},
    body:JSON.stringify({clientId:'client_first_12345',clientSecret:'secret-first-12345',userAgent:'ProfitPilot security test',environment:'sandbox'})
  });
  assert.equal(allegroConfigResponse.status,200);
  const firstIntegrations=await (await fetch(`${runtime.origin}/api/integrations`,{headers:{Cookie:first.cookie}})).json();
  const secondIntegrations=await (await fetch(`${runtime.origin}/api/integrations`,{headers:{Cookie:second.cookie}})).json();
  assert.equal(firstIntegrations.allegroConfigured,true);
  assert.equal(firstIntegrations.allegroConfig.environment,'sandbox');
  assert.equal('clientSecret' in firstIntegrations.allegroConfig,false);
  assert.equal(secondIntegrations.allegroConfigured,false);
  const empikConfigResponse=await fetch(`${runtime.origin}/api/integrations/empik/config`,{
    method:'POST',headers:{Cookie:first.cookie,'Content-Type':'application/json','X-CSRF-Token':first.csrf},
    body:JSON.stringify({accountName:'First Empik shop',apiKey:'empik-test-key-123456789'})
  });
  assert.equal(empikConfigResponse.status,200);
  const firstAfterEmpik=await (await fetch(`${runtime.origin}/api/integrations`,{headers:{Cookie:first.cookie}})).json();
  const secondAfterEmpik=await (await fetch(`${runtime.origin}/api/integrations`,{headers:{Cookie:second.cookie}})).json();
  assert.equal(firstAfterEmpik.integrations.find(item=>item.provider==='Empik').status,'configured');
  assert.equal('access_token' in firstAfterEmpik.integrations.find(item=>item.provider==='Empik'),false);
  assert.equal(secondAfterEmpik.integrations.find(item=>item.provider==='Empik').status,'disconnected');

  const createdProductResponse=await fetch(`${runtime.origin}/api/products`,{
    method:'POST',headers:{Cookie:first.cookie,'Content-Type':'application/json','X-CSRF-Token':first.csrf},
    body:JSON.stringify({sku:'TENANT-ONLY',name:'Tenant-only product',channel:'Allegro',units:3,price:100,cost:50,commission:5,ads:2,shipping:3,returns:1})
  });
  assert.equal(createdProductResponse.status,201);
  const createdProduct=(await createdProductResponse.json()).product;
  const secondTenantProducts=(await (await fetch(`${runtime.origin}/api/products`,{headers:{Cookie:second.cookie}})).json()).products;
  assert.equal(secondTenantProducts.some(product=>product.sku==='TENANT-ONLY'),false);
  const economicsUpdate=await fetch(`${runtime.origin}/api/products/${createdProduct.id}/economics`,{
    method:'PATCH',headers:{Cookie:first.cookie,'Content-Type':'application/json','X-CSRF-Token':first.csrf},
    body:JSON.stringify({cost:40,commission:5,ads:2,shipping:3,returns:1})
  });
  assert.equal(economicsUpdate.status,200);
  const crossTenantDelete=await fetch(`${runtime.origin}/api/products/${createdProduct.id}`,{method:'DELETE',headers:{Cookie:second.cookie,'X-CSRF-Token':second.csrf}});
  assert.equal(crossTenantDelete.status,404);

  const firstProductsResponse=await fetch(`${runtime.origin}/api/products`,{headers:{Cookie:first.cookie}});
  assert.equal(firstProductsResponse.status,200);
  const firstProducts=(await firstProductsResponse.json()).products;
  assert.equal(firstProducts.length,11);

  const target=firstProducts.find(product=>product.sku==='ONEBLADE-2724');
  const missingCsrf=await fetch(`${runtime.origin}/api/products/${target.id}/market`,{
    method:'PATCH',headers:{Cookie:first.cookie,'Content-Type':'application/json'},body:JSON.stringify({marketPrice:99})
  });
  assert.equal(missingCsrf.status,403);

  const updated=await fetch(`${runtime.origin}/api/products/${target.id}/market`,{
    method:'PATCH',headers:{Cookie:first.cookie,'Content-Type':'application/json','X-CSRF-Token':first.csrf},body:JSON.stringify({marketPrice:99})
  });
  assert.equal(updated.status,200);

  const firstAfter=(await (await fetch(`${runtime.origin}/api/products`,{headers:{Cookie:first.cookie}})).json()).products;
  const secondAfter=(await (await fetch(`${runtime.origin}/api/products`,{headers:{Cookie:second.cookie}})).json()).products;
  assert.equal(firstAfter.find(product=>product.sku==='ONEBLADE-2724').marketPrice,99);
  assert.equal(secondAfter.find(product=>product.sku==='ONEBLADE-2724').marketPrice,116.9);

  const resetWithoutCsrf=await fetch(`${runtime.origin}/api/demo/reset`,{method:'POST',headers:{Cookie:first.cookie}});
  assert.equal(resetWithoutCsrf.status,403);

  const profileUpdate=await fetch(`${runtime.origin}/api/account/profile`,{
    method:'PATCH',headers:{Cookie:first.cookie,'Content-Type':'application/json','X-CSRF-Token':first.csrf},body:JSON.stringify({organizationName:'Renamed secure shop'})
  });
  assert.equal(profileUpdate.status,200);
  const profile=(await (await fetch(`${runtime.origin}/api/auth/me`,{headers:{Cookie:first.cookie}})).json()).organization;
  assert.equal(profile.name,'Renamed secure shop');

  const secondLogin=await fetch(`${runtime.origin}/api/auth/login`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner-one@example.test',password:'A-unique-test-password-123!'})
  });
  assert.equal(secondLogin.status,200);
  const secondLoginCookie=cookieFrom(secondLogin);
  const revoke=await fetch(`${runtime.origin}/api/security/sessions`,{method:'DELETE',headers:{Cookie:first.cookie,'X-CSRF-Token':first.csrf}});
  assert.equal(revoke.status,200);
  assert.ok((await revoke.json()).revoked>=1);
  assert.equal((await fetch(`${runtime.origin}/api/auth/me`,{headers:{Cookie:secondLoginCookie}})).status,401);

  const passwordChange=await fetch(`${runtime.origin}/api/security/password`,{
    method:'PATCH',headers:{Cookie:first.cookie,'Content-Type':'application/json','X-CSRF-Token':first.csrf},body:JSON.stringify({currentPassword:'A-unique-test-password-123!',newPassword:'A-new-unique-test-password-456!'})
  });
  assert.equal(passwordChange.status,200);

  const logout=await fetch(`${runtime.origin}/api/auth/logout`,{method:'POST',headers:{Cookie:first.cookie,'X-CSRF-Token':first.csrf}});
  assert.equal(logout.status,200);
  const afterLogout=await fetch(`${runtime.origin}/api/products`,{headers:{Cookie:first.cookie}});
  assert.equal(afterLogout.status,401);

  const oldPassword=await fetch(`${runtime.origin}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner-one@example.test',password:'A-unique-test-password-123!'})});
  assert.equal(oldPassword.status,401);
  const newPassword=await fetch(`${runtime.origin}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner-one@example.test',password:'A-new-unique-test-password-456!'})});
  assert.equal(newPassword.status,200);
});
