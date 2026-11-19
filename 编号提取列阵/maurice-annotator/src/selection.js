/**
 * 选区服务：捕获页面文本选区（原生选择 + 右键拖动选择），
 * 并把选区映射到已提取的标注节点。
 *
 * 只处理 DOM 选区，不认识词库、面板和导出。
 */
(function registerSelection(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.constants
     */
    function createSelectionService({ constants }) {
        /** 最后一次有效（非折叠）的页面选区 */
        let lastRange = null;
        let lastText = '';

        /** 右键拖动状态 */
        let rightDrag = null;
        let suppressContextMenu = false;
        let contextMenuTimer = null;

        const listeners = new Set();

        function elementOf(node) {
            if (!node) return null;
            return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        }

        function isPanelNode(node) {
            const el = elementOf(node);
            return !!(el && typeof el.closest === 'function' && el.closest(constants.PANEL_SELECTOR));
        }

        /** 面板、输入框、可编辑区域里不启动右键选择 */
        function isIgnoredTarget(target) {
            const el = elementOf(target);
            if (!el) return false;
            if (typeof el.closest === 'function' && el.closest(constants.PANEL_SELECTOR)) return true;

            const tag = el.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return true;
            if (el.isContentEditable) return true;
            return false;
        }

        function getCurrent() {
            if (!lastRange || !lastRange.toString().trim()) return null;
            return { range: lastRange.cloneRange(), text: lastRange.toString() };
        }

        function hasSelection() {
            return !!getCurrent();
        }

        function clear() {
            lastRange = null;
            lastText = '';
        }

        function notify() {
            const info = getCurrent();
            for (const listener of listeners) {
                try {
                    listener(info);
                } catch (_) {
                    // 监听器自己的错误不影响选区
                }
            }
        }

        /** 记下当前原生选区；折叠时不覆盖，保证点“查找”后选区还在 */
        function rememberSelection() {
            const selection = window.getSelection();
            if (!selection || !selection.rangeCount || selection.isCollapsed) return;

            const range = selection.getRangeAt(0);
            const text = range.toString();
            if (!text.trim()) return;
            if (isPanelNode(range.startContainer) || isPanelNode(range.endContainer)) return;

            lastRange = range.cloneRange();
            if (text !== lastText) {
                lastText = text;
                notify();
            }
        }

        /** 用坐标取一个折叠的 Range（右键拖动的起点 / 终点） */
        function caretRangeAt(x, y) {
            if (typeof document.caretRangeFromPoint === 'function') {
                try {
                    return document.caretRangeFromPoint(x, y);
                } catch (_) {
                    // 继续尝试标准 API
                }
            }

            if (typeof document.caretPositionFromPoint === 'function') {
                try {
                    const position = document.caretPositionFromPoint(x, y);
                    if (!position) return null;
                    const range = document.createRange();
                    range.setStart(position.offsetNode, position.offset);
                    range.collapse(true);
                    return range;
                } catch (_) {
                    // 坐标不在文本上
                }
            }
            return null;
        }

        /** 合并起点 / 终点，自动处理反向拖动 */
        function rangeFromPoints(startRange, endRange) {
            if (!startRange || !endRange) return null;
            try {
                let start = startRange;
                let end = endRange;
                if (start.compareBoundaryPoints(Range.START_TO_START, end) > 0) {
                    start = endRange;
                    end = startRange;
                }

                const range = document.createRange();
                range.setStart(start.startContainer, start.startOffset);
                range.setEnd(end.endContainer, end.endOffset);
                return range.collapsed ? null : range;
            } catch (_) {
                return null;
            }
        }

        function applyRange(range) {
            if (!range) return;
            try {
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);

                lastRange = range.cloneRange();
                const text = range.toString();
                if (text !== lastText) {
                    lastText = text;
                    notify();
                }
            } catch (_) {
                // 页面结构在拖动过程中变化时忽略
            }
        }

        function resetContextMenuSoon() {
            if (contextMenuTimer) clearTimeout(contextMenuTimer);
            contextMenuTimer = setTimeout(() => {
                suppressContextMenu = false;
                contextMenuTimer = null;
            }, 600);
        }

        function onMouseDown(event) {
            // 在页面其它地方按下左键，视为放弃旧选区（面板内不受影响）
            if (event.button === 0 && !isPanelNode(event.target)) {
                clear();
            }

            if (event.button !== 2) return;
            if (isIgnoredTarget(event.target)) return;

            const startRange = caretRangeAt(event.clientX, event.clientY);
            if (!startRange) return;

            rightDrag = {
                startX: event.clientX,
                startY: event.clientY,
                startRange,
                moved: false
            };
        }

        function onMouseMove(event) {
            if (!rightDrag) return;

            // 右键已经松开（可能在窗口外松开）
            if (!(event.buttons & 2)) {
                rightDrag = null;
                return;
            }

            const dx = event.clientX - rightDrag.startX;
            const dy = event.clientY - rightDrag.startY;
            if (!rightDrag.moved && Math.hypot(dx, dy) < constants.SELECTION_DRAG_THRESHOLD) return;

            if (!rightDrag.moved) {
                rightDrag.moved = true;
                suppressContextMenu = true;
            }

            event.preventDefault();
            event.stopPropagation();

            const endRange = caretRangeAt(event.clientX, event.clientY);
            const range = rangeFromPoints(rightDrag.startRange, endRange);
            applyRange(range);
        }

        function onMouseUp(event) {
            if (event.button !== 2 || !rightDrag) return;

            const moved = rightDrag.moved;
            rightDrag = null;
            if (!moved) return;

            event.preventDefault();
            event.stopPropagation();
            rememberSelection();
            resetContextMenuSoon();
        }

        function onContextMenu(event) {
            if (!suppressContextMenu) return;
            event.preventDefault();
            event.stopPropagation();
            suppressContextMenu = false;
        }

        function onBlur() {
            rightDrag = null;
            suppressContextMenu = false;
        }

        function install() {
            document.addEventListener('selectionchange', rememberSelection);
            document.addEventListener('mousedown', onMouseDown, true);
            window.addEventListener('mousemove', onMouseMove, true);
            window.addEventListener('mouseup', onMouseUp, true);
            window.addEventListener('contextmenu', onContextMenu, true);
            window.addEventListener('blur', onBlur);
        }

        /**
         * 选区覆盖到了哪些标注。
         * 用“选区与文本节点内容”的交集判断，只碰到边界不算。
         * @param {Range} range
         * @param {Array<object>} annotations
         */
        function matchAnnotations(range, annotations) {
            if (!range || !Array.isArray(annotations)) return [];

            const matched = [];
            for (const annotation of annotations) {
                const node = annotation.node;
                if (!node || !node.isConnected) continue;

                const overlap = overlapWithNode(range, node);
                if (overlap) matched.push(annotation);
            }
            return matched;
        }

        function overlapWithNode(range, node) {
            try {
                const nodeRange = document.createRange();
                nodeRange.selectNodeContents(node);

                const overlap = range.cloneRange();
                if (overlap.compareBoundaryPoints(Range.START_TO_START, nodeRange) < 0) {
                    overlap.setStart(nodeRange.startContainer, nodeRange.startOffset);
                }
                if (overlap.compareBoundaryPoints(Range.END_TO_END, nodeRange) > 0) {
                    overlap.setEnd(nodeRange.endContainer, nodeRange.endOffset);
                }

                if (overlap.collapsed) return null;
                return overlap.toString().trim() ? overlap : null;
            } catch (_) {
                return null;
            }
        }

        /**
         * 订阅选区变化（用于面板清空输入框等）。
         * @param {(info: object|null) => void} listener
         * @returns {() => void} 取消订阅
         */
        function onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }

        return {
            install,
            getCurrent,
            hasSelection,
            clear,
            onChange,
            matchAnnotations
        };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createSelectionService = createSelectionService;
})(globalThis);
