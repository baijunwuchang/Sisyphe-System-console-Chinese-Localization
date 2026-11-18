// ========== 配置 ==========

// 完全不处理的标签（这些标签内的文本不属于“界面文案”）
const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR'
]);

// 韩文范围：Hangul Syllables + Hangul Jamo
const KOREAN_REGEX = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;

// 英文：至少包含一个英文字母，且允许常见标点和空格
const ENGLISH_REGEX = /[A-Za-z]/;

// 句子长度下限（去掉纯符号、单个字母的噪音）
const MIN_LENGTH = 2;

// ========== 提取函数 ==========

function extractSentences() {
    const results = new Set(); // Set 自动去重

    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                if (SKIP_TAGS.has(parent.tagName)) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    let node;
    while ((node = walker.nextNode())) {
        const raw = node.textContent;
        if (!raw) continue;

        // 按句子切分：句号、问号、感叹号、换行，以及韩文/英文常见结束符
        const candidates = raw.split(/[.!?。？！\n\r]+/);

        for (let s of candidates) {
            s = s.trim();
            if (s.length < MIN_LENGTH) continue;

            const hasKorean = KOREAN_REGEX.test(s);
            const hasEnglish = ENGLISH_REGEX.test(s);

            // 只要包含韩文或英文，就保留（很多句子是韩英混排）
            if (hasKorean || hasEnglish) {
                results.add(s);
            }
        }
    }

    return [...results];
}

// ========== 消息监听：popup 请求提取时执行 ==========

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extract') {
        try {
            const sentences = extractSentences();
            sendResponse({ success: true, data: sentences });
        } catch (err) {
            sendResponse({ success: false, error: err.message });
        }
    }
    return true; // 保持异步通道开放
});