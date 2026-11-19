/**
 * 词库仓库：词库的增删改查、启用状态、精确匹配。
 *
 * 数据形状与旧版保持一致：
 *   dicts[name] = {
 *       name, description, version, author,
 *       global:  { 原文: 译文 },
 *       perPage: { P1: { 原文: 译文 } }
 *   }
 * 这里只做“精确匹配”；带数字的规则匹配交给 pattern-rules / translator。
 */
(function registerDictionary(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.store
     * @param {object} deps.constants
     */
    function createDictionary({ store, constants }) {
        function all() {
            return store.state.dicts;
        }

        function activeNames() {
            return store.state.activeDicts;
        }

        function get(name) {
            return store.state.dicts[name] || null;
        }

        function ensureCustom() {
            if (!store.state.dicts[constants.CUSTOM_DICT_NAME]) {
                store.state.dicts[constants.CUSTOM_DICT_NAME] = {
                    name: constants.CUSTOM_DICT_NAME,
                    description: constants.CUSTOM_DICT_DESCRIPTION,
                    global: {},
                    perPage: {}
                };
            }
            if (!store.state.activeDicts.includes(constants.CUSTOM_DICT_NAME)) {
                store.state.activeDicts.push(constants.CUSTOM_DICT_NAME);
            }
        }

        /** 初始化：保证 custom 词库存在并启用，然后落盘 */
        async function init() {
            ensureCustom();
            await store.saveAll();
        }

        /**
         * 精确匹配。查找顺序与旧版一致：
         *   1. 启用词库的“本页”词条（后启用的优先）
         *   2. 启用词库的“全局”词条（后启用的优先）
         * @returns {string|null}
         */
        function lookupExact(original, pageId) {
            const names = store.state.activeDicts;

            for (let i = names.length - 1; i >= 0; i--) {
                const dict = store.state.dicts[names[i]];
                if (!dict) continue;
                const pageEntries = dict.perPage && dict.perPage[pageId];
                if (pageEntries && pageEntries[original] !== undefined) {
                    return pageEntries[original];
                }
            }

            for (let i = names.length - 1; i >= 0; i--) {
                const dict = store.state.dicts[names[i]];
                if (!dict) continue;
                if (dict.global && dict.global[original] !== undefined) {
                    return dict.global[original];
                }
            }

            return null;
        }

        /**
         * 保存面板里写的翻译。译文为空字符串表示删除。
         * @param {string} original
         * @param {string} translated
         * @param {'global'|'page'} scope
         * @param {string} pageId
         */
        async function saveTranslation(original, translated, scope, pageId) {
            ensureCustom();
            const dict = store.state.dicts[constants.CUSTOM_DICT_NAME];
            if (!dict.global) dict.global = {};
            if (!dict.perPage) dict.perPage = {};

            if (scope === 'page') {
                if (!pageId) throw new Error('当前没有页号，存不了本页翻译');
                if (!dict.perPage[pageId]) dict.perPage[pageId] = {};
                if (translated === '') delete dict.perPage[pageId][original];
                else dict.perPage[pageId][original] = translated;
            } else {
                if (translated === '') delete dict.global[original];
                else dict.global[original] = translated;
            }

            await store.saveDicts();
        }

        /**
         * 导入词库对象（文件读取 / JSON 解析在 transfer 层完成）。
         * @returns {Promise<{key:string, isOverwrite:boolean}>}
         */
        async function importData(data) {
            if (!data || typeof data !== 'object' || !data.name) {
                throw new Error('文件里连 name 都没有');
            }

            const key = String(data.name);
            const isOverwrite = !!store.state.dicts[key];

            store.state.dicts[key] = {
                name: key,
                description: data.description || '',
                version: data.version || '',
                author: data.author || '',
                global: data.global || {},
                perPage: data.perPage || {}
            };
            if (!store.state.activeDicts.includes(key)) {
                store.state.activeDicts.push(key);
            }

            await store.saveDicts();
            return { key, isOverwrite };
        }

        async function setEnabled(name, enabled) {
            const index = store.state.activeDicts.indexOf(name);
            if (enabled && index === -1) store.state.activeDicts.push(name);
            else if (!enabled && index !== -1) store.state.activeDicts.splice(index, 1);
            await store.saveDicts();
        }

        /** 删除词库（custom 不允许删） */
        async function remove(name) {
            if (name === constants.CUSTOM_DICT_NAME) return false;
            delete store.state.dicts[name];
            const index = store.state.activeDicts.indexOf(name);
            if (index !== -1) store.state.activeDicts.splice(index, 1);
            await store.saveDicts();
            return true;
        }

        function countWords(dict) {
            if (!dict) return 0;
            let count = Object.keys(dict.global || {}).length;
            for (const pageId of Object.keys(dict.perPage || {})) {
                count += Object.keys(dict.perPage[pageId] || {}).length;
            }
            return count;
        }

        /** 面板列表用的只读视图 */
        function list() {
            return Object.keys(store.state.dicts).map((name) => {
                const dict = store.state.dicts[name];
                const isCustom = name === constants.CUSTOM_DICT_NAME;
                return {
                    name,
                    label: isCustom ? '面板内随手记的' : name,
                    description: dict.description || '',
                    count: countWords(dict),
                    active: store.state.activeDicts.includes(name),
                    deletable: !isCustom
                };
            });
        }

        /** 合并所有启用词库（全局覆盖全局，本页按页合并） */
        function mergeEnabled() {
            const mergedGlobal = {};
            const mergedPerPage = {};

            for (const name of store.state.activeDicts) {
                const dict = store.state.dicts[name];
                if (!dict) continue;
                Object.assign(mergedGlobal, dict.global || {});
                for (const pageId of Object.keys(dict.perPage || {})) {
                    if (!mergedPerPage[pageId]) mergedPerPage[pageId] = {};
                    Object.assign(mergedPerPage[pageId], dict.perPage[pageId] || {});
                }
            }

            return { mergedGlobal, mergedPerPage };
        }

        /** 导出单个词库用的 payload */
        function toPayload(name) {
            const dict = store.state.dicts[name];
            if (!dict) return null;
            return {
                format: constants.DICT_FORMAT,
                version: constants.DICT_FORMAT_VERSION,
                name: dict.name,
                description: dict.description || '',
                author: dict.author || '',
                global: dict.global || {},
                perPage: dict.perPage || {}
            };
        }

        return {
            all,
            activeNames,
            get,
            init,
            lookupExact,
            saveTranslation,
            importData,
            setEnabled,
            remove,
            countWords,
            list,
            mergeEnabled,
            toPayload
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createDictionary = createDictionary;
})(globalThis);
