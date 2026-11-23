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
                // custom 放在最前面（优先级最低），后导入的词库可以覆盖它
                store.state.activeDicts.unshift(constants.CUSTOM_DICT_NAME);
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

        /** 只启用某一个词库（“单独加载”按钮用） */
        async function setOnly(name) {
            if (!store.state.dicts[name]) {
                throw new Error(`找不到词库「${name}」`);
            }
            store.state.activeDicts = [name];
            await store.saveDicts();
        }

        function ensureTableDict() {
            const name = constants.TABLE_DICT_NAME;
            if (!store.state.dicts[name]) {
                store.state.dicts[name] = {
                    name,
                    description: constants.TABLE_DICT_DESCRIPTION,
                    global: {},
                    perPage: {}
                };
            }
            const table = store.state.dicts[name];
            if (!table.global) table.global = {};
            if (!table.perPage) table.perPage = {};
            return table;
        }

        function pageIdFromTextId(textId) {
            const match = /^(P\d+)-\d+$/i.exec(String(textId || '').trim());
            return match ? match[1].toUpperCase() : null;
        }

        /**
         * 导入可编辑对照表（原文 / 编号 / 译文）。
         * 译文写进独立的“导入对照表”词库，并把它放到启用列表最后，
         * 这样表格里的修改优先级最高，导入后能覆盖旧译文。
         * @param {Array<{text:string, id?:string, pageId?:string, translation:string}>} rows
         */
        async function applyTable(rows) {
            const tableName = constants.TABLE_DICT_NAME;
            const table = ensureTableDict();

            const allTexts = new Set();
            const translatedByText = new Map();
            const translatedByTextPage = new Map();
            const seenTextPage = new Set();

            let updated = 0;
            let skipped = 0;

            for (const row of rows || []) {
                const text = String(row.text == null ? '' : row.text);
                if (!text.trim()) {
                    skipped++;
                    continue;
                }

                const pageId = row.pageId || pageIdFromTextId(row.id);
                const value = String(row.translation == null ? '' : row.translation).trim();

                allTexts.add(text);
                if (pageId) seenTextPage.add(text + '\u0000' + pageId);

                if (!value || value === constants.TABLE_EMPTY) {
                    skipped++;
                    continue;
                }

                translatedByText.set(text, value);
                if (pageId) {
                    translatedByTextPage.set(text + '\u0000' + pageId, { text, pageId, value });
                }
                updated++;
            }

            // 全局译文：同一原文以最后一条有效译文为准；全是“暂无”就删掉
            for (const text of allTexts) {
                const value = translatedByText.get(text);
                if (value === undefined) {
                    delete table.global[text];
                    for (const pageId of Object.keys(table.perPage)) {
                        delete table.perPage[pageId][text];
                    }
                } else {
                    table.global[text] = value;
                }
            }

            // 本页译文：保证表格里的值在该页优先级最高
            for (const key of seenTextPage) {
                const [text, pageId] = key.split('\u0000');
                const entry = translatedByTextPage.get(key);
                if (entry) {
                    if (!table.perPage[pageId]) table.perPage[pageId] = {};
                    table.perPage[pageId][text] = entry.value;
                } else if (table.perPage[pageId]) {
                    delete table.perPage[pageId][text];
                }
            }

            // 放到启用列表最后：越靠后优先级越高
            const active = store.state.activeDicts;
            const existing = active.indexOf(tableName);
            if (existing !== -1) active.splice(existing, 1);
            active.push(tableName);

            await store.saveDicts();
            return { updated, skipped, total: (rows || []).length, dictName: tableName };
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

        /**
         * 安装/更新从服务器下载的词库。
         * 用 server-<编号> 作为固定 key，重复下载会覆盖内容但保留启用状态。
         * @param {{code:string,title:string,description:string,content:object,activate?:boolean}} input
         */
        async function installServerFile({ code, title, description, content, updatedAt = 0, activate = false }) {
            const key = constants.SERVER_DICT_PREFIX + code;
            const existing = store.state.dicts[key];
            const wasActive = existing
                ? store.state.activeDicts.includes(key)
                : false;

            const rawTitle = String(
                title || (content && content.name) || code
            );
            const displayTitle = rawTitle.startsWith(code + ' ') || rawTitle === code
                ? rawTitle
                : `${code} ${rawTitle}`;

            store.state.dicts[key] = {
                name: (content && content.name) || rawTitle,
                title: displayTitle,
                serverCode: code,
                serverUpdatedAt: Number(updatedAt) || 0,
                description: description || (content && content.description) || '',
                version: (content && content.version) || '',
                author: (content && content.author) || '',
                global: (content && content.global) || {},
                perPage: (content && content.perPage) || {}
            };

            const shouldActivate = activate || wasActive;
            const index = store.state.activeDicts.indexOf(key);
            if (shouldActivate && index === -1) {
                store.state.activeDicts.push(key);
            } else if (!shouldActivate && index !== -1) {
                store.state.activeDicts.splice(index, 1);
            }

            await store.saveDicts();
            return {
                key,
                isNew: !existing,
                active: store.state.activeDicts.includes(key)
            };
        }

        /** 给本地词库记录“已上传到服务器”的编号 */
        async function attachServerCode(name, code, title) {
            const dict = store.state.dicts[name];
            if (!dict) throw new Error(`找不到词库「${name}」`);
            dict.serverCode = code;
            if (title) dict.title = title;
            await store.saveDicts();
        }

        /** 解除词库与服务器编号的关联（服务器文件删除后） */
        async function detachServerCode(name) {
            const dict = store.state.dicts[name];
            if (!dict) return;
            delete dict.serverCode;
            await store.saveDicts();
        }

        function findByServerCode(code) {
            for (const name of Object.keys(store.state.dicts)) {
                if (store.state.dicts[name].serverCode === code) {
                    return { name, dict: store.state.dicts[name] };
                }
            }
            return null;
        }

        /** 删除服务器文件后，解除所有本地副本的编号关联 */
        async function detachServerCodeByCode(code) {
            const names = [];
            for (const name of Object.keys(store.state.dicts)) {
                if (store.state.dicts[name].serverCode === code) {
                    delete store.state.dicts[name].serverCode;
                    names.push(name);
                }
            }
            if (names.length) await store.saveDicts();
            return names;
        }

        function countWords(dict) {
            if (!dict) return 0;
            const words = new Set(Object.keys(dict.global || {}));
            for (const pageId of Object.keys(dict.perPage || {})) {
                for (const word of Object.keys(dict.perPage[pageId] || {})) {
                    words.add(word);
                }
            }
            return words.size;
        }

        /** 面板列表用的只读视图 */
        function list() {
            return Object.keys(store.state.dicts).map((name) => {
                const dict = store.state.dicts[name];
                const isCustom = name === constants.CUSTOM_DICT_NAME;
                return {
                    name,
                    label: dict.title || (isCustom ? '面板内随手记的' : name),
                    description: dict.description || '',
                    count: countWords(dict),
                    active: store.state.activeDicts.includes(name),
                    deletable: !isCustom,
                    serverCode: dict.serverCode || null
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
            setOnly,
            applyTable,
            remove,
            installServerFile,
            attachServerCode,
            detachServerCode,
            findByServerCode,
            detachServerCodeByCode,
            countWords,
            list,
            mergeEnabled,
            toPayload
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createDictionary = createDictionary;
})(globalThis);
