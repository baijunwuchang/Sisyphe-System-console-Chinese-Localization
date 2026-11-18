(function() {
    if (window.__mauriceAnnoLoaded) return;
    window.__mauriceAnnoLoaded = true;

    // ============================================================
    // 配置
    // ============================================================
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META']);
    const DOC_CLASS_RE = /markdown|manual|doc-|docs-|article|prose|readme|guide|help-|text-?panel|content-?body/i;
    const EDITOR_CONTAINER_RE = /monaco-editor|CodeMirror|ace_editor|ace_text|cm-editor|script-?editor|code-?area|editor-?container/i;
    const TOKEN_CLASS_RE = /^token-|\btoken\b|hljs-|syntax-/i;
    const KOREAN_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;
    const ENGLISH_RE = /[A-Za-z]/;

    // ============================================================
    // 状态
    // ============================================================
    let annotations = [];       // 当前页: { id, pageId, textId, type, text, node }
    let pageId = null;
    let pageIdMap = {};         // { urlKey: pageId }
    let pagesStore = {};        // { pageId: { url, title, extractedAt, texts: [...] } }
    let pageCounter = 0;

    let overlayEl = null;
    let badgeItems = [];
    let panelEl = null;
    let panelVisible = false;
    let highlightTimer = null;
    let highlightEls = [];

    // ============================================================
    // 存储
    // ============================================================
    async function loadStore() {
        const d = await chrome.storage.local.get(['pageIdMap', 'pageCounter', 'pages']);
        pageIdMap = d.pageIdMap || {};
        pageCounter = d.pageCounter || 0;
        pagesStore = d.pages || {};
    }

    async function saveStore() {
        await chrome.storage.local.set({
            pageIdMap,
            pageCounter,
            pages: pagesStore
        });
    }

    function urlKey() {
        return location.pathname + location.search + location.hash;
    }

    // 解析/分配当前 URL 对应的页面号
    // forceNew=true 时强制分配新页面号并覆盖当前 URL 的映射
    async function resolvePageId(forceNew = false) {
        if (forceNew) {
            pageCounter += 1;
            pageId = 'P' + pageCounter;
            pageIdMap[urlKey()] = pageId;
            await saveStore();
            return pageId;
        }
        if (pageIdMap[urlKey()]) {
            pageId = pageIdMap[urlKey()];
            return pageId;
        }
        // 该 URL 从未分配过页面号，分配新的
        pageCounter += 1;
        pageId = 'P' + pageCounter;
        pageIdMap[urlKey()] = pageId;
        await saveStore();
        return pageId;
    }

    // ============================================================
    // 类型判断（ui / code）
    // ============================================================
    function getTextType(node) {
        // 1) 先向上找文档/手册容器，命中视为 UI
        let cur = node.parentElement;
        let d = 0;
        while (cur && d < 30) {
            const cls = typeof cur.className === 'string'
                ? cur.className
                : (cur.className && cur.className.baseVal) || '';
            if (DOC_CLASS_RE.test(cls)) return 'ui';
            cur = cur.parentElement;
            d++;
        }

        // 2) 再判断编辑器特征
        let el = node.parentElement;
        let depth = 0;
        while (el && depth < 30) {
            if (el.tagName === 'TEXTAREA') return 'code';
            if (el.isContentEditable) return 'code';

            const cls = typeof el.className === 'string'
                ? el.className
                : (el.className && el.className.baseVal) || '';
            if (cls) {
                if (EDITOR_CONTAINER_RE.test(cls)) return 'code';
                if (TOKEN_CLASS_RE.test(cls) && el.childElementCount === 0) return 'code';
            }

            if (el.tagName === 'CODE' || el.tagName === 'PRE') {
                // CODE / PRE 只有在没有文档容器祖先时才当代码
                let p = el.parentElement;
                let d3 = 0;
                while (p && d3 < 10) {
                    const pcls = typeof p.className === 'string'
                        ? p.className
                        : (p.className && p.className.baseVal) || '';
                    if (DOC_CLASS_RE.test(pcls)) return 'ui';
                    p = p.parentElement;
                    d3++;
                }
                return 'code';
            }

            el = el.parentElement;
            depth++;
        }
        return 'ui';
    }

    // ============================================================
    // 提取（只建立内存映射）
    // ============================================================
    function extractAll() {
        const list = [];
        let textId = 0;

        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(n) {
                    const p = n.parentElement;
                    if (!p) return NodeFilter.FILTER_REJECT;
                    if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        let node;
        while ((node = walker.nextNode())) {
            const raw = node.textContent;
            if (!raw) continue;
            const t = raw.trim();
            if (!t) continue;
            if (!KOREAN_RE.test(t) && !ENGLISH_RE.test(t)) continue;

            textId++;
            list.push({
                id: `${pageId}-${textId}`,
                pageId,
                textId,
                type: getTextType(node),
                text: t,
                node
            });
        }
        return list;
    }

    async function extractAndSave() {
        await loadStore();
        // 如果 pageId 已经由外部（input 手动指定或 doNewPage）设置且与 urlKey 绑定，直接用
        if (!pageId || pageIdMap[urlKey()] !== pageId) {
            await resolvePageId(false);
        }
        annotations = extractAll();

        pagesStore[pageId] = {
            url: location.href,
            title: document.title,
            extractedAt: Date.now(),
            texts: annotations.map(a => ({
                id: a.id,
                pageId,
                textId: a.textId,
                type: a.type,
                text: a.text
            }))
        };
        await saveStore();
        return annotations;
    }

    // ============================================================
    // 徽标
    // ============================================================
    function clearBadges() {
        if (overlayEl) {
            overlayEl.remove();
            overlayEl = null;
        }
        badgeItems = [];
    }

    function renderBadges() {
        clearBadges();
        overlayEl = document.createElement('div');
        Object.assign(overlayEl.style, {
            position: 'fixed',
            inset: '0',
            pointerEvents: 'none',
            zIndex: '2147483646'
        });
        document.documentElement.appendChild(overlayEl);

        for (const a of annotations) {
            const rect = getFirstRect(a.node);
            if (!rect) continue;
            const badge = document.createElement('div');
            badge.textContent = a.id;
            Object.assign(badge.style, {
                position: 'absolute',
                background: a.type === 'code' ? '#e11d48' : '#2563eb',
                color: '#fff',
                fontSize: '10px',
                padding: '1px 4px',
                borderRadius: '3px',
                fontFamily: 'monospace',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                transition: 'opacity .15s'
            });
            placeBadge(badge, rect);
            overlayEl.appendChild(badge);
            badgeItems.push({ badge, node: a.node, annotation: a });
        }

        window.addEventListener('scroll', repositionBadges, true);
        window.addEventListener('resize', repositionBadges);
    }

    function placeBadge(badge, rect) {
        badge.style.left = (rect.left + window.scrollX) + 'px';
        badge.style.top = (rect.top + window.scrollY) + 'px';
        badge.style.transform = 'translateY(-100%)';
    }

    function repositionBadges() {
        for (const it of badgeItems) {
            const r = getFirstRect(it.node);
            if (!r) {
                it.badge.style.display = 'none';
                continue;
            }
            it.badge.style.display = '';
            placeBadge(it.badge, r);
        }
    }

    function getNodeRects(node) {
        if (!node || !node.isConnected) return [];
        try {
            const range = document.createRange();
            range.selectNodeContents(node);
            return Array.from(range.getClientRects());
        } catch (_) {
            return [];
        }
    }

    function getFirstRect(node) {
        const r = getNodeRects(node);
        return r.length ? r[0] : null;
    }

    // ============================================================
    // 高亮
    // ============================================================
    function clearHighlight() {
        if (highlightTimer) {
            clearTimeout(highlightTimer);
            highlightTimer = null;
        }
        highlightEls.forEach(el => el.remove());
        highlightEls = [];
        badgeItems.forEach(b => {
            b.badge.style.background = b.annotation.type === 'code' ? '#e11d48' : '#2563eb';
        });
    }

    function highlightNode(node) {
        clearHighlight();
        const rects = getNodeRects(node);
        if (!rects.length) return false;

        for (const r of rects) {
            const hl = document.createElement('div');
            Object.assign(hl.style, {
                position: 'absolute',
                left: (r.left + window.scrollX) + 'px',
                top: (r.top + window.scrollY) + 'px',
                width: r.width + 'px',
                height: r.height + 'px',
                background: 'rgba(250, 204, 21, 0.45)',
                outline: '2px solid #f59e0b',
                pointerEvents: 'none',
                zIndex: '2147483645',
                borderRadius: '2px'
            });
            document.documentElement.appendChild(hl);
            highlightEls.push(hl);
        }

        window.scrollTo({
            top: rects[0].top + window.scrollY - window.innerHeight / 3,
            behavior: 'smooth'
        });

        const item = badgeItems.find(b => b.node === node);
        if (item) item.badge.style.background = '#f59e0b';

        highlightTimer = setTimeout(clearHighlight, 4000);
        return true;
    }

    // ============================================================
    // 查找
    // ============================================================
    async function findById(numStr) {
        const m = /^(P\d+)-(\d+)$/i.exec(String(numStr).trim());
        if (!m) return { ok: false, msg: '格式应为 P8-42' };
        const targetPage = m[1].toUpperCase();
        const targetTid = parseInt(m[2], 10);

        // 当前页：优先用内存映射
        if (targetPage === pageId) {
            if (!annotations.length) annotations = extractAll();
            const a = annotations.find(x => x.textId === targetTid);
            if (!a) return { ok: false, msg: `当前页 (${pageId}) 没有编号 ${targetTid}` };
            highlightNode(a.node);
            return { ok: true, type: 'current', msg: `已定位：${a.text}` };
        }

        // 其他页：查 storage
        await loadStore();
        const pg = pagesStore[targetPage];
        if (!pg) {
            return {
                ok: false,
                msg: `还没有记录页面 ${targetPage}，请先去那页按 F1 提取`
            };
        }
        const entry = pg.texts.find(t => t.textId === targetTid);
        if (!entry) {
            return { ok: false, msg: `页面 ${targetPage} 没有编号 ${targetTid}` };
        }
        return {
            ok: true,
            type: 'other',
            msg:
                `该词不在当前页。\n` +
                `页面：${targetPage}\n` +
                `标题：${pg.title || '(无)'}\n` +
                `URL：${pg.url}\n` +
                `原文：${entry.text}\n` +
                `请切换到该页面后按 F1 重新提取`
        };
    }

    // ============================================================
    // 面板
    // ============================================================
    function buildPanel() {
        if (panelEl) return panelEl;
        panelEl = document.createElement('div');
        Object.assign(panelEl.style, {
            position: 'fixed',
            right: '16px',
            top: '16px',
            width: '440px',
            maxHeight: '84vh',
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
            zIndex: '2147483647',
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)'
        });

        panelEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="font-size:13px;">Maurice 文本标注</strong>
        <button data-act="close" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:16px;">×</button>
      </div>

      <div style="display:flex;gap:6px;margin-bottom:6px;">
        <label style="flex:1;display:flex;align-items:center;gap:4px;">
          <span style="color:#aaa;white-space:nowrap;">当前页号</span>
          <input data-el="pid" value="" style="flex:1;background:#111;border:1px solid #444;color:#eee;padding:4px 6px;border-radius:4px;font-family:monospace;" />
        </label>
        <button data-act="extract" style="padding:4px 8px;background:#3b82f6;color:#fff;border:none;border-radius:4px;cursor:pointer;white-space:nowrap;">提取并保存</button>
        <button data-act="newpage" style="padding:4px 8px;background:#f59e0b;color:#fff;border:none;border-radius:4px;cursor:pointer;white-space:nowrap;">分配新页号</button>
      </div>

      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <input data-el="q" placeholder="输入编号查找，例如 P8-42" style="flex:1;background:#111;border:1px solid #444;color:#eee;padding:6px 8px;border-radius:4px;font-family:monospace;" />
        <button data-act="find" style="padding:6px 12px;background:#10b981;color:#fff;border:none;border-radius:4px;cursor:pointer;">查找</button>
      </div>

      <div data-el="result" style="margin-bottom:8px;padding:8px;background:#111;border-radius:4px;min-height:40px;color:#aaa;white-space:pre-wrap;font-size:11px;line-height:1.5;"></div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="color:#aaa;font-size:11px;">已提取页面</span>
        <button data-act="refresh" style="background:none;border:none;color:#888;cursor:pointer;font-size:11px;">刷新</button>
      </div>

      <div data-el="pages" style="max-height:180px;overflow:auto;background:#111;border-radius:4px;padding:6px;font-family:monospace;font-size:11px;line-height:1.6;margin-bottom:8px;"></div>

      <div style="display:flex;gap:6px;">
        <button data-act="export-json" style="flex:1;padding:6px;background:#10b981;color:#fff;border:none;border-radius:4px;cursor:pointer;">导出全部 JSON</button>
        <button data-act="export-tsv" style="flex:1;padding:6px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;">导出全部 TSV</button>
      </div>
    `;

        document.documentElement.appendChild(panelEl);

        panelEl.addEventListener('click', async (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'close') hidePanel();
            else if (act === 'extract') await doExtract();
            else if (act === 'newpage') await doNewPage();
            else if (act === 'find') await doFind();
            else if (act === 'refresh') await refreshPages();
            else if (act === 'export-json') await exportAll('json');
            else if (act === 'export-tsv') await exportAll('tsv');
        });

        panelEl.querySelector('[data-el="q"]').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                doFind();
            }
        });

        return panelEl;
    }

    async function doExtract() {
        const pidInput = panelEl.querySelector('[data-el="pid"]');
        const userPid = pidInput.value.trim().toUpperCase();

        await loadStore();

        // 用户手动在输入框指定了页面号，则以此为准
        if (userPid && /^P\d+$/.test(userPid)) {
            pageId = userPid;
            pageIdMap[urlKey()] = pageId;
            const n = parseInt(pageId.slice(1), 10);
            if (n > pageCounter) pageCounter = n;
            await saveStore();
        } else {
            await resolvePageId(false);
        }

        await extractAndSave();
        renderBadges();
        updatePanel();
        setResult(`✅ 已提取 ${annotations.length} 条并存入 ${pageId}`);
    }

    async function doNewPage() {
        await loadStore();
        pageCounter += 1;
        pageId = 'P' + pageCounter;
        pageIdMap[urlKey()] = pageId;
        await saveStore();
        panelEl.querySelector('[data-el="pid"]').value = pageId;
        setResult(`新页面号：${pageId}\n点"提取并保存"确认`);
    }

    async function doFind() {
        const q = panelEl.querySelector('[data-el="q"]').value;
        const res = await findById(q);
        setResult(res.msg);
    }

    function setResult(text) {
        panelEl.querySelector('[data-el="result"]').textContent = text;
    }

    async function refreshPages() {
        await loadStore();
        const el = panelEl.querySelector('[data-el="pages"]');
        const ids = Object.keys(pagesStore).sort(
            (a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)
        );
        if (!ids.length) {
            el.textContent = '（暂无）';
            return;
        }
        el.innerHTML = ids.map(id => {
            const p = pagesStore[id];
            const cur = id === pageId ? ' ←当前' : '';
            return `<div style="display:flex;gap:6px;padding:2px 0;border-bottom:1px solid #2a2a2a;">
        <span style="color:#60a5fa;flex-shrink:0;">${id}${cur}</span>
        <span style="color:#888;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(p.url)}">${escapeHtml(p.title || p.url)}</span>
        <span style="color:#f59e0b;flex-shrink:0;">${p.texts.length}条</span>
      </div>`;
        }).join('');
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
        );
    }

    async function exportAll(kind) {
        await loadStore();
        const ids = Object.keys(pagesStore).sort(
            (a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)
        );

        let content, filename, mime;
        if (kind === 'json') {
            const data = [];
            for (const id of ids) {
                for (const t of pagesStore[id].texts) {
                    data.push({
                        id: t.id,
                        pageId: t.pageId,
                        textId: t.textId,
                        type: t.type,
                        text: t.text,
                        translation: ''
                    });
                }
            }
            content = JSON.stringify(data, null, 2);
            filename = 'maurice_all.json';
            mime = 'application/json';
        } else {
            const lines = ['id\ttype\ttext'];
            for (const id of ids) {
                for (const t of pagesStore[id].texts) {
                    lines.push(`${t.id}\t${t.type}\t${t.text.replace(/\t/g, ' ')}`);
                }
            }
            content = lines.join('\n');
            filename = 'maurice_all.tsv';
            mime = 'text/tab-separated-values';
        }

        const blob = new Blob([content], { type: mime + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    }

    function updatePanel() {
        if (!panelEl) return;
        panelEl.querySelector('[data-el="pid"]').value = pageId || '';
        refreshPages();
    }

    function showPanel() {
        buildPanel();
        panelEl.style.display = 'flex';
        panelVisible = true;
        updatePanel();
    }

    function hidePanel() {
        if (panelEl) panelEl.style.display = 'none';
        panelVisible = false;
    }

    function togglePanel() {
        panelVisible ? hidePanel() : showPanel();
    }

    // ============================================================
    // F1 / 消息
    // ============================================================
    document.addEventListener('keydown', (e) => {
        if (e.key === 'F1') {
            e.preventDefault();
            e.stopPropagation();
            togglePanel();
        }
    }, true);

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'toggle') togglePanel();
    });

    // ============================================================
    // 初始化
    // ============================================================
    (async () => {
        await loadStore();
        await resolvePageId(false);
        annotations = extractAll();
        console.log(
            `[Maurice] 已加载，当前页 ${pageId}，DOM 中识别 ${annotations.length} 条`
        );
    })();
})();