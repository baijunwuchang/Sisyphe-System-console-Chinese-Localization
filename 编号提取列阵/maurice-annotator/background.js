chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || !tab.id) return;
    try {
        await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
    } catch (_) {
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