/**
 * 精确复现"每批第一个必挂"
 * 关键：client 连上后立即发 createTarget（不等任何初始化）
 * 5 个 client 同时连，看第一个是否必挂
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

const PLUGIN_PORT = 30301;
const POOL_PORT = 30302;
const TK_PORT = 30303;

function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function hg(port,p){return new Promise((res,rej)=>{http.get('http://localhost:'+port+p,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch{res(d)}})}).on('error',rej)})}

function mkClient(port){
  const ws=new WebSocket('ws://localhost:'+port+'/client');
  const p=new Map();let id=1;
  ws.on('message',d=>{const m=JSON.parse(d);if(m.id&&p.has(m.id)){const{resolve,reject}=p.get(m.id);p.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}});
  function cdp(method,params,sid){return new Promise((resolve,reject)=>{const i=id++;p.set(i,{resolve,reject});setTimeout(()=>{if(p.has(i)){p.delete(i);reject(new Error('T:'+method))}},20000);const o={id:i,method,params:params||{}};if(sid)o.sessionId=sid;ws.send(JSON.stringify(o))})};
  return{ws,cdp,open:new Promise((r,e)=>{ws.on('open',r);ws.on('error',e)})}
}

// 精确模拟 xbrowser：连接后立即并行发 getTargets + setAutoAttach + createTarget
async function xbrowserFast(port, label){
  try{
    const c = mkClient(port); await c.open;

    // xbrowser 的实际行为：连接后立即并行发这些命令
    const tgPromise = c.cdp('Target.getTargets');
    const saPromise = c.cdp('Target.setAutoAttach', {autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
    const ctPromise = c.cdp('Target.createTarget', {url:'about:blank'});

    // 等全部完成
    const tg = await tgPromise;
    const pages = (tg.targetInfos||[]).filter(t=>t.type==='page');

    // attach 已有 page（如果有）
    for(const pg of pages){
      try{ await c.cdp('Target.attachToTarget',{targetId:pg.targetId,flatten:true}); }catch(e){}
    }

    await saPromise;
    const ct = await ctPromise;
    if(!ct||!ct.targetId) return{label,ok:false,r:'no tid'};

    const at = await c.cdp('Target.attachToTarget',{targetId:ct.targetId,flatten:true});
    if(!at||!at.sessionId) return{label,ok:false,r:'attach fail'};
    await c.cdp('Page.enable',{},at.sessionId);
    await c.cdp('Page.navigate',{url:'https://www.example.com'},at.sessionId);
    await sleep(2000);
    const u = await c.cdp('Runtime.evaluate',{expression:'location.href',returnByValue:true},at.sessionId);
    await c.cdp('Target.closeTarget',{targetId:ct.targetId}).catch(()=>{});
    c.ws.close();
    return{label,ok:u.result.value.includes('example'),r:u.result.value};
  }catch(e){return{label,ok:false,r:e.message.slice(0,50)}}
}

(async()=>{
  let proxy,chrome,configOrig;
  try{
    configOrig=fs.readFileSync(CFG,'utf8');
    fs.writeFileSync(CFG,configOrig.replace(/WS_URL:\s*'[^']*'/,"WS_URL: 'ws://localhost:"+PLUGIN_PORT+"/plugin'"));

    proxy=spawn(process.execPath,[PROXY],{env:{...process.env,PORT:String(PLUGIN_PORT),TAKEOVER_PORT:String(TK_PORT),POOL_START:String(POOL_PORT),POOL_SIZE:'1',POOL_TAKEOVER_PORT:String(TK_PORT),LOG_LEVEL:'debug'},stdio:['pipe','pipe','pipe']});
    const logStream=fs.createWriteStream('/tmp/cdp-fast.log');
    proxy.stdout.pipe(logStream);
    proxy.stderr.pipe(logStream);
    for(let i=0;i<20;i++){try{await hg(PLUGIN_PORT,'/json/version');break}catch{await sleep(500)}}

    const profile='/tmp/cdp-fast-'+Date.now();
    chrome=spawn(CHROME,['--user-data-dir='+profile,'--load-extension='+EXT,'--no-first-run','--no-default-browser-check','--disable-features=DialMediaRouteProvider','about:blank'],{detached:true,stdio:'ignore'});
    chrome._profile=profile;
    await sleep(5000);

    let ready=false;
    for(let i=0;i<90;i++){try{const v=await hg(PLUGIN_PORT,'/json/version');if(v&&v.webSocketDebuggerUrl){ready=true;break}}catch{}await sleep(2000)}
    if(!ready){console.log('Extension not connected');process.exit(1)}
    console.log('Ready\n');

    const C=5,B=6;let ok=0,fail=0;
    console.log('=== xbrowser 快速并行 '+C+'×'+B+' ===\n');
    for(let b=1;b<=B;b++){
      const sessions=[];
      for(let i=1;i<=C;i++)sessions.push(xbrowserFast(POOL_PORT,'b'+b+'_s'+i));
      const results=await Promise.all(sessions);
      for(const r of results){if(r.ok)ok++;else fail++;console.log((r.ok?'✅':'❌')+' '+r.label+': '+r.r.slice(0,40))}
      console.log('');
      await sleep(1000);
    }
    console.log('=== Concurrent Pool: '+ok+'/'+(ok+fail)+' ===');

  }catch(e){console.log('ERROR:',e.message);fail++}
  finally{
    if(chrome){try{process.kill(-chrome.pid)}catch{}try{fs.rmSync(chrome._profile,{recursive:true,force:true})}catch{}}
    if(proxy){try{proxy.kill('SIGINT')}catch{}}
    if(configOrig){try{fs.writeFileSync(CFG,configOrig)}catch{}}
  }
  console.log('\n=== RESULTS: '+ok+' passed, '+fail+' failed ===');
  process.exit(fail > 0 ? 1 : 0);
})();
