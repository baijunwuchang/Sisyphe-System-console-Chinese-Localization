/**
 * 提取器：把页面上所有含韩文 / 英文的文本节点编号并收集起来。
 *
 * 只负责“读页面 + 编号”，不写存储、不画界面。保存快照由应用层决定。
 */
(function registerExtractor(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.domUtils
     * @param {object} deps.constants
     * @param {(node: Text) => string} [deps.getOriginalText] 已翻译节点取原文
     */
    function createExtractor({ domUtils, constants, getOriginalText }) {
        /**
         * @param {string} pageId
         * @returns {{annotations: Array<object>, stats: {total:number, visible:number, hidden:number}}}
         */
        function extractAll(pageId) {
            domUtils.resetVisibilityCache();

            const annotations = [];
            let textId = 0;
            let visibleCount = 0;

            domUtils.forEachTextNode(document.body, (node) => {
                // 页面可能已经被翻译，优先取节点原始文本，保证编号 / 导出稳定
                const raw = typeof getOriginalText === 'function'
                    ? getOriginalText(node)
                    : (node.textContent || '');
                const text = domUtils.cleanText(raw);
                if (!text) return;
                // 含有韩文或英文才算待翻译文本
                if (!constants.KOREAN_RE.test(text) && !constants.ENGLISH_RE.test(text)) return;

                textId++;
                const visible = domUtils.isVisible(node);
                if (visible) visibleCount++;

                annotations.push({
                    id: pageId + constants.TEXT_ID_SEPARATOR + textId,
                    pageId,
                    textId,
                    type: domUtils.getTextType(node),
                    text,
                    node,
                    visible
                });
            });

            return {
                annotations,
                stats: {
                    total: annotations.length,
                    visible: visibleCount,
                    hidden: annotations.length - visibleCount
                }
            };
        }

        /** 转成可以写进 chrome.storage 的纯数据（去掉 DOM 引用） */
        function toStoredEntries(annotations) {
            return annotations.map((item) => ({
                id: item.id,
                pageId: item.pageId,
                textId: item.textId,
                type: item.type,
                text: item.text
            }));
        }

        return { extractAll, toStoredEntries };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createExtractor = createExtractor;
})(globalThis);
