const { log, sleep, sendCDP, httpGet, collectCDPEvents,
        startProxy, patchExtension, startBrowser, waitForExtension,
        connectCDP, cleanup } = require('./helpers');

const TEST_PORT = 19876;

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('  CDP Tunnel E2E Test Suite');
  console.log('='.repeat(60));

  try {
    log('SETUP', `Starting proxy on port ${TEST_PORT}...`);
    assert(await startProxy(TEST_PORT), 'Proxy failed to start');
    log('SETUP', 'Proxy started');

    log('SETUP', 'Patching extension...');
    await patchExtension(TEST_PORT);

    log('SETUP', 'Starting browser...');
    await startBrowser();

    log('SETUP', 'Waiting for extension...');
    assert(await waitForExtension(TEST_PORT), 'Extension failed to connect');
    log('SETUP', 'Extension connected');

    await sleep(3000);

    async function cleanupLeftoverPages() {
      try {
        const list = await httpGet(TEST_PORT, '/json/list');
        const leftovers = list.filter(t => t.url && t.url.includes('example.com'));
        if (leftovers.length > 0) {
          log('CLEANUP', `Found ${leftovers.length} leftover pages from previous test, cleaning...`);
          const ws = await connectCDP(TEST_PORT);
          await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });
          for (const t of leftovers) {
            try { await sendCDP(ws, 'Target.closeTarget', { targetId: t.id }); } catch {}
          }
          ws.close();
          await sleep(3000);
        }
      } catch {}
    }

    // ===== T2: Single client disconnect =====
    await cleanupLeftoverPages();
    await runTest('T2: Client disconnect kills all pages', async () => {
      const ws = await connectCDP(TEST_PORT);
      await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });

      const pages = [];
      for (let i = 0; i < 2; i++) {
        const r = await sendCDP(ws, 'Target.createTarget', { url: `https://www.example.com/?t2_${i}` });
        pages.push(r.targetId);
      }
      await sleep(8000);

      ws.close();
      await sleep(10000);

      const list = await httpGet(TEST_PORT, '/json/list');
      const surviving = list.filter(t => pages.includes(t.id));
      assert(surviving.length === 0, `${surviving.length} pages survived disconnect`);
    });
    await sleep(5000);

    // ===== T1: Single client Browser.close =====
    await cleanupLeftoverPages();
    await runTest('T1: Browser.close kills all pages', async () => {
      const ws = await connectCDP(TEST_PORT);
      await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });

      const pages = [];
      for (let i = 0; i < 3; i++) {
        const r = await sendCDP(ws, 'Target.createTarget', { url: `https://www.example.com/?t1_${i}` });
        pages.push(r.targetId);
      }
      await sleep(5000);

      await sendCDP(ws, 'Browser.close');
      await sleep(6000);

      const list = await httpGet(TEST_PORT, '/json/list');
      const surviving = list.filter(t => pages.includes(t.id));
      assert(surviving.length === 0, `${surviving.length} pages survived Browser.close`);
    });
    await sleep(5000);

    // ===== T3: Multi-client isolation - getTargets =====
    await cleanupLeftoverPages();
    await runTest('T3: Multi-client Target.getTargets isolation', async () => {
      const wsA = await connectCDP(TEST_PORT);
      const wsB = await connectCDP(TEST_PORT);
      await sendCDP(wsA, 'Target.setDiscoverTargets', { discover: true });
      await sendCDP(wsB, 'Target.setDiscoverTargets', { discover: true });

      const rA = await sendCDP(wsA, 'Target.createTarget', { url: 'https://www.example.com/?clientA' });
      const rB = await sendCDP(wsB, 'Target.createTarget', { url: 'https://www.example.com/?clientB' });
      await sleep(3000);

      const targetsA = await sendCDP(wsA, 'Target.getTargets');
      const targetsB = await sendCDP(wsB, 'Target.getTargets');

      const pagesA = targetsA.targetInfos.filter(t => t.type === 'page' && t.url.includes('client'));
      const pagesB = targetsB.targetInfos.filter(t => t.type === 'page' && t.url.includes('client'));

      assert(!pagesA.some(p => p.url.includes('clientB')), 'Client A sees Client B pages!');
      assert(!pagesB.some(p => p.url.includes('clientA')), 'Client B sees Client A pages!');
      assert(pagesA.some(p => p.url.includes('clientA')), 'Client A cannot see own pages');
      assert(pagesB.some(p => p.url.includes('clientB')), 'Client B cannot see own pages');

      wsA.close();
      wsB.close();
      await sleep(8000);
    });
    await sleep(5000);

    // ===== T4: Close individual page =====
    await cleanupLeftoverPages();
    await runTest('T4: Close individual page without affecting others', async () => {
      const ws = await connectCDP(TEST_PORT);
      await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });

      const r1 = await sendCDP(ws, 'Target.createTarget', { url: 'https://www.example.com/?t4_keep' });
      const r2 = await sendCDP(ws, 'Target.createTarget', { url: 'https://www.example.com/?t4_close' });
      await sleep(3000);

      await sendCDP(ws, 'Target.closeTarget', { targetId: r2.targetId });
      await sleep(2000);

      const targets = await sendCDP(ws, 'Target.getTargets');
      const pages = targets.targetInfos.filter(t => t.type === 'page' && t.url.includes('t4'));
      
      assert(pages.some(p => p.url.includes('t4_keep')), 't4_keep should still exist');
      assert(!pages.some(p => p.url.includes('t4_close')), 't4_close should be gone');

      await sendCDP(ws, 'Browser.close');
      await sleep(6000);
    });
    await sleep(5000);

    // ===== T5: No cross-client page leakage =====
    await cleanupLeftoverPages();
    await runTest('T5: No page leakage across clients', async () => {
      const wsA = await connectCDP(TEST_PORT);
      const wsB = await connectCDP(TEST_PORT);
      await sendCDP(wsA, 'Target.setDiscoverTargets', { discover: true });
      await sendCDP(wsB, 'Target.setDiscoverTargets', { discover: true });

      // Client A creates a page
      const rA = await sendCDP(wsA, 'Target.createTarget', { url: 'https://www.example.com/?t5_A' });
      await sleep(3000);

      // Client B should not see it
      const targetsB = await sendCDP(wsB, 'Target.getTargets');
      const pagesB = targetsB.targetInfos.filter(t => t.type === 'page' && t.url.includes('t5'));
      assert(pagesB.length === 0, `Client B sees ${pagesB.length} of Client A pages`);

      // Client A closes, B should not be affected
      await sendCDP(wsA, 'Browser.close');
      await sleep(6000);

      const targetsB2 = await sendCDP(wsB, 'Target.getTargets');
      assert(targetsB2.targetInfos !== undefined, 'Client B should still be functional');

      wsB.close();
      await sleep(8000);
    });
    await sleep(5000);

  } catch (e) {
    console.error(`\nSetup failed: ${e.message}`);
    console.error(e.stack);
  }

  await cleanup();

  console.log('\n' + '='.repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
main();
