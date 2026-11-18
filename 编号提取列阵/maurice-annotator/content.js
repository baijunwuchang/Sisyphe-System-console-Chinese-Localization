(function() {
    if (window.__mauriceAnnoLoaded) return;
    window.__mauriceAnnoLoaded = true;

    // ============================================================
    // 配置
    // ============================================================
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META']);
    const DOC_CLASS_RE = /markdown|manual|doc-|docs-|article|prose|readme|guide|help-|text-?panel|content-?body/i;
    const EDITOR_CONTAINER_RE = /monaco-editor|CodeMirror|ace_editor|ace_text|cm-editor|script-?editor|code-?area|editor-?container/i;
    const KOREAN_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;
    const ENGLISH_RE = /[A-Za-z]/;
    const INVISIBLE_CHARS_RE = /[\u200B-\u200D\uFEFF\u00AD\u2060]/g;
    const MIN_RECT_WIDTH = 4;
    const MIN_RECT_HEIGHT = 6;
    const CUSTOM_DICT_NAME = 'custom';

    // ============================================================
    // 状态
    // ============================================================
    let annotations = [];
    let pageId = null;
    let pageIdMap = {};
    let pagesStore = {};
    let pageCounter = 0;

    // 词库系统
    let dicts = {};        // { name: { name, description, global, perPage } }
    let activeDicts = [];  // 启用中的词库 name 数组，越靠后优先级越高

    const replacedNodes = new WeakSet();
    let replaceObserver = null;

    let overlayEl = null;
    let badgeItems = [];
    let badgesVisible = true;

    let panelEl = null;
    let panelVisible = false;
    let highlightTimer = null;
    let highlightEls = [];

    let visibleCache = new WeakMap();
    let lastScanTotal = 0;
    let lastReplaceCount = 0;

    // ============================================================
    // 存储
    // ============================================================
    async function loadStore() {
        const d = await chrome.storage.local.get([
            'pageIdMap', 'pageCounter', 'pages', 'dicts', 'activeDicts'
        ]);
        pageIdMap = d.pageIdMap || {};
        pageCounter = d.pageCounter || 0;
        pagesStore = d.pages || {};
        dicts = d.dicts || {};
        activeDicts = d.activeDicts || [];

        // 首次使用时初始化内置 custom 词库
        if (!dicts[CUSTOM_DICT_NAME]) {
            dicts[CUSTOM_DICT_NAME] = {
                name: CUSTOM_DICT_NAME,
                description: '面板内即时保存的翻译',
                global: {},
                perPage: {}
            };
        }
        if (!activeDicts.includes(CUSTOM_DICT_NAME)) {
            activeDicts.push(CUSTOM_DICT_NAME);
        }
        await saveStore();
    }
    async function saveStore() {
        await chrome.storage.local.set({
            pageIdMap, pageCounter, pages: pagesStore, dicts, activeDicts
        });
    }
    async function saveDictsOnly() {
        await chrome.storage.local.set({ dicts, activeDicts });
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
    // 可见性 / 文本清洗 / 类型判断
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
                    cur = cur.parentElement; d++;
                }
            }
            if (visible) {
                const r = el.getBoundingClientRect();
                if (r.width < 1 || r.height < 1) visible = false;
            }
        } catch (_) { visible = true; }
        visibleCache.set(el, visible);
        return visible;
    }

    function cleanText(raw) {
        return raw.replace(INVISIBLE_CHARS_RE, '').trim();
    }

    function getTextType(node) {
        // 1) 先向上找文档/手册容器，命中视为 UI
        let cur = node.parentElement, d = 0;
        while (cur && d < 30) {
            const cls = typeof cur.className === 'string' ? cur.className : (cur.className && cur.className.baseVal) || '';
            if (DOC_CLASS_RE.test(cls)) return 'ui';
            cur = cur.parentElement; d++;
        }

        // 2) 再判断编辑器特征（只排除真正的输入框和游戏代码编辑区）
        let el = node.parentElement, depth = 0;
        while (el && depth < 30) {
            if (el.tagName === 'TEXTAREA') return 'code';
            if (el.isContentEditable) return 'code';

            const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
            if (cls) {
                // 只拦截真正的编辑器容器
                if (EDITOR_CONTAINER_RE.test(cls)) return 'code';
                // 🔑 删除了对 TOKEN_CLASS_RE 的拦截，允许翻译终端日志里的高亮文本
            }

            // CODE / PRE 只有在没有文档容器祖先时才当代码
            if (el.tagName === 'CODE' || el.tagName === 'PRE') {
                let p = el.parentElement, d3 = 0;
                while (p && d3 < 10) {
                    const pcls = typeof p.className === 'string' ? p.className : (p.className && p.className.baseVal) || '';
                    if (DOC_CLASS_RE.test(pcls)) return 'ui';
                    p = p.parentElement; d3++;
                }
                // 如果是终端日志，有时候外层是 pre，但通常里面会有特殊结构
                // 为了避免终端日志被跳过，如果不确定，这里返回 ui
                // （注：如果这里误放行了代码区，玩家在代码区看到的韩文会被替换导致无法运行，
                // 但通常代码区会带有 monaco/CodeMirror 等 class，已被上面的正则拦截）
                return 'ui';
            }
            el = el.parentElement; depth++;
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
            document.body, NodeFilter.SHOW_TEXT,
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
                pageId, textId,
                type: getTextType(node),
                text: t,
                node
            });
        }
        return list;
    }

    async function extractAndSave() {
        await loadStore();
        if (!pageId || pageIdMap[urlKey()] !== pageId) await resolvePageId(false);
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
    // 词库查找
    // ============================================================
    function lookupTranslation(original, pid) {
        // 1) 所有启用词库中的 perPage 匹配（后启用的优先）
        for (let i = activeDicts.length - 1; i >= 0; i--) {
            const d = dicts[activeDicts[i]];
            if (!d || !d.perPage) continue;
            const pg = d.perPage[pid];
            if (pg && pg[original] !== undefined) return pg[original];
        }
        // 2) 所有启用词库中的 global 匹配（后启用的优先）
        for (let i = activeDicts.length - 1; i >= 0; i--) {
            const d = dicts[activeDicts[i]];
            if (!d || !d.global) continue;
            if (d.global[original] !== undefined) return d.global[original];
        }
        return null;
    }

    // ============================================================
    // 替换核心
    // ============================================================
    function replaceNode(node) {
        if (replacedNodes.has(node)) return false;
        const raw = node.textContent || '';
        const t = cleanText(raw);
        if (!t) return false;
        const translated = lookupTranslation(t, pageId);
        if (translated === null) return false;
        const leading = raw.match(/^\s*/)[0];
        const trailing = raw.match(/\s*$/)[0];
        node.textContent = leading + translated + trailing;
        replacedNodes.add(node);
        return true;
    }

    function replaceAll(root = document.body) {
        let count = 0;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(n) {
                const p = n.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        let node;
        while ((node = walker.nextNode())) {
            const t = cleanText(node.textContent || '');
            if (!t) continue;
            if (getTextType(node) === 'code') {
                replacedNodes.add(node);
                continue;
            }
            if (replaceNode(node)) count++;
        }
        return count;
    }

    function applyTranslation() {
        lastReplaceCount = replaceAll(document.body);
        return lastReplaceCount;
    }

    function startReplaceObserver() {
        if (replaceObserver) replaceObserver.disconnect();
        replaceObserver = new MutationObserver((muts) => {
            let changed = false;
            for (const m of muts) {
                for (const n of m.addedNodes) {
                    if (n.nodeType === Node.ELEMENT_NODE) {
                        if (replaceAll(n) > 0) changed = true;
                    } else if (n.nodeType === Node.TEXT_NODE) {
                        const t = cleanText(n.textContent || '');
                        if (!t) continue;
                        if (getTextType(n) === 'code') continue;
                        if (replaceNode(n)) changed = true;
                    }
                }
            }
            if (changed && badgesVisible) repositionBadges();
        });
        replaceObserver.observe(document.body, { childList: true, subtree: true });
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
        if (!badgesVisible || !annotations.length) return;
        overlayEl = document.createElement('div');
        Object.assign(overlayEl.style, {
            position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483646'
        });
        document.documentElement.appendChild(overlayEl);

        for (const a of annotations) {
            if (!a.node || !a.node.isConnected) continue;
            const rect = getFirstRect(a.node);
            if (!rect) continue;
            const badge = document.createElement('div');
            badge.textContent = a.id;
            Object.assign(badge.style, {
                position: 'absolute',
                background: a.type === 'code' ? '#e11d48' : '#2563eb',
                color: '#fff', fontSize: '10px', padding: '1px 4px',
                borderRadius: '3px', fontFamily: 'monospace',
                whiteSpace: 'nowrap', pointerEvents: 'auto', cursor: 'pointer',
                userSelect: 'none'
            });
            badge.addEventListener('click', (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                highlightNode(a.node);
                setResult(`已定位：${a.text}`);
            });
            placeBadge(badge, rect);
            overlayEl.appendChild(badge);
            badgeItems.push({ badge, node: a.node, annotation: a });
        }
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
    function showBadges() { badgesVisible = true; renderBadges(); updatePanel(); }
    function hideBadges() { badgesVisible = false; clearBadges(); updatePanel(); }

    // ============================================================
    // 高亮
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
        if (!node || !node.isConnected) return false;
        const rects = getValidRects(node);
        if (!rects.length) return false;
        for (const r of rects) {
            const hl = document.createElement('div');
            Object.assign(hl.style, {
                position: 'absolute',
                left: (r.left + window.scrollX) + 'px',
                top: (r.top + window.scrollY) + 'px',
                width: r.width + 'px', height: r.height + 'px',
                background: 'rgba(250, 204, 21, 0.45)',
                outline: '2px solid #f59e0b',
                pointerEvents: 'none', zIndex: '2147483645', borderRadius: '2px'
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

        if (targetPage === pageId) {
            if (!annotations.length) annotations = extractAll();
            const a = annotations.find(x => x.textId === targetTid);
            if (!a) return { ok: false, msg: `当前页 (${pageId}) 没有编号 ${targetTid}` };
            const ok = highlightNode(a.node);
            return {
                ok, type: 'current',
                msg: ok ? `已定位：${a.text}` : `找到了 ${a.id}，但当前视口中没有有效几何位置`,
                annotation: a
            };
        }

        await loadStore();
        const pg = pagesStore[targetPage];
        if (!pg) return { ok: false, msg: `还没有记录页面 ${targetPage}，请先去那页按 F1 提取` };
        const entry = pg.texts.find(t => t.textId === targetTid);
        if (!entry) return { ok: false, msg: `页面 ${targetPage} 没有编号 ${targetTid}` };
        return {
            ok: true, type: 'other',
            msg: `该词不在当前页。\n页面：${targetPage}\n标题：${pg.title || '(无)'}\nURL：${pg.url}\n原文：${entry.text}\n请切换到该页面后按 F1 重新提取`,
            annotation: entry
        };
    }

    // ============================================================
    // 词库操作
    // ============================================================
    function ensureCustomDict() {
        if (!dicts[CUSTOM_DICT_NAME]) {
            dicts[CUSTOM_DICT_NAME] = {
                name: CUSTOM_DICT_NAME,
                description: '面板内即时保存的翻译',
                global: {},
                perPage: {}
            };
        }
        if (!activeDicts.includes(CUSTOM_DICT_NAME)) activeDicts.push(CUSTOM_DICT_NAME);
    }

    async function saveCustomTranslation(original, translated, scope) {
        await loadStore();
        ensureCustomDict();
        const d = dicts[CUSTOM_DICT_NAME];
        if (!d.global) d.global = {};
        if (!d.perPage) d.perPage = {};

        if (scope === 'page') {
            if (!d.perPage[pageId]) d.perPage[pageId] = {};
            if (translated === '') delete d.perPage[pageId][original];
            else d.perPage[pageId][original] = translated;
        } else {
            if (translated === '') delete d.global[original];
            else d.global[original] = translated;
        }
        await saveDictsOnly();
        return applyTranslation();
    }

    async function importDictFromFile(file) {
        const text = await file.text();
        let data;
        try { data = JSON.parse(text); }
        catch (e) { throw new Error('不是有效的 JSON 文件'); }

        if (!data || typeof data !== 'object') throw new Error('文件内容不是对象');
        if (!data.name) throw new Error('缺少 name 字段');
        if (data.global && typeof data.global !== 'object') throw new Error('global 必须是对象');
        if (data.perPage && typeof data.perPage !== 'object') throw new Error('perPage 必须是对象');

        const key = String(data.name);
        const isOverwrite = !!dicts[key];

        dicts[key] = {
            name: key,
            description: data.description || '',
            version: data.version || '',
            author: data.author || '',
            global: data.global || {},
            perPage: data.perPage || {}
        };
        if (!activeDicts.includes(key)) activeDicts.push(key);
        await saveDictsOnly();
        return { key, isOverwrite };
    }

    async function toggleDict(name, enabled) {
        await loadStore();
        const idx = activeDicts.indexOf(name);
        if (enabled && idx === -1) activeDicts.push(name);
        else if (!enabled && idx !== -1) activeDicts.splice(idx, 1);
        await saveDictsOnly();
    }

    async function deleteDict(name) {
        await loadStore();
        if (name === CUSTOM_DICT_NAME) return false;
        delete dicts[name];
        const idx = activeDicts.indexOf(name);
        if (idx !== -1) activeDicts.splice(idx, 1);
        await saveDictsOnly();
        return true;
    }

    function countDictWords(d) {
        let n = Object.keys(d.global || {}).length;
        for (const pid of Object.keys(d.perPage || {})) {
            n += Object.keys(d.perPage[pid]).length;
        }
        return n;
    }

    // ============================================================
    // 面板
    // ============================================================
    function buildPanel() {
        if (panelEl) return panelEl;
        panelEl = document.createElement('div');
        Object.assign(panelEl.style, {
            position: 'fixed', right: '16px', top: '16px', width: '500px', maxHeight: '90vh',
            overflow: 'hidden', display: 'flex', flexDirection: 'column',
            background: '#1e1e1e', color: '#eee',
            fontFamily: 'system-ui, sans-serif', fontSize: '12px',
            border: '1px solid #444', borderRadius: '8px', padding: '12px',
            zIndex: '2147483647', boxShadow: '0 4px 24px rgba(0,0,0,0.5)'
        });

        panelEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="font-size:13px;">Maurice 标注 / 汉化</strong>
        <button data-act="close" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:16px;">×</button>
      </div>

      <div style="flex:1;overflow-y:auto;padding-right:4px;">
        <!-- 页面 & 提取 -->
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <label style="flex:1;display:flex;align-items:center;gap:4px;">
            <span style="color:#aaa;white-space:nowrap;">当前页号</span>
            <input data-el="pid" value="" style="flex:1;background:#111;border:1px solid #444;color:#eee;padding:4px 6px;border-radius:4px;font-family:monospace;" />
          </label>
          <button data-act="extract" style="padding:4px 8px;background:#3b82f6;color:#fff;border:none;border-radius:4px;cursor:pointer;white-space:nowrap;">提取并保存</button>
          <button data-act="newpage" style="padding:4px 8px;background:#f59e0b;color:#fff;border:none;border-radius:4px;cursor:pointer;white-space:nowrap;">分配新页号</button>
        </div>

        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <button data-act="show-badges" style="flex:1;padding:6px;background:#8b5cf6;color:#fff;border:none;border-radius:4px;cursor:pointer;">显示标注</button>
          <button data-act="hide-badges" style="flex:1;padding:6px;background:#4b5563;color:#fff;border:none;border-radius:4px;cursor:pointer;">取消标注</button>
          <button data-act="apply-all" style="flex:1;padding:6px;background:#059669;color:#fff;border:none;border-radius:4px;cursor:pointer;">应用全部翻译</button>
        </div>

        <!-- 查找 -->
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <input data-el="q" placeholder="输入编号，例如 P1-42" style="flex:1;background:#111;border:1px solid #444;color:#eee;padding:6px 8px;border-radius:4px;font-family:monospace;" />
          <button data-act="find" style="padding:6px 12px;background:#10b981;color:#fff;border:none;border-radius:4px;cursor:pointer;">查找</button>
        </div>

        <div data-el="result" style="margin-bottom:8px;padding:8px;background:#111;border-radius:4px;min-height:36px;color:#aaa;white-space:pre-wrap;font-size:11px;line-height:1.5;"></div>

        <!-- 翻译编辑 -->
        <div style="background:#111;border-radius:4px;padding:8px;margin-bottom:10px;">
          <div style="color:#aaa;font-size:11px;margin-bottom:4px;">翻译编辑（保存到内置 custom 词库）</div>
          <div style="display:flex;gap:4px;margin-bottom:4px;">
            <input data-el="src" placeholder="原文（自动填入或手动输入）" style="flex:1;background:#1a1a1a;border:1px solid #444;color:#eee;padding:4px 6px;border-radius:4px;font-family:monospace;font-size:11px;" />
          </div>
          <div style="display:flex;gap:4px;margin-bottom:4px;">
            <input data-el="dst" placeholder="译文" style="flex:1;background:#1a1a1a;border:1px solid #444;color:#eee;padding:4px 6px;border-radius:4px;font-family:monospace;font-size:11px;" />
          </div>
          <div style="display:flex;gap:4px;">
            <button data-act="save-global" style="flex:1;padding:5px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">保存为全局</button>
            <button data-act="save-page" style="flex:1;padding:5px;background:#7c3aed;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">保存为当前页</button>
            <button data-act="del-trans" style="flex:1;padding:5px;background:#b91c1c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">删除</button>
          </div>
        </div>

        <!-- 词库管理 -->
        <div style="background:#111;border-radius:4px;padding:8px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="color:#aaa;font-size:11px;">词库管理（☑ = 启用）</span>
            <button data-act="import-dict" style="padding:3px 8px;background:#0ea5e9;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">导入词库文件</button>
          </div>
          <div data-el="dicts" style="max-height:180px;overflow:auto;font-family:monospace;font-size:11px;line-height:1.6;"></div>
          <div style="display:flex;gap:4px;margin-top:6px;">
            <button data-act="export-all-dicts" style="flex:1;padding:5px;background:#0891b2;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">导出全部启用词库</button>
          </div>
          <input data-el="file" type="file" accept=".json,application/json" style="display:none;" />
        </div>

        <!-- 页面列表 -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="color:#aaa;font-size:11px;">已提取页面</span>
          <button data-act="refresh" style="background:none;border:none;color:#888;cursor:pointer;font-size:11px;">刷新</button>
        </div>
        <div data-el="pages" style="max-height:140px;overflow:auto;background:#111;border-radius:4px;padding:6px;font-family:monospace;font-size:11px;line-height:1.6;margin-bottom:8px;"></div>

        <div style="display:flex;gap:6px;">
          <button data-act="export-json" style="flex:1;padding:6px;background:#10b981;color:#fff;border:none;border-radius:4px;cursor:pointer;">导出文本+翻译 JSON</button>
          <button data-act="export-tsv" style="flex:1;padding:6px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;">导出文本 TSV</button>
        </div>
      </div>
    `;

        document.documentElement.appendChild(panelEl);

        // 点击事件
        panelEl.addEventListener('click', async (e) => {
            const dictExportBtn = e.target.closest('[data-dict-export]');
            if (dictExportBtn) {
                await exportSingleDict(dictExportBtn.dataset.dictExport);
                return;
            }
            const dictDelBtn = e.target.closest('[data-dict-del]');
            if (dictDelBtn) {
                const name = dictDelBtn.dataset.dictDel;
                if (confirm(`确定删除词库「${name}」？\n已替换的文本需要刷新页面后恢复原文。`)) {
                    await deleteDict(name);
                    updatePanel();
                }
                return;
            }

            const btn = e.target.closest('button');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'close') hidePanel();
            else if (act === 'extract') await doExtract();
            else if (act === 'newpage') await doNewPage();
            else if (act === 'show-badges') showBadges();
            else if (act === 'hide-badges') hideBadges();
            else if (act === 'apply-all') await doApplyAll();
            else if (act === 'find') await doFind();
            else if (act === 'refresh') await refreshPages();
            else if (act === 'save-global') await doSaveTrans('global');
            else if (act === 'save-page') await doSaveTrans('page');
            else if (act === 'del-trans') await doDelTrans();
            else if (act === 'import-dict') panelEl.querySelector('[data-el="file"]').click();
            else if (act === 'export-all-dicts') await exportAllEnabledDicts();
            else if (act === 'export-json') await exportAll('json');
            else if (act === 'export-tsv') await exportAll('tsv');
        });

        // 词库 checkbox
        panelEl.addEventListener('change', async (e) => {
            const cb = e.target.closest('[data-dict-toggle]');
            if (cb) {
                await toggleDict(cb.dataset.dictToggle, cb.checked);
                const n = applyTranslation();
                setResult(`词库已${cb.checked ? '启用' : '禁用'}，本次应用替换 ${n} 个节点\n（已替换的文本需刷新页面后才会恢复原文）`);
                updatePanel();
            }
        });

        // 文件导入
        panelEl.querySelector('[data-el="file"]').addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            try {
                const { key, isOverwrite } = await importDictFromFile(file);
                const n = applyTranslation();
                setResult(
                    `已导入词库「${key}」${isOverwrite ? '（覆盖同名）' : ''}\n` +
                    `本次替换 ${n} 个节点`
                );
                updatePanel();
            } catch (err) {
                setResult(`导入失败：${err.message}`);
            } finally {
                e.target.value = '';
            }
        });

        panelEl.querySelector('[data-el="q"]').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); doFind(); }
        });
        panelEl.querySelector('[data-el="dst"]').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); doSaveTrans('global'); }
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
        renderBadges();
        updatePanel();
        const hidden = lastScanTotal - annotations.length;
        setResult(
            `✅ 已提取 ${annotations.length} 条可见文本并存入 ${pageId}\n` +
            `（DOM 中命中 ${lastScanTotal} 条，过滤隐藏/空壳 ${hidden} 条）`
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
        if (res.annotation) {
            panelEl.querySelector('[data-el="src"]').value = res.annotation.text;
            const t = lookupTranslation(res.annotation.text, pageId);
            panelEl.querySelector('[data-el="dst"]').value = t || '';
        }
    }

    async function doApplyAll() {
        await loadStore();
        const n = applyTranslation();
        setResult(`已应用翻译：替换 ${n} 个文本节点（代码区域不替换）`);
    }

    async function doSaveTrans(scope) {
        const src = panelEl.querySelector('[data-el="src"]').value.trim();
        const dst = panelEl.querySelector('[data-el="dst"]').value.trim();
        if (!src) { setResult('请填写原文'); return; }
        if (!dst) { setResult('请填写译文，删除请用"删除"按钮'); return; }
        const n = await saveCustomTranslation(src, dst, scope);
        setResult(
            `已保存到 custom 词库（${scope === 'page' ? '当前页专属' : '全局'}）：\n${src}\n→ ${dst}\n` +
            `本次替换 ${n} 个节点`
        );
        updatePanel();
    }

    async function doDelTrans() {
        const src = panelEl.querySelector('[data-el="src"]').value.trim();
        if (!src) { setResult('请填写要删除的原文'); return; }
        await saveCustomTranslation(src, '', 'global');
        await saveCustomTranslation(src, '', 'page');
        setResult(`已从 custom 词库删除：${src}\n（已替换的文本需刷新页面才能恢复原文）`);
        updatePanel();
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
        <span style="color:#888;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeAttr(p.url)}">${escapeHtml(p.title || p.url)}</span>
        <span style="color:#f59e0b;flex-shrink:0;">${p.texts.length}条</span>
      </div>`;
        }).join('');
    }

    function renderDictList() {
        if (!panelEl) return;
        const el = panelEl.querySelector('[data-el="dicts"]');
        if (!el) return;
        const names = Object.keys(dicts);
        if (!names.length) { el.textContent = '（暂无词库）'; return; }
        el.innerHTML = names.map(name => {
            const d = dicts[name];
            const count = countDictWords(d);
            const checked = activeDicts.includes(name) ? 'checked' : '';
            const isCustom = name === CUSTOM_DICT_NAME;
            const desc = d.description || '';
            const label = isCustom ? '内置自定义' : name;
            return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid #2a2a2a;">
        <input type="checkbox" data-dict-toggle="${escapeAttr(name)}" ${checked} style="cursor:pointer;" />
        <span style="flex:1;color:#eee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeAttr(desc || label)}">
          ${escapeHtml(label)}${desc ? `<span style="color:#666;"> · ${escapeHtml(desc)}</span>` : ''}
        </span>
        <span style="color:#f59e0b;font-size:10px;white-space:nowrap;">${count}词</span>
        <button data-dict-export="${escapeAttr(name)}" style="background:none;border:none;color:#60a5fa;cursor:pointer;font-size:10px;">导出</button>
        ${isCustom ? '' : `<button data-dict-del="${escapeAttr(name)}" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:10px;">删除</button>`}
      </div>`;
        }).join('');
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
        );
    }
    function escapeAttr(s) {
        return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
        );
    }

    // ============================================================
    // 导出
    // ============================================================
    async function exportAll(kind) {
        await loadStore();
        const ids = Object.keys(pagesStore).sort(
            (a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)
        );
        let content, filename, mime;
        if (kind === 'json') {
            const data = [];
            for (const id of ids) for (const t of pagesStore[id].texts) {
                const translated = lookupTranslation(t.text, id) || '';
                data.push({
                    id: t.id, pageId: t.pageId, textId: t.textId,
                    type: t.type, text: t.text, translation: translated
                });
            }
            content = JSON.stringify(data, null, 2);
            filename = 'maurice_texts.json';
            mime = 'application/json';
        } else {
            const lines = ['id\ttype\ttext\ttranslation'];
            for (const id of ids) for (const t of pagesStore[id].texts) {
                const translated = lookupTranslation(t.text, id) || '';
                lines.push(`${t.id}\t${t.type}\t${t.text.replace(/\t/g, ' ')}\t${translated.replace(/\t/g, ' ')}`);
            }
            content = lines.join('\n');
            filename = 'maurice_texts.tsv';
            mime = 'text/tab-separated-values';
        }
        downloadFile(content, filename, mime);
    }

    async function exportSingleDict(name) {
        await loadStore();
        const d = dicts[name];
        if (!d) return;
        const payload = {
            format: 'maurice-dict',
            version: '1.0',
            name: d.name,
            description: d.description || '',
            author: d.author || '',
            global: d.global || {},
            perPage: d.perPage || {}
        };
        downloadFile(
            JSON.stringify(payload, null, 2),
            `dict_${name}.json`,
            'application/json'
        );
    }

    async function exportAllEnabledDicts() {
        await loadStore();
        const mergedGlobal = {};
        const mergedPerPage = {};
        for (const name of activeDicts) {
            const d = dicts[name];
            if (!d) continue;
            Object.assign(mergedGlobal, d.global || {});
            for (const pid of Object.keys(d.perPage || {})) {
                if (!mergedPerPage[pid]) mergedPerPage[pid] = {};
                Object.assign(mergedPerPage[pid], d.perPage[pid]);
            }
        }
        const payload = {
            format: 'maurice-dict',
            version: '1.0',
            name: 'merged_all',
            description: `合并了 ${activeDicts.length} 个启用词库`,
            global: mergedGlobal,
            perPage: mergedPerPage
        };
        downloadFile(
            JSON.stringify(payload, null, 2),
            'dict_merged_all.json',
            'application/json'
        );
    }

    function downloadFile(content, filename, mime) {
        const blob = new Blob([content], { type: mime + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    }

    // ============================================================
    // 面板状态
    // ============================================================
    function updatePanel() {
        if (!panelEl) return;
        panelEl.querySelector('[data-el="pid"]').value = pageId || '';
        const showBtn = panelEl.querySelector('[data-act="show-badges"]');
        const hideBtn = panelEl.querySelector('[data-act="hide-badges"]');
        if (showBtn && hideBtn) {
            if (badgesVisible) {
                showBtn.style.opacity = '0.55'; hideBtn.style.opacity = '1';
            } else {
                showBtn.style.opacity = '1'; hideBtn.style.opacity = '0.55';
            }
        }
        renderDictList();
        refreshPages();
    }

    function showPanel() { buildPanel(); panelEl.style.display = 'flex'; panelVisible = true; updatePanel(); }
    function hidePanel() { if (panelEl) panelEl.style.display = 'none'; panelVisible = false; }
    function togglePanel() { panelVisible ? hidePanel() : showPanel(); }

    // ============================================================
    // F1 / 消息
    // ============================================================
    document.addEventListener('keydown', (e) => {
        if (e.key === 'F1') { e.preventDefault(); e.stopPropagation(); togglePanel(); }
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
        applyTranslation();
        annotations = extractAll();
        startReplaceObserver();
        console.log(
            `[Maurice] 已加载，当前页 ${pageId}，可见文本 ${annotations.length} 条，` +
            `词库 ${Object.keys(dicts).length} 个（启用 ${activeDicts.length}）`
        );
    })();
})();