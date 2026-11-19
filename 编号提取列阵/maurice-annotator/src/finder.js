/**
 * 按编号查找：P1-42 这样的编号，先在当前页找，找不到再翻已抓取的快照。
 *
 * 另外支持“页面选区查找”：选中一段文本后点查找，直接定位它属于哪个编号。
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
     * @param {object} [deps.selection] 可选：选区服务
     */
    function createFinder({ store, constants, badges, translator, selection }) {
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

        /**
         * 选区查找：选中一段文本后点查找。
         * - 覆盖 1～2 条标注：高亮完整段落，并返回第一条的编号 / 原文；
         * - 超过 2 条：只高亮选中的部分，消息里列出编号。
         * @param {{getAnnotations: () => Array<object>}} context
         */
        async function findSelection({ getAnnotations }) {
            if (!selection) {
                return { ok: false, message: '当前没有选区服务' };
            }

            const info = selection.getCurrent();
            if (!info) {
                return {
                    ok: false,
                    message:
                        `先在页面上选中一段文本，再点“查找”\n` +
                        `（查找框留空时会按选区查找；也可以直接输入 P1-42）`
                };
            }

            const list = typeof getAnnotations === 'function' ? getAnnotations() || [] : [];
            if (!list.length) {
                return {
                    ok: false,
                    message: '当前页还没有提取结果，先点“提取并保存”'
                };
            }

            let matched = [];
            try {
                matched = selection.matchAnnotations(info.range, list);
            } catch (_) {
                matched = [];
            }

            if (!matched.length) {
                return {
                    ok: false,
                    message:
                        `选中的文本没有对应的标注编号\n` +
                        `（可能选中的是不含韩文 / 英文的文本，或还没点“提取并保存”）`
                };
            }

            const ids = matched.map((item) => item.id);

            if (matched.length <= constants.SELECTION_FULL_HIGHLIGHT_MAX) {
                const highlighted = badges.highlightNodes(matched.map((item) => item.node));
                const previews = matched
                    .map((item) => `“${previewText(item.text)}”`)
                    .join('\n');
                const headline = matched.length === 1
                    ? `选中文本属于 ${ids[0]}`
                    : `选中文本涉及 2 条编号：${ids.join('、')}`;

                return {
                    ok: true,
                    type: matched.length === 1 ? 'selection' : 'selection-pair',
                    message:
                        `${headline}\n` +
                        `已高亮完整${matched.length === 1 ? '本段' : '两段'}文本：\n` +
                        `${previews}` +
                        (highlighted ? '' : '\n（这些文本当前无法高亮）'),
                    annotation: matched[0]
                };
            }

            const highlighted = badges.highlightRange(info.range);
            return {
                ok: true,
                type: 'selection-range',
                message:
                    `选中文本涉及 ${matched.length} 条编号：${formatIds(ids)}\n` +
                    (highlighted ? '已只高亮选中的部分' : '选中的范围无法高亮'),
                selectedText: previewText(info.text)
            };
        }

        function previewText(text) {
            const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
            const max = constants.SELECTION_PREVIEW_LENGTH;
            return value.length > max ? value.slice(0, max) + '…' : value;
        }

        function formatIds(ids) {
            const limit = constants.SELECTION_ID_LIST_LIMIT;
            if (ids.length <= limit) return ids.join('、');
            return `${ids.slice(0, limit).join('、')} …（共 ${ids.length} 条）`;
        }

        /** 查找结果回填输入框时用：优先取已有译文 */
        function translationFor(annotation, pageId) {
            if (!annotation) return '';
            if (!translator) return '';
            return translator.lookup(annotation.text, pageId) || '';
        }

        return { parse, find, findSelection, translationFor };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createFinder = createFinder;
})(globalThis);
