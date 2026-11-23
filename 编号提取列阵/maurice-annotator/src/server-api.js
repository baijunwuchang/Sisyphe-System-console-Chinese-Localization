/**
 * 共享服务器 API 客户端。
 *
 * content script 不能直接跨域访问 HTTP 接口（页面是 HTTPS），
 * 所以统一发消息给 background，由 service worker 代请求。
 */
(function registerServerApi(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.constants
     */
    function createServerApi({ constants }) {
        function request(method, path, body) {
            return new Promise((resolve, reject) => {
                chrome.runtime.sendMessage(
                    {
                        type: constants.SERVER_API_MESSAGE,
                        method,
                        path,
                        body
                    },
                    (response) => {
                        const lastError = chrome.runtime.lastError;
                        if (lastError) {
                            reject(new Error(lastError.message));
                            return;
                        }
                        if (!response) {
                            reject(new Error('后台没有响应'));
                            return;
                        }
                        if (!response.ok) {
                            reject(new Error(response.error || '服务器请求失败'));
                            return;
                        }
                        resolve(response.data);
                    }
                );
            });
        }

        /**
         * 1~5 位数字；1/2 归一到 001/002，普通编号从 010 开始。
         * @returns {string|null}
         */
        function normalizeCode(input) {
            const text = String(input == null ? '' : input).trim();
            if (!/^\d{1,5}$/.test(text)) return null;
            const number = Number(text);
            if (!Number.isInteger(number) || number < 1 || number > constants.SERVER_MAX_CODE) {
                return null;
            }
            if (number === 1) return '001';
            if (number === 2) return '002';
            if (number < constants.SERVER_MIN_UPLOAD_CODE) return null;
            return number < 1000 ? String(number).padStart(3, '0') : String(number);
        }

        async function getProgress() {
            return request('GET', '?action=progress');
        }

        async function getFile(code) {
            return request('GET', `?action=file&code=${encodeURIComponent(code)}`);
        }

        async function listMine(clientId) {
            return request('GET', `?action=my&clientId=${encodeURIComponent(clientId)}`);
        }

        async function upload({ clientId, title, description, content }) {
            return request('POST', '?action=upload', {
                clientId,
                title,
                description,
                content
            });
        }

        async function deleteMine({ clientId, code }) {
            return request('POST', '?action=delete', { clientId, code });
        }

        return {
            normalizeCode,
            getProgress,
            getFile,
            listMine,
            upload,
            deleteMine
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createServerApi = createServerApi;
})(globalThis);
