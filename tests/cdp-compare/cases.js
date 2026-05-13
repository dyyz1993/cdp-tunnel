#!/usr/bin/env node
'use strict';

const http = require('http');

function compare(name, direct, tunnel, details) {
  return { name, direct, tunnel, match: JSON.stringify(direct) === JSON.stringify(tunnel), details: details || '' };
}

module.exports = {

  'Case 1: /json/version': async (ctx) => {
    const direct = await ctx.httpGet(`http://localhost:${ctx.directPort}/json/version`);
    const tunnel = await ctx.httpGet(`http://localhost:${ctx.tunnelPort}/json/version`);
    return [
      {
        name: 'Browser 字段',
        direct: direct.Browser,
        tunnel: tunnel.Browser,
        match: tunnel.Browser.startsWith('Chrome/' + direct.Browser.split('/')[1].split('.').slice(0, 1).join('.')),
        details: 'Chrome 主版本号是否一致'
      },
      {
        name: 'Protocol-Version 字段',
        direct: direct['Protocol-Version'],
        tunnel: tunnel['Protocol-Version'],
        match: direct['Protocol-Version'] === tunnel['Protocol-Version'],
        details: 'CDP 协议版本是否一致'
      },
      {
        name: 'webSocketDebuggerUrl 存在',
        direct: !!direct.webSocketDebuggerUrl,
        tunnel: !!tunnel.webSocketDebuggerUrl,
        match: !!direct.webSocketDebuggerUrl === !!tunnel.webSocketDebuggerUrl,
        details: `标准: ${direct.webSocketDebuggerUrl || 'null'} | Tunnel: ${tunnel.webSocketDebuggerUrl || 'null'}`
      },
    ];
  },

  'Case 2: /json 初始 target 列表': async (ctx) => {
    const directTargets = await ctx.httpGet(`http://localhost:${ctx.directPort}/json`);
    const tunnelTargets = await ctx.httpGet(`http://localhost:${ctx.tunnelPort}/json`);

    const directPages = (directTargets || []).filter(t => t.type === 'page');
    const tunnelPages = (tunnelTargets || []).filter(t => t.type === 'page');

    const directUrls = directPages.map(t => t.url).sort();
    const tunnelUrls = tunnelPages.map(t => t.url).sort();

    return [
      {
        name: 'page target 数量',
        direct: directPages.length,
        tunnel: tunnelPages.length,
        match: directPages.length === tunnelPages.length,
        details: `标准 ${directPages.length} vs Tunnel ${tunnelPages.length} 个 page`
      },
      {
        name: 'page URL 列表',
        direct: directUrls,
        tunnel: tunnelUrls,
        match: JSON.stringify(directUrls) === JSON.stringify(tunnelUrls),
        details: 'page target 的 URL 列表是否一致'
      },
    ];
  },

  'Case 3: Target.setDiscoverTargets 事件': async (ctx) => {
    const directVersion = await ctx.httpGet(`http://localhost:${ctx.directPort}/json/version`);
    const tunnelVersion = await ctx.httpGet(`http://localhost:${ctx.tunnelPort}/json/version`);

    const directWs = await ctx.connectWS(directVersion.webSocketDebuggerUrl);
    const tunnelWs = await ctx.connectWS(tunnelVersion.webSocketDebuggerUrl);

    const directPromise = ctx.collectEvents(directWs, ['Target.targetCreated'], 5000);
    const tunnelPromise = ctx.collectEvents(tunnelWs, ['Target.targetCreated'], 5000);

    ctx.sendCDP(directWs, 'Target.setDiscoverTargets', { discover: true });
    ctx.sendCDP(tunnelWs, 'Target.setDiscoverTargets', { discover: true });

    const [directResult, tunnelResult] = await Promise.all([directPromise, tunnelPromise]);

    const directPages = directResult.filter(e => e.params?.targetInfo?.type === 'page');
    const tunnelPages = tunnelResult.filter(e => e.params?.targetInfo?.type === 'page');

    directWs.close();
    tunnelWs.close();

    return [
      {
        name: 'page targetCreated 事件数量',
        direct: directPages.length,
        tunnel: tunnelPages.length,
        match: directPages.length === tunnelPages.length,
        details: `标准 ${directPages.length} vs Tunnel ${tunnelPages.length} 个`
      },
      {
        name: 'targetId 列表',
        direct: directPages.map(e => e.params.targetInfo.targetId).sort(),
        tunnel: tunnelPages.map(e => e.params.targetInfo.targetId).sort(),
        match: JSON.stringify(directPages.map(e => e.params.targetInfo.targetId).sort()) ===
               JSON.stringify(tunnelPages.map(e => e.params.targetInfo.targetId).sort()),
        details: '两端的 targetId 是否完全一致'
      },
    ];
  },

  'Case 4: Target.getTargets 返回': async (ctx) => {
    const directVersion = await ctx.httpGet(`http://localhost:${ctx.directPort}/json/version`);
    const tunnelVersion = await ctx.httpGet(`http://localhost:${ctx.tunnelPort}/json/version`);

    const directWs = await ctx.connectWS(directVersion.webSocketDebuggerUrl);
    const tunnelWs = await ctx.connectWS(tunnelVersion.webSocketDebuggerUrl);

    const directResult = await ctx.sendCDP(directWs, 'Target.getTargets');
    const tunnelResult = await ctx.sendCDP(tunnelWs, 'Target.getTargets');

    directWs.close();
    tunnelWs.close();

    const directPages = (directResult.result?.targetInfos || []).filter(t => t.type === 'page');
    const tunnelPages = (tunnelResult.result?.targetInfos || []).filter(t => t.type === 'page');

    return [
      {
        name: 'page target 数量',
        direct: directPages.length,
        tunnel: tunnelPages.length,
        match: directPages.length === tunnelPages.length,
        details: `标准 ${directPages.length} vs Tunnel ${tunnelPages.length} 个 page`
      },
    ];
  },

  'Case 5: Target.createTarget + /json 可见性': async (ctx) => {
    const directBefore = await ctx.httpGet(`http://localhost:${ctx.directPort}/json`);
    const tunnelBefore = await ctx.httpGet(`http://localhost:${ctx.tunnelPort}/json`);
    const directBeforeCount = (directBefore || []).filter(t => t.type === 'page').length;
    const tunnelBeforeCount = (tunnelBefore || []).filter(t => t.type === 'page').length;

    const directVersion = await ctx.httpGet(`http://localhost:${ctx.directPort}/json/version`);
    const tunnelVersion = await ctx.httpGet(`http://localhost:${ctx.tunnelPort}/json/version`);
    const directWs = await ctx.connectWS(directVersion.webSocketDebuggerUrl);
    const tunnelWs = await ctx.connectWS(tunnelVersion.webSocketDebuggerUrl);

    const directCreate = await ctx.sendCDP(directWs, 'Target.createTarget', { url: 'https://example.com/cdp-compare-test' });
    const tunnelCreate = await ctx.sendCDP(tunnelWs, 'Target.createTarget', { url: 'https://example.com/cdp-compare-test' });

    const directTargetId = directCreate.result?.targetId;
    const tunnelTargetId = tunnelCreate.result?.targetId;

    await ctx.sleep(500);

    const directAfter = await ctx.httpGet(`http://localhost:${ctx.directPort}/json`);
    const tunnelAfter = await ctx.httpGet(`http://localhost:${ctx.tunnelPort}/json`);
    const directAfterCount = (directAfter || []).filter(t => t.type === 'page').length;
    const tunnelAfterCount = (tunnelAfter || []).filter(t => t.type === 'page').length;

    const directNewTarget = (directAfter || []).find(t => t.id === directTargetId);
    const tunnelNewTarget = (tunnelAfter || []).find(t => t.id === tunnelTargetId);

    directWs.close();
    tunnelWs.close();

    return [
      {
        name: 'createTarget 返回 targetId',
        direct: !!directTargetId,
        tunnel: !!tunnelTargetId,
        match: !!directTargetId && !!tunnelTargetId,
        details: `标准: ${directTargetId || 'null'} | Tunnel: ${tunnelTargetId || 'null'}`
      },
      {
        name: '创建后 /json target 数量变化',
        direct: directAfterCount - directBeforeCount,
        tunnel: tunnelAfterCount - tunnelBeforeCount,
        match: (directAfterCount - directBeforeCount) === (tunnelAfterCount - tunnelBeforeCount),
        details: `标准 +${directAfterCount - directBeforeCount} vs Tunnel +${tunnelAfterCount - tunnelBeforeCount}`
      },
      {
        name: '新 page 在 /json 中可见',
        direct: !!directNewTarget,
        tunnel: !!tunnelNewTarget,
        match: !!directNewTarget === !!tunnelNewTarget,
        details: `标准: ${!!directNewTarget} | Tunnel: ${!!tunnelNewTarget}`
      },
      {
        name: '新 page URL 正确',
        direct: directNewTarget?.url || 'N/A',
        tunnel: tunnelNewTarget?.url || 'N/A',
        match: directNewTarget?.url === tunnelNewTarget?.url,
        details: '导航后 /json 中 URL 是否更新为 example.com'
      },
    ];
  },

  'Case 6: Target.setAutoAttach 行为': async (ctx) => {
    const directVersion = await ctx.httpGet(`http://localhost:${ctx.directPort}/json/version`);
    const tunnelVersion = await ctx.httpGet(`http://localhost:${ctx.tunnelPort}/json/version`);
    const directWs = await ctx.connectWS(directVersion.webSocketDebuggerUrl);
    const tunnelWs = await ctx.connectWS(tunnelVersion.webSocketDebuggerUrl);

    const directPromise = ctx.collectEvents(directWs, ['Target.attachedToTarget', 'Target.targetCreated'], 8000);
    const tunnelPromise = ctx.collectEvents(tunnelWs, ['Target.attachedToTarget', 'Target.targetCreated'], 8000);

    ctx.sendCDP(directWs, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    });
    ctx.sendCDP(tunnelWs, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    });

    const [directResult, tunnelResult] = await Promise.all([directPromise, tunnelPromise]);

    const directAttached = directResult.filter(e => e.method === 'Target.attachedToTarget');
    const tunnelAttached = tunnelResult.filter(e => e.method === 'Target.attachedToTarget');
    const directCreated = directResult.filter(e => e.method === 'Target.targetCreated');
    const tunnelCreated = tunnelResult.filter(e => e.method === 'Target.targetCreated');

    directWs.close();
    tunnelWs.close();

    return [
      {
        name: 'attachedToTarget 事件数',
        direct: directAttached.length,
        tunnel: tunnelAttached.length,
        match: directAttached.length === tunnelAttached.length,
        details: `标准 ${directAttached.length} vs Tunnel ${tunnelAttached.length}`
      },
      {
        name: 'targetCreated 事件数',
        direct: directCreated.length,
        tunnel: tunnelCreated.length,
        match: directCreated.length === tunnelCreated.length,
        details: `标准 ${directCreated.length} vs Tunnel ${tunnelCreated.length}`
      },
    ];
  },

  'Case 7: Playwright pages()/contexts()': async (ctx) => {
    const results = [];

    let directBrowser, tunnelBrowser;
    try {
      directBrowser = await ctx.chromium.connectOverCDP(`http://localhost:${ctx.directPort}`, { timeout: 15000 });
    } catch (e) {
      results.push({
        name: 'connectOverCDP 连接',
        direct: 'FAILED',
        tunnel: null,
        match: false,
        details: `标准端连接失败: ${e.message}`
      });
      return results;
    }

    try {
      tunnelBrowser = await ctx.chromium.connectOverCDP(`http://localhost:${ctx.tunnelPort}`, { timeout: 15000 });
    } catch (e) {
      results.push({
        name: 'connectOverCDP 连接',
        direct: 'OK',
        tunnel: 'FAILED',
        match: false,
        details: `Tunnel端连接失败: ${e.message}`
      });
      try { directBrowser.close(); } catch {}
      return results;
    }

    const directCtxs = directBrowser.contexts();
    const tunnelCtxs = tunnelBrowser.contexts();

    results.push({
      name: 'browser.contexts() 数量',
      direct: directCtxs.length,
      tunnel: tunnelCtxs.length,
      match: directCtxs.length === tunnelCtxs.length,
      details: `标准 ${directCtxs.length} vs Tunnel ${tunnelCtxs.length} 个 context`
    });

    if (directCtxs.length > 0 && tunnelCtxs.length > 0) {
      const directPages = directCtxs[0].pages();
      const tunnelPages = tunnelCtxs[0].pages();

      results.push({
        name: 'contexts()[0].pages() 数量',
        direct: directPages.length,
        tunnel: tunnelPages.length,
        match: directPages.length === tunnelPages.length,
        details: `标准 ${directPages.length} vs Tunnel ${tunnelPages.length} 个 page`
      });

      results.push({
        name: 'pages() URL 列表',
        direct: directPages.map(p => p.url()).sort(),
        tunnel: tunnelPages.map(p => p.url()).sort(),
        match: JSON.stringify(directPages.map(p => p.url()).sort()) ===
               JSON.stringify(tunnelPages.map(p => p.url()).sort()),
        details: 'page URL 是否一致'
      });
    }

    try { directBrowser.close(); } catch {}
    try { tunnelBrowser.close(); } catch {}

    return results;
  },

  'Case 8: /json 与 Target.getTargets ID 对齐': async (ctx) => {
    const results = [];

    const jsonTargets = await ctx.httpGet(`http://localhost:${ctx.tunnelPort}/json`);
    const jsonPageIds = (jsonTargets || []).filter(t => t.type === 'page').map(t => t.id).sort();

    const tunnelVersion = await ctx.httpGet(`http://localhost:${ctx.tunnelPort}/json/version`);
    const tunnelWs = await ctx.connectWS(tunnelVersion.webSocketDebuggerUrl);
    const cdpResult = await ctx.sendCDP(tunnelWs, 'Target.getTargets');
    tunnelWs.close();

    const cdpPageIds = (cdpResult.result?.targetInfos || [])
      .filter(t => t.type === 'page')
      .map(t => t.targetId)
      .sort();

    const overlap = jsonPageIds.filter(id => cdpPageIds.includes(id));

    results.push({
      name: '/json page ID 与 CDP targetId 有交集',
      direct: jsonPageIds.length > 0,
      tunnel: overlap.length > 0,
      match: overlap.length > 0,
      details: `/json ${jsonPageIds.length} 个 page ID, CDP ${cdpPageIds.length} 个 page ID, 重叠 ${overlap.length} 个`
    });

    results.push({
      name: '/json page IDs',
      direct: jsonPageIds,
      tunnel: cdpPageIds,
      match: JSON.stringify(jsonPageIds) === JSON.stringify(cdpPageIds),
      details: 'ID 集合是否完全一致'
    });

    return results;
  },

  'Case 9: Target.getTargets 类型分布': async (ctx) => {
    const results = [];

    const directVersion = await ctx.httpGet(`http://localhost:${ctx.directPort}/json/version`);
    const tunnelVersion = await ctx.httpGet(`http://localhost:${ctx.tunnelPort}/json/version`);
    const directWs = await ctx.connectWS(directVersion.webSocketDebuggerUrl);
    const tunnelWs = await ctx.connectWS(tunnelVersion.webSocketDebuggerUrl);

    const directResult = await ctx.sendCDP(directWs, 'Target.getTargets');
    const tunnelResult = await ctx.sendCDP(tunnelWs, 'Target.getTargets');

    directWs.close();
    tunnelWs.close();

    const countByType = (infos) => {
      const counts = {};
      for (const t of infos) {
        counts[t.type] = (counts[t.type] || 0) + 1;
      }
      return counts;
    };

    const directCounts = countByType(directResult.result?.targetInfos || []);
    const tunnelCounts = countByType(tunnelResult.result?.targetInfos || []);

    results.push({
      name: 'page 类型 target 数量',
      direct: directCounts['page'] || 0,
      tunnel: tunnelCounts['page'] || 0,
      match: (directCounts['page'] || 0) === (tunnelCounts['page'] || 0),
      details: `标准 page: ${directCounts['page'] || 0} | Tunnel page: ${tunnelCounts['page'] || 0}`
    });

    results.push({
      name: 'target 类型分布',
      direct: directCounts,
      tunnel: tunnelCounts,
      match: JSON.stringify(directCounts) === JSON.stringify(tunnelCounts),
      details: '各类型 target 数量分布'
    });

    return results;
  },

  'Case 10: HTTP REST 端点 (/json/new, /json/close, /json/activate, /json/protocol)': async (ctx) => {
    const results = [];

    const endpoints = [
      { path: '/json/protocol', method: 'GET', desc: 'CDP 协议定义' },
      { path: '/json/new', method: 'PUT', desc: '创建新标签页' },
    ];

    for (const ep of endpoints) {
      const directOk = await checkEndpoint(ctx.directPort, ep.path, ep.method);
      const tunnelOk = await checkEndpoint(ctx.tunnelPort, ep.path, ep.method);

      results.push({
        name: `${ep.method} ${ep.path}`,
        direct: directOk,
        tunnel: tunnelOk,
        match: directOk === tunnelOk,
        details: `${ep.desc} — 标准: ${directOk ? '支持' : '不支持'} | Tunnel: ${tunnelOk ? '支持' : '不支持'}`
      });
    }

    const directTargets = await ctx.httpGet(`http://localhost:${ctx.directPort}/json`);
    const directPageId = (directTargets || []).find(t => t.type === 'page')?.id;

    if (directPageId) {
      for (const ep of [
        { path: `/json/close/${directPageId}`, desc: '关闭标签页' },
        { path: `/json/activate/${directPageId}`, desc: '激活标签页' },
      ]) {
        const directOk = await checkEndpoint(ctx.directPort, ep.path, 'GET');
        const tunnelOk = await checkEndpoint(ctx.tunnelPort, ep.path.replace(directPageId, 'ANY_ID'), 'GET');

        results.push({
          name: `GET ${ep.path}`,
          direct: directOk,
          tunnel: tunnelOk,
          match: directOk === tunnelOk,
          details: `${ep.desc} — 标准: ${directOk ? '支持' : '不支持'} | Tunnel: ${tunnelOk ? '支持' : '不支持'}`
        });
      }
    }

    return results;
  },

  'Case 11: 新建 page 在 Target.getTargets 中是否可见（区分已有 vs 新建）': async (ctx) => {
    const results = [];

    const directVersion = await ctx.httpGet(`http://localhost:${ctx.directPort}/json/version`);
    const tunnelVersion = await ctx.httpGet(`http://localhost:${ctx.tunnelPort}/json/version`);
    const directWs = await ctx.connectWS(directVersion.webSocketDebuggerUrl);
    const tunnelWs = await ctx.connectWS(tunnelVersion.webSocketDebuggerUrl);

    const directBefore = await ctx.sendCDP(directWs, 'Target.getTargets');
    const tunnelBefore = await ctx.sendCDP(tunnelWs, 'Target.getTargets');
    const directPagesBefore = (directBefore.result?.targetInfos || []).filter(t => t.type === 'page').length;
    const tunnelPagesBefore = (tunnelBefore.result?.targetInfos || []).filter(t => t.type === 'page').length;

    results.push({
      name: '创建前: Target.getTargets page 数量 (均为新客户端)',
      direct: directPagesBefore,
      tunnel: tunnelPagesBefore,
      match: directPagesBefore === tunnelPagesBefore,
      details: `两者都是新连接，尚未创建任何 page`
    });

    const directCreate = await ctx.sendCDP(directWs, 'Target.createTarget', { url: 'about:blank' });
    const tunnelCreate = await ctx.sendCDP(tunnelWs, 'Target.createTarget', { url: 'about:blank' });
    const directNewId = directCreate.result?.targetId;
    const tunnelNewId = tunnelCreate.result?.targetId;

    await ctx.sleep(1000);

    const directAfter = await ctx.sendCDP(directWs, 'Target.getTargets');
    const tunnelAfter = await ctx.sendCDP(tunnelWs, 'Target.getTargets');
    const directPagesAfter = (directAfter.result?.targetInfos || []).filter(t => t.type === 'page');
    const tunnelPagesAfter = (tunnelAfter.result?.targetInfos || []).filter(t => t.type === 'page');

    const directFound = directPagesAfter.some(t => t.targetId === directNewId);
    const tunnelFound = tunnelPagesAfter.some(t => t.targetId === tunnelNewId);

    results.push({
      name: '创建后: 新 page 在 Target.getTargets 中可见',
      direct: directFound,
      tunnel: tunnelFound,
      match: directFound === tunnelFound,
      details: `标准: ${directFound ? '找到' : '未找到'} | Tunnel: ${tunnelFound ? '找到' : '未找到'} (新建的 page)`
    });

    results.push({
      name: '创建后: page 数量变化',
      direct: directPagesAfter.length - directPagesBefore,
      tunnel: tunnelPagesAfter.length - tunnelPagesBefore,
      match: (directPagesAfter.length - directPagesBefore) === (tunnelPagesAfter.length - tunnelPagesBefore),
      details: `标准 +${directPagesAfter.length - directPagesBefore} vs Tunnel +${tunnelPagesAfter.length - tunnelPagesBefore}`
    });

    directWs.close();
    tunnelWs.close();

    return results;
  },
};

function checkEndpoint(port, urlPath, method) {
  return new Promise((resolve) => {
    const url = new URL(`http://localhost:${port}${urlPath}`);
    const options = { hostname: url.hostname, port: url.port, path: url.pathname, method, timeout: 3000 };
    const req = http.request(options, (res) => {
      resolve(res.statusCode !== 404);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

