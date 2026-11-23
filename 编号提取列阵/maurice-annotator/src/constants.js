/**
 * 常量与配置。
 *
 * 这一层不依赖任何其他模块，也不访问 DOM / chrome API。
 * 其它模块只从这里读取规则，避免同一条规则散落在多个文件里。
 */
(function registerConstants(global) {
    'use strict';

    /** chrome.storage.local 里用到的全部键（保持与旧版一致，旧数据可直接沿用） */
    const STORAGE_KEYS = Object.freeze([
        'pageIdMap',
        'pageCounter',
        'pages',
        'dicts',
        'activeDicts',
        'clientId'
    ]);

    const constants = Object.freeze({
        /** chrome.storage.local 用到的键 */
        STORAGE_KEYS,

        // ---- 扫描规则 ----
        /** 这些标签里的文本永远不处理 */
        SKIP_TAGS: new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META']),

        /** 命中这些 class 的容器按“手册 / 文档界面”处理，而不是代码区 */
        DOC_CLASS_RE: /markdown|manual|doc-|docs-|article|prose|readme|guide|help-|text-?panel|content-?body/i,

        /** 命中这些 class 的容器是代码编辑器，禁止替换 */
        EDITOR_CONTAINER_RE: /monaco-editor|CodeMirror|ace_editor|ace_text|cm-editor|script-?editor|code-?area|editor-?container/i,

        /** 需要提取的语种：韩文或英文 */
        KOREAN_RE: /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/,
        ENGLISH_RE: /[A-Za-z]/,

        /** 零宽 / 软连字符等看不见的字符，匹配前先删掉 */
        INVISIBLE_CHARS_RE: /[\u200B-\u200D\uFEFF\u00AD\u2060]/g,

        // ---- 数据格式 ----
        /** 面板里随手记的翻译固定存这个“词库” */
        CUSTOM_DICT_NAME: 'custom',
        CUSTOM_DICT_DESCRIPTION: '面板里随手存的翻译',

        /** 词库文件的 format / version 标记 */
        DICT_FORMAT: 'maurice-dict',
        DICT_FORMAT_VERSION: '1.0',

        /** 可编辑对照表的列名 / 未翻译占位 / 导入后生成的词库名 */
        TABLE_HEADER: Object.freeze(['原文', '编号', '译文']),
        TABLE_EMPTY: '暂无',
        TABLE_DICT_NAME: '导入对照表',
        TABLE_DICT_DESCRIPTION: '从可编辑对照表导入的译文',

        /**
         * 导出文件名。可导入的对照表 / 词库都用中文名；
         * JSON 备份保留英文名，避免误当成可导入文件。
         */
        EXPORT_FILENAMES: Object.freeze({
            textsJson: 'maurice_texts.json',
            textsTsv: 'maurice_texts.tsv',
            table: '文本对照表.tsv',
            translatedTable: '已翻译文本.tsv',
            pendingDict: '待翻译词库.json',
            mergedDict: '合并词库.json',
            dictPrefix: '词库_',
            dictSuffix: '.json',
            customDictBase: '自定义'
        }),

        /** 编号格式：P<页号>-<文本序号>，例如 P1-42 */
        ID_PATTERN: /^(P\d+)-(\d+)$/i,
        PAGE_ID_PREFIX: 'P',
        TEXT_ID_SEPARATOR: '-',

        // ---- 运行时消息 ----
        /** background 通知 content 开关面板的消息名 */
        TOGGLE_MESSAGE: 'toggle',
        /** content 通过 background 代理服务器请求的消息名 */
        SERVER_API_MESSAGE: 'maurice-api',

        // ---- 共享服务器 ----
        SERVER_API_BASE: 'http://47.80.59.80/maurice-api.php',
        /** 作者保留的初始文件编号（默认下载但不在面板里默认启用） */
        SERVER_INITIAL_CODES: Object.freeze(['001', '002']),
        /** 普通用户上传编号从 010 开始 */
        SERVER_MIN_UPLOAD_CODE: 10,
        SERVER_MAX_CODE: 99999,
        SERVER_MAX_UPLOADS: 4,
        /** 服务器文件在本地词库里的 key 前缀 */
        SERVER_DICT_PREFIX: 'server-',

        // ---- 界面 ----
        /** 面板根节点的标记 / 选择器（选区服务用它排除面板内部） */
        PANEL_SELECTOR: '[data-maurice-panel]',
        PANEL_WIDTH_PX: 500,
        OVERLAY_Z_INDEX: '2147483646',
        PANEL_Z_INDEX: '2147483647',
        HIGHLIGHT_Z_INDEX: '2147483645',
        HIGHLIGHT_DURATION_MS: 4000,
        /** 小于这个尺寸的矩形不参与标注，避免乱标 */
        MIN_RECT_WIDTH: 4,
        MIN_RECT_HEIGHT: 6,
        /** 向上查找祖先节点的最大层数 */
        MAX_ANCESTOR_DEPTH: 30,
        MAX_VISIBILITY_DEPTH: 40,

        // ---- 选区查找 ----
        /** 右键拖动超过这个像素才算“选中”而不是普通右键菜单 */
        SELECTION_DRAG_THRESHOLD: 4,
        /** 选区覆盖不超过这么多条标注时，高亮整段；超过则只高亮选中的部分 */
        SELECTION_FULL_HIGHLIGHT_MAX: 2,
        SELECTION_PREVIEW_LENGTH: 60,
        SELECTION_ID_LIST_LIMIT: 8,

        COLORS: Object.freeze({
            badgeCode: '#e11d48',
            badgeUi: '#2563eb',
            badgeActive: '#f59e0b',
            highlightFill: 'rgba(250, 204, 21, 0.45)',
            highlightOutline: '#f59e0b'
        })
    });

    global.Maurice = global.Maurice || {};
    global.Maurice.constants = constants;
})(globalThis);
