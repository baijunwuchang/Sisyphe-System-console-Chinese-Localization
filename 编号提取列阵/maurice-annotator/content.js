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
    const INVISIBLE_CHARS_RE = /[\u200B-\u200D\uFEFF\u00AD\u2060]/g;
    const MIN_RECT_WIDTH = 4;
    const MIN_RECT_HEIGHT = 6;

    // ============================================================
    // 状态
    // ============================================================
    let annotations = [];
    let pageId = null;
    let pageIdMap = {};
    let pagesStore = {};
    let pageCounter = 0;

    let overlayEl = null;
    let badgeItems = [];
    let badgesVisible = true;   // 🔑 新状态：徽标是否显示

    let panelEl = null;
    let panelVisible = false;
    let highlightTimer = null;
    let highlightEls = [];

    let visibleCache = new WeakMap();
    let lastScanTotal = 0;

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
        await chrome.storage.local.set({ pageIdMap, pageCounter, pages: pagesStore });
    }
    function urlKey() {
        return location.pathname + location.search + location.hash;
    }
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
        pageCounter += 1;
        pageId = 'P' + pageCounter;
        pageIdMap[urlKey()] = pageId;
        await saveStore();
        return pageId;
    }

    // ============================================================
    // 可见性判断
    // ============================================================
    function isVisible(node) {
        const el = node.parentElement;
        if (!el) return false;
        if (visibleCache.has(el)) return visibleCache.get(el);

        let visible = true;
        try {
            if (typeof el.checkVisibility === 'function') {
                visible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
            } else {
                let cur = el, d = 0;
                while (cur && d < 40) {
                    let cs;
                    try { cs = getComputedStyle(cur); } catch (_) { break; }
                    if (
                        cs.display === 'none' ||
                        cs.visibility === 'hidden' ||
                        cs.visibility === 'collapse' ||
                        parseFloat(cs.opacity) === 0
                    ) { visible = false; break; }
                    cur = cur.parentElement;
                    d++;
                }
            }
            if (visible) {
                const r = el.getBoundingClientRect();
                if (r.width < 1 || r.height < 1) visible = false;
            }
        } catch (_) {
            visible = true;
        }
        visibleCache.set(el, visible);
        return visible;
    }

    function cleanText(raw) {
        return raw.replace(INVISIBLE_CHARS_RE, '').trim();
    }

    // ============================================================
    // 类型判断
    // ============================================================
    function getTextType(node) {
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
                let p = el.parentElement, d3 = 0;
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
    // 提取
    // ============================================================
    function extractAll() {
        visibleCache = new WeakMap();
        lastScanTotal = 0;
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
            const t = cleanText(node.textContent || '');
            if (!t) continue;
            if (!KOREAN_RE.test(t) && !ENGLISH_RE.test(t)) continue;

            lastScanTotal++;
            if (!isVisible(node)) continue;

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
        if (!pageId || pageIdMap[urlKey()] !== pageId) {
            await resolvePageId(false);
        }
        annotations = extractAll();
        pagesStore[pageId] = {
            url: location.href,
            title: document.title,
            extractedAt: Date.now(),
            texts: annotations.map(a => ({
                id: a.id, pageId, textId: a.textId, type: a.type, text: a.text
            }))
        };
        await saveStore();
        return annotations;
    }

    // ============================================================
    // 矩形工具
    // ============================================================
    function getNodeRects(node) {
        if (!node || !node.isConnected) return [];
        try {
            const r = document.createRange();
            r.selectNodeContents(node);
            return Array.from(r.getClientRects());
        } catch (_) { return []; }
    }
    function getValidRects(node) {
        return getNodeRects(node).filter(
            r => r.width >= MIN_RECT_WIDTH && r.height >= MIN_RECT_HEIGHT
        );
    }
    function getFirstRect(node) {
        const rs = getValidRects(node);
        return rs.length ? rs[0] : null;
    }

    // ============================================================
    // 徽标
    // ============================================================
    function clearBadges() {
        if (overlayEl) { overlayEl.remove(); overlayEl = null; }
        badgeItems = [];
    }

    function renderBadges() {
        clearBadges();
        // 🔑 如果处于"取消标注"状态，则不渲染
        if (!badgesVisible) return;
        if (!annotations.length) return;

        overlayEl = document.createElement('div');
        Object.assign(overlayEl.style, {
            position: 'fixed',
            inset: '0',
            pointerEvents: 'none',
            zIndex: '2147483646'
        });
        document.documentElement.appendChild(overlayEl);

        let rendered = 0;
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
                pointerEvents: 'auto',
                cursor: 'pointer',
                userSelect: 'none',
                transition: 'opacity .15s'
            });
            badge.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                highlightNode(a.node);
                setResult(`已定位：${a.text}`);
            });
            placeBadge(badge, rect);
            overlayEl.appendChild(badge);
            badgeItems.push({ badge, node: a.node, annotation: a });
            rendered++;
        }
        console.log(`[Maurice] 徽标渲染 ${rendered}/${annotations.length}`);

        // 避免重复挂监听
        window.removeEventListener('scroll', repositionBadges, true);
        window.removeEventListener('resize', repositionBadges);
        window.addEventListener('scroll', repositionBadges, true);
        window.addEventListener('resize', repositionBadges);
    }

    function placeBadge(badge, rect) {
        badge.style.left = (rect.left + window.scrollX) + 'px';
        badge.style.top = (rect.top + window.scrollY) + 'px';
        badge.style.transform = 'translateY(-100%)';
    }

    function repositionBadges() {
        if (!badgesVisible || !overlayEl) return;
        for (const it of badgeItems) {
            const r = getFirstRect(it.node);
            if (!r) { it.badge.style.display = 'none'; continue; }
            it.badge.style.display = '';
            placeBadge(it.badge, r);
        }
    }

    // 🔑 显示 / 隐藏徽标
    function showBadges() {
        badgesVisible = true;
        if (annotations.length) renderBadges();
        updatePanel();
    }
    function hideBadges() {
        badgesVisible = false;
        clearBadges();
        updatePanel();
    }

    // ============================================================
    // 高亮（独立于徽标显隐，永远可用）
    // ============================================================
    function clearHighlight() {
        if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
        highlightEls.forEach(el => el.remove());
        highlightEls = [];
        badgeItems.forEach(b => {
            b.badge.style.background = b.annotation.type === 'code' ? '#e11d48' : '#2563eb';
        });
    }

    function highlightNode(node) {
        clearHighlight();
        const rects = getValidRects(node);
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

        // 如果有徽标显示，同步变黄；如果已隐藏，跳过
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

        if (targetPage === pageId) {
            if (!annotations.length) annotations = extractAll();
            const a = annotations.find(x => x.textId === targetTid);
            if (!a) return { ok: false, msg: `当前页 (${pageId}) 没有编号 ${targetTid}` };
            const ok = highlightNode(a.node);
            return {
                ok,
                type: 'current',
                msg: ok ? `已定位：${a.text}` : `找到了 ${a.id}，但当前视口中没有有效几何位置`
            };
        }

        await loadStore();
        const pg = pagesStore[targetPage];
        if (!pg) return { ok: false, msg: `还没有记录页面 ${targetPage}，请先去那页按 F1 提取` };
        const entry = pg.texts.find(t => t.textId === targetTid);
        if (!entry) return { ok: false, msg: `页面 ${targetPage} 没有编号 ${targetTid}` };
        return {
            ok: true, type: 'other',
            msg: `该词不在当前页。\n页面：${targetPage}\n标题：${pg.title || '(无)'}\nURL：${pg.url}\n原文：${entry.text}\n请切换到该页面后按 F1 重新提取`
        };
    }

    // ============================================================
    // 面板
    // ============================================================
    function buildPanel() {
        if (panelEl) return panelEl;
        panelEl = document.createElement('div');
        Object.assign(panelEl.style, {
            position: 'fixed', right: '16px', top: '16px', width: '460px', maxHeight: '86vh',
            overflow: 'hidden', display: 'flex', flexDirection: 'column',
            background: '#1e1e1e', color: '#eee',
            fontFamily: 'system-ui, sans-serif', fontSize: '12px',
            border: '1px solid #444', borderRadius: '8px', padding: '12px',
            zIndex: '2147483647', boxShadow: '0 4px 24px rgba(0,0,0,0.5)'
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
        <button data-act="show-badges" style="flex:1;padding:6px;background:#8b5cf6;color:#fff;border:none;border-radius:4px;cursor:pointer;">显示标注</button>
        <button data-act="hide-badges" style="flex:1;padding:6px;background:#4b5563;color:#fff;border:none;border-radius:4px;cursor:pointer;">取消标注</button>
      </div>

      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <input data-el="q" placeholder="输入编号查找，例如 P1-42" style="flex:1;background:#111;border:1px solid #444;color:#eee;padding:6px 8px;border-radius:4px;font-family:monospace;" />
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
            else if (act === 'show-badges') showBadges();
            else if (act === 'hide-badges') hideBadges();
            else if (act === 'find') await doFind();
            else if (act === 'refresh') await refreshPages();
            else if (act === 'export-json') await exportAll('json');
            else if (act === 'export-tsv') await exportAll('tsv');
        });

        panelEl.querySelector('[data-el="q"]').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); doFind(); }
        });

        return panelEl;
    }

    async function doExtract() {
        const pidInput = panelEl.querySelector('[data-el="pid"]');
        const userPid = pidInput.value.trim().toUpperCase();

        await loadStore();
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
        renderBadges();   // 内部会检查 badgesVisible
        updatePanel();

        const hidden = lastScanTotal - annotations.length;
        setResult(
            `✅ 已提取 ${annotations.length} 条可见文本并存入 ${pageId}\n` +
            `（DOM 中命中 ${lastScanTotal} 条，过滤隐藏/空壳 ${hidden} 条）\n` +
            `当前徽标：${badgesVisible ? '显示中' : '已隐藏（可点"显示标注"恢复）'}`
        );
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
        if (!panelEl) return;
        panelEl.querySelector('[data-el="result"]').textContent = text;
    }

    async function refreshPages() {
        await loadStore();
        const el = panelEl.querySelector('[data-el="pages"]');
        if (!el) return;
        const ids = Object.keys(pagesStore).sort(
            (a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)
        );
        if (!ids.length) { el.textContent = '（暂无）'; return; }
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
            for (const id of ids) for (const t of pagesStore[id].texts) {
                data.push({
                    id: t.id, pageId: t.pageId, textId: t.textId,
                    type: t.type, text: t.text, translation: ''
                });
            }
            content = JSON.stringify(data, null, 2);
            filename = 'maurice_all.json';
            mime = 'application/json';
        } else {
            const lines = ['id\ttype\ttext'];
            for (const id of ids) for (const t of pagesStore[id].texts) {
                lines.push(`${t.id}\t${t.type}\t${t.text.replace(/\t/g, ' ')}`);
            }
            content = lines.join('\n');
            filename = 'maurice_all.tsv';
            mime = 'text/tab-separated-values';
        }
        const blob = new Blob([content], { type: mime + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    }

    function updatePanel() {
        if (!panelEl) return;
        panelEl.querySelector('[data-el="pid"]').value = pageId || '';
        // 根据当前状态给按钮上/下色，让用户知道处于哪一档
        const showBtn = panelEl.querySelector('[data-act="show-badges"]');
        const hideBtn = panelEl.querySelector('[data-act="hide-badges"]');
        if (showBtn && hideBtn) {
            if (badgesVisible) {
                showBtn.style.background = '#8b5cf6';
                showBtn.style.opacity = '0.55';
                hideBtn.style.background = '#4b5563';
                hideBtn.style.opacity = '1';
            } else {
                showBtn.style.background = '#8b5cf6';
                showBtn.style.opacity = '1';
                hideBtn.style.background = '#4b5563';
                hideBtn.style.opacity = '0.55';
            }
        }
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
            `[Maurice] 已加载，当前页 ${pageId}，可见文本 ${annotations.length} 条 / DOM 命中 ${lastScanTotal} 条`
        );
    })();
})();