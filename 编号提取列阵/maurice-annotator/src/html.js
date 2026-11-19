/**
 * HTML 转义工具。
 *
 * 面板用模板字符串拼 innerHTML，凡是来自页面 / 词库 / 用户输入的字符串
 * 都必须先过这里，避免把页面文本当 HTML 执行。
 */
(function registerHtml(global) {
    'use strict';

    const ESCAPE_MAP = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };

    /** 转义文本节点内容 */
    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
    }

    /** 转义 HTML 属性值（规则与文本相同，单独命名是为了语义清晰） */
    function escapeAttr(value) {
        return escapeHtml(value);
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.html = Object.freeze({ escapeHtml, escapeAttr });
})(globalThis);
