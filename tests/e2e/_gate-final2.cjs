/**
 * 端口池 vs 直连 Chrome 对照测试
 * 两阶段并发 + closeTarget + Browser.close
 * 
 * 两边各跑独立的 Chromium，同样的操作序列，对比结果
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('/Users/xuyingzhou/Project/study-web/cdp-tunnel2/node_modules/ws');

const CHROME = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXT = '/Users/xuyingzhou/Project/study-web/cdp-tunnel2/extension-new';
const PROXY = '/Users/xuyingzhou/Project/study-web/cdp-tunnel2/server/proxy-server.js';
const CFG = path.join(EXT, 'utils', 'config.js');

const DIRECT_PORT = 30110;
const PLUGIN_PORT = 30111;
const POOL_PORT = 30112;
const TK_PORT = 30113;

function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function hg(port,p){return new Promise((res,rej)=>{http.get('http://localhost:'+port+p,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch{res(d)}})}).on('error',rej)})}

function mkPoolClient(port){
  const ws=new WebSocket('ws://localhost:'+port+'/client');
  const pending=new Map();let id=1;
  ws.on('message',d=>{const m=JSON.parse(d);if(m.id&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}});
  function cdp(method,params,sid){return new Promise((resolve,reject)=>{const i=id++;pending.set(i,{resolve,reject});setTimeout(()=>{if(pending.has(i)){pending.delete(i);reject(new Error('T:'+method))}},20000);const o={id:i,method,params:params||{}};if(sid)o.sessionId=sid;ws.send(JSON.stringify(o))})};
  return{ws,cdp,open:new Promise((r,e)=>{ws.on('open',r);ws.on('error',e)})}
}

async function mkDirectClient(port){
  const ver=await hg(port,'/json/version');
  const ws=new WebSocket(ver.webSocketDebuggerUrl);
  const pending=new Map();let id=1;
  ws.on('message',d=>{const m=JSON.parse(d);if(m.id&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}});
  function cdp(method,params,sid){return new Promise((resolve,reject)=>{const i=id++;pending.set(i,{resolve,reject});setTimeout(()=>{if(pending.has(i)){pending.delete(i);reject(new Error('T:'+method))}},20000);const o={id:i,method,params:params||{}};if(sid)o.sessionId=sid;ws.send(JSON.stringify(o))})};
  await new Promise((r,e)=>{ws.on('open',r);ws.on('error',e)});
  return{ws,cdp}
}

// 完整的单 session 操作序列（对标直连 Chrome）
async function fullSession(makeClient, port, label){
  try{
    const c=await makeClient(port);
    
    // 1. createTarget
    const ct=await c.cdp('Target.createTarget',{url:'about:blank'});
    if(!ct||!ct.targetId)return{label,ok:false,r:'no tid'};
    const tid=ct.targetId;
    
    // 2. attachToTarget
    const at=await c.cdp('Target.attachToTarget',{targetId:tid,flatten:true});
    if(!at||!at.sessionId)return{label,ok:false,r:'attach fail'};
    const sid=at.sessionId;
    
    // 3. enable + navigate
    await c.cdp('Page.enable',{},sid);
    await c.cdp('Runtime.enable',{},sid);
    await c.cdp('Page.navigate',{url:'https://www.example.com'},sid);
    await sleep(2000);
    
    // 4. evaluate
    const ev=await c.cdp('Runtime.evaluate',{expression:'document.title',returnByValue:true},sid);
    if(!ev||!ev.result||ev.result.value!=='Example Domain')return{label,ok:false,r:'eval wrong: '+ev?.result?.value};
    
    // 5. screenshot
    const shot=await c.cdp('Page.captureScreenshot',{format:'jpeg',quality:30},sid);
    if(!shot||!shot.data)return{label,ok:false,r:'no screenshot'};
    
    // 6. closeTarget
    await c.cdp('Target.closeTarget',{targetId:tid});
    await sleep(1000); // 等 Chrome 更新 target 列表
    
    // 7. verify closed
    const tg=await c.cdp('Target.getTargets');
    const stillExists=(tg.targetInfos||[]).some(t=>t.targetId===tid);
    if(stillExists)return{label,ok:false,r:'tab not closed'};
    
    c.ws.close();
    return{label,ok:true,r:'all pass'};
  }catch(e){return{label,ok:false,r:e.message.slice(0,50)}}
}

// 并发测试
async function concurrentTest(makeClient, port, label, C, B){
  let ok=0,fail=0;
  console.log(`\n--- ${label} ${C}×${B} ---`);
  for(let b=1;b<=B;b++){
    const sessions=[];
    for(let i=1;i<=C;i++)sessions.push(fullSession(makeClient,port,`b${b}_s${i}`));
    const results=await Promise.all(sessions);
    for(const r of results){if(r.ok)ok++;else fail++;console.log((r.ok?'✅':'❌')+' '+r.label+': '+r.r.slice(0,40))}
    await sleep(500);
  }
  return{ok,fail,total:ok+fail};
}

(async()=>{
  let proxy,configOrig,directChrome,poolChrome;
  
  try{
    // === A: 直连 Chrome ===
    const dp='/tmp/cdp-cmp-direct-'+Date.now();
    directChrome=spawn(CHROME,['--user-data-dir='+dp,'--remote-debugging-port='+DIRECT_PORT,'--no-first-run','--no-default-browser-check','--disable-features=DialMediaRouteProvider','about:blank'],{detached:true,stdio:'ignore'});
    directChrome._profile=dp;
    await sleep(4000);
    for(let i=0;i<30;i++){try{await hg(DIRECT_PORT,'/json/version');break}catch{await sleep(1000)}}
    console.log('直连 Chrome ready');
    
    const directResult=await concurrentTest(
      (port)=>mkDirectClient(port), DIRECT_PORT, '直连', 5, 4
    );
    console.log(`>>> 直连: ${directResult.ok}/${directResult.total} (${Math.round(directResult.fail/directResult.total*100)}% fail)`);
    
    // 关掉直连
    try{process.kill(-directChrome.pid)}catch{}
    try{fs.rmSync(dp,{recursive:true,force:true})}catch{}
    await sleep(3000);
    
    // === B: 端口池 ===
    configOrig=fs.readFileSync(CFG,'utf8');
    fs.writeFileSync(CFG,configOrig.replace(/WS_URL:\s*'[^']*'/,"WS_URL: 'ws://localhost:"+PLUGIN_PORT+"/plugin'"));
    
    proxy=spawn(process.execPath,[PROXY],{env:{...process.env,PORT:String(PLUGIN_PORT),TAKEOVER_PORT:String(TK_PORT),POOL_START:String(POOL_PORT),POOL_SIZE:'1',POOL_TAKEOVER_PORT:String(TK_PORT),LOG_LEVEL:'warn'},stdio:['pipe','pipe','pipe']});
    for(let i=0;i<20;i++){try{await hg(PLUGIN_PORT,'/json/version');break}catch{await sleep(500)}}
    
    const pp='/tmp/cdp-cmp-pool-'+Date.now();
    poolChrome=spawn(CHROME,['--user-data-dir='+pp,'--load-extension='+EXT,'--no-first-run','--no-default-browser-check','--disable-features=DialMediaRouteProvider','about:blank'],{detached:true,stdio:'ignore'});
    poolChrome._profile=pp;
    await sleep(5000);
    
    let ready=false;
    for(let i=0;i<90;i++){try{const v=await hg(PLUGIN_PORT,'/json/version');if(v&&v.webSocketDebuggerUrl){ready=true;break}}catch{}await sleep(2000)}
    if(!ready){console.log('Extension not connected');process.exit(1)}
    console.log('端口池 ready');
    
    const poolResult=await concurrentTest(
      async(port)=>{const c=mkPoolClient(port);await c.open;return c}, POOL_PORT, '端口池', 5, 4
    );
    console.log(`>>> 端口池: ${poolResult.ok}/${poolResult.total} (${Math.round(poolResult.fail/poolResult.total*100)}% fail)`);
    
    // === 对照 ===
    console.log('\n=== 对照结论 ===');
    console.log(`直连: ${directResult.ok}/${directResult.total}`);
    console.log(`端口池: ${poolResult.ok}/${poolResult.total}`);
    if(directResult.fail===0&&poolResult.fail===0){
      console.log('✅ PASS — 两边一致');
    }else{
      console.log('❌ FAIL — 有差异');
    }
    
  }catch(e){console.log('ERROR:',e.message,e.stack)}
  finally{
    if(directChrome){try{process.kill(-directChrome.pid)}catch{}}
    if(poolChrome){try{process.kill(-poolChrome.pid)}catch{}}
    if(proxy){try{proxy.kill('SIGINT')}catch{}}
    if(configOrig){try{fs.writeFileSync(CFG,configOrig)}catch{}}
    try{fs.rmSync('/tmp/cdp-cmp-direct-'+Date.now(),{recursive:true,force:true})}catch{}
    try{fs.rmSync('/tmp/cdp-cmp-pool-'+Date.now(),{recursive:true,force:true})}catch{}
  }
  process.exit(0);
})();
