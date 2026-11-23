/**
 * 后台 service worker：点扩展图标时通知当前页切换面板；
 * 同时代理共享服务器 API 请求，避免 HTTPS 页面直接请求 HTTP 接口。
 *
 * 只做两件事：转发消息；页面尚未注入时按 manifest 里的顺序补注入。
 */
'use strict';

const TOGGLE_MESSAGE = 'toggle';
const SERVER_API_MESSAGE = 'maurice-api';
const SERVER_API_BASE = 'http://47.80.59.80/maurice-api.php';

/**
 * 直接读 manifest，避免这里再维护一份模块清单。
 * @returns {string[]}
 */
function getContentScriptFiles() {
    const manifest = chrome.runtime.getManifest();
    const entry = (manifest.content_scripts || [])[0];
    return entry && Array.isArray(entry.js) && entry.js.length
        ? entry.js
        : ['content.js'];
}

async function handleServerRequest(message) {
    const method = String(message.method || '').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
        throw new Error('不支持的请求方式');
    }

    const path = String(message.path || '');
    if (!path.startsWith('?')) {
        throw new Error('不支持的接口路径');
    }

    const headers = {};
    let body;
    if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(message.body || {});
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
        response = await fetch(SERVER_API_BASE + path, {
            method,
            headers,
            body,
            credentials: 'omit',
            signal: controller.signal
        });
    } catch (error) {
        clearTimeout(timer);
        if (error && error.name === 'AbortError') {
            throw new Error('服务器请求超时');
        }
        throw new Error('连不上服务器：' + (error && error.message ? error.message : '网络错误'));
    }
    clearTimeout(timer);

    let data;
    try {
        data = await response.json();
    } catch (_) {
        throw new Error(`服务器返回异常（HTTP ${response.status}）`);
    }

    if (!response.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || `服务器错误（HTTP ${response.status}）`);
    }
    return data;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== SERVER_API_MESSAGE) return undefined;

    handleServerRequest(message)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));

    // 异步 sendResponse，必须保持消息通道
    return true;
});

chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || !tab.id) return;

    try {
        await chrome.tabs.sendMessage(tab.id, { action: TOGGLE_MESSAGE });
        return;
    } catch (_) {
        // content script 还没注入，手动补一下
    }

    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: getContentScriptFiles()
        });
        // 给脚本一点初始化时间再发消息
        setTimeout(async () => {
            try {
                await chrome.tabs.sendMessage(tab.id, { action: TOGGLE_MESSAGE });
            } catch (_) {
                // 页面不允许注入（比如 chrome://）时静默失败
            }
        }, 150);
    } catch (_) {
        // 非目标站点或受限页面，忽略
    }
});
