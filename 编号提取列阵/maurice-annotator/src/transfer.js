/**
 * 文件进出：触发浏览器下载、读取用户选的 JSON 文件。
 *
 * 把 Blob / URL / <a download> 这些细节关在这里，导出模块只拼内容。
 */
(function registerTransfer(global) {
    'use strict';

    /**
     * @param {object} [deps]
     * @param {Document} [deps.documentRef]
     * @param {typeof Blob} [deps.BlobCtor]
     * @param {typeof URL} [deps.urlApi]
     */
    function createTransfer(deps = {}) {
        const doc = deps.documentRef || global.document;
        const BlobCtor = deps.BlobCtor || global.Blob;
        const urlApi = deps.urlApi || global.URL;

        /** 触发一次浏览器下载 */
        function downloadFile(content, filename, mime) {
            const blob = new BlobCtor([content], {
                type: mime + ';charset=utf-8'
            });
            const url = urlApi.createObjectURL(blob);
            const anchor = doc.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            anchor.click();
            setTimeout(() => urlApi.revokeObjectURL(url), 3000);
        }

        /** 读取 <input type="file"> 选中的 JSON 文件 */
        async function readJsonFile(file) {
            const text = await file.text();
            try {
                return JSON.parse(text);
            } catch (_) {
                throw new Error('这不是个合法的 JSON 文件');
            }
        }

        /** 词库名可能带路径符号，做下载文件名时替换掉 */
        function sanitizeFilename(name) {
            return String(name).replace(/[\\/:*?"<>|]/g, '_');
        }

        return { downloadFile, readJsonFile, sanitizeFilename };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createTransfer = createTransfer;
})(globalThis);
