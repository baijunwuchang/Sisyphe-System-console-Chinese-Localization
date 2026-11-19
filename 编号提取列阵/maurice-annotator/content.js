/**
 * 启动入口：只负责“按顺序装配依赖”，不含业务逻辑。
 *
 * 所有模块都挂在 globalThis.Maurice 命名空间下，按 manifest 中的顺序加载；
 * 每个模块只通过工厂参数拿依赖，不互相直接引用。
 */
(function bootstrap(global) {
    'use strict';

    // 防止 content script 被重复注入（点扩展图标时 background 可能补注一次）
    if (global.__mauriceAnnoLoaded) return;
    global.__mauriceAnnoLoaded = true;

    const M = global.Maurice;

    const REQUIRED_MODULES = [
        'constants',
        'html',
        'createDomUtils',
        'createStore',
        'createPageRegistry',
        'createPatternEngine',
        'createDictionary',
        'createTranslator',
        'createExtractor',
        'createBadgeLayer',
        'createSelectionService',
        'createFinder',
        'createExportBuilders',
        'createTextTable',
        'createTransfer',
        'createExporters',
        'createApp',
        'panelTemplate',
        'createPanel'
    ];

    const missing = M ? REQUIRED_MODULES.filter((name) => typeof M[name] === 'undefined') : REQUIRED_MODULES;
    if (!M || missing.length) {
        console.error('[Maurice] 模块没加载全，缺少：', missing.join(', '));
        return;
    }

    const { constants, html } = M;

    /** 会话状态：当前页号在这几个服务之间通过 getter 共享 */
    const session = { pageId: null };

    // ---- 基础服务 ----
    const domUtils = M.createDomUtils({ constants });
    const transfer = M.createTransfer();
    const store = M.createStore({ constants });
    const pageRegistry = M.createPageRegistry({ store, constants });
    const dictionary = M.createDictionary({ store, constants });
    const patternEngine = M.createPatternEngine();

    // ---- 业务服务 ----
    const translator = M.createTranslator({
        dictionary,
        patternEngine,
        domUtils,
        getPageId: () => session.pageId
    });

    const extractor = M.createExtractor({
        domUtils,
        constants,
        getOriginalText: translator.getOriginalText
    });

    const badges = M.createBadgeLayer({
        domUtils,
        constants,
        onBadgeClick: (annotation) => {
            if (panel) panel.setResult(`已定位：${annotation.text}`);
        }
    });

    const selection = M.createSelectionService({ constants });
    selection.install();

    const finder = M.createFinder({ store, constants, badges, translator, selection });
    const builders = M.createExportBuilders({ constants });
    const textTable = M.createTextTable({ constants });

    const exporters = M.createExporters({
        store,
        dictionary,
        translator,
        transfer,
        builders,
        textTable,
        constants
    });

    const app = M.createApp({
        session,
        store,
        pageRegistry,
        dictionary,
        translator,
        extractor,
        badges,
        finder,
        exporters,
        transfer,
        textTable,
        selection
    });

    // ---- 界面 ----
    const panel = M.createPanel({
        app,
        constants,
        html,
        template: M.panelTemplate
    });

    // ---- 启动 ----
    app.init()
        .then(() => panel.update())
        .catch((error) => console.error('[Maurice] 初始化失败', error));

    // F1 开关面板（捕获阶段，避免被页面自己的快捷键吃掉）
    document.addEventListener(
        'keydown',
        (event) => {
            if (event.key === 'F1') {
                event.preventDefault();
                event.stopPropagation();
                panel.toggle();
            }
        },
        true
    );

    // 点扩展图标：background 发消息过来切换面板
    chrome.runtime.onMessage.addListener((message) => {
        if (message && message.action === constants.TOGGLE_MESSAGE) panel.toggle();
    });
})(globalThis);
