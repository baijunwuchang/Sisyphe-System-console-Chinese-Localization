/**
 * 导出内容的纯构造函数：只接收数据，返回字符串 / 对象。
 *
 * 文件下载和 chrome API 都在 exporters / transfer 层，
 * 因此这里可以直接拿 Node 做单元测试。
 */
(function registerExportBuilders(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.constants
     */
    function createExportBuilders({ constants }) {
        function sortPageIds(pages) {
            return Object.keys(pages).sort(
                (a, b) => Number(a.slice(1)) - Number(b.slice(1))
            );
        }

        /**
         * 未翻译词库：遍历所有抓取快照，跳过代码区与已有译文的条目。
         * @param {object} options
         * @param {object} options.pages
         * @param {(text:string, pageId:string) => (string|null)} options.lookup
         */
        function buildPendingPayload({ pages, lookup }) {
            const pendingGlobal = {};
            const pendingPerPage = {};
            const sourceIds = {};

            for (const pageId of sortPageIds(pages)) {
                const page = pages[pageId];
                for (const entry of page.texts || []) {
                    if (entry.type === 'code') continue; // 代码区通常不用翻
                    if (lookup(entry.text, pageId) !== null) continue; // 已有译文

                    if (!sourceIds[entry.text]) sourceIds[entry.text] = [];
                    if (!sourceIds[entry.text].includes(entry.id)) {
                        sourceIds[entry.text].push(entry.id);
                    }
                    pendingGlobal[entry.text] = '';
                }
            }

            return {
                format: constants.DICT_FORMAT,
                version: constants.DICT_FORMAT_VERSION,
                name: '待翻译词库',
                description: '由插件自动生成的未翻译列表，填入译文后可直接导入生效',
                global: pendingGlobal,
                perPage: pendingPerPage,
                // 仅方便人工查找；导入时会被忽略
                _sourceIds: sourceIds
            };
        }

        /**
         * 所有文本 + 译文的 JSON 数组。
         * @returns {string}
         */
        function buildTextsJson({ pages, lookup }) {
            const data = [];
            for (const pageId of sortPageIds(pages)) {
                const page = pages[pageId];
                for (const entry of page.texts || []) {
                    data.push({
                        id: entry.id,
                        pageId: entry.pageId,
                        textId: entry.textId,
                        type: entry.type,
                        text: entry.text,
                        translation: lookup(entry.text, pageId) || ''
                    });
                }
            }
            return JSON.stringify(data, null, 2);
        }

        /**
         * 所有文本 + 译文的 TSV（制表符转成空格，避免列错位）。
         * @returns {string}
         */
        function buildTextsTsv({ pages, lookup }) {
            const lines = ['id\ttype\ttext\ttranslation'];
            for (const pageId of sortPageIds(pages)) {
                const page = pages[pageId];
                for (const entry of page.texts || []) {
                    const translated = lookup(entry.text, pageId) || '';
                    lines.push(
                        `${entry.id}\t${entry.type}\t` +
                        `${String(entry.text).replace(/\t/g, ' ')}\t` +
                        `${String(translated).replace(/\t/g, ' ')}`
                    );
                }
            }
            return lines.join('\n');
        }

        /**
         * 合并所有启用词库。
         */
        function buildMergedPayload({ dicts, activeNames }) {
            const mergedGlobal = {};
            const mergedPerPage = {};

            for (const name of activeNames) {
                const dict = dicts[name];
                if (!dict) continue;
                Object.assign(mergedGlobal, dict.global || {});
                for (const pageId of Object.keys(dict.perPage || {})) {
                    if (!mergedPerPage[pageId]) mergedPerPage[pageId] = {};
                    Object.assign(mergedPerPage[pageId], dict.perPage[pageId] || {});
                }
            }

            return {
                format: constants.DICT_FORMAT,
                version: constants.DICT_FORMAT_VERSION,
                name: 'merged_all',
                description: `合并了 ${activeNames.length} 个词库`,
                global: mergedGlobal,
                perPage: mergedPerPage
            };
        }

        return {
            sortPageIds,
            buildPendingPayload,
            buildTextsJson,
            buildTextsTsv,
            buildMergedPayload
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createExportBuilders = createExportBuilders;
})(globalThis);
