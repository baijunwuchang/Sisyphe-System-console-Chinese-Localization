/**
 * 导出编排：读存储 → 让 builders 拼内容 → 交给 transfer 下载。
 *
 * 所有导出动作都返回下载文件名，方便面板显示“已导出 xxx”。
 * 可再次导入的词库文件统一用中文名（见 constants.EXPORT_FILENAMES）。
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
     * @param {object} deps.constants
     */
    function createExporters({ store, dictionary, translator, transfer, builders, constants }) {
        const names = constants.EXPORT_FILENAMES;

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

        /** 导出所有页面的文本 + 译文（json / tsv，不是词库，不能导入） */
        async function exportAll(kind) {
            await store.load();
            const pages = store.state.pages;

            if (kind === 'json') {
                const content = builders.buildTextsJson({ pages, lookup });
                transfer.downloadFile(content, names.textsJson, 'application/json');
                return names.textsJson;
            }

            const content = builders.buildTextsTsv({ pages, lookup });
            transfer.downloadFile(content, names.textsTsv, 'text/tab-separated-values');
            return names.textsTsv;
        }

        /** 导出所有还没翻译的条目，供人工填写后重新导入 */
        async function exportPending() {
            await store.load();
            const payload = builders.buildPendingPayload({
                pages: store.state.pages,
                lookup
            });
            return downloadJson(payload, names.pendingDict);
        }

        /** 合并导出所有启用词库，可再次导入 */
        async function exportMerged() {
            await store.load();
            const payload = builders.buildMergedPayload({
                dicts: dictionary.all(),
                activeNames: dictionary.activeNames()
            });
            return downloadJson(payload, names.mergedDict);
        }

        /** 导出单个词库，可再次导入 */
        async function exportSingleDict(name) {
            await store.load();
            const payload = dictionary.toPayload(name);
            if (!payload) throw new Error(`找不到词库「${name}」`);

            const baseName = name === constants.CUSTOM_DICT_NAME
                ? names.customDictBase
                : transfer.sanitizeFilename(name);

            return downloadJson(
                payload,
                `${names.dictPrefix}${baseName}${names.dictSuffix}`
            );
        }

        return { exportAll, exportPending, exportMerged, exportSingleDict };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createExporters = createExporters;
})(globalThis);
