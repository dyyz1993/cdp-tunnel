const { chromium } = require('playwright');

async function testTabGrouping() {
  console.log('Testing tab grouping functionality...');
  
  // Connect to CDP tunnel
  const browser = await chromium.connectOverCDP('http://localhost:9221');
  
  try {
    // Create a new page
    console.log('Creating new page...');
    const page = await browser.newPage();
    
    // Navigate to Baidu
    console.log('Navigating to Baidu...');
    await page.goto('https://www.baidu.com/');
    
    // Wait for a moment to ensure the page is loaded
    await page.waitForTimeout(2000);
    
    console.log('Page created successfully. Check if it is in the "lo" group.');
    
    // Create another page to test multiple pages
    console.log('Creating second page...');
    const page2 = await browser.newPage();
    await page2.goto('https://www.google.com/');
    await page2.waitForTimeout(2000);
    
    console.log('Second page created. Check if both pages are in the "lo" group.');
    
    // Keep the browser open for inspection
    console.log('Test completed. Check the Chrome browser for tab groups.');
    
    // Wait for user input to close
    console.log('Press Enter to close...');
    process.stdin.resume();
    process.stdin.on('data', async () => {
      await browser.close();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('Error during test:', error);
    await browser.close();
  }
}

testTabGrouping();