(function() {
    // 防止重复注入，费性能
    if (window.__mauriceAnnoLoaded) return;
    window.__mauriceAnnoLoaded = true;

    // ===== 一些常量和规则 =====
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META']);
    const DOC_CLASS_RE = /markdown|manual|doc-|docs-|article|prose|readme|guide|help-|text-?panel|content-?body/i;
    const EDITOR_CONTAINER_RE = /monaco-editor|CodeMirror|ace_editor|ace_text|cm-editor|script-?editor|code-?area|editor-?container/i;
    const KOREAN_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;
    const ENGLISH_RE = /[A-Za-z]/;
    const INVISIBLE_CHARS_RE = /[\u200B-\u200D\uFEFF\u00AD\u2060]/g;
    const CUSTOM_DICT_NAME = 'custom';

    // ===== 内存状态 =====
    let annotations = []; // 当前页提取出来的所有文本节点信息
    let pageId = null;
    let pageIdMap = {};
    let pagesStore = {};
    let pageCounter = 0;

    let dicts = {}; // 词库
    let activeDicts = []; // 启用的词库
    let compiledRegexes = []; // 用于应对动态数字（比如 {d}일차）的正则

    const replacedNodes = new WeakSet(); // 替换过的节点就不管了，防止死循环
    let replaceObserver = null;

    // 界面元素
    let overlayEl = null; // 标注覆盖层
    let badgeItems = []; // 页面上的小蓝/红块
    let badgesVisible = true;
    let panelEl = null;
    let panelVisible = false;
    let highlightTimer = null;
    let highlightEls = [];

    let visibleCache = new WeakMap();
    let lastScanTotal = 0;
    let lastScanVisible = 0;

    // ===== 数据存取 =====
    async function loadStore() {
        const d = await chrome.storage.local.get([
            'pageIdMap', 'pageCounter', 'pages', 'dicts', 'activeDicts'
        ]);
        pageIdMap = d.pageIdMap || {};
        pageCounter = d.pageCounter || 0;
        pagesStore = d.pages || {};
        dicts = d.dicts || {};
        activeDicts = d.activeDicts || [];

        // 初始化我们自己的词库
        if (!dicts[CUSTOM_DICT_NAME]) {
            dicts[CUSTOM_DICT_NAME] = {
                name: CUSTOM_DICT_NAME,
                description: '面板里随手存的翻译',
                global: {},
                perPage: {}
            };
        }
        if (!activeDicts.includes(CUSTOM_DICT_NAME)) {
            activeDicts.push(CUSTOM_DICT_NAME);
        }
        await saveStore();
        rebuildRegexCache();
    }

    async function saveStore() {
        await chrome.storage.local.set({
            pageIdMap, pageCounter, pages: pagesStore, dicts, activeDicts
        });
    }

    async function saveDictsOnly() {
        await chrome.storage.local.set({ dicts, activeDicts });
        rebuildRegexCache();
    }

    // ===== 页面号分配 =====
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

    // ===== 动态数字处理 (正则缓存) =====
    function rebuildRegexCache() {
        compiledRegexes = [];

        const addRule = (orig, trans) => {
            if (!orig.includes('{d}') && !/\d/.test(orig)) return;

            // 如果原文显式用了 {d}
            if (orig.includes('{d}')) {
                let regStr = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regStr = regStr.replace(/\\\{d\\\}/g, '(\\d+)');
                regStr = '^' + regStr + '$';
                let template = trans;
                let count = 1;
                template = template.replace(/\{d\}/g, () => '$' + (count++));
                try {
                    compiledRegexes.push({ regex: new RegExp(regStr), template: template });
                } catch (e) { }
                return;
            }

            // 如果原文没写 {d}，但混着数字，自动抓数字当占位符
            const numsInOrig = orig.match(/\d+/g);
            if (!numsInOrig) return;

            const parts = orig.split(/(\d+)/);
            let regStr = '^';
            for (const part of parts) {
                if (/^\d+$/.test(part)) {
                    regStr += '(\\d+)';
                } else {
                    regStr += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                }
            }
            regStr += '$';

            let template = trans;
            for (let i = 0; i < numsInOrig.length; i++) {
                const num = numsInOrig[i];
                template = template.replace(num, '$' + (i + 1));
            }

            try {
                compiledRegexes.push({ regex: new RegExp(regStr), template: template });
            } catch (e) { }
        };

        // 把所有启用词库里的规则都捞出来
        for (const dictName of activeDicts) {
            const d = dicts[dictName];
            if (!d) continue;
            for (const [orig, trans] of Object.entries(d.global || {})) addRule(orig, trans);
            if (d.perPage && d.perPage[pageId]) {
                for (const [orig, trans] of Object.entries(d.perPage[pageId])) addRule(orig, trans);
            }
        }
        // 长的优先匹配，免得被短的正则截胡
        compiledRegexes.sort((a, b) => b.regex.source.length - a.regex.source.length);
    }

    // ===== 工具函数 =====
    function isVisible(node) {
        const el = node.parentElement;
        if (!el) return false;
        if (visibleCache.has(el)) return visibleCache.get(el);

        let visible = true;
        try {
            if (typeof el.checkVisibility === 'function') {
                visible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
            } else {
                // 兜底：手动往上查
                let cur = el, d = 0;
                while (cur && d < 40) {
                    let cs;
                    try { cs = getComputedStyle(cur); } catch (_) { break; }
                    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
                        visible = false; break;
                    }
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
        // 除掉那些看不见的零宽字符，免得匹配不上
        return raw.replace(INVISIBLE_CHARS_RE, '').trim();
    }

    // 判断文本是在普通界面里还是在代码编辑器里
    function getTextType(node) {
        // 先看看有没有文档容器的特征（比如手册）
        let cur = node.parentElement, d = 0;
        while (cur && d < 30) {
            const cls = typeof cur.className === 'string' ? cur.className : (cur.className && cur.className.baseVal) || '';
            if (DOC_CLASS_RE.test(cls)) return 'ui';
            cur = cur.parentElement; d++;
        }

        // 再看是不是在编辑器里
        let el = node.parentElement, depth = 0;
        while (el && depth < 30) {
            if (el.tagName === 'TEXTAREA' || el.isContentEditable) return 'code';
            const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
            if (cls && EDITOR_CONTAINER_RE.test(cls)) return 'code';

            // 如果是 pre/code，但外层有手册标记，当普通界面处理
            if (el.tagName === 'CODE' || el.tagName === 'PRE') {
                let p = el.parentElement, d3 = 0;
                while (p && d3 < 10) {
                    const pcls = typeof p.className === 'string' ? p.className : (p.className && p.className.baseVal) || '';
                    if (DOC_CLASS_RE.test(pcls)) return 'ui';
                    p = p.parentElement; d3++;
                }
                return 'ui'; // 放了终端日志一马
            }
            el = el.parentElement; depth++;
        }
        return 'ui';
    }

    // ===== 提取 =====
    function extractAll() {
        visibleCache = new WeakMap();
        lastScanTotal = 0;
        lastScanVisible = 0;
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
            // 只要包含韩文或英文就算，不管隐不隐藏
            if (!KOREAN_RE.test(t) && !ENGLISH_RE.test(t)) continue;

            textId++;
            lastScanTotal++;

            const isVis = isVisible(node);
            if (isVis) lastScanVisible++;

            list.push({
                id: `${pageId}-${textId}`,
                pageId, textId,
                type: getTextType(node),
                text: t,
                node,
                visible: isVis
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

    // ===== 翻译查找与替换 =====
    function lookupTranslation(original, pid) {
        // 1. 查全局和专属词库（精确匹配）
        for (let i = activeDicts.length - 1; i >= 0; i--) {
            const d = dicts[activeDicts[i]];
            if (!d) continue;
            if (d.perPage && d.perPage[pid] && d.perPage[pid][original] !== undefined) {
                return d.perPage[pid][original];
            }
        }
        for (let i = activeDicts.length - 1; i >= 0; i--) {
            const d = dicts[activeDicts[i]];
            if (!d) continue;
            if (d.global && d.global[original] !== undefined) {
                return d.global[original];
            }
        }

        // 2. 查正则（处理动态数字）
        for (const rule of compiledRegexes) {
            const match = original.match(rule.regex);
            if (match) {
                let result = rule.template;
                for (let i = 1; i < match.length; i++) {
                    result = result.split('$' + i).join(match[i]);
                }
                return result;
            }
        }
        return null;
    }

    function replaceNode(node) {
        if (replacedNodes.has(node)) return false;
        const raw = node.textContent || '';
        const t = cleanText(raw);
        if (!t) return false;

        const translated = lookupTranslation(t, pageId);
        if (translated === null) return false;

        // 保留前后的空白，别把排版搞乱了
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

            // 代码区的绝对不碰
            if (getTextType(node) === 'code') {
                replacedNodes.add(node);
                continue;
            }
            if (replaceNode(node)) count++;
        }
        return count;
    }

    function applyTranslation() {
        const count = replaceAll(document.body);
        return count;
    }

    // 监听页面动态生成的内容（比如终端日志跳动）
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
            // 文字变了宽度就会变，徽标位置得重新算
            if (changed && badgesVisible) repositionBadges();
        });
        replaceObserver.observe(document.body, { childList: true, subtree: true });
    }

    // ===== 界面绘图（徽标与高亮） =====
    function getNodeRects(node) {
        if (!node || !node.isConnected) return [];
        try {
            const r = document.createRange();
            r.selectNodeContents(node);
            return Array.from(r.getClientRects());
        } catch (_) { return []; }
    }

    function getValidRects(node) {
        // 太小的就不算了，避免乱标
        return getNodeRects(node).filter(r => r.width >= 4 && r.height >= 6);
    }

    function getFirstRect(node) {
        const rs = getValidRects(node);
        return rs.length ? rs[0] : null;
    }

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
            if (!rect) continue; // 隐藏的文本直接跳过，不画

            const badge = document.createElement('div');
            badge.textContent = a.id;
            Object.assign(badge.style, {
                position: 'absolute',
                background: a.type === 'code' ? '#e11d48' : '#2563eb', // 代码红的，普通蓝的
                color: '#fff', fontSize: '10px', padding: '1px 4px',
                borderRadius: '3px', fontFamily: 'monospace',
                whiteSpace: 'nowrap', pointerEvents: 'auto', cursor: 'pointer',
                userSelect: 'none'
            });
            // 点标直接高亮
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
        if (!rects.length) return false; // 隐藏的文本没有几何位置，高亮不了

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
        if (item) item.badge.style.background = '#f59e0b'; // 被点的高亮成黄标

        highlightTimer = setTimeout(clearHighlight, 4000); // 4秒后自动消失
        return true;
    }

    function showBadges() { badgesVisible = true; renderBadges(); updatePanel(); }
    function hideBadges() { badgesVisible = false; clearBadges(); updatePanel(); }

    // ===== 查找功能 =====
    async function findById(numStr) {
        const m = /^(P\d+)-(\d+)$/i.exec(String(numStr).trim());
        if (!m) return { ok: false, msg: '格式好像不对，应该是 P1-42 这样' };
        const targetPage = m[1].toUpperCase();
        const targetTid = parseInt(m[2], 10);

        if (targetPage === pageId) {
            if (!annotations.length) annotations = extractAll();
            const a = annotations.find(x => x.textId === targetTid);
            if (!a) return { ok: false, msg: `本页 (${pageId}) 没找到编号 ${targetTid}` };

            const ok = highlightNode(a.node);
            if (ok) {
                return { ok: true, type: 'current', msg: `已定位：${a.text}`, annotation: a };
            } else {
                return {
                    ok: true, type: 'hidden',
                    msg: `找到了 ${a.id}：\n"${a.text}"\n\n⚠️ 它现在被隐藏了（页面上看不见），没法高亮。\n不过你可以直接在下面填翻译。`,
                    annotation: a
                };
            }
        }

        // 找其他页的
        await loadStore();
        const pg = pagesStore[targetPage];
        if (!pg) return { ok: false, msg: `还没抓过页面 ${targetPage}，先去那页按 F1 提取一下吧` };
        const entry = pg.texts.find(t => t.textId === targetTid);
        if (!entry) return { ok: false, msg: `页面 ${targetPage} 里没找到编号 ${targetTid}` };
        return {
            ok: true, type: 'other',
            msg: `词在别的页面哦：\n页面：${targetPage}\n标题：${pg.title || '(无)'}\nURL：${pg.url}\n原文：${entry.text}\n切到那页按 F1 就能弄了`,
            annotation: entry
        };
    }

    // ===== 词库管理 =====
    function ensureCustomDict() {
        if (!dicts[CUSTOM_DICT_NAME]) {
            dicts[CUSTOM_DICT_NAME] = { name: CUSTOM_DICT_NAME, description: '面板里随手存的翻译', global: {}, perPage: {} };
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
        catch (e) { throw new Error('这不是个合法的 JSON 文件'); }

        if (!data || typeof data !== 'object' || !data.name) throw new Error('文件里连 name 都没有');

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
        if (name === CUSTOM_DICT_NAME) return false; // 自定义的不让删
        delete dicts[name];
        const idx = activeDicts.indexOf(name);
        if (idx !== -1) activeDicts.splice(idx, 1);
        await saveDictsOnly();
        return true;
    }

    function countDictWords(d) {
        let n = Object.keys(d.global || {}).length;
        for (const pid of Object.keys(d.perPage || {})) n += Object.keys(d.perPage[pid]).length;
        return n;
    }

    // ===== 面板界面 =====
    function buildPanel() {
        if (panelEl) return panelEl;
        panelEl = document.createElement('div');
        Object.assign(panelEl.style, {
            position: 'fixed', right: '16px', top: '16px', width: '500px', maxHeight: '90vh',
            overflow: 'hidden', display: 'flex', flexDirection: 'column',
            background: '#1e1e1e', color: '#eee', fontFamily: 'system-ui, sans-serif',
            fontSize: '12px', border: '1px solid #444', borderRadius: '8px', padding: '12px',
            zIndex: '2147483647', boxShadow: '0 4px 24px rgba(0,0,0,0.5)'
        });

        panelEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="font-size:13px;">Maurice 标注 / 汉化</strong>
        <button data-act="close" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:16px;">×</button>
      </div>

      <div style="flex:1;overflow-y:auto;padding-right:4px;">
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <label style="flex:1;display:flex;align-items:center;gap:4px;">
            <span style="color:#aaa;white-space:nowrap;">页号</span>
            <input data-el="pid" value="" style="flex:1;background:#111;border:1px solid #444;color:#eee;padding:4px 6px;border-radius:4px;font-family:monospace;" />
          </label>
          <button data-act="extract" style="padding:4px 8px;background:#3b82f6;color:#fff;border:none;border-radius:4px;cursor:pointer;white-space:nowrap;">提取并保存</button>
          <button data-act="newpage" style="padding:4px 8px;background:#f59e0b;color:#fff;border:none;border-radius:4px;cursor:pointer;white-space:nowrap;">新页号</button>
        </div>

        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <button data-act="show-badges" style="flex:1;padding:6px;background:#8b5cf6;color:#fff;border:none;border-radius:4px;cursor:pointer;">显示标注</button>
          <button data-act="hide-badges" style="flex:1;padding:6px;background:#4b5563;color:#fff;border:none;border-radius:4px;cursor:pointer;">取消标注</button>
          <button data-act="apply-all" style="flex:1;padding:6px;background:#059669;color:#fff;border:none;border-radius:4px;cursor:pointer;">应用翻译</button>
        </div>

        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <input data-el="q" placeholder="输入编号查词，比如 P1-42" style="flex:1;background:#111;border:1px solid #444;color:#eee;padding:6px 8px;border-radius:4px;font-family:monospace;" />
          <button data-act="find" style="padding:6px 12px;background:#10b981;color:#fff;border:none;border-radius:4px;cursor:pointer;">查找</button>
        </div>

        <div data-el="result" style="margin-bottom:8px;padding:8px;background:#111;border-radius:4px;min-height:36px;color:#aaa;white-space:pre-wrap;font-size:11px;line-height:1.5;"></div>

        <div style="background:#111;border-radius:4px;padding:8px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <span style="color:#aaa;font-size:11px;">翻译编辑</span>
            <span style="color:#f59e0b;font-size:10px;">💡 有数字用 {d} 代替，如 第{d}天</span>
          </div>
          <input data-el="src" placeholder="原文（自动填或手动输）" style="width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #444;color:#eee;padding:4px 6px;border-radius:4px;font-family:monospace;font-size:11px;margin-bottom:4px;" />
          <input data-el="dst" placeholder="译文" style="width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #444;color:#eee;padding:4px 6px;border-radius:4px;font-family:monospace;font-size:11px;margin-bottom:4px;" />
          <div style="display:flex;gap:4px;">
            <button data-act="save-global" style="flex:1;padding:5px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">存全局</button>
            <button data-act="save-page" style="flex:1;padding:5px;background:#7c3aed;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">存本页</button>
            <button data-act="del-trans" style="flex:1;padding:5px;background:#b91c1c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">删除</button>
          </div>
        </div>

        <div style="background:#111;border-radius:4px;padding:8px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="color:#aaa;font-size:11px;">词库列表</span>
            <button data-act="import-dict" style="padding:3px 8px;background:#0ea5e9;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">导入文件</button>
          </div>
          <div data-el="dicts" style="max-height:180px;overflow:auto;font-family:monospace;font-size:11px;line-height:1.6;"></div>
          <div style="display:flex;gap:4px;margin-top:6px;">
            <button data-act="export-all-dicts" style="flex:1;padding:5px;background:#0891b2;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">合并导出启用的词库</button>
          </div>
          <input data-el="file" type="file" accept=".json,application/json" style="display:none;" />
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="color:#aaa;font-size:11px;">抓取过的页面</span>
          <button data-act="refresh" style="background:none;border:none;color:#888;cursor:pointer;font-size:11px;">刷新</button>
        </div>
        <div data-el="pages" style="max-height:140px;overflow:auto;background:#111;border-radius:4px;padding:6px;font-family:monospace;font-size:11px;line-height:1.6;margin-bottom:8px;"></div>

        <div style="display:flex;gap:6px;">
          <button data-act="export-json" style="flex:1;padding:6px;background:#10b981;color:#fff;border:none;border-radius:4px;cursor:pointer;">导出文本+翻译</button>
          <button data-act="export-tsv" style="flex:1;padding:6px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;">导出 TSV</button>
        </div>
      </div>
    `;

        document.documentElement.appendChild(panelEl);

        panelEl.addEventListener('click', async (e) => {
            const dictExportBtn = e.target.closest('[data-dict-export]');
            if (dictExportBtn) {
                await exportSingleDict(dictExportBtn.dataset.dictExport);
                return;
            }
            const dictDelBtn = e.target.closest('[data-dict-del]');
            if (dictDelBtn) {
                const name = dictDelBtn.dataset.dictDel;
                if (confirm(`确定把词库「${name}」删了？`)) {
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

        panelEl.addEventListener('change', async (e) => {
            const cb = e.target.closest('[data-dict-toggle]');
            if (cb) {
                await toggleDict(cb.dataset.dictToggle, cb.checked);
                const n = applyTranslation();
                setResult(`词库已${cb.checked ? '勾上' : '取消'}，这次替换了 ${n} 个节点\n（变回原文需要刷新页面的）`);
                updatePanel();
            }
        });

        panelEl.querySelector('[data-el="file"]').addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            try {
                const { key, isOverwrite } = await importDictFromFile(file);
                const n = applyTranslation();
                setResult(`词库「${key}」导入成功${isOverwrite ? '（把旧的盖了）' : ''}\n这次替换了 ${n} 个节点`);
                updatePanel();
            } catch (err) {
                setResult(`导入报错：${err.message}`);
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

        const hidden = lastScanTotal - lastScanVisible;
        setResult(
            `✅ 搞定了！共提取 ${annotations.length} 条文本（含隐藏）并存入 ${pageId}\n` +
            `（可见 ${lastScanVisible} 条，隐藏 ${hidden} 条。隐藏的也能改，就是高亮不了）\n` +
            `当前标注：${badgesVisible ? '显示中' : '已隐藏'}`
        );
    }

    async function doNewPage() {
        await loadStore();
        pageCounter += 1;
        pageId = 'P' + pageCounter;
        pageIdMap[urlKey()] = pageId;
        await saveStore();
        panelEl.querySelector('[data-el="pid"]').value = pageId;
        setResult(`分了个新页号：${pageId}\n点"提取并保存"确认一下`);
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
        setResult(`手动扫了一遍，替换了 ${n} 个文本节点（代码区没碰）`);
    }

    async function doSaveTrans(scope) {
        const src = panelEl.querySelector('[data-el="src"]').value.trim();
        const dst = panelEl.querySelector('[data-el="dst"]').value.trim();
        if (!src) { setResult('原文得填一下'); return; }
        if (!dst) { setResult('译文没填，要删的话点删除按钮'); return; }

        const n = await saveCustomTranslation(src, dst, scope);
        setResult(
            `存到 custom 词库了（${scope === 'page' ? '只管这一页' : '全页面生效'}）：\n${src}\n→ ${dst}\n` +
            `顺手替换了 ${n} 个节点`
        );
        updatePanel();
    }

    async function doDelTrans() {
        const src = panelEl.querySelector('[data-el="src"]').value.trim();
        if (!src) { setResult('你想删哪句？先把原文填上'); return; }
        await saveCustomTranslation(src, '', 'global');
        await saveCustomTranslation(src, '', 'page');
        setResult(`从 custom 词库移除了：${src}\n（页面上已经变了的字，得刷新才能恢复）`);
        updatePanel();
    }

    function setResult(text) {
        if (panelEl) panelEl.querySelector('[data-el="result"]').textContent = text;
    }

    async function refreshPages() {
        await loadStore();
        const el = panelEl.querySelector('[data-el="pages"]');
        if (!el) return;
        const ids = Object.keys(pagesStore).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
        if (!ids.length) { el.textContent = '（还没抓过任何页面）'; return; }
        el.innerHTML = ids.map(id => {
            const p = pagesStore[id];
            const cur = id === pageId ? ' ← 当前' : '';
            return `<div style="display:flex;gap:6px;padding:2px 0;border-bottom:1px solid #2a2a2a;">
        <span style="color:#60a5fa;flex-shrink:0;">${id}${cur}</span>
        <span style="color:#888;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeAttr(p.url)}">${escapeHtml(p.title || p.url)}</span>
        <span style="color:#f59e0b;flex-shrink:0;">${p.texts.length} 条</span>
      </div>`;
        }).join('');
    }

    function renderDictList() {
        if (!panelEl) return;
        const el = panelEl.querySelector('[data-el="dicts"]');
        if (!el) return;
        const names = Object.keys(dicts);
        if (!names.length) { el.textContent = '（没词库）'; return; }
        el.innerHTML = names.map(name => {
            const d = dicts[name];
            const count = countDictWords(d);
            const checked = activeDicts.includes(name) ? 'checked' : '';
            const isCustom = name === CUSTOM_DICT_NAME;
            const desc = d.description || '';
            const label = isCustom ? '面板内随手记的' : name;
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
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function escapeAttr(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ===== 导出 =====
    async function exportAll(kind) {
        await loadStore();
        const ids = Object.keys(pagesStore).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
        let content, filename, mime;

        if (kind === 'json') {
            const data = [];
            for (const id of ids) {
                for (const t of pagesStore[id].texts) {
                    const translated = lookupTranslation(t.text, id) || '';
                    data.push({ id: t.id, pageId: t.pageId, textId: t.textId, type: t.type, text: t.text, translation: translated });
                }
            }
            content = JSON.stringify(data, null, 2);
            filename = 'maurice_texts.json';
            mime = 'application/json';
        } else {
            const lines = ['id\ttype\ttext\ttranslation'];
            for (const id of ids) {
                for (const t of pagesStore[id].texts) {
                    const translated = lookupTranslation(t.text, id) || '';
                    lines.push(`${t.id}\t${t.type}\t${t.text.replace(/\t/g, ' ')}\t${translated.replace(/\t/g, ' ')}`);
                }
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
            format: 'maurice-dict', version: '1.0', name: d.name,
            description: d.description || '', author: d.author || '',
            global: d.global || {}, perPage: d.perPage || {}
        };
        downloadFile(JSON.stringify(payload, null, 2), `dict_${name}.json`, 'application/json');
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
            format: 'maurice-dict', version: '1.0', name: 'merged_all',
            description: `合并了 ${activeDicts.length} 个词库`,
            global: mergedGlobal, perPage: mergedPerPage
        };
        downloadFile(JSON.stringify(payload, null, 2), 'dict_merged_all.json', 'application/json');
    }

    function downloadFile(content, filename, mime) {
        const blob = new Blob([content], { type: mime + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    }

    // ===== 面板显隐 =====
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

    // ===== 快捷键与入口 =====
    document.addEventListener('keydown', (e) => {
        if (e.key === 'F1') { e.preventDefault(); e.stopPropagation(); togglePanel(); }
    }, true);

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'toggle') togglePanel();
    });

    // 启动
    (async () => {
        await loadStore();
        await resolvePageId(false);
        applyTranslation(); // 这部分是无脑翻译
        annotations = extractAll(); // 然后把现有文本抓一遍备用
        startReplaceObserver(); // 开启监听，随时翻译动态加进来的东西
    })();
})();