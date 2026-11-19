/**
 * 导出编排：读存储 → 让 builders 拼内容 → 交给 transfer 下载。
 *
 * 所有导出动作都返回下载文件名，方便面板显示“已导出 xxx”。
 */
(function registerExporters(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.store
     * @param {object} deps.dictionary
     * @param {object} deps.translator
     * @param {object} deps.transfer
     * @param {object} deps.builders
     */
    function createExporters({ store, dictionary, translator, transfer, builders }) {
        function lookup(text, pageId) {
            return translator.lookup(text, pageId);
        }

        function downloadJson(payload, filename) {
            transfer.downloadFile(
                JSON.stringify(payload, null, 2),
                filename,
                'application/json'
            );
            return filename;
        }

        /** 导出所有页面的文本 + 译文（json / tsv） */
        async function exportAll(kind) {
            await store.load();
            const pages = store.state.pages;

            if (kind === 'json') {
                const content = builders.buildTextsJson({ pages, lookup });
                const filename = 'maurice_texts.json';
                transfer.downloadFile(content, filename, 'application/json');
                return filename;
            }

            const content = builders.buildTextsTsv({ pages, lookup });
            const filename = 'maurice_texts.tsv';
            transfer.downloadFile(content, filename, 'text/tab-separated-values');
            return filename;
        }

        /** 导出所有还没翻译的条目，供人工填写 */
        async function exportPending() {
            await store.load();
            const payload = builders.buildPendingPayload({
                pages: store.state.pages,
                lookup
            });
            return downloadJson(payload, 'dict_pending.json');
        }

        /** 合并导出所有启用词库 */
        async function exportMerged() {
            await store.load();
            const payload = builders.buildMergedPayload({
                dicts: dictionary.all(),
                activeNames: dictionary.activeNames()
            });
            return downloadJson(payload, 'dict_merged_all.json');
        }

        /** 导出单个词库 */
        async function exportSingleDict(name) {
            await store.load();
            const payload = dictionary.toPayload(name);
            if (!payload) throw new Error(`找不到词库「${name}」`);
            return downloadJson(payload, `dict_${transfer.sanitizeFilename(name)}.json`);
        }

        return { exportAll, exportPending, exportMerged, exportSingleDict };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createExporters = createExporters;
})(globalThis);
