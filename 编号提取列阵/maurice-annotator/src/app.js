/**
 * 应用层：把各个服务拼成面板可以直接调用的动作。
 *
 * 它持有“当前页号 / 当前提取结果”这份会话状态，但不碰 DOM、不拼 HTML。
 * 面板只负责收集输入、调用这里的方法、展示返回的文字。
 */
(function registerApp(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.session 共享会话状态 { pageId: string|null }
     * @param {object} deps.store
     * @param {object} deps.pageRegistry
     * @param {object} deps.dictionary
     * @param {object} deps.translator
     * @param {object} deps.extractor
     * @param {object} deps.badges
     * @param {object} deps.finder
     * @param {object} deps.exporters
     * @param {object} deps.transfer
     * @param {object} deps.textTable 可编辑对照表
     * @param {object} deps.selection 选区服务
     */
    function createApp({
        session,
        store,
        pageRegistry,
        dictionary,
        translator,
        extractor,
        badges,
        finder,
        exporters,
        transfer,
        textTable,
        selection
    }) {
        /** 当前页的提取结果（含 DOM 引用，仅内存） */
        let annotations = [];

        let readyPromise = null;

        async function doInit() {
            await store.load();
            await dictionary.init();

            session.pageId = await pageRegistry.resolvePageId();
            translator.rebuild(session.pageId);

            // 与旧版一致：先把已有词库应用上去，再抓一遍当前文本备用
            translator.apply(session.pageId);
            annotations = extractor.extractAll(session.pageId).annotations;

            // 页面动态变化时，若有徽标则重新贴合
            translator.startObserver({
                onChanged: () => {
                    if (badges.isVisible()) badges.reposition();
                }
            });
        }

        /** 幂等初始化；面板动作里也会 await，避免抢跑 */
        function init() {
            if (!readyPromise) readyPromise = doInit();
            return readyPromise;
        }

        function getPageId() {
            return session.pageId;
        }

        function getAnnotations() {
            return annotations;
        }

        /** 取当前页文本，必要时补一次提取（不落盘） */
        function ensureAnnotations() {
            if (!annotations.length && session.pageId) {
                annotations = extractor.extractAll(session.pageId).annotations;
            }
            return annotations;
        }

        // ===== 提取 =====

        async function extract() {
            await init();
            await store.load();

            session.pageId = await pageRegistry.resolvePageId();
            translator.rebuild(session.pageId);

            const { annotations: list, stats } = extractor.extractAll(session.pageId);
            annotations = list;

            await pageRegistry.recordPage(session.pageId, {
                url: location.href,
                title: document.title,
                texts: extractor.toStoredEntries(list)
            });

            badges.render(annotations);

            return (
                `✅ 搞定了！共提取 ${stats.total} 条文本（含隐藏）\n` +
                `（可见 ${stats.visible} 条，隐藏 ${stats.hidden} 条。隐藏的也能改，就是高亮不了）\n` +
                `当前标注：${badges.isVisible() ? '显示中' : '已隐藏'}`
            );
        }

        // ===== 翻译 =====

        /** 重建规则并应用，返回页面实际变化的节点数 */
        async function reapply() {
            translator.rebuild(session.pageId);
            const count = translator.apply(session.pageId);
            if (badges.isVisible()) badges.reposition();
            return count;
        }

        async function applyAll() {
            await init();
            await store.load();
            const count = await reapply();
            return `手动扫了一遍，更新了 ${count} 个文本节点（代码区没碰）`;
        }

        async function saveTranslation({ source, target, scope }) {
            const original = (source || '').trim();
            const translated = (target || '').trim();
            if (!original) throw new Error('原文得填一下');
            if (!translated) throw new Error('译文没填，要删的话点删除按钮');

            await init();
            await store.load();
            await dictionary.saveTranslation(original, translated, scope, session.pageId);

            const count = await reapply();

            return (
                `存到 custom 词库了（${scope === 'page' ? '只管这一页' : '全页面生效'}）：\n` +
                `${original}\n→ ${translated}\n页面更新了 ${count} 个节点`
            );
        }

        async function deleteTranslation(source) {
            const original = (source || '').trim();
            if (!original) throw new Error('你想删哪句？先把原文填上');

            await init();
            await store.load();
            await dictionary.saveTranslation(original, '', 'global', session.pageId);
            await dictionary.saveTranslation(original, '', 'page', session.pageId);

            const count = await reapply();
            return (
                `从 custom 词库移除了：${original}\n` +
                `页面已重新翻译，更新了 ${count} 个节点` +
                `（没有其他词库提供译文时会恢复原文）`
            );
        }

        /** 清除页面上已经应用的译文，恢复原文；词库保留 */
        async function clearPageTranslations() {
            await init();
            const count = translator.clearApplied();
            if (badges.isVisible()) badges.reposition();
            return (
                `已清除页面上的 ${count} 处译文，恢复为原文\n` +
                `（词库仍然保留，点“应用翻译”可以重新应用）`
            );
        }

        // ===== 词库 =====

        async function toggleDict(name, enabled) {
            await init();
            await store.load();
            await dictionary.setEnabled(name, enabled);

            const count = await reapply();

            return (
                `词库已${enabled ? '勾上' : '取消'}，页面重新翻译后更新了 ${count} 个节点`
            );
        }

        /** 只加载某一个词库（其他词库暂时停用） */
        async function loadDictAlone(name) {
            await init();
            await store.load();
            await dictionary.setOnly(name);

            const count = await reapply();

            return (
                `已单独加载词库「${name}」\n` +
                `其他词库已暂时取消勾选\n` +
                `页面更新了 ${count} 个节点`
            );
        }

        async function deleteDict(name) {
            await init();
            await store.load();
            const removed = await dictionary.remove(name);
            if (!removed) throw new Error('custom 词库不能删');
            const count = await reapply();
            return `已删除词库「${name}」\n页面重新翻译后更新了 ${count} 个节点`;
        }

        /**
         * 导入文件：JSON 词库按原逻辑导入；TSV / 文本按可编辑对照表导入。
         */
        async function importFile(file) {
            await init();
            await store.load();

            const content = await transfer.readTextFile(file);
            const trimmed = String(content || '').replace(/^\uFEFF/, '').trim();
            const filename = String(file && file.name ? file.name : '').toLowerCase();

            if (filename.endsWith('.json') || trimmed.startsWith('{')) {
                let data;
                try {
                    data = JSON.parse(trimmed);
                } catch (_) {
                    throw new Error('这不是个合法的 JSON 文件');
                }

                const { key, isOverwrite } = await dictionary.importData(data);
                const count = await reapply();

                return (
                    `词库「${key}」导入成功${isOverwrite ? '（把旧的盖了）' : ''}\n` +
                    `页面更新了 ${count} 个节点`
                );
            }

            const parsed = textTable.parse(content);
            if (!parsed.rows.length) {
                throw new Error('对照表里没有可导入的行（需要 原文 / 编号 / 译文 三列）');
            }

            const result = await dictionary.applyTable(parsed.rows);
            const count = await reapply();

            return (
                `对照表导入成功：更新 ${result.updated} 条，跳过 ${result.skipped + parsed.skipped} 条\n` +
                `译文写入「${result.dictName}」，已放到最高优先级\n` +
                `页面更新了 ${count} 个节点`
            );
        }

        // ===== 查词 =====

        async function find(query) {
            await init();

            const queryText = String(query == null ? '' : query).trim();
            const result = queryText
                ? await finder.find(queryText, {
                    pageId: session.pageId,
                    getAnnotations: ensureAnnotations
                })
                : await finder.findSelection({ getAnnotations: ensureAnnotations });

            if (result.annotation) {
                return {
                    ...result,
                    source: result.annotation.text,
                    translation: finder.translationFor(result.annotation, session.pageId)
                };
            }

            // 超过 2 段时没有单一原文可编辑，清空输入框避免残留上一条
            if (result.type === 'selection-range') {
                return { ...result, source: '', translation: '' };
            }

            return result;
        }

        function hasSelection() {
            return !!(selection && selection.hasSelection());
        }

        function clearSelection() {
            if (selection) selection.clear();
        }

        // ===== 标注 =====

        function setBadgesVisible(show) {
            if (show) {
                badges.show();
            } else {
                badges.hide();
            }
            return badges.isVisible();
        }

        function isBadgesVisible() {
            return badges.isVisible();
        }

        // ===== 导出 =====

        async function exportAll(kind) {
            await init();
            const filename = await exporters.exportAll(kind);
            return `已导出：${filename}`;
        }

        /** 导出全部文本的可编辑对照表（未翻译显示“暂无”） */
        async function exportTable() {
            await init();
            const filename = await exporters.exportTable();
            return (
                `已导出对照表：${filename}\n` +
                `直接编辑“译文”列后，用“导入对照表”导回即可生效`
            );
        }

        /** 只导出已经有译文的文本 */
        async function exportTranslated() {
            await init();
            const filename = await exporters.exportTranslated();
            return `已导出已翻译文本：${filename}`;
        }

        async function exportPending() {
            await init();
            const filename = await exporters.exportPending();
            return `已导出：${filename}`;
        }

        async function exportMerged() {
            await init();
            const filename = await exporters.exportMerged();
            return `已导出：${filename}`;
        }

        async function exportDict(name) {
            await init();
            const filename = await exporters.exportSingleDict(name);
            return `已导出：${filename}`;
        }

        return {
            init,
            getPageId,
            getAnnotations,
            getDicts: () => dictionary.list(),
            isBadgesVisible,
            setBadgesVisible,
            extract,
            applyAll,
            find,
            hasSelection,
            clearSelection,
            saveTranslation,
            deleteTranslation,
            clearPageTranslations,
            toggleDict,
            loadDictAlone,
            deleteDict,
            importFile,
            exportAll,
            exportTable,
            exportTranslated,
            exportPending,
            exportMerged,
            exportDict
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createApp = createApp;
})(globalThis);
