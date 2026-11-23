/**
 * 持久化层：只负责 chrome.storage.local 的读写，不认识业务。
 *
 * 存储结构（与旧版 3.5 完全一致，可直接沿用旧数据）：
 *   pageIdMap   { [urlKey]: 'P1' }
 *   pageCounter 数字，只用于分配新页号
 *   pages       { P1: { url, title, extractedAt, texts: [...] } }
 *   dicts       { [词库名]: { name, description, global, perPage } }
 *   activeDicts ['custom', ...]
 *
 * 说明：分页界面已移除，但页号仍然参与编号（P1-42）和“按页词库”，
 * 所以 pages / pageIdMap 继续保留，只是不再展示。
 */
(function registerStore(global) {
    'use strict';

    function resolveDefaultStorageArea() {
        const chromeApi = global.chrome;
        if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) {
            throw new Error('chrome.storage.local 不可用（扩展环境才有）');
        }
        return chromeApi.storage.local;
    }

    /**
     * @param {object} deps
     * @param {object} deps.constants
     * @param {object} [deps.storageArea] 测试时可注入假的存储区
     */
    function createStore({ constants, storageArea }) {
        const area = storageArea || resolveDefaultStorageArea();

        /** 保持同一个对象引用，load() 只改属性，不替换整个对象 */
        const state = {
            pageIdMap: {},
            pageCounter: 0,
            pages: {},
            dicts: {},
            activeDicts: [],
            clientId: ''
        };

        /** 从存储重新读取（多标签页共享数据，操作前读一次最稳） */
        async function load() {
            const data = (await area.get(constants.STORAGE_KEYS)) || {};
            state.pageIdMap = data.pageIdMap || {};
            state.pageCounter = Number(data.pageCounter) || 0;
            state.pages = data.pages || {};
            state.dicts = data.dicts || {};
            state.activeDicts = Array.isArray(data.activeDicts)
                ? data.activeDicts.slice()
                : [];
            state.clientId = typeof data.clientId === 'string' ? data.clientId : '';
            return state;
        }

        async function saveAll() {
            await area.set({
                pageIdMap: state.pageIdMap,
                pageCounter: state.pageCounter,
                pages: state.pages,
                dicts: state.dicts,
                activeDicts: state.activeDicts,
                clientId: state.clientId
            });
        }

        async function saveDicts() {
            await area.set({
                dicts: state.dicts,
                activeDicts: state.activeDicts
            });
        }

        async function savePageIndex() {
            await area.set({
                pageIdMap: state.pageIdMap,
                pageCounter: state.pageCounter
            });
        }

        async function savePages() {
            await area.set({ pages: state.pages });
        }

        async function saveClientId() {
            await area.set({ clientId: state.clientId });
        }

        return {
            state,
            load,
            saveAll,
            saveDicts,
            savePageIndex,
            savePages,
            saveClientId
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createStore = createStore;
})(globalThis);
