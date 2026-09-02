// Screenshot script for DW态势 page
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const LOCAL_URL = 'http://127.0.0.1:8765/pages/dw-situation.html';

async function main() {
  let browserPath = CHROME_PATH;
  if (!fs.existsSync(browserPath)) {
    browserPath = EDGE_PATH;
  }
  if (!fs.existsSync(browserPath)) {
    console.log('No Chrome/Edge found at: ' + browserPath);
    // Search for chrome
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) { browserPath = p; break; }
    }
  }
  console.log('Using browser: ' + browserPath);
  
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });
  
  const page = await browser.newViewport({ width: 1400, height: 900 });
  // Also set user agent for Windows
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  console.log('Navigating to ' + LOCAL_URL);
  await page.goto(LOCAL_URL, { waitUntil: 'networkidle2', timeout: 15000 });
  
  // Wait for Lucide icons to initialize
  await page.waitForTimeout(2500);
  
  // Try to render icons
  try {
    await page.evaluate(() => {
      if (window.lucide && window.lucide.createIcons) {
        window.lucide.createIcons();
      }
    });
  } catch (e) {
    console.log('Lucide init error: ' + e.message);
  }
  
  await page.waitForTimeout(1500);
  
  const outPath = path.join(__dirname, 'assets', 'dw-screenshot.png');
  await page.screenshot({ path: outPath, fullPage: false });
  console.log('Screenshot saved: ' + outPath);
  
  // Also check icon visibility
  const iconCheck = await page.evaluate(() => {
    const icons = document.querySelectorAll('[data-lucide]');
    const iconSizes = Array.from(icons).slice(0, 10).map(i => {
      const r = i.getBoundingClientRect();
      return { name: i.getAttribute('data-lucide'), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return {
      totalIcons: icons.length,
      topIcons: iconSizes
    };
  });
  console.log(JSON.stringify(iconCheck, null, 2));
  
  await browser.close();
}

main().catch(err => {
  console.error('Error: ' + err.message);
  process.exit(1);
});
