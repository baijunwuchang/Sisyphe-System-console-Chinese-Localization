/**
 * 页号注册表：给每个 URL 分配一个稳定的 P 号，并保存抓取快照。
 *
 * 分页界面移除后，这一层退居幕后，只保证：
 *   1. 编号始终是 P?-?? 格式（例如 P1-42）；
 *   2. 同一个 URL 刷新后页号不变；
 *   3. “按页词库”和跨页导出仍然有据可查。
 * 它不产生任何 DOM，也不向用户展示页号。
 */
(function registerPageRegistry(global) {
    'use strict';

    function defaultUrlKey() {
        return location.pathname + location.search + location.hash;
    }

    /**
     * @param {object} deps
     * @param {object} deps.store
     * @param {object} deps.constants
     * @param {() => string} [deps.getUrlKey] 测试 / 特殊场景可注入
     */
    function createPageRegistry({ store, constants, getUrlKey }) {
        const urlKey = typeof getUrlKey === 'function' ? getUrlKey : defaultUrlKey;

        /** 当前 URL 已经分配过的页号（没有就返回 null） */
        function getCurrentPageId() {
            return store.state.pageIdMap[urlKey()] || null;
        }

        /**
         * 取当前 URL 的页号，没有就分配一个新的。
         * 分配前会扫一遍已有编号，避免 pageCounter 落后导致 P1 撞车。
         */
        async function resolvePageId() {
            const key = urlKey();
            const existing = store.state.pageIdMap[key];
            if (existing) return existing;

            const next = nextPageNumber();
            const pageId = constants.PAGE_ID_PREFIX + next;
            store.state.pageIdMap[key] = pageId;
            store.state.pageCounter = next;
            await store.savePageIndex();
            return pageId;
        }

        function nextPageNumber() {
            let max = Number(store.state.pageCounter) || 0;

            const consider = (pid) => {
                const match = /^P(\d+)$/.exec(String(pid));
                if (match) max = Math.max(max, Number(match[1]));
            };

            Object.values(store.state.pageIdMap).forEach(consider);
            Object.keys(store.state.pages).forEach(consider);
            return max + 1;
        }

        /**
         * 保存一次提取快照。pages 的结构与旧版一致，导出 / 查词仍然能用。
         * @param {string} pageId
         * @param {{url:string,title:string,texts:Array<object>}} snapshot
         */
        async function recordPage(pageId, snapshot) {
            store.state.pages[pageId] = {
                url: snapshot.url,
                title: snapshot.title,
                extractedAt: Date.now(),
                texts: snapshot.texts
            };
            await store.savePages();
        }

        function listPageIds() {
            return Object.keys(store.state.pages).sort(
                (a, b) => Number(a.slice(1)) - Number(b.slice(1))
            );
        }

        function getPage(pageId) {
            return store.state.pages[pageId] || null;
        }

        return {
            urlKey,
            getCurrentPageId,
            resolvePageId,
            nextPageNumber,
            recordPage,
            listPageIds,
            getPage
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createPageRegistry = createPageRegistry;
})(globalThis);
