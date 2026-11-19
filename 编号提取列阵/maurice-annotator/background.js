/**
 * 后台 service worker：点扩展图标时通知当前页切换面板。
 *
 * 只做两件事：转发消息；页面尚未注入时按 manifest 里的顺序补注入。
 */
'use strict';

const TOGGLE_MESSAGE = 'toggle';

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
