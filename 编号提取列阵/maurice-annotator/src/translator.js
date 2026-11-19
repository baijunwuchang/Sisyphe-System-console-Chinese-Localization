/**
 * 翻译器：查词 + 替换文本节点 + 监听动态内容 + 清除页面译文。
 *
 * 只认三个协作者：词库（精确匹配）、规则引擎（动态数字）、DOM 工具。
 * 页号通过 getPageId() 延迟获取，避免把“当前页”做成全局可变状态。
 *
 * 节点状态用 Map 记录，而不是只记“处理过”：
 *   original 最初原文（带空白）
 *   applied  当前应用的译文
 *   rendered 实际写进节点的完整文本
 * 这样导入新译文时可以原地更新，删词条后可以恢复原文，“清除译文”也能批量还原。
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

        /** 文本节点 → { original, applied, rendered } */
        const nodeStates = new Map();

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

        function cleanupStates() {
            for (const node of nodeStates.keys()) {
                if (!node.isConnected) nodeStates.delete(node);
            }
        }

        /**
         * 处理单个文本节点，保留前后空白。
         * 已有译文时可以原地更新；译文被删除时可以恢复原文。
         * @returns {boolean} 页面文本是否真的发生变化
         */
        function replaceNode(node, pageId = getPageId()) {
            const currentRaw = node.textContent || '';
            let state = nodeStates.get(node);

            // 节点文本被页面自己改过（不再是我们写进去的译文），以当前文本为新原文
            if (state && state.applied !== null && currentRaw !== state.rendered) {
                nodeStates.delete(node);
                state = null;
            }

            const raw = state ? state.original : currentRaw;
            const text = domUtils.cleanText(raw);
            if (!text) return false;

            // 代码区绝对不碰；如果之前误翻过，恢复原文
            if (domUtils.getTextType(node) === 'code') {
                if (state && state.applied !== null) {
                    node.textContent = state.original;
                    nodeStates.delete(node);
                    return true;
                }
                return false;
            }

            const translated = lookup(text, pageId);

            if (translated === null) {
                if (state && state.applied !== null) {
                    node.textContent = state.original;
                    nodeStates.delete(node);
                    return true;
                }
                return false;
            }

            if (state && state.applied === translated) return false;

            const leading = raw.match(/^\s*/)[0];
            const trailing = raw.match(/\s*$/)[0];
            const rendered = leading + translated + trailing;

            node.textContent = rendered;
            nodeStates.set(node, {
                original: state ? state.original : raw,
                applied: translated,
                rendered
            });
            return true;
        }

        /**
         * 替换 root 下所有可翻译文本节点。
         * @returns {number} 发生变化的节点数
         */
        function replaceAll(root = document.body, pageId = getPageId()) {
            let count = 0;
            domUtils.forEachTextNode(root, (node) => {
                if (replaceNode(node, pageId)) count++;
            });
            return count;
        }

        /** 手动全页翻译（面板“应用翻译” / 启动 / 导入词库后用） */
        function apply(pageId = getPageId()) {
            cleanupStates();
            return replaceAll(document.body, pageId);
        }

        /**
         * 清除页面上已经应用的译文，全部恢复成原文。
         * 词库不动，之后仍可重新“应用翻译”。
         * @returns {number} 恢复的节点数
         */
        function clearApplied() {
            let count = 0;
            for (const [node, state] of nodeStates) {
                if (node.isConnected && state.applied !== null) {
                    node.textContent = state.original;
                    count++;
                }
                nodeStates.delete(node);
            }
            return count;
        }

        /**
         * 取节点的“原文”：已翻译节点返回最初原文，未翻译节点返回当前文本。
         * 提取器用它，保证页面翻译后再次提取仍能拿到原文。
         */
        function getOriginalText(node) {
            const state = nodeStates.get(node);
            if (!state) return node.textContent || '';
            // 页面自己改过文本时，不再相信旧缓存
            if (state.applied !== null && node.textContent !== state.rendered) {
                return node.textContent || '';
            }
            return state.original;
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
            clearApplied,
            getOriginalText,
            startObserver,
            stopObserver,
            getRuleCount: () => rules.length
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createTranslator = createTranslator;
})(globalThis);
