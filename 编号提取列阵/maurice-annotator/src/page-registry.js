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
         * 确保页面对象有稳定的文本编号表。
         * 旧数据没有 textIdMap 时，从已有的 texts 快照迁移：
         * 按“类型 + 原文 + 同文出现序号”建键，保留原来的 textId。
         * 迁移时如果发现旧快照里已经有重复 textId，会给重复项重新分配新号，
         * 避免“两段不同文本共用一个编号”的问题继续留在数据里。
         * @param {string} pageId
         */
        function ensureTextIdState(pageId) {
            let page = store.state.pages[pageId];
            if (!page) {
                page = store.state.pages[pageId] = {
                    url: '',
                    title: '',
                    extractedAt: 0,
                    texts: []
                };
            }

            if (!page.textIdMap || typeof page.textIdMap !== 'object') {
                page.textIdMap = {};
                const occurrences = new Map();

                for (const entry of page.texts || []) {
                    const type = entry.type || 'ui';
                    const text = String(entry.text == null ? '' : entry.text);
                    const base = type + '\u0000' + text;
                    const index = occurrences.get(base) || 0;
                    occurrences.set(base, index + 1);
                    const key = index === 0 ? base : base + '\u0000#' + index;

                    const textId = Number(entry.textId) || 0;
                    if (textId > 0) page.textIdMap[key] = textId;
                }
            }

            // 清理重复 / 非法编号：第一个占用的编号保留，其余重新发号
            const usedIds = new Set();
            const pendingKeys = [];
            let maxId = 0;

            for (const [key, value] of Object.entries(page.textIdMap)) {
                const textId = Number(value);
                if (Number.isFinite(textId) && textId >= 1 && !usedIds.has(textId)) {
                    usedIds.add(textId);
                    maxId = Math.max(maxId, textId);
                } else {
                    pendingKeys.push(key);
                }
            }

            let nextId = maxId + 1;
            for (const key of pendingKeys) {
                while (usedIds.has(nextId)) nextId += 1;
                page.textIdMap[key] = nextId;
                usedIds.add(nextId);
                nextId += 1;
            }

            if (!Number.isFinite(page.nextTextId) || page.nextTextId < nextId) {
                page.nextTextId = nextId;
            }

            return page;
        }

        /**
         * 为一次提取创建编号分配器。
         * 同一个文本（类型 + 原文 + 同文序号）永远复用第一次分到的编号；
         * 新出现的文本分配新号，不会重排旧文本的编号。
         * @param {string} pageId
         */
        function createIdAllocator(pageId) {
            const page = ensureTextIdState(pageId);
            const occurrences = new Map();

            function allocate({ type, text }) {
                const kind = type || 'ui';
                const value = String(text == null ? '' : text);
                const base = kind + '\u0000' + value;
                const index = occurrences.get(base) || 0;
                occurrences.set(base, index + 1);
                const key = index === 0 ? base : base + '\u0000#' + index;

                let textId = Number(page.textIdMap[key]);
                if (!Number.isFinite(textId) || textId < 1) {
                    textId = page.nextTextId;
                    page.textIdMap[key] = textId;
                    page.nextTextId += 1;
                }
                return textId;
            }

            return { allocate, getPage: () => page };
        }

        /**
         * 保存一次提取快照。pages 的结构与旧版一致，导出 / 查词仍然能用。
         * 同时保留 textIdMap / nextTextId，保证再次提取编号不变。
         * @param {string} pageId
         * @param {{url:string,title:string,texts:Array<object>}} snapshot
         */
        async function recordPage(pageId, snapshot) {
            const page = ensureTextIdState(pageId);
            page.url = snapshot.url;
            page.title = snapshot.title;
            page.extractedAt = Date.now();
            page.texts = snapshot.texts;
            store.state.pages[pageId] = page;
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
            ensureTextIdState,
            createIdAllocator,
            recordPage,
            listPageIds,
            getPage
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createPageRegistry = createPageRegistry;
})(globalThis);
