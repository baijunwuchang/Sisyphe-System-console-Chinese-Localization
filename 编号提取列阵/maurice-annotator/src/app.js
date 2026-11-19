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
        transfer
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

        async function applyAll() {
            await init();
            await store.load();
            translator.rebuild(session.pageId);
            const count = translator.apply(session.pageId);
            return `手动扫了一遍，替换了 ${count} 个文本节点（代码区没碰）`;
        }

        async function saveTranslation({ source, target, scope }) {
            const original = (source || '').trim();
            const translated = (target || '').trim();
            if (!original) throw new Error('原文得填一下');
            if (!translated) throw new Error('译文没填，要删的话点删除按钮');

            await init();
            await store.load();
            await dictionary.saveTranslation(original, translated, scope, session.pageId);

            translator.rebuild(session.pageId);
            const count = translator.apply(session.pageId);

            return (
                `存到 custom 词库了（${scope === 'page' ? '只管这一页' : '全页面生效'}）：\n` +
                `${original}\n→ ${translated}\n顺手替换了 ${count} 个节点`
            );
        }

        async function deleteTranslation(source) {
            const original = (source || '').trim();
            if (!original) throw new Error('你想删哪句？先把原文填上');

            await init();
            await store.load();
            await dictionary.saveTranslation(original, '', 'global', session.pageId);
            await dictionary.saveTranslation(original, '', 'page', session.pageId);

            translator.rebuild(session.pageId);
            translator.apply(session.pageId);

            return `从 custom 词库移除了：${original}\n（页面上已经变了的字，得刷新才能恢复）`;
        }

        // ===== 词库 =====

        async function toggleDict(name, enabled) {
            await init();
            await store.load();
            await dictionary.setEnabled(name, enabled);

            translator.rebuild(session.pageId);
            const count = translator.apply(session.pageId);

            return (
                `词库已${enabled ? '勾上' : '取消'}，这次替换了 ${count} 个节点\n` +
                `（变回原文需要刷新页面的）`
            );
        }

        async function deleteDict(name) {
            await init();
            await store.load();
            const removed = await dictionary.remove(name);
            if (!removed) throw new Error('custom 词库不能删');
            return `已删除词库「${name}」`;
        }

        async function importFile(file) {
            await init();
            await store.load();

            const data = await transfer.readJsonFile(file);
            const { key, isOverwrite } = await dictionary.importData(data);

            translator.rebuild(session.pageId);
            const count = translator.apply(session.pageId);

            return (
                `词库「${key}」导入成功${isOverwrite ? '（把旧的盖了）' : ''}\n` +
                `这次替换了 ${count} 个节点`
            );
        }

        // ===== 查词 =====

        async function find(query) {
            await init();
            const result = await finder.find(query, {
                pageId: session.pageId,
                getAnnotations: ensureAnnotations
            });

            if (result.annotation) {
                return {
                    ...result,
                    source: result.annotation.text,
                    translation: finder.translationFor(result.annotation, session.pageId)
                };
            }
            return result;
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
            saveTranslation,
            deleteTranslation,
            toggleDict,
            deleteDict,
            importFile,
            exportAll,
            exportPending,
            exportMerged,
            exportDict
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createApp = createApp;
})(globalThis);
