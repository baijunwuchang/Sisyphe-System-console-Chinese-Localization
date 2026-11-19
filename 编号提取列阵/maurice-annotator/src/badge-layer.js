/**
 * 标注层：在页面上画 P?-?? 小徽标，以及点击 / 查找时的高亮框。
 *
 * 只负责“画”，不认识词库和面板。点击徽标通过 onBadgeClick 回调通知外部，
 * 高亮状态自己维护（4 秒后自动清除）。
 */
(function registerBadgeLayer(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.domUtils
     * @param {object} deps.constants
     * @param {(annotation: object) => void} [deps.onBadgeClick]
     */
    function createBadgeLayer({ domUtils, constants, onBadgeClick }) {
        let overlay = null;
        let items = [];
        let annotations = [];
        let visible = true;

        let highlightTimer = null;
        let highlightEls = [];

        function isVisible() {
            return visible;
        }

        function clear() {
            if (overlay) {
                overlay.remove();
                overlay = null;
            }
            items = [];
        }

        /**
         * 重画所有可见文本的徽标。
         * @param {Array<object>} [list] 省略时沿用上一次的提取结果
         */
        function render(list) {
            if (Array.isArray(list)) annotations = list;
            clear();
            if (!visible || !annotations.length) return;

            overlay = document.createElement('div');
            Object.assign(overlay.style, {
                position: 'fixed',
                inset: '0',
                pointerEvents: 'none',
                zIndex: constants.OVERLAY_Z_INDEX
            });
            document.documentElement.appendChild(overlay);

            for (const annotation of annotations) {
                const node = annotation.node;
                if (!node || !node.isConnected) continue;

                const rect = domUtils.getFirstRect(node);
                if (!rect) continue; // 隐藏文本没有几何位置，不画标

                const badge = document.createElement('div');
                badge.textContent = annotation.id;
                Object.assign(badge.style, {
                    position: 'absolute',
                    background: badgeColor(annotation),
                    color: '#fff',
                    fontSize: '10px',
                    padding: '1px 4px',
                    borderRadius: '3px',
                    fontFamily: 'monospace',
                    whiteSpace: 'nowrap',
                    pointerEvents: 'auto',
                    cursor: 'pointer',
                    userSelect: 'none'
                });

                badge.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    highlight(annotation.node);
                    if (typeof onBadgeClick === 'function') onBadgeClick(annotation);
                });

                placeBadge(badge, rect);
                overlay.appendChild(badge);
                items.push({ badge, node, annotation });
            }
        }

        function badgeColor(annotation) {
            return annotation.type === 'code'
                ? constants.COLORS.badgeCode
                : constants.COLORS.badgeUi;
        }

        /**
         * overlay 是 fixed 定位，绝对定位的子元素坐标就是视口坐标，
         * 所以这里不能叠加 scrollX / scrollY。
         */
        function placeBadge(badge, rect) {
            badge.style.left = rect.left + 'px';
            badge.style.top = rect.top + 'px';
            badge.style.transform = 'translateY(-100%)';
        }

        /** 滚动 / 缩放后重新贴徽标（文字宽度变了也要调用） */
        function reposition() {
            if (!visible || !overlay) return;
            for (const item of items) {
                const rect = domUtils.getFirstRect(item.node);
                if (!rect) {
                    item.badge.style.display = 'none';
                    continue;
                }
                item.badge.style.display = '';
                placeBadge(item.badge, rect);
            }
        }

        function clearHighlight() {
            if (highlightTimer) {
                clearTimeout(highlightTimer);
                highlightTimer = null;
            }
            highlightEls.forEach((el) => el.remove());
            highlightEls = [];

            items.forEach((item) => {
                item.badge.style.background = badgeColor(item.annotation);
            });
        }

        function paintRects(rects) {
            for (const rect of rects) {
                const highlightEl = document.createElement('div');
                Object.assign(highlightEl.style, {
                    position: 'absolute',
                    left: rect.left + window.scrollX + 'px',
                    top: rect.top + window.scrollY + 'px',
                    width: rect.width + 'px',
                    height: rect.height + 'px',
                    background: constants.COLORS.highlightFill,
                    outline: '2px solid ' + constants.COLORS.highlightOutline,
                    pointerEvents: 'none',
                    zIndex: constants.HIGHLIGHT_Z_INDEX,
                    borderRadius: '2px'
                });
                document.documentElement.appendChild(highlightEl);
                highlightEls.push(highlightEl);
            }
        }

        function scrollToRect(rect) {
            window.scrollTo({
                top: rect.top + window.scrollY - window.innerHeight / 3,
                behavior: 'smooth'
            });
        }

        /**
         * 高亮多个完整文本节点（例如选区覆盖 1～2 条标注）。
         * @param {Array<Node>} nodes
         * @returns {boolean} 是否至少高亮到一段
         */
        function highlightNodes(nodes) {
            clearHighlight();

            const targets = (nodes || []).filter((node) => node && node.isConnected);
            if (!targets.length) return false;

            const rects = [];
            let firstRect = null;
            for (const node of targets) {
                const nodeRects = domUtils.getValidRects(node);
                if (!nodeRects.length) continue;
                if (!firstRect) firstRect = nodeRects[0];
                rects.push(...nodeRects);
            }
            if (!rects.length) return false;

            paintRects(rects);
            scrollToRect(firstRect);

            for (const node of targets) {
                const item = items.find((entry) => entry.node === node);
                if (item) item.badge.style.background = constants.COLORS.badgeActive;
            }

            highlightTimer = setTimeout(clearHighlight, constants.HIGHLIGHT_DURATION_MS);
            return true;
        }

        /**
         * 只高亮选中的那一段（选区覆盖超过 2 条标注时用）。
         * @param {Range} range
         * @returns {boolean} 是否高亮成功
         */
        function highlightRange(range) {
            clearHighlight();
            if (!range) return false;

            let rects;
            try {
                rects = Array.from(range.getClientRects()).filter(
                    (rect) =>
                        rect.width >= constants.MIN_RECT_WIDTH &&
                        rect.height >= constants.MIN_RECT_HEIGHT
                );
            } catch (_) {
                return false;
            }
            if (!rects.length) return false;

            paintRects(rects);
            scrollToRect(rects[0]);
            highlightTimer = setTimeout(clearHighlight, constants.HIGHLIGHT_DURATION_MS);
            return true;
        }

        /**
         * 高亮单个文本节点（快捷方式）。
         * @returns {boolean} 节点当前是否可见（隐藏文本无法高亮）
         */
        function highlight(node) {
            return highlightNodes([node]);
        }

        function show() {
            visible = true;
            render();
        }

        function hide() {
            visible = false;
            clear();
        }

        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);

        return {
            render,
            clear,
            reposition,
            highlight,
            highlightNodes,
            highlightRange,
            clearHighlight,
            show,
            hide,
            isVisible
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createBadgeLayer = createBadgeLayer;
})(globalThis);
