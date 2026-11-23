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
        '--disable-features=ExtensionDisableUnsupportedDeveloper',
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

async function clickPanelButton(label) {
    return evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            if (!panel) return false;
            const button = [...panel.querySelectorAll('button')]
                .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
            if (!button) return false;
            button.click();
            return true;
        })()
    `);
}

async function getPanelResult() {
    return evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            return panel ? panel.querySelector('[data-el="result"]').textContent : '';
        })()
    `);
}

async function clearPanelResult() {
    return evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            if (panel) panel.querySelector('[data-el="result"]').textContent = '';
            return true;
        })()
    `);
}

async function findCurrentSelectionId() {
    await clearPanelResult();
    await clickPanelButton('查找');
    const message = await poll('选区查找', async () => {
        const text = await getPanelResult();
        return /属于 P\d+-\d+/.test(text) ? text : '';
    }, 15000);
    return { message, id: (/P\d+-\d+/.exec(message) || [])[0] };
}

async function selectSmokeSpan(index, start, end) {
    return evaluate(`
        (() => {
            const box = document.getElementById('maurice-smoke-selection');
            if (!box) return null;
            const span = box.querySelectorAll('span')[${index}];
            if (!span || !span.firstChild) return null;
            const node = span.firstChild;
            const range = document.createRange();
            range.setStart(node, ${start});
            range.setEnd(node, Math.min(node.textContent.length, ${end}));
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return range.toString();
        })()
    `);
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
        if (message.method === 'Page.javascriptDialogOpening') {
            send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        }
    };

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');

    // 2. 等页面加载完，按 Alt+M 打开面板
    await poll('页面加载完成', () => evaluate(`document.readyState === 'complete'`), 30000);

    const openPanel = async () => {
        return evaluate(`
            (() => {
                const panels = [...document.documentElement.children].filter(
                    (el) => el.style && el.style.zIndex === '2147483647'
                );
                if (panels.length) return true;
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'm', code: 'KeyM', altKey: true, bubbles: true, cancelable: true
                }));
                return false;
            })()
        `);
    };

    await poll('按 Alt+M 后出现面板', async () => (await openPanel()) || null, 20000);

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

    // 3. 服务器：001 / 002 自动下载（不勾选），并测试手动下载编号
    await sleep(5000);
    const initialServerState = await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            const text = panel.innerText;
            return {
                has001: text.includes('001 人工翻译'),
                has002: text.includes('002 AI 翻译'),
                checked001: (() => {
                    const box = panel.querySelector('[data-dict-toggle="server-001"]');
                    return box ? box.checked : null;
                })(),
                result: panel.querySelector('[data-el="result"]').textContent
            };
        })()
    `);
    console.log('初始服务器文件:', JSON.stringify(initialServerState));
    if (!initialServerState.has001 || !initialServerState.has002) {
        throw new Error('001 / 002 没有自动下载');
    }
    if (initialServerState.checked001 !== false) {
        throw new Error('001 初始文件被默认勾选了');
    }

    await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            panel.querySelector('[data-dict-progress="001"]').click();
            return true;
        })()
    `);
    const progressResult = await poll('查询 001 进度', async () => {
        const text = await getPanelResult();
        return text.includes('001 翻译进度') ? text : '';
    }, 20000);
    console.log('查询进度:', progressResult.replace(/\n/g, ' / '));

    await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            panel.querySelector('[data-dict-progress="002"]').click();
            return true;
        })()
    `);
    const progress002 = await poll('查询 002 进度', async () => {
        const text = await getPanelResult();
        return text.includes('002 翻译进度') && text.includes('52%') ? text : '';
    }, 20000);
    console.log('查询 002 进度:', progress002.replace(/\n/g, ' / '));

    await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            panel.querySelector('[data-el="server-code"]').value = '001';
            [...panel.querySelectorAll('button')]
                .find((b) => b.dataset.act === 'download-server')
                .click();
            return true;
        })()
    `);

    const serverDownloadResult = await poll('服务器编号下载', async () => {
        const text = await getPanelResult();
        return text.includes('已下载') || text.includes('出错') ? text : '';
    }, 20000);
    console.log('下载 001:', serverDownloadResult.replace(/\n/g, ' / '));
    if (serverDownloadResult.includes('出错')) {
        throw new Error('服务器下载失败：' + serverDownloadResult);
    }

    // 4. 提取并检查徽标
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

    // 4. 选区查找：只选中一段文本的一部分，应高亮完整段落
    const partialSelection = await evaluate(`
        (() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const parent = node.parentElement;
                if (!parent || parent.closest('[data-maurice-panel]')) continue;
                const text = node.textContent || '';
                const start = text.search(/[A-Za-z]/);
                if (start < 0) continue;
                const rect = parent.getBoundingClientRect();
                if (rect.width < 4 || rect.height < 4) continue;

                const range = document.createRange();
                range.setStart(node, start);
                range.setEnd(node, Math.min(text.length, start + 4));
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                return { text: range.toString(), rect: range.getBoundingClientRect().toJSON() };
            }
            return null;
        })()
    `);
    if (!partialSelection || !partialSelection.text.trim()) {
        throw new Error('没能在页面上选中一段测试文本');
    }
    await sleep(150);
    await clearPanelResult();
    await clickPanelButton('查找');

    const partialResult = await poll('选区查找（部分选中）', async () => {
        const text = await getPanelResult();
        return /属于 P\d+-\d+/.test(text) ? text : '';
    }, 15000);

    const partialHighlight = await evaluate(`
        [...document.documentElement.children].filter(
            (el) => el.style && el.style.zIndex === '2147483645'
        ).length
    `);
    console.log('部分选中:', partialSelection.text.trim(), '→', partialResult.replace(/\n/g, ' / '));
    if (!partialHighlight) throw new Error('选区查找没有画出高亮框');

    // 5. 右键拖动 + 超过 2 条标注时只高亮选区
    await evaluate(`
        (() => {
            const box = document.createElement('div');
            box.id = 'maurice-smoke-selection';
            Object.assign(box.style, {
                position: 'fixed',
                left: '40px',
                top: '560px',
                zIndex: '2147483644',
                background: '#fff',
                color: '#000',
                padding: '10px',
                fontFamily: 'monospace',
                fontSize: '16px'
            });
            box.innerHTML = [
                '<span>AlphaOne</span>',
                '<span>BetaTwo</span>',
                '<span>GammaThree</span>'
            ].join(' ');
            document.body.appendChild(box);
            return true;
        })()
    `);

    await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            panel.querySelector('[data-el="result"]').textContent = '';
            return true;
        })()
    `);
    await clickPanelButton('提取并保存');
    await poll('测试容器提取完成', async () => {
        const text = await getPanelResult();
        return text.includes('共提取') ? text : '';
    }, 30000);

    const rightDragText = await evaluate(`
        (() => {
            const box = document.getElementById('maurice-smoke-selection');
            const span = box.querySelectorAll('span')[1];
            const rect = span.getBoundingClientRect();
            const y = rect.top + rect.height / 2;
            const startX = rect.left + 6;
            const endX = rect.right - 6;

            const fire = (type, x, buttons) => {
                document.dispatchEvent(new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    button: 2,
                    buttons,
                    clientX: x,
                    clientY: y
                }));
            };

            fire('mousedown', startX, 2);
            fire('mousemove', (startX + endX) / 2, 2);
            fire('mousemove', endX, 2);
            fire('mouseup', endX, 0);

            return window.getSelection().toString();
        })()
    `);
    if (!rightDragText.trim()) throw new Error('右键拖动没有产生选区');
    await sleep(150);
    await clearPanelResult();
    await clickPanelButton('查找');

    const rightDragResult = await poll('右键选区查找', async () => {
        const text = await getPanelResult();
        return /属于 P\d+-\d+/.test(text) ? text : '';
    }, 15000);
    console.log('右键拖动:', rightDragText.trim(), '→', rightDragResult.replace(/\n/g, ' / '));

    const multiSelection = await evaluate(`
        (() => {
            const box = document.getElementById('maurice-smoke-selection');
            const spans = box.querySelectorAll('span');
            const first = spans[0].firstChild;
            const last = spans[2].firstChild;
            const range = document.createRange();
            range.setStart(first, 0);
            range.setEnd(last, last.textContent.length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return range.toString();
        })()
    `);
    await sleep(150);
    await clearPanelResult();
    await clickPanelButton('查找');

    const multiResult = await poll('多段选区查找', async () => {
        const text = await getPanelResult();
        return text.includes('3 条编号') && text.includes('只高亮') ? text : '';
    }, 15000);
    console.log('多段选中:', multiSelection.replace(/\s+/g, ' '), '→', multiResult.replace(/\n/g, ' / '));

    // 5.5 编号稳定：在前面插入新文本后，旧文本编号不能变
    const alphaText = await selectSmokeSpan(0, 0, 5);
    await sleep(150);
    const alphaBefore = await findCurrentSelectionId();
    if (!alphaBefore.id) throw new Error('没有查到 AlphaOne 的编号');
    console.log('插入前 AlphaOne:', alphaText, '→', alphaBefore.id);

    await evaluate(`
        (() => {
            const box = document.getElementById('maurice-smoke-selection');
            const span = document.createElement('span');
            span.textContent = 'ZeroText';
            box.insertBefore(span, box.firstChild);
            return true;
        })()
    `);

    await clearPanelResult();
    await clickPanelButton('提取并保存');
    await poll('插入新文本后重新提取', async () => {
        const text = await getPanelResult();
        return text.includes('共提取') ? text : '';
    }, 60000);

    const alphaTextAfter = await selectSmokeSpan(1, 0, 5);
    await sleep(150);
    const alphaAfter = await findCurrentSelectionId();
    console.log('插入后 AlphaOne:', alphaTextAfter, '→', alphaAfter.id);

    if (alphaAfter.id !== alphaBefore.id) {
        throw new Error(`旧文本编号发生变化：${alphaBefore.id} → ${alphaAfter.id}`);
    }

    await selectSmokeSpan(0, 0, 4);
    await sleep(150);
    const zeroResult = await findCurrentSelectionId();
    console.log('新增 ZeroText:', zeroResult.id);
    if (!zeroResult.id || zeroResult.id === alphaBefore.id) {
        throw new Error('新增文本没有拿到独立编号，发生了编号复用');
    }

    // 清理测试容器，重新提取，避免影响截图
    await evaluate(`
        (() => {
            const box = document.getElementById('maurice-smoke-selection');
            if (box) box.remove();
            window.getSelection().removeAllRanges();
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            panel.querySelector('[data-el="result"]').textContent = '';
            return true;
        })()
    `);
    await clickPanelButton('提取并保存');
    await poll('清理后重新提取', async () => {
        const text = await getPanelResult();
        return text.includes('共提取') ? text : '';
    }, 60000);

    // 6. 用“导入文件”走一遍真实翻译链路
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

    // 7. 导入可编辑对照表：修改已有译文应原地生效
    await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            const tsv = [
                '原文\\t编号\\t译文',
                '파일\\tP1-1\\t档案',
                '편집\\tP1-1\\t编辑',
                '보기\\tP1-1\\t视图'
            ].join('\\n');
            const file = new File([tsv], '对照表.tsv', {
                type: 'text/tab-separated-values'
            });
            const transfer = new DataTransfer();
            transfer.items.add(file);
            const input = panel.querySelector('[data-el="file"]');
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()
    `);

    const tableImportResult = await poll('对照表导入完成', async () => {
        const text = await getPanelResult();
        return text.includes('对照表导入成功') ? text : '';
    }, 30000);

    const updatedTranslation = await evaluate(`
        (() => {
            const bodyText = document.body.innerText;
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            return {
                hasArchive: bodyText.includes('档案'),
                hasFile: bodyText.includes('文件'),
                tableListed: panel.innerText.includes('导入对照表')
            };
        })()
    `);

    console.log('对照表导入:', tableImportResult.replace(/\n/g, ' / '));
    console.log('修改后页面:', JSON.stringify(updatedTranslation));
    if (!updatedTranslation.hasArchive || updatedTranslation.hasFile) {
        throw new Error('导入对照表后，页面译文没有原地更新为“档案”');
    }
    if (!updatedTranslation.tableListed) {
        throw new Error('词库列表没有出现“导入对照表”');
    }

    // 8. 清除页面译文 → 恢复原文；再应用 → 恢复表格译文
    await clickPanelButton('清除译文');
    const cleared = await poll('清除页面译文', async () => {
        const text = await getPanelResult();
        if (!text.includes('已清除')) return '';
        return evaluate(`
            (() => {
                const bodyText = document.body.innerText;
                return {
                    hasKorean: bodyText.includes('파일'),
                    hasArchive: bodyText.includes('档案'),
                    hasFile: bodyText.includes('文件')
                };
            })()
        `);
    }, 15000);

    console.log('清除页面译文:', JSON.stringify(cleared));
    if (!cleared.hasKorean || cleared.hasArchive || cleared.hasFile) {
        throw new Error('“清除译文”没有把页面恢复成原文');
    }

    await clickPanelButton('应用翻译');
    const reapplied = await poll('重新应用翻译', async () => {
        const text = await getPanelResult();
        return text.includes('更新了') ? text : '';
    }, 15000);
    const hasArchiveAgain = await evaluate(`document.body.innerText.includes('档案')`);
    if (!hasArchiveAgain) throw new Error('清除后重新应用，没有恢复对照表译文');
    console.log('重新应用:', reapplied.replace(/\n/g, ' / '));

    // 9. 单独加载 smoke-demo 词库
    await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            const button = panel.querySelector('[data-dict-load="smoke-demo"]');
            if (!button) return false;
            button.click();
            return true;
        })()
    `);

    const aloneResult = await poll('单独加载词库', async () => {
        const text = await getPanelResult();
        return text.includes('单独加载') ? text : '';
    }, 15000);

    const aloneState = await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            const bodyText = document.body.innerText;
            const smoke = panel.querySelector('[data-dict-toggle="smoke-demo"]');
            const table = panel.querySelector('[data-dict-toggle="导入对照表"]');
            return {
                smokeChecked: smoke ? smoke.checked : false,
                tableChecked: table ? table.checked : false,
                hasFile: bodyText.includes('文件'),
                hasArchive: bodyText.includes('档案')
            };
        })()
    `);

    console.log('单独加载:', aloneResult.replace(/\n/g, ' / '), JSON.stringify(aloneState));
    if (!aloneState.smokeChecked || aloneState.tableChecked) {
        throw new Error('“加载”没有把其他词库取消勾选');
    }
    if (!aloneState.hasFile || aloneState.hasArchive) {
        throw new Error('单独加载 smoke-demo 后页面译文不正确');
    }

    // 译文生效后再提取一次，应仍然拿到原文（而不是中文）
    await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            panel.querySelector('[data-el="result"]').textContent = '';
            return true;
        })()
    `);
    await clickPanelButton('提取并保存');
    const reExtractResult = await poll('翻译后重新提取', async () => {
        const text = await getPanelResult();
        return text.includes('共提取') ? text : '';
    }, 60000);
    const reExtractCount = Number((/共提取 (\d+)/.exec(reExtractResult) || [])[1] || 0);
    console.log('翻译后重新提取:', reExtractResult.replace(/\n/g, ' / '));
    if (reExtractCount < 100) {
        throw new Error('页面已翻译后重新提取，丢失了大部分原文（只拿到 ' + reExtractCount + ' 条）');
    }

    // 10. 导出全部对照表 / 导出已翻译
    await clickPanelButton('导出全部（可编辑）');
    const tableExport = await poll('导出全部对照表', async () => {
        const text = await getPanelResult();
        return text.includes('已导出对照表') ? text : '';
    }, 15000);

    await clickPanelButton('导出已翻译');
    const translatedExport = await poll('导出已翻译', async () => {
        const text = await getPanelResult();
        return text.includes('已导出已翻译文本') ? text : '';
    }, 15000);

    console.log('导出对照表:', tableExport.replace(/\n/g, ' / '));
    console.log('导出已翻译:', translatedExport.replace(/\n/g, ' / '));

    // 11. 上传 smoke-demo 到共享服务器 → 查看我的上传 → 下载 → 删除
    await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            const button = panel.querySelector('[data-dict-upload="smoke-demo"]');
            if (!button) return false;
            button.click();
            return true;
        })()
    `);

    const uploadResult = await poll('上传词库到服务器', async () => {
        const text = await getPanelResult();
        return text.includes('已上传') ? text : '';
    }, 30000);
    const uploadCode = (/#(\d{3,5})/.exec(uploadResult) || [])[1];
    if (!uploadCode) throw new Error('上传成功但没有解析到编号：' + uploadResult);
    console.log('上传服务器:', uploadResult.replace(/\n/g, ' / '));

    await clickPanelButton('刷新我的上传');
    const uploadList = await poll('我的上传列表', async () => {
        const text = await evaluate(`
            (() => {
                const panel = [...document.documentElement.children].find(
                    (el) => el.style && el.style.zIndex === '2147483647'
                );
                return panel.querySelector('[data-el="uploads"]').innerText;
            })()
        `);
        return text.includes('#' + uploadCode) ? text : '';
    }, 20000);
    console.log('我的上传:', uploadList.replace(/\n/g, ' | '));

    await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            panel.querySelector('[data-upload-download="${uploadCode}"]').click();
            return true;
        })()
    `);
    const uploadDownload = await poll('下载我的上传', async () => {
        const text = await getPanelResult();
        return text.includes('已下载') ? text : '';
    }, 20000);

    await evaluate(`
        (() => {
            const panel = [...document.documentElement.children].find(
                (el) => el.style && el.style.zIndex === '2147483647'
            );
            panel.querySelector('[data-upload-delete="${uploadCode}"]').click();
            return true;
        })()
    `);
    const uploadDelete = await poll('删除我的上传', async () => {
        const text = await getPanelResult();
        return text.includes('已从服务器删除') ? text : '';
    }, 20000);

    console.log('下载上传:', uploadDownload.replace(/\n/g, ' / '));
    console.log('删除上传:', uploadDelete.replace(/\n/g, ' / '));

    // 12. 截图（等选区高亮 4 秒自动消失，截图干净一些）
    await sleep(4500);
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
