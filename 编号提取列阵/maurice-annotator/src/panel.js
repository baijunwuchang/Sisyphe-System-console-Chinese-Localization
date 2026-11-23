/**
 * 面板视图：建 DOM、绑事件、把动作转发给应用层。
 *
 * 这里是唯一知道“按钮长什么样、点了调哪个方法”的地方；
 * 业务逻辑（提取 / 词库 / 导出）全部通过 app 注入。
 */
(function registerPanel(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.app
     * @param {object} deps.constants
     * @param {object} deps.html
     * @param {Function} deps.template
     */
    function createPanel({ app, constants, html, template }) {
        let panelEl = null;
        let visible = false;
        let myUploads = [];
        let initialServerRequested = false;

        function query(selector) {
            return panelEl ? panelEl.querySelector(selector) : null;
        }

        function build() {
            if (panelEl) return panelEl;

            panelEl = document.createElement('div');
            panelEl.setAttribute('data-maurice-panel', '1');
            Object.assign(panelEl.style, {
                position: 'fixed',
                right: '16px',
                top: '16px',
                width: constants.PANEL_WIDTH_PX + 'px',
                maxHeight: '90vh',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                background: '#1e1e1e',
                color: '#eee',
                fontFamily: 'system-ui, sans-serif',
                fontSize: '12px',
                border: '1px solid #444',
                borderRadius: '8px',
                padding: '12px',
                zIndex: constants.PANEL_Z_INDEX,
                boxShadow: '0 4px 24px rgba(0,0,0,0.5)'
            });
            panelEl.innerHTML = template({ constants });
            document.documentElement.appendChild(panelEl);

            bindEvents();
            return panelEl;
        }

        /** 统一捕获动作异常，避免面板静默 */
        async function run(action) {
            try {
                const message = await action();
                if (message) setResult(message);
            } catch (error) {
                setResult('出错：' + (error && error.message ? error.message : String(error)));
            }
            update();
        }

        async function doFind() {
            const queryInput = query('[data-el="q"]');
            const result = await app.find(queryInput.value);
            if (result.source !== undefined) {
                query('[data-el="src"]').value = result.source;
                query('[data-el="dst"]').value = result.translation || '';
            }
            setResult(result.message);
            update();
        }

        function bindEvents() {
            panelEl.addEventListener('click', (event) => {
                const progressButton = event.target.closest('[data-dict-progress]');
                if (progressButton) {
                    run(() => app.queryProgress(progressButton.dataset.dictProgress));
                    return;
                }

                const uploadButton = event.target.closest('[data-dict-upload]');
                if (uploadButton) {
                    const name = uploadButton.dataset.dictUpload;
                    run(async () => {
                        const message = await app.uploadDict(name);
                        await refreshUploads(false);
                        return message;
                    });
                    return;
                }

                const uploadDownload = event.target.closest('[data-upload-download]');
                if (uploadDownload) {
                    run(() => app.downloadServerFile(uploadDownload.dataset.uploadDownload));
                    return;
                }

                const uploadDelete = event.target.closest('[data-upload-delete]');
                if (uploadDelete) {
                    const code = uploadDelete.dataset.uploadDelete;
                    if (confirm(`确定删除服务器上的 #${code}？`)) {
                        run(async () => {
                            const message = await app.deleteUpload(code);
                            await refreshUploads(false);
                            return message;
                        });
                    }
                    return;
                }

                const loadButton = event.target.closest('[data-dict-load]');
                if (loadButton) {
                    run(() => app.loadDictAlone(loadButton.dataset.dictLoad));
                    return;
                }

                const exportButton = event.target.closest('[data-dict-export]');
                if (exportButton) {
                    run(() => app.exportDict(exportButton.dataset.dictExport));
                    return;
                }

                const deleteButton = event.target.closest('[data-dict-del]');
                if (deleteButton) {
                    const name = deleteButton.dataset.dictDel;
                    if (confirm(`确定把词库「${name}」删了？`)) {
                        run(() => app.deleteDict(name));
                    }
                    return;
                }

                const button = event.target.closest('button');
                if (!button) return;
                const action = button.dataset.act;

                switch (action) {
                    case 'close':
                        hide();
                        break;
                    case 'extract':
                        run(() => app.extract());
                        break;
                    case 'show-badges':
                        app.setBadgesVisible(true);
                        update();
                        break;
                    case 'hide-badges':
                        app.setBadgesVisible(false);
                        update();
                        break;
                    case 'apply-all':
                        run(() => app.applyAll());
                        break;
                    case 'clear-translated':
                        run(() => app.clearPageTranslations());
                        break;
                    case 'find':
                        run(doFind);
                        break;
                    case 'save-global':
                        run(() =>
                            app.saveTranslation({
                                source: query('[data-el="src"]').value,
                                target: query('[data-el="dst"]').value,
                                scope: 'global'
                            })
                        );
                        break;
                    case 'save-page':
                        run(() =>
                            app.saveTranslation({
                                source: query('[data-el="src"]').value,
                                target: query('[data-el="dst"]').value,
                                scope: 'page'
                            })
                        );
                        break;
                    case 'del-trans':
                        run(() => app.deleteTranslation(query('[data-el="src"]').value));
                        break;
                    case 'import-dict':
                        query('[data-el="file"]').click();
                        break;
                    case 'import-table':
                        query('[data-el="file"]').click();
                        break;
                    case 'download-server':
                        run(() => app.downloadServerFile(query('[data-el="server-code"]').value));
                        break;
                    case 'refresh-uploads':
                        run(async () => {
                            await refreshUploads();
                            return `我的上传：${myUploads.length} 个`;
                        });
                        break;
                    case 'export-all-dicts':
                        run(() => app.exportMerged());
                        break;
                    case 'export-pending':
                        run(() => app.exportPending());
                        break;
                    case 'export-table':
                        run(() => app.exportTable());
                        break;
                    case 'export-translated':
                        run(() => app.exportTranslated());
                        break;
                    case 'export-json':
                        run(() => app.exportAll('json'));
                        break;
                    default:
                        break;
                }
            });

            panelEl.addEventListener('change', (event) => {
                const checkbox = event.target.closest('[data-dict-toggle]');
                if (!checkbox) return;
                run(() => app.toggleDict(checkbox.dataset.dictToggle, checkbox.checked));
            });

            const fileInput = panelEl.querySelector('[data-el="file"]');
            fileInput.addEventListener('change', (event) => {
                const file = event.target.files && event.target.files[0];
                if (!file) return;
                run(() => app.importFile(file)).finally(() => {
                    event.target.value = '';
                });
            });

            const queryInput = panelEl.querySelector('[data-el="q"]');
            queryInput.addEventListener('input', () => {
                // 用户开始输编号时，放弃页面上残留的选区
                app.clearSelection();
            });
            queryInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    run(doFind);
                }
            });

            const serverCodeInput = panelEl.querySelector('[data-el="server-code"]');
            serverCodeInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    run(() => app.downloadServerFile(serverCodeInput.value));
                }
            });

            // 在页面上选中新文本后，清空查找框，让“查找”按选区走
            document.addEventListener('selectionchange', () => {
                if (queryInput.value && app.hasSelection()) {
                    queryInput.value = '';
                }
            });

            const targetInput = panelEl.querySelector('[data-el="dst"]');
            targetInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    run(() =>
                        app.saveTranslation({
                            source: query('[data-el="src"]').value,
                            target: query('[data-el="dst"]').value,
                            scope: 'global'
                        })
                    );
                }
            });
        }

        function renderDictList() {
            const container = query('[data-el="dicts"]');
            if (!container) return;

            const dicts = app.getDicts();
            if (!dicts.length) {
                container.textContent = '（没词库）';
                return;
            }

            container.innerHTML = dicts
                .map((dict) => {
                    const checked = dict.active ? 'checked' : '';
                    const title = html.escapeAttr(dict.description || dict.label);
                    const description = dict.description
                        ? `<span style="color:#666;"> · ${html.escapeHtml(dict.description)}</span>`
                        : '';
                    const deleteButton = dict.deletable
                        ? `<button data-dict-del="${html.escapeAttr(dict.name)}" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:10px;">删除</button>`
                        : '';
                    const codeBadge = dict.serverCode
                        ? `<span style="color:#38bdf8;font-size:10px;white-space:nowrap;">#${html.escapeHtml(dict.serverCode)}</span>`
                        : '';
                    const isInitial = dict.serverCode === '001' || dict.serverCode === '002';
                    const progressButton = isInitial
                        ? `<button data-dict-progress="${html.escapeAttr(dict.serverCode)}" title="查看作者声明的翻译进度" style="background:none;border:none;color:#fbbf24;cursor:pointer;font-size:10px;">查询进度</button>`
                        : '';
                    const uploadButton = dict.serverCode
                        ? ''
                        : `<button data-dict-upload="${html.escapeAttr(dict.name)}" title="上传到共享服务器（每人最多 4 个）" style="background:none;border:none;color:#2dd4bf;cursor:pointer;font-size:10px;">上传</button>`;

                    return `<div style="display:flex;align-items:center;gap:5px;padding:3px 0;border-bottom:1px solid #2a2a2a;">
        <input type="checkbox" data-dict-toggle="${html.escapeAttr(dict.name)}" ${checked} style="cursor:pointer;" />
        <span style="flex:1;color:#eee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${title}">
          ${html.escapeHtml(dict.label)}${description}
        </span>
        ${codeBadge}
        <span style="color:#f59e0b;font-size:10px;white-space:nowrap;">${dict.count}词</span>
        ${progressButton}
        ${uploadButton}
        <button data-dict-load="${html.escapeAttr(dict.name)}" title="只启用这个词库并立即应用，其他词库会暂时取消" style="background:none;border:none;color:#34d399;cursor:pointer;font-size:10px;">加载</button>
        <button data-dict-export="${html.escapeAttr(dict.name)}" title="导出这个词库" style="background:none;border:none;color:#60a5fa;cursor:pointer;font-size:10px;">导出</button>
        ${deleteButton}
      </div>`;
                })
                .join('');
        }

        function renderUploads() {
            const container = query('[data-el="uploads"]');
            if (!container) return;

            if (!myUploads.length) {
                container.textContent = '（还没有上传，或点“刷新我的上传”查看）';
                return;
            }

            container.innerHTML = myUploads
                .map((file) => {
                    const code = html.escapeHtml(file.code);
                    const title = html.escapeHtml(file.title || '未命名');
                    return `<div style="display:flex;align-items:center;gap:5px;padding:2px 0;border-bottom:1px solid #222;">
        <span style="color:#38bdf8;">#${code}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${title}">${title}</span>
        <button data-upload-download="${html.escapeAttr(file.code)}" style="background:none;border:none;color:#60a5fa;cursor:pointer;font-size:10px;">下载</button>
        <button data-upload-delete="${html.escapeAttr(file.code)}" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:10px;">删除</button>
      </div>`;
                })
                .join('');
        }

        async function refreshUploads() {
            myUploads = await app.listMyUploads();
            renderUploads();
        }

        function update() {
            if (!panelEl) return;

            const showButton = query('[data-act="show-badges"]');
            const hideButton = query('[data-act="hide-badges"]');
            if (showButton && hideButton) {
                const badgesVisible = app.isBadgesVisible();
                showButton.style.opacity = badgesVisible ? '0.55' : '1';
                hideButton.style.opacity = badgesVisible ? '1' : '0.55';
            }

            renderDictList();
            renderUploads();
        }

        function setResult(text) {
            const result = query('[data-el="result"]');
            if (result) result.textContent = text;
        }

        function show() {
            build();
            panelEl.style.display = 'flex';
            visible = true;
            update();

            if (!initialServerRequested) {
                initialServerRequested = true;
                app.ensureInitialServerFiles()
                    .then((result) => {
                        if (result.downloaded.length) update();
                        const resultEl = query('[data-el="result"]');
                        if (result.errors.length && resultEl && !resultEl.textContent) {
                            setResult('初始文件下载失败：\n' + result.errors.join('\n'));
                        }
                    })
                    .catch((error) => {
                        const resultEl = query('[data-el="result"]');
                        if (resultEl && !resultEl.textContent) {
                            setResult('初始文件下载失败：' + error.message);
                        }
                    });
            }
        }

        function hide() {
            if (panelEl) panelEl.style.display = 'none';
            visible = false;
        }

        function toggle() {
            if (visible) hide();
            else show();
        }

        return { show, hide, toggle, update, setResult };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createPanel = createPanel;
})(globalThis);
