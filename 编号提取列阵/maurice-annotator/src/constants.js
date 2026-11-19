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
        'activeDicts'
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

        /**
         * 导出文件名。词库类文件（待翻译 / 合并 / 单个词库）可以再次导入，
         * 所以固定用中文名；文本对照文件不是词库，保留原英文名避免误导入。
         */
        EXPORT_FILENAMES: Object.freeze({
            textsJson: 'maurice_texts.json',
            textsTsv: 'maurice_texts.tsv',
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

        // ---- 界面 ----
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
