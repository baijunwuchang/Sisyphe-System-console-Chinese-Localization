/**
 * 可编辑对照表（原文 / 编号 / 译文）的构造与解析。
 *
 * 纯函数，不下载、不读存储：
 *   - 导出时未翻译的译文列写“暂无”；
 *   - 导入时“暂无”或空值表示这条不翻译；
 *   - 同时兼容旧版 `id / type / text / translation` 的 TSV。
 */
(function registerTextTable(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.constants
     */
    function createTextTable({ constants }) {
        function sanitizeCell(value) {
            return String(value == null ? '' : value)
                .replace(/[\t\r\n]+/g, ' ')
                .trim();
        }

        function isTranslated(value) {
            const text = String(value == null ? '' : value).trim();
            return text !== '' && text !== constants.TABLE_EMPTY;
        }

        function pageIdOf(textId) {
            const match = /^(P\d+)-\d+$/i.exec(String(textId || '').trim());
            return match ? match[1].toUpperCase() : null;
        }

        function sortPageIds(pages) {
            return Object.keys(pages).sort(
                (a, b) => Number(a.slice(1)) - Number(b.slice(1))
            );
        }

        function collectRows({ pages, lookup, onlyTranslated }) {
            const rows = [];
            for (const pageId of sortPageIds(pages || {})) {
                const page = pages[pageId];
                for (const entry of page.texts || []) {
                    // 代码区不会被翻译器替换，放进对照表只会误导
                    if (entry.type === 'code') continue;

                    const translation = lookup(entry.text, pageId);
                    const translated = isTranslated(translation);
                    if (onlyTranslated && !translated) continue;

                    rows.push({
                        text: entry.text,
                        id: entry.id,
                        pageId: entry.pageId || pageId,
                        translation: translated
                            ? String(translation).trim()
                            : constants.TABLE_EMPTY
                    });
                }
            }
            return rows;
        }

        function toTsv(rows) {
            const lines = [constants.TABLE_HEADER.join('\t')];
            for (const row of rows) {
                lines.push(
                    [row.text, row.id, row.translation]
                        .map(sanitizeCell)
                        .join('\t')
                );
            }
            return lines.join('\n');
        }

        /** 全部文本（已翻译 + 未翻译），未翻译写“暂无” */
        function buildAll({ pages, lookup }) {
            return toTsv(collectRows({ pages, lookup, onlyTranslated: false }));
        }

        /** 只导出已经有译文的文本 */
        function buildTranslated({ pages, lookup }) {
            return toTsv(collectRows({ pages, lookup, onlyTranslated: true }));
        }

        /**
         * 解析对照表文本。
         * @param {string} text
         * @returns {{rows: Array<{text:string,id:string,pageId:string|null,translation:string}>, skipped:number}}
         */
        function parse(text) {
            const content = String(text == null ? '' : text)
                .replace(/^\uFEFF/, '')
                .replace(/\r\n?/g, '\n');

            const rows = [];
            let skipped = 0;
            let mode = null;
            let headerSeen = false;

            for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                const columns = line.split('\t');
                const head = columns.map((cell) => cell.trim());

                if (!headerSeen) {
                    if (head[0] === constants.TABLE_HEADER[0] && head.includes(constants.TABLE_HEADER[2])) {
                        mode = 'table';
                        headerSeen = true;
                        continue;
                    }
                    if (/^id$/i.test(head[0]) && head.some((cell) => /^translation$/i.test(cell))) {
                        mode = 'legacy';
                        headerSeen = true;
                        continue;
                    }
                }

                if (!mode) {
                    mode = /^P\d+-\d+$/i.test((head[1] || '')) ? 'table' : 'legacy';
                }

                if (mode === 'table') {
                    const original = columns[0] == null ? '' : columns[0];
                    const id = (columns[1] || '').trim();
                    const translation = columns.slice(2).join('\t');
                    if (!original.trim()) {
                        skipped++;
                        continue;
                    }
                    rows.push({
                        text: original.trim(),
                        id,
                        pageId: pageIdOf(id),
                        translation
                    });
                } else {
                    const id = (columns[0] || '').trim();
                    const original = columns[2] == null ? '' : columns[2];
                    const translation = columns.slice(3).join('\t');
                    if (!original.trim()) {
                        skipped++;
                        continue;
                    }
                    rows.push({
                        text: original.trim(),
                        id,
                        pageId: pageIdOf(id),
                        translation
                    });
                }
            }

            return { rows, skipped };
        }

        return {
            buildAll,
            buildTranslated,
            parse,
            isTranslated,
            sanitizeCell
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createTextTable = createTextTable;
})(globalThis);
