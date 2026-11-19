// 点扩展图标的时候，给当前页面发个消息打开面板
chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || !tab.id) return;
    try {
        await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
    } catch (_) {
        // 如果是刚安装插件、页面还没刷新，content.js 还没注入，手动插一下再试
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
            });
            setTimeout(async () => {
                try {
                    await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
                } catch (e) { }
            }, 150);
        } catch (err) { }
    }
});