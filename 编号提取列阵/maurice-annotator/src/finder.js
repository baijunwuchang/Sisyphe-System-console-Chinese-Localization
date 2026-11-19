/**
 * 按编号查找：P1-42 这样的编号，先在当前页找，找不到再翻已抓取的快照。
 *
 * 不直接读存储里的页面列表做展示，只在需要时查一条记录并把结果返回给面板。
 */
(function registerFinder(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.store
     * @param {object} deps.constants
     * @param {object} deps.badges
     * @param {object} [deps.translator] 可选：用于回填已有译文
     */
    function createFinder({ store, constants, badges, translator }) {
        /**
         * @param {string} query
         * @returns {{pageId:string, textId:number}|null}
         */
        function parse(query) {
            const match = constants.ID_PATTERN.exec(String(query == null ? '' : query).trim());
            if (!match) return null;
            return {
                pageId: match[1].toUpperCase(),
                textId: parseInt(match[2], 10)
            };
        }

        /**
         * @param {string} query
         * @param {{pageId: string, getAnnotations: () => Array<object>}} context
         */
        async function find(query, { pageId, getAnnotations }) {
            const target = parse(query);
            if (!target) {
                return { ok: false, message: '格式好像不对，应该是 P1-42 这样' };
            }

            if (target.pageId === pageId) {
                const list = typeof getAnnotations === 'function' ? getAnnotations() || [] : [];
                const annotation = list.find((item) => item.textId === target.textId);
                if (!annotation) {
                    return {
                        ok: false,
                        message: `当前页面没找到编号 ${target.textId}`
                    };
                }

                const highlighted = badges.highlight(annotation.node);
                if (highlighted) {
                    return {
                        ok: true,
                        type: 'current',
                        message: `已定位：${annotation.text}`,
                        annotation
                    };
                }

                return {
                    ok: true,
                    type: 'hidden',
                    message:
                        `找到了 ${annotation.id}：\n"${annotation.text}"\n\n` +
                        `⚠️ 它现在被隐藏了（页面上看不见），没法高亮。\n` +
                        `不过你可以直接在下面填翻译。`,
                    annotation
                };
            }

            await store.load();
            const page = store.state.pages[target.pageId];
            if (!page) {
                return {
                    ok: false,
                    message: `还没抓过 ${target.pageId} 这个页号，先打开那一页按 F1 提取一下吧`
                };
            }

            const entry = (page.texts || []).find((item) => item.textId === target.textId);
            if (!entry) {
                return {
                    ok: false,
                    message: `${target.pageId} 里没找到编号 ${target.textId}`
                };
            }

            return {
                ok: true,
                type: 'other',
                message:
                    `这条文本不在当前页：\n` +
                    `编号：${entry.id}\n` +
                    `标题：${page.title || '(无)'}\n` +
                    `URL：${page.url}\n` +
                    `原文：${entry.text}\n` +
                    `切到那一页按 F1 就能处理`,
                annotation: entry
            };
        }

        /** 查找结果回填输入框时用：优先取已有译文 */
        function translationFor(annotation, pageId) {
            if (!annotation) return '';
            if (!translator) return '';
            return translator.lookup(annotation.text, pageId) || '';
        }

        return { parse, find, translationFor };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createFinder = createFinder;
})(globalThis);
