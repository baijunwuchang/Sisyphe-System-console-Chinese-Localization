/**
 * 翻译器：查词 + 替换文本节点 + 监听动态内容。
 *
 * 只认三个协作者：词库（精确匹配）、规则引擎（动态数字）、DOM 工具。
 * 页号通过 getPageId() 延迟获取，避免把“当前页”做成全局可变状态。
 */
(function registerTranslator(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.dictionary
     * @param {object} deps.patternEngine
     * @param {object} deps.domUtils
     * @param {() => string|null} deps.getPageId
     */
    function createTranslator({ dictionary, patternEngine, domUtils, getPageId }) {
        /** 当前页号对应的编译后规则 */
        let rules = [];

        /** 已经处理过的文本节点，避免观察器反复套娃 */
        const replacedNodes = new WeakSet();

        let observer = null;

        /** 重建动态规则（词库变更 / 切页后调用） */
        function rebuild(pageId = getPageId()) {
            rules = patternEngine.compile({
                dicts: dictionary.all(),
                activeDicts: dictionary.activeNames(),
                pageId
            });
            return rules.length;
        }

        /**
         * 查找译文：先精确匹配，再按动态规则匹配。
         * @returns {string|null}
         */
        function lookup(original, pageId = getPageId()) {
            const exact = dictionary.lookupExact(original, pageId);
            if (exact !== null && exact !== undefined) return exact;

            for (const rule of rules) {
                const match = original.match(rule.regex);
                if (match) return patternEngine.expand(rule, match);
            }
            return null;
        }

        /**
         * 替换单个文本节点，保留前后空白。
         * @returns {boolean} 是否真的替换了
         */
        function replaceNode(node, pageId = getPageId()) {
            if (replacedNodes.has(node)) return false;

            const raw = node.textContent || '';
            const text = domUtils.cleanText(raw);
            if (!text) return false;

            // 代码区绝对不碰，标记后不再重复判断
            if (domUtils.getTextType(node) === 'code') {
                replacedNodes.add(node);
                return false;
            }

            const translated = lookup(text, pageId);
            if (translated === null) return false;

            const leading = raw.match(/^\s*/)[0];
            const trailing = raw.match(/\s*$/)[0];
            node.textContent = leading + translated + trailing;

            replacedNodes.add(node);
            return true;
        }

        /**
         * 替换 root 下所有可翻译文本节点。
         * @returns {number} 替换数量
         */
        function replaceAll(root = document.body, pageId = getPageId()) {
            let count = 0;
            domUtils.forEachTextNode(root, (node, text) => {
                if (!text) return;
                if (replaceNode(node, pageId)) count++;
            });
            return count;
        }

        /** 手动全页翻译（面板“应用翻译” / 启动时用） */
        function apply(pageId = getPageId()) {
            return replaceAll(document.body, pageId);
        }

        /**
         * 监听动态插入的内容（终端日志、切屏等）。
         * @param {{onChanged?: () => void}} [options]
         */
        function startObserver({ onChanged } = {}) {
            stopObserver();

            observer = new MutationObserver((mutations) => {
                let changed = false;

                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (replaceAll(node) > 0) changed = true;
                        } else if (node.nodeType === Node.TEXT_NODE) {
                            if (replaceNode(node)) changed = true;
                        }
                    }
                }

                if (changed && typeof onChanged === 'function') onChanged();
            });

            observer.observe(document.body, { childList: true, subtree: true });
        }

        function stopObserver() {
            if (observer) {
                observer.disconnect();
                observer = null;
            }
        }

        return {
            rebuild,
            lookup,
            replaceNode,
            replaceAll,
            apply,
            startObserver,
            stopObserver,
            getRuleCount: () => rules.length
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createTranslator = createTranslator;
})(globalThis);
