// 点击扩展工具栏图标时，向当前标签页发送 toggle 消息打开面板
chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || !tab.id) return;
    try {
        await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
    } catch (_) {
        // content script 尚未注入（例如安装扩展前已打开的页面），尝试主动注入后重试
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
            });
            setTimeout(async () => {
                try {
                    await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
                } catch (e) {
                    console.error('[Maurice] 注入后仍无法打开面板', e);
                }
            }, 150);
        } catch (err) {
            console.error('[Maurice] 主动注入失败', err);
        }
    }
});