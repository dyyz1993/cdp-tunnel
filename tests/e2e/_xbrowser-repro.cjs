/**
 * 精确复现 xbrowser 的 discoverContexts + createTarget 序列
 * 验证"第一个 session 必挂"
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

const PLUGIN_PORT = 30201;
const POOL_PORT = 30202;
const TK_PORT = 30203;

function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function hg(port,p){return new Promise((res,rej)=>{http.get('http://localhost:'+port+p,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch{res(d)}})}).on('error',rej)})}

function mkClient(port){
  const ws=new WebSocket('ws://localhost:'+port+'/client');
  const p=new Map();let id=1;
  ws.on('message',d=>{const m=JSON.parse(d);if(m.id&&p.has(m.id)){const{resolve,reject}=p.get(m.id);p.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}});
  function cdp(method,params,sid){return new Promise((resolve,reject)=>{const i=id++;p.set(i,{resolve,reject});setTimeout(()=>{if(p.has(i)){p.delete(i);reject(new Error('T:'+method))}},20000);const o={id:i,method,params:params||{}};if(sid)o.sessionId=sid;ws.send(JSON.stringify(o))})};
  return{ws,cdp,open:new Promise((r,e)=>{ws.on('open',r);ws.on('error',e)})}
}

// 精确模拟 xbrowser 的完整序列
async function xbrowserSession(port, label){
  const t0 = Date.now();
  try{
    const c = mkClient(port); await c.open;

    // === discoverContexts ===
    // 1. getTargets
    const tg = await c.cdp('Target.getTargets');
    const pages = (tg.targetInfos||[]).filter(t=>t.type==='page');

    // 2. attach 已有 page（如果有）
    for(const pg of pages){
      try{ await c.cdp('Target.attachToTarget',{targetId:pg.targetId,flatten:true}); }catch(e){}
    }

    // 3. setAutoAttach
    await c.cdp('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});

    // === createTarget ===
    const ct = await c.cdp('Target.createTarget',{url:'about:blank'});
    if(!ct||!ct.targetId) return{label,ok:false,r:'no tid',ms:Date.now()-t0};
    const tid = ct.targetId;

    // attach + navigate
    const at = await c.cdp('Target.attachToTarget',{targetId:tid,flatten:true});
    if(!at||!at.sessionId) return{label,ok:false,r:'attach fail',ms:Date.now()-t0};
    const sid = at.sessionId;

    await c.cdp('Page.enable',{},sid);
    await c.cdp('Runtime.enable',{},sid);
    await c.cdp('Page.navigate',{url:'https://www.example.com'},sid);
    await sleep(2000);

    const u = await c.cdp('Runtime.evaluate',{expression:'location.href',returnByValue:true},sid);
    await c.cdp('Target.closeTarget',{targetId:tid}).catch(()=>{});
    c.ws.close();
    return{label,ok:u.result.value.includes('example'),r:u.result.value,ms:Date.now()-t0};
  }catch(e){return{label,ok:false,r:e.message.slice(0,50),ms:Date.now()-t0}}
}

(async()=>{
  let proxy,chrome,configOrig;
  try{
    configOrig=fs.readFileSync(CFG,'utf8');
    fs.writeFileSync(CFG,configOrig.replace(/WS_URL:\s*'[^']*'/,"WS_URL: 'ws://localhost:"+PLUGIN_PORT+"/plugin'"));

    proxy=spawn(process.execPath,[PROXY],{env:{...process.env,PORT:String(PLUGIN_PORT),TAKEOVER_PORT:String(TK_PORT),POOL_START:String(POOL_PORT),POOL_SIZE:'1',POOL_TAKEOVER_PORT:String(TK_PORT),LOG_LEVEL:'warn'},stdio:['pipe','pipe','pipe']});
    for(let i=0;i<20;i++){try{await hg(PLUGIN_PORT,'/json/version');break}catch{await sleep(500)}}

    const profile='/tmp/cdp-xbrowser-'+Date.now();
    chrome=spawn(CHROME,['--user-data-dir='+profile,'--load-extension='+EXT,'--no-first-run','--no-default-browser-check','--disable-features=DialMediaRouteProvider','about:blank'],{detached:true,stdio:'ignore'});
    chrome._profile=profile;
    await sleep(5000);

    let ready=false;
    for(let i=0;i<90;i++){try{const v=await hg(PLUGIN_PORT,'/json/version');if(v&&v.webSocketDebuggerUrl){ready=true;break}}catch{}await sleep(2000)}
    if(!ready){console.log('Extension not connected');process.exit(1)}
    console.log('Ready\n');

    const C=5,B=4;let ok=0,fail=0;
    console.log('=== xbrowser 序列 '+C+'×'+B+' ===\n');
    for(let b=1;b<=B;b++){
      const sessions=[];
      for(let i=1;i<=C;i++)sessions.push(xbrowserSession(POOL_PORT,'b'+b+'_s'+i));
      const results=await Promise.all(sessions);
      for(const r of results){
        if(r.ok)ok++;else fail++;
        console.log((r.ok?'✅':'❌')+' '+r.label+': '+r.r.slice(0,40)+' ('+r.ms+'ms)');
      }
      console.log('');
      await sleep(1000);
    }
    console.log('=== '+ok+'/'+(ok+fail)+' ('+Math.round(fail/(ok+fail)*100)+'% fail) ===');

  }catch(e){console.log('ERROR:',e.message)}
  finally{
    if(chrome){try{process.kill(-chrome.pid)}catch{}try{fs.rmSync(chrome._profile,{recursive:true,force:true})}catch{}}
    if(proxy){try{proxy.kill('SIGINT')}catch{}}
    if(configOrig){try{fs.writeFileSync(CFG,configOrig)}catch{}}
  }
  process.exit(0);
})();
