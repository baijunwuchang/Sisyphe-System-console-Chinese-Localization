/**
 * 面板的 HTML 模板（纯字符串，不绑定事件、不查 DOM）。
 *
 * 分页相关控件（页号输入框、新页号、抓取过的页面列表）已全部移除；
 * 编号格式 P?-?? 仍保留在标注和查找功能里。
 */
(function registerPanelTemplate(global) {
    'use strict';

    /**
     * @param {object} deps
     * @param {object} deps.constants
     * @returns {string}
     */
    function panelTemplate({ constants }) {
        const row = 'display:flex;gap:6px;margin-bottom:6px;';
        const button = 'padding:6px;color:#fff;border:none;border-radius:4px;cursor:pointer;';

        return `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="display:flex;flex-direction:column;gap:2px;">
          <strong style="font-size:13px;">Maurice 标注 / 汉化</strong>
          <span style="color:#888;font-size:10px;line-height:1.35;">本插件部分内容使用AI制作，完全开源</span>
          <span style="color:#f59e0b;font-size:10px;line-height:1.35;">快捷键：Alt+M（F1 可能被浏览器帮助页占用）</span>
        </div>
        <button data-act="close" title="关闭" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:16px;line-height:1;">×</button>
      </div>

      <div style="flex:1;overflow-y:auto;padding-right:4px;">
        <button data-act="extract" style="width:100%;padding:7px;background:#3b82f6;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-bottom:6px;">提取并保存</button>

        <div style="${row}">
          <button data-act="show-badges" style="flex:1;${button}background:#8b5cf6;">显示标注</button>
          <button data-act="hide-badges" style="flex:1;${button}background:#4b5563;">取消标注</button>
          <button data-act="apply-all" style="flex:1;${button}background:#059669;">应用翻译</button>
          <button data-act="clear-translated" title="把页面上已应用的译文恢复成原文；词库保留，可重新应用" style="flex:1;${button}background:#b45309;">清除译文</button>
        </div>

        <div style="${row}">
          <input data-el="q" placeholder="输入编号（如 P1-42）或选中文本后留空查找" title="输入框留空时，按页面选区查找编号" style="flex:1;background:#111;border:1px solid #444;color:#eee;padding:6px 8px;border-radius:4px;font-family:monospace;" />
          <button data-act="find" title="输入框留空时，按页面选区查找编号" style="padding:6px 12px;background:#10b981;color:#fff;border:none;border-radius:4px;cursor:pointer;">查找</button>
        </div>

        <div data-el="result" style="margin-bottom:8px;padding:8px;background:#111;border-radius:4px;min-height:36px;color:#aaa;white-space:pre-wrap;font-size:11px;line-height:1.5;"></div>

        <div style="background:#111;border-radius:4px;padding:8px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <span style="color:#aaa;font-size:11px;">翻译编辑</span>
            <span style="color:#f59e0b;font-size:10px;">💡 有数字用 {d} 代替</span>
          </div>
          <input data-el="src" placeholder="原文（自动填或手动输）" style="width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #444;color:#eee;padding:4px 6px;border-radius:4px;font-family:monospace;font-size:11px;margin-bottom:4px;" />
          <input data-el="dst" placeholder="译文" style="width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #444;color:#eee;padding:4px 6px;border-radius:4px;font-family:monospace;font-size:11px;margin-bottom:4px;" />
          <div style="display:flex;gap:4px;">
            <button data-act="save-global" style="flex:1;padding:5px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">存全局</button>
            <button data-act="save-page" style="flex:1;padding:5px;background:#7c3aed;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">存当前页</button>
            <button data-act="del-trans" style="flex:1;padding:5px;background:#b91c1c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">删除</button>
          </div>
        </div>

        <div style="background:#111;border-radius:4px;padding:8px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="color:#aaa;font-size:11px;">共享词库</span>
            <button data-act="refresh-uploads" style="padding:3px 8px;background:#334155;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">刷新我的上传</button>
          </div>
          <div style="display:flex;gap:6px;margin-bottom:4px;">
            <input data-el="server-code" maxlength="5" placeholder="输入编号，如 010" style="flex:1;background:#1a1a1a;border:1px solid #444;color:#eee;padding:5px 7px;border-radius:4px;font-family:monospace;font-size:11px;" />
            <button data-act="download-server" style="padding:5px 10px;background:#0ea5e9;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">下载编号</button>
          </div>
          <div style="color:#666;font-size:10px;line-height:1.5;">
            001 / 002 会在打开面板时自动下载，默认不勾选；每人最多上传 4 个，普通编号从 010 开始。
          </div>
          <div data-el="uploads" style="max-height:110px;overflow:auto;margin-top:6px;font-family:monospace;font-size:10px;line-height:1.7;color:#999;">（点“刷新我的上传”查看自己上传的文件）</div>
        </div>

        <div style="background:#111;border-radius:4px;padding:8px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="color:#aaa;font-size:11px;">词库列表</span>
            <button data-act="import-dict" title="导入词库 JSON，或导入可编辑对照表" style="padding:3px 8px;background:#0ea5e9;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">导入文件</button>
          </div>
          <div data-el="dicts" style="max-height:140px;overflow:auto;font-family:monospace;font-size:11px;line-height:1.6;"></div>
          <div style="display:flex;gap:4px;margin-top:6px;">
            <button data-act="export-all-dicts" style="flex:1;padding:5px;background:#0891b2;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">合并导出已翻</button>
            <button data-act="export-pending" style="flex:1;padding:5px;background:#e11d48;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">导出未翻译</button>
          </div>
          <input data-el="file" type="file" accept=".json,.tsv,.txt,application/json,text/tab-separated-values,text/plain" style="display:none;" />
        </div>

        <div style="background:#111;border-radius:4px;padding:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <span style="color:#aaa;font-size:11px;">文本对照表</span>
            <span style="color:#f59e0b;font-size:10px;">未翻译填“暂无”</span>
          </div>
          <div style="color:#666;font-size:10px;line-height:1.5;margin-bottom:6px;">
            导出后编辑“译文”列，再用“导入对照表”导回；原文和编号请勿改动。
          </div>
          <div style="display:flex;gap:6px;margin-bottom:6px;">
            <button data-act="export-table" style="flex:1;${button}background:#10b981;">导出全部（可编辑）</button>
            <button data-act="export-translated" style="flex:1;${button}background:#0891b2;">导出已翻译</button>
          </div>
          <div style="display:flex;gap:6px;">
            <button data-act="import-table" title="导入原文 / 编号 / 译文的 TSV 对照表" style="flex:1;${button}background:#0ea5e9;">导入对照表</button>
            <button data-act="export-json" title="旧版 JSON 备份，不是可导入对照表" style="flex:1;${button}background:#444;">导出 JSON（备份）</button>
          </div>
        </div>
      </div>
    `;
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.panelTemplate = panelTemplate;
})(globalThis);
