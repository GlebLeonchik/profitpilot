import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import http from 'node:http';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startServer(overrides={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'profitpilot-pentest-'));
  const port=22000+Math.floor(Math.random()*5000);
  const origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--experimental-sqlite','server.mjs'],{
    cwd:new URL('.',import.meta.url),
    env:{...process.env,PORT:String(port),APP_URL:origin,DATA_DIR:dataDir,SESSION_SECRET:'pentest-session-secret-with-more-than-32-characters',TOKEN_ENCRYPTION_KEY:'pentest-token-key-with-more-than-32-characters',...overrides},
    stdio:['ignore','pipe','pipe']
  });
  let stderr=''; child.stderr.on('data',chunk=>{stderr+=chunk;});
  for(let attempt=0;attempt<80;attempt+=1) {
    try { const response=await fetch(`${origin}/api/health`); if(response.ok)return {child,dataDir,origin,port,getStderr:()=>stderr}; }
    catch {}
    if(child.exitCode!==null) throw new Error(`Server exited early: ${stderr}`);
    await wait(100);
  }
  child.kill('SIGTERM'); throw new Error(`Server did not start: ${stderr}`);
}

async function stopServer(t,runtime) {
  t.after(async()=>{
    runtime.child.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>runtime.child.once('exit',resolve)),wait(2000)]);
    await rm(runtime.dataDir,{recursive:true,force:true});
  });
}

function cookieFrom(response) { return response.headers.get('set-cookie').split(';')[0]; }

function rawRequestStatus(origin,method,path='/') {
  return new Promise((resolve,reject)=>{
    const request=http.request(new URL(path,origin),{method},response=>{
      response.resume();
      response.once('end',()=>resolve(response.statusCode));
    });
    request.once('error',reject);
    request.end();
  });
}

async function register(runtime,email='security@example.test',organizationName='Security shop') {
  const response=await fetch(`${runtime.origin}/api/auth/register`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'Secure-password-123!',organizationName})
  });
  assert.equal(response.status,201);
  const body=await response.json();
  return {cookie:cookieFrom(response),csrf:body.csrfToken,body};
}

test('penetration probes are rejected without data disclosure', {timeout:30000}, async t=>{
  const runtime=await startServer(); await stopServer(t,runtime);
  const session=await register(runtime,'security@example.test','<img src=x onerror=alert(1)>');

  const home=await fetch(`${runtime.origin}/`);
  assert.equal(home.status,200);
  const csp=home.headers.get('content-security-policy')||'';
  assert.match(csp,/script-src 'self'/);
  assert.doesNotMatch(csp,/script-src[^;]*unsafe-inline/);
  assert.equal(home.headers.get('x-frame-options'),'DENY');

  const me=await fetch(`${runtime.origin}/api/auth/me`,{headers:{Cookie:session.cookie}});
  assert.equal((await me.json()).organization.name,'<img src=x onerror=alert(1)>');

  const sqlLogin=await fetch(`${runtime.origin}/api/auth/login`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:"' OR 1=1 --",password:"' OR 1=1 --"})
  });
  assert.equal(sqlLogin.status,401);

  const objectInjection=await fetch(`${runtime.origin}/api/auth/login`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:{$ne:null},password:{$ne:null}})
  });
  assert.equal(objectInjection.status,401);

  const routeInjection=await fetch(`${runtime.origin}/api/products/1%20OR%201=1/market`,{
    method:'PATCH',headers:{Cookie:session.cookie,'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify({marketPrice:1})
  });
  assert.equal(routeInjection.status,404);

  const wrongCsrf=await fetch(`${runtime.origin}/api/demo/reset`,{method:'POST',headers:{Cookie:session.cookie,'X-CSRF-Token':'wrong-token'}});
  assert.equal(wrongCsrf.status,403);

  const foreignOrigin=await fetch(`${runtime.origin}/api/demo/reset`,{method:'POST',headers:{Cookie:session.cookie,'X-CSRF-Token':session.csrf,Origin:'https://attacker.example'}});
  assert.equal(foreignOrigin.status,403);

  const traversal=await fetch(`${runtime.origin}/..%2f..%2f.env`);
  assert.equal(traversal.status,404);
  assert.doesNotMatch(await traversal.text(),/SESSION_SECRET|TOKEN_ENCRYPTION_KEY/);

  const traceStatus=await rawRequestStatus(runtime.origin,'TRACE');
  assert.equal(traceStatus,405);

  const badType=await fetch(`${runtime.origin}/api/auth/register`,{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'});
  assert.equal(badType.status,415);

  const malformed=await fetch(`${runtime.origin}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"email":'});
  assert.equal(malformed.status,400);

  const oversized=await fetch(`${runtime.origin}/api/import/csv`,{
    method:'POST',headers:{Cookie:session.cookie,'X-CSRF-Token':session.csrf,'Content-Type':'text/csv'},body:'x'.repeat(5*1024*1024+1)
  });
  assert.equal(oversized.status,413);

  const bruteStatuses=[];
  for(let index=0;index<12;index+=1) {
    const response=await fetch(`${runtime.origin}/api/auth/login`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'brute@example.test',password:`wrong-password-${index}`})
    });
    bruteStatuses.push(response.status);
  }
  assert.ok(bruteStatuses.includes(429),'brute-force attempts must be rate limited');

  const sessions=await fetch(`${runtime.origin}/api/security/sessions`,{headers:{Cookie:session.cookie}});
  assert.equal(sessions.status,200);
  assert.equal((await sessions.json()).sessions[0].current,true);
});

test('bounded HTTP flood is throttled and service remains available', {timeout:30000}, async t=>{
  const runtime=await startServer({API_RATE_LIMIT_PER_MINUTE:'60',MAX_ACTIVE_REQUESTS:'20'}); await stopServer(t,runtime);
  const started=Date.now();
  const results=await Promise.all(Array.from({length:140},async()=>{
    try { return (await fetch(`${runtime.origin}/api/health`)).status; }
    catch { return 0; }
  }));
  assert.ok(Date.now()-started<10000,'bounded flood should be handled promptly');
  assert.ok(results.some(status=>status===429||status===503),'excess traffic must be throttled');
  assert.equal(runtime.child.exitCode,null,'server process must survive the flood');
  const counts=results.reduce((summary,status)=>({...summary,[status]:(summary[status]||0)+1}),{});
  t.diagnostic(`bounded flood status counts: ${JSON.stringify(counts)}`);
  const staticPage=await fetch(`${runtime.origin}/`);
  assert.equal(staticPage.status,200,'independent static route must remain available');
});

test('slow incomplete HTTP headers are timed out', {timeout:20000}, async t=>{
  const runtime=await startServer(); await stopServer(t,runtime);
  const closed=await new Promise((resolve,reject)=>{
    const socket=net.createConnection({host:'127.0.0.1',port:runtime.port},()=>socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: '));
    const timer=setTimeout(()=>{socket.destroy();reject(new Error('slow connection was not closed'));},16000);
    socket.on('close',()=>{clearTimeout(timer);resolve(true);});
    socket.on('error',error=>{clearTimeout(timer); if(error.code==='ECONNRESET')resolve(true);else reject(error);});
  });
  assert.equal(closed,true);
});
