/**
 * Chrome headless 冒烟测试：真实加载扩展，打开目标站点，验证
 *   1. 面板可打开、分页控件已消失
 *   2. 提取 + 徽标渲染正常
 *   3. 通过“导入文件”真正改写页面文本
 *
 * 运行：<node> tests/smoke.mjs [扩展目录]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.resolve(process.argv[2] || root);
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9400 + Math.floor(Math.random() * 200);
const profileDir = path.join(root, '.tmp', 'chrome-profile-' + Date.now());
const chromeLog = path.join(root, '.tmp', 'chrome-smoke.log');
const screenshotPath = path.join(root, 'tests', 'screenshots', 'smoke.png');

fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
fs.rmSync(chromeLog, { force: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(
    chromePath,
    [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--user-data-dir=' + profileDir,
        '--remote-debugging-port=' + port,
        '--disable-extensions-except=' + extensionPath,
        '--load-extension=' + extensionPath,
        '--window-size=1440,1000',
        '--enable-logging',
        '--log-file=' + chromeLog,
        'https://lell1203.github.io/maurice_simul/'
    ],
    { stdio: 'ignore' }
);

let chromeExit = null;
chrome.on('exit', (code, signal) => {
    chromeExit = { code, signal };
    console.log('Chrome 进程退出:', code, signal);
});

let ws = null;
let messageId = 0;
const pending = new Map();
const consoleEvents = [];
const errors = [];

async function fetchJson(url, attempts = 200) {
    for (let i = 0; i < attempts; i++) {
        try {
            const response = await fetch(url);
            if (response.ok) return await response.json();
        } catch (_) {
            // Chrome 还没起来
        }
        await sleep(200);
    }
    throw new Error('无法连接 Chrome DevTools：' + url);
}

function send(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = ++messageId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
    });
    if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
        throw new Error('页面脚本异常：' + detail);
    }
    return result.result.value;
}

async function poll(description, fn, timeoutMs = 30000) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
        try {
            last = await fn();
            if (last) return last;
        } catch (error) {
            last = error.message;
        }
        await sleep(250);
    }
    throw new Error(`等待超时：${description}（最后结果：${JSON.stringify(last)}）`);
}

async function closeChrome() {
    try {
        if (ws) await send('Browser.close');
    } catch (_) {
        // 已经关了
    }
    await sleep(500);
    if (!chrome.killed) {
        const killer = spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
        await new Promise((resolve) => killer.on('exit', resolve));
    }
}

try {
    // 1. 连接页面
    await fetchJson(`http://127.0.0.1:${port}/json/version`);
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const pageTarget = targets.find(
        (target) => target.type === 'page' && target.url.includes('lell1203.github.io')
    );
    if (!pageTarget) throw new Error('没找到目标页面：' + JSON.stringify(targets));

    const serviceWorker = targets.find((target) => target.type === 'service_worker');
    console.log('扩展 service worker:', serviceWorker ? serviceWorker.url : '（未发现）');

    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error('DevTools WebSocket 连接失败'));
    });

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            const { resolve, reject } = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) reject(new Error(message.error.message));
            else resolve(message.result);
            return;
        }
        if (message.method === 'Runtime.consoleAPICalled') {
            const text = (message.params.args || [])
                .map((arg) => arg.value ?? arg.description ?? '')
                .join(' ');
            consoleEvents.push({ type: message.params.type, text });
            if (message.params.type === 'error') errors.push(text);
        }
        if (message.method === 'Runtime.exceptionThrown') {
            errors.push(message.params.exceptionDetails.exception?.description || '未捕获异常');
        }
        if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
            errors.push(message.params.entry.text);
        }
    };

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');

    // 2. 等页面加载完，按 F1 打开面板
    await poll('页面加载完成', () => evaluate(`document.readyState === 'complete'`), 30000);

    const openPanel = async () => {
        return evaluate(`
            (() => {
                const panels = [...document.documentElement.children].filter(
                    (el) => el.style && el.style.zIndex === '2147483647'
                );
                if (panels.length) return true;
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'F1', code: 'F1', bubbles: true, cancelable: true
                }));
                return false;
            })()
        `);
    };

    await poll('按 F1 后出现面板', async () => (await openPanel()) || null, 20000);

    const panelInfo = await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            const text = panel.innerText;
            return {
                text,
                hasExtract: text.includes('提取并保存'),
                hasFind: !!panel.querySelector('[data-el="q"]'),
                findPlaceholder: panel.querySelector('[data-el="q"]')?.placeholder || '',
                hasNewPage: text.includes('新页号'),
                hasPageList: text.includes('抓取过的页面'),
                hasPageInput: !!panel.querySelector('[data-el="pid"]'),
                buttons: [...panel.querySelectorAll('button')].map((b) => b.textContent.trim())
            };
        })()
    `);

    console.log('面板按钮:', panelInfo.buttons.join(' | '));
    if (!panelInfo.hasExtract) throw new Error('面板缺少“提取并保存”按钮');
    if (!panelInfo.hasFind) throw new Error('面板缺少查词输入框');
    if (panelInfo.hasNewPage || panelInfo.hasPageList || panelInfo.hasPageInput) {
        throw new Error('分页控件没有被移除');
    }

    // 3. 提取并检查徽标
    await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            [...panel.querySelectorAll('button')]
                .find((b) => b.textContent.trim() === '提取并保存')
                .click();
            return true;
        })()
    `);

    const extractResult = await poll('提取完成', () =>
        evaluate(`
            (() => {
                const panel = [...document.documentElement.children].find(
                    (el) => el.style && el.style.zIndex === '2147483647'
                );
                const text = panel.querySelector('[data-el="result"]').textContent;
                return text.includes('共提取') ? text : '';
            })()
        `), 60000
    );

    const counts = await evaluate(`
        (() => {
            const overlay = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483646'
            );
            return {
                badges: overlay ? overlay.children.length : 0,
                result: (() => {
                    const panel = [...document.documentElement.children].find(
                        (el) => el.style && el.style.zIndex === '2147483647'
                    );
                    return panel.querySelector('[data-el="result"]').textContent;
                })()
            };
        })()
    `);

    console.log('提取结果:', extractResult.replace(/\n/g, ' / '));
    console.log('徽标数量:', counts.badges);
    if (!counts.badges) throw new Error('提取后没有渲染任何徽标');

    // 4. 用“导入文件”走一遍真实翻译链路
    await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            const dict = {
                format: 'maurice-dict',
                version: '1.0',
                name: 'smoke-demo',
                description: '冒烟测试',
                global: { '파일': '文件', '편집': '编辑', '보기': '视图' },
                perPage: {}
            };
            const file = new File([JSON.stringify(dict)], 'smoke-demo.json', {
                type: 'application/json'
            });
            const transfer = new DataTransfer();
            transfer.items.add(file);
            const input = panel.querySelector('[data-el="file"]');
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()
    `);

    const importResult = await poll('词库导入完成', () =>
        evaluate(`
            (() => {
                const panel = [...document.documentElement.children].find(
                    (el) => el.style && el.style.zIndex === '2147483647'
                );
                const text = panel.querySelector('[data-el="result"]').textContent;
                return text.includes('导入成功') ? text : '';
            })()
        `), 30000
    );

    const translation = await evaluate(`
        (() => {
            const bodyText = document.body.innerText;
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            return {
                hasChinese: bodyText.includes('文件'),
                hasKorean: bodyText.includes('파일'),
                dictListed: panel.innerText.includes('smoke-demo'),
                dictChecked: (() => {
                    const box = panel.querySelector('[data-dict-toggle="smoke-demo"]');
                    return box ? box.checked : false;
                })()
            };
        })()
    `);

    console.log('导入结果:', importResult.replace(/\n/g, ' / '));
    console.log('页面翻译:', JSON.stringify(translation));
    if (!translation.hasChinese) throw new Error('导入词库后页面没有出现译文“文件”');
    if (!translation.dictListed || !translation.dictChecked) {
        throw new Error('词库列表没有显示 / 启用导入的词库');
    }

    // 5. 截图
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    const ignoredWarnings = errors.filter(
        (text) => !/favicon|net::ERR|Failed to load resource/i.test(text)
    );
    console.log('控制台错误:', ignoredWarnings.length ? ignoredWarnings : '无');
    console.log('截图:', screenshotPath);
    console.log('\nSMOKE OK');
    if (ignoredWarnings.length) process.exitCode = 2;
} catch (error) {
    console.error('\nSMOKE FAILED:', error.message);
    if (chromeExit) console.error('Chrome 退出状态:', chromeExit);
    try {
        const log = fs.readFileSync(chromeLog, 'utf8').trim().split('\n').slice(-25).join('\n');
        if (log) console.error('Chrome 日志:\n' + log);
    } catch (_) {
        // 没有日志
    }
    if (consoleEvents.length) {
        console.error('控制台输出:');
        for (const event of consoleEvents.slice(-30)) {
            console.error(`  [${event.type}] ${event.text}`);
        }
    }
    process.exitCode = 1;
} finally {
    await closeChrome();
    try {
        fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (_) {
        // 文件占用就留着
    }
}
