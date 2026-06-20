const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = '/Users/xuyingzhou/Project/study-web/cdp-tunnel2/extension-new';
const PROXY_PATH = '/Users/xuyingzhou/Project/study-web/cdp-tunnel2/server/proxy-server.js';
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');

const PLUGIN_PORT = 29901;
const POOL_PORT = 29902;
const TAKEOVER_PORT = 29903;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:'+port+p, res => {
      let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d))}catch{resolve(d)}});
    }).on('error',reject);
  });
}

function makeClient(port) {
  const ws = new WebSocket('ws://localhost:'+port+'/client');
  const pending = new Map();let id=1;
  ws.on('message',d=>{const m=JSON.parse(d);if(m.id&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}});
  function cdp(method,params,sid){return new Promise((resolve,reject)=>{const i=id++;pending.set(i,{resolve,reject});setTimeout(()=>{if(pending.has(i)){pending.delete(i);reject(new Error('T:'+method))}},20000);const o={id:i,method,params:params||{}};if(sid)o.sessionId=sid;ws.send(JSON.stringify(o))})}
  return{ws,cdp,open:new Promise((r,e)=>{ws.on('open',r);ws.on('error',e)})}
}

async function xbrowserSession(port,label){
  try{
    const c=makeClient(port);await c.open;
    const tg=await c.cdp('Target.getTargets');
    const pages=(tg.targetInfos||[]).filter(t=>t.type==='page');
    for(const page of pages){
      try{await c.cdp('Target.attachToTarget',{targetId:page.targetId,flatten:true})}catch(e){}
    }
    await c.cdp('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
    const ct=await c.cdp('Target.createTarget',{url:'about:blank'});
    if(!ct||!ct.targetId)return{label,ok:false,reason:'no targetId'};
    const at=await c.cdp('Target.attachToTarget',{targetId:ct.targetId,flatten:true});
    if(!at||!at.sessionId)return{label,ok:false,reason:'attach failed'};
    await c.cdp('Page.enable',{},at.sessionId);
    await c.cdp('Runtime.enable',{},at.sessionId);
    await c.cdp('Page.navigate',{url:'https://www.example.com'},at.sessionId);
    await sleep(3000);
    const urlR=await c.cdp('Runtime.evaluate',{expression:'location.href',returnByValue:true},at.sessionId);
    await c.cdp('Target.closeTarget',{targetId:ct.targetId}).catch(()=>{});
    c.ws.close();
    return{label,ok:urlR.result.value.includes('example.com'),reason:urlR.result.value};
  }catch(e){return{label,ok:false,reason:e.message.slice(0,60)}}
}

(async()=>{
  const configOrig=fs.readFileSync(CONFIG_PATH,'utf8');
  fs.writeFileSync(CONFIG_PATH,configOrig.replace(/WS_URL:\s*'[^']*'/,"WS_URL: 'ws://localhost:"+PLUGIN_PORT+"/plugin'"));

  const proxy=spawn(process.execPath,[PROXY_PATH],{env:{...process.env,PORT:String(PLUGIN_PORT),TAKEOVER_PORT:String(TAKEOVER_PORT),POOL_START:String(POOL_PORT),POOL_SIZE:'1',POOL_TAKEOVER_PORT:String(TAKEOVER_PORT),LOG_LEVEL:'warn'},stdio:['pipe','pipe','pipe']});
  for(let i=0;i<20;i++){try{await httpGet(PLUGIN_PORT,'/json/version');break}catch{await sleep(500)}}

  const profile='/tmp/cdp-2phase-'+Date.now();
  const chrome=spawn(CHROME_PATH,['--user-data-dir='+profile,'--load-extension='+EXTENSION_PATH,'--no-first-run','--no-default-browser-check','about:blank'],{detached:true,stdio:'ignore'});
  chrome._profile=profile;
  await sleep(4000);

  let ready=false;
  for(let i=0;i<90;i++){try{const v=await httpGet(PLUGIN_PORT,'/json/version');if(v&&v.webSocketDebuggerUrl){ready=true;break}}catch{}await sleep(2000)}
  if(!ready){console.log('Extension not connected');process.exit(1)}
  console.log('Ready\n');

  const C=5,B=4;let ok=0,fail=0;
  console.log('=== 两阶段并发: '+C+'×'+B+' ===\n');
  for(let batch=1;batch<=B;batch++){
    const sessions=[];
    for(let i=1;i<=C;i++)sessions.push(xbrowserSession(POOL_PORT,'b'+batch+'_s'+i));
    const results=await Promise.all(sessions);
    for(const r of results){if(r.ok)ok++;else fail++;console.log((r.ok?'✅':'❌')+' '+r.label+': '+r.reason.slice(0,50))}
    console.log('');
    await sleep(1000);
  }
  console.log('=== 结果: '+ok+'/'+(ok+fail)+' ('+Math.round(fail/(ok+fail)*100)+'% 失败) ===');

  try{process.kill(-chrome.pid)}catch{}
  try{fs.rmSync(profile,{recursive:true,force:true})}catch{}
  proxy.kill();
  fs.writeFileSync(CONFIG_PATH,configOrig);
  process.exit(0);
})();
