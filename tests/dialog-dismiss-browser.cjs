// Offline interaction checks: no server, account, database or network required.
const {chromium} = require('/opt/travel-notes/test-tools/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
(async () => {
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({viewport: mobile ? {width: 390, height: 844} : {width: 1280, height: 900}, hasTouch: mobile});
      await context.route('**/*', route => route.abort());
      const page = await context.newPage();
      for (const entry of ['admin', 'index']) {
        const html = read(`static/${entry}.html`);
        assert.ok(html.includes('/static/dialog-dismiss.js'));
        await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, ''));
        await page.addStyleTag({content: read(`static/${entry === 'admin' ? 'admin' : 'style'}.css`)});
        await page.addScriptTag({path: path.join(root, 'static/dialog-dismiss.js')});
        const selector = entry === 'admin' ? '#dialog' : '#confirm-dialog';
        await page.evaluate(selector => {
          window.d = document.querySelector(selector);
          if (selector === '#dialog') document.querySelector('#dialog-content').innerHTML = '<h2>正文预览</h2><input value="保留正文"><p>可选择的文字</p>';
          window.cancels = 0;
          d.addEventListener('cancel', () => window.cancels++);
          d.showModal();
        }, selector);
        const open = () => page.evaluate(() => d.open);
        const box = await page.locator(selector).boundingBox();
        await page.mouse.click(box.x + 8, box.y + 8); // dialog padding is content, not backdrop
        assert.equal(await open(), true);
        await page.mouse.move(box.x + 30, box.y + 60);
        await page.mouse.down();
        await page.mouse.move(3, 3);
        await page.mouse.up();
        assert.equal(await open(), true, 'dragging out must not close');
        await page.mouse.move(3, 3);
        await page.mouse.down();
        await page.mouse.move(100, 3);
        await page.mouse.up();
        assert.equal(await open(), true, 'swiping backdrop must not close');
        if (mobile) await page.touchscreen.tap(3, 3);
        else await page.mouse.click(3, 3);
        assert.equal(await open(), false);
        assert.equal(await page.evaluate(() => cancels), 1);
        await page.evaluate(() => d.showModal());
        await page.keyboard.press('Escape');
        assert.equal(await open(), false);
        // A dynamically appended dialog uses the same handler and respects cancel guards.
        await page.evaluate(() => {
          window.d = document.createElement('dialog');
          d.textContent = '动态照片 / 分享弹窗';
          document.body.append(d);
          window.guard = e => e.preventDefault();
          d.addEventListener('cancel', guard);
          d.showModal();
        });
        await page.mouse.click(3, 3);
        assert.equal(await open(), true);
        await page.evaluate(() => d.removeEventListener('cancel', guard));
        await page.mouse.click(3, 3);
        assert.equal(await open(), false);
        if (entry === 'index') {
          // Exercise the application's actual delete-confirmation promise.
          const confirmFunction = read('static/app.js').split('\n').find(line => line.startsWith('function confirmDelete()'));
          await page.addScriptTag({content: 'const $ = selector => document.querySelector(selector);\n' + confirmFunction});
          await page.evaluate(() => { window.result = 'pending'; confirmDelete().then(value => window.result = value); });
          await page.mouse.click(3, 3);
          assert.equal(await page.evaluate(() => result), false);
          await page.evaluate(() => { window.result = 'pending'; confirmDelete().then(value => window.result = value); });
          await page.locator('#confirm-ok').click();
          assert.equal(await page.evaluate(() => result), true);
        }
      }
      await context.close();
    }
    console.log('PASS: desktop/mobile backdrop, content, drag, swipe, Esc, dynamic dialogs, cancel guard and delete confirmation');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
