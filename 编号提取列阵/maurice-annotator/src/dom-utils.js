/**
 * DOM 读取工具：可见性判断、文本清洗、代码区识别、位置矩形、文本节点遍历。
 *
 * 这一层只读 DOM，不写 DOM，也不认识“标注”“词库”这些业务概念，
 * 因此提取器和翻译器可以共用同一套判断，避免规则出现两份。
 */
(function registerDomUtils(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.constants 常量表
     */
    function createDomUtils({ constants }) {
        let visibleCache = new WeakMap();

        /** 每次整页扫描前调用，避免沿用上一轮的可见性缓存 */
        function resetVisibilityCache() {
            visibleCache = new WeakMap();
        }

        function readClassName(el) {
            if (!el) return '';
            const cls = el.className;
            if (typeof cls === 'string') return cls;
            if (cls && typeof cls.baseVal === 'string') return cls.baseVal;
            return '';
        }

        /**
         * 文本节点是否真的显示在页面上（父元素有尺寸、没被 display/opacity 隐藏）。
         * 结果按父元素缓存，一次扫描里同一个父元素只算一次。
         */
        function isVisible(node) {
            const el = node.parentElement;
            if (!el) return false;
            if (visibleCache.has(el)) return visibleCache.get(el);

            let visible = true;
            try {
                if (typeof el.checkVisibility === 'function') {
                    visible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
                } else {
                    // 老浏览器兜底：手动往上查
                    let cur = el;
                    let depth = 0;
                    while (cur && depth < constants.MAX_VISIBILITY_DEPTH) {
                        let style;
                        try {
                            style = getComputedStyle(cur);
                        } catch (_) {
                            break;
                        }
                        if (
                            style.display === 'none' ||
                            style.visibility === 'hidden' ||
                            parseFloat(style.opacity) === 0
                        ) {
                            visible = false;
                            break;
                        }
                        cur = cur.parentElement;
                        depth++;
                    }
                }

                if (visible) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 1 || rect.height < 1) visible = false;
                }
            } catch (_) {
                visible = true;
            }

            visibleCache.set(el, visible);
            return visible;
        }

        /** 去掉零宽字符和首尾空白，得到用于匹配的干净文本 */
        function cleanText(raw) {
            return String(raw == null ? '' : raw)
                .replace(constants.INVISIBLE_CHARS_RE, '')
                .trim();
        }

        /** 文本是在普通界面（ui）里，还是在代码编辑器 / 代码块（code）里 */
        function getTextType(node) {
            const start = node.parentElement;

            // 1. 有文档容器特征的一律当普通界面（手册里的 pre/code 也放行）
            let cur = start;
            let depth = 0;
            while (cur && depth < constants.MAX_ANCESTOR_DEPTH) {
                if (constants.DOC_CLASS_RE.test(readClassName(cur))) return 'ui';
                cur = cur.parentElement;
                depth++;
            }

            // 2. 再看是不是编辑器
            let el = start;
            depth = 0;
            while (el && depth < constants.MAX_ANCESTOR_DEPTH) {
                if (el.tagName === 'TEXTAREA' || el.isContentEditable) return 'code';
                const cls = readClassName(el);
                if (cls && constants.EDITOR_CONTAINER_RE.test(cls)) return 'code';

                // pre/code 默认当普通终端日志，不拦
                if (el.tagName === 'CODE' || el.tagName === 'PRE') {
                    let parent = el.parentElement;
                    let innerDepth = 0;
                    while (parent && innerDepth < 10) {
                        if (constants.DOC_CLASS_RE.test(readClassName(parent))) return 'ui';
                        parent = parent.parentElement;
                        innerDepth++;
                    }
                    return 'ui';
                }
                el = el.parentElement;
                depth++;
            }
            return 'ui';
        }

        /** 文本节点的所有几何矩形（可能跨多行） */
        function getNodeRects(node) {
            if (!node || !node.isConnected) return [];
            try {
                const range = document.createRange();
                range.selectNodeContents(node);
                return Array.from(range.getClientRects());
            } catch (_) {
                return [];
            }
        }

        /** 过滤掉太小的矩形，避免标注乱飞 */
        function getValidRects(node) {
            return getNodeRects(node).filter(
                (rect) =>
                    rect.width >= constants.MIN_RECT_WIDTH &&
                    rect.height >= constants.MIN_RECT_HEIGHT
            );
        }

        function getFirstRect(node) {
            const rects = getValidRects(node);
            return rects.length ? rects[0] : null;
        }

        /**
         * 建一个只遍历“可处理文本节点”的 TreeWalker：
         * 跳过 SCRIPT/STYLE 等标签，也跳过没有父元素的孤节点。
         */
        function createTextWalker(root) {
            return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    const parent = node.parentElement;
                    if (!parent) return NodeFilter.FILTER_REJECT;
                    if (constants.SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
        }

        /**
         * 遍历 root 下的文本节点。
         * @param {Node} root
         * @param {(node: Text, text: string) => void} visit
         */
        function forEachTextNode(root, visit) {
            const walker = createTextWalker(root);
            let node;
            while ((node = walker.nextNode())) {
                visit(node, cleanText(node.textContent || ''));
            }
        }

        return {
            resetVisibilityCache,
            isVisible,
            cleanText,
            getTextType,
            getNodeRects,
            getValidRects,
            getFirstRect,
            createTextWalker,
            forEachTextNode
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createDomUtils = createDomUtils;
})(globalThis);
