let extractedData = [];

const extractBtn = document.getElementById('extractBtn');
const downloadBtn = document.getElementById('downloadBtn');
const statusEl = document.getElementById('status');
const previewEl = document.getElementById('preview');

extractBtn.addEventListener('click', async () => {
    statusEl.textContent = '正在提取…';
    extractBtn.disabled = true;
    downloadBtn.disabled = true;
    previewEl.textContent = '';

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        // 向 content script 发送提取指令
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'extract' });

        if (!response || !response.success) {
            throw new Error(response?.error || '提取失败');
        }

        extractedData = response.data || [];
        statusEl.textContent = `✅ 共提取 ${extractedData.length} 条句子`;

        previewEl.textContent = extractedData.slice(0, 50).join('\n');
        if (extractedData.length > 50) {
            previewEl.textContent += `\n… 还有 ${extractedData.length - 50} 条`;
        }

        downloadBtn.disabled = extractedData.length === 0;
    } catch (err) {
        statusEl.textContent = '❌ ' + err.message;
        console.error(err);
    } finally {
        extractBtn.disabled = false;
    }
});

downloadBtn.addEventListener('click', () => {
    if (!extractedData.length) return;

    // 整理成汉化词库常用的 [原文, 译文] 格式，译文暂空
    const jsonContent = JSON.stringify(
        extractedData.map(text => [text, '']),
        null,
        2
    );

    const blob = new Blob([jsonContent], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    chrome.downloads.download({
        url: url,
        filename: 'maurice_texts.json',
        saveAs: true
    }, () => {
        // 下载开始后释放 blob URL
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    });
});