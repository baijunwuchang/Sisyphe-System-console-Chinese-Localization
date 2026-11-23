# Maurice 标注 / 汉化（解耦版 4.0）

对 `https://lell1203.github.io/maurice_simul/` 的汉化辅助扩展：按 **Alt+M** 打开面板（F1 常被浏览器帮助页占用），提取页面文本、按编号标注、维护词库，并把译文实时写回页面。

这一版主要做了六件事：

1. **把原来的单文件 `content.js` 拆成 20 个职责单一的模块**，改由 `content.js` 统一装配；
2. **移除面板里的分页显示与管理控件**，但保留 `P1-42` 这样的编号格式；
3. **新增选区查找**：在页面上选中文本后点“查找”，直接定位它属于哪个编号，并按选区范围决定高亮整段还是只高亮选中部分；
4. **新增可编辑对照表**：导出“原文 / 编号 / 译文”，未翻译写“暂无”，改完直接导入即可原地更新页面；同时支持只导出已翻译文本、清除页面译文、单独加载某个词库；
5. **新增共享词库服务器**：001 / 002 初始文件自动下载（默认不勾选），支持查询作者进度、上传自己的词库、按编号下载、查看和删除自己的上传；
6. **新增一键启动脚本**：双击 `启动西西弗汉化.bat`，优先用 Edge、没 Edge 时读默认的 Chromium 浏览器，自动打开网站并加载插件。

> 想逐个文件看“写了什么、负责什么、依赖谁”，见 [文件说明.md](文件说明.md)。
>
> 本插件部分内容使用 AI 制作，完全开源。

---

## 1. 目录结构

```
maurice-annotator/
├─ manifest.json            MV3 清单：模块加载顺序
├─ background.js            点图标转发消息；必要时按 manifest 补注入
├─ content.js               启动入口：只负责装配依赖
├─ README.md                总说明
├─ 文件说明.md              逐文件说明
├─ 启动西西弗汉化.bat       双击启动浏览器 + 自动加载插件
├─ detect-browser.ps1       读取 Windows 默认浏览器路径
├─ src/
│  ├─ constants.js          常量 / 选择器 / 颜色 / 编号格式
│  ├─ html.js               HTML 转义
│  ├─ dom-utils.js          DOM 读取：可见性、清洗、代码区判断、矩形
│  ├─ storage.js            chrome.storage 读写（数据结构与旧版一致）
│  ├─ page-registry.js      内部页号分配与页面快照（不展示）
│  ├─ pattern-rules.js      动态数字规则编译（纯函数）
│  ├─ dictionary.js         词库增删改查、精确匹配、导入导出 payload
│  ├─ translator.js         查词、替换文本、监听动态内容
│  ├─ extractor.js          扫描页面并生成 P?-?? 标注
│  ├─ badge-layer.js        页面徽标与高亮框
│  ├─ selection.js          文本选区捕获与选区 → 标注映射
│  ├─ finder.js             按编号 / 按选区查词
│  ├─ export-builders.js    旧版导出内容构造（纯函数）
│  ├─ text-table.js         可编辑对照表构造 / 解析（纯函数）
│  ├─ server-api.js         共享服务器 API 客户端
│  ├─ transfer.js           下载文件 / 读取 JSON 文件
│  ├─ exporters.js          导出流程编排
│  ├─ app.js                应用动作（面板调用的 API）
│  ├─ panel-template.js     面板 HTML 模板
│  └─ panel.js              面板 DOM 与事件绑定
└─ tests/
   ├─ run-tests.mjs         Node 纯逻辑测试（43 项）
   └─ smoke.mjs             Chrome headless 端到端冒烟测试
```

## 2. 解耦方式

所有模块只做两件事：

- 向 `globalThis.Maurice` 注册一个**工厂函数**；
- 通过工厂参数接收依赖，不直接读取别的模块的全局变量。

`content.js` 是唯一的装配点：

```js
const domUtils = M.createDomUtils({ constants });
const store = M.createStore({ constants });
const pageRegistry = M.createPageRegistry({ store, constants });
const dictionary = M.createDictionary({ store, constants });
const patternEngine = M.createPatternEngine();
const translator = M.createTranslator({ dictionary, patternEngine, domUtils, getPageId });
const extractor = M.createExtractor({ domUtils, constants });
const badges = M.createBadgeLayer({ domUtils, constants, onBadgeClick });
const selection = M.createSelectionService({ constants });
selection.install();
const finder = M.createFinder({ store, constants, badges, translator, selection });
const builders = M.createExportBuilders({ constants });
const textTable = M.createTextTable({ constants });
const exporters = M.createExporters({ store, dictionary, translator, transfer, builders, textTable, constants });
const app = M.createApp({ ... });
const panel = M.createPanel({ app, constants, html, template: M.panelTemplate });
```

依赖方向大致如下（箭头表示“被谁使用”）：

```
constants / html
      ↓
dom-utils        storage ── page-registry
      ↓              ↓
   extractor     dictionary ── pattern-rules
      ↓              ↓
   badges        translator
      ↓              ↓
                finder
                     ↓
export-builders ── transfer ── exporters
                     ↓
                    app
                     ↓
             panel-template / panel
                     ↓
                  content.js
```

### 为什么不用 ES Module

MV3 的 `content_scripts` 不支持静态 `type: "module"`。为了保持“拖进浏览器就能用、不需要构建”，这里采用：

- manifest 中按顺序列出模块文件；
- 每个文件用 IIFE 注册工厂；
- 依赖通过参数注入。

效果等价于一个很小的依赖注入容器，同时保留了可直接加载的便利。

### 模块边界

| 模块 | 只负责 | 不负责 |
| --- | --- | --- |
| `storage` | 读写 chrome.storage | 业务规则 |
| `page-registry` | 页号分配、页面快照 | 展示页号 |
| `dictionary` | 词库数据与精确匹配 | 正则、DOM |
| `pattern-rules` | 动态数字规则 | 存储、DOM |
| `translator` | 替换与动态监听 | 词库编辑、面板 |
| `extractor` | 扫描 + 编号 | 保存、渲染 |
| `badge-layer` | 画徽标 / 高亮 | 业务消息 |
| `selection` | 捕获选区、匹配标注节点 | 词库、面板 |
| `finder` | 按编号 / 按选区查词 | 面板布局 |
| `text-table` | 构造 / 解析可编辑对照表 | 下载、词库写入 |
| `export-builders` | 纯数据 → 字符串 | 下载 |
| `exporters` | 导出流程 | 面板 |
| `app` | 组合动作、会话状态 | DOM / HTML |
| `panel` | DOM、事件 | 业务逻辑 |

## 3. 分页功能的处理

### 已移除

- 面板顶部的“页号”输入框；
- “新页号”按钮；
- “抓取过的页面”列表与“刷新”按钮；
- 提取结果里“存入 P1”这类页号提示。

### 保留

- 编号格式仍然是 **`P?-??`**（例如 `P1-42`），显示在页面徽标、查找提示和导出文件里；
- 内部仍会按 URL 自动分配页号，用于：
  - 同一 URL 刷新后编号保持稳定；
  - “存当前页”的按页词库；
  - 跨页查找与导出时定位条目。

页号分配现在完全自动：打开页面时分配并保存，用户看不到、也不需要管理。因为不再有“新页号”按钮，如果站点是 SPA 且 URL 变化后需要新页号，下一次点“提取并保存”会按新 URL 自动分配。

> 如果你确实想彻底删除页号存储（`pages` / `pageIdMap`），只需要改 `storage.js` 和 `page-registry.js`；但这样会丢掉旧数据和跨页导出能力，所以本版没有这么做。

## 4. 数据兼容性

存储键兼容旧版，并新增了稳定编号 / 共享服务器字段：

```
pageIdMap   { "/path": "P1" }
pageCounter 6
pages       { P1: { url, title, extractedAt, texts: [...],
                     textIdMap: { "键": 42 }, nextTextId: 43 } }
dicts       { custom: { global, perPage }, ... }
activeDicts ["custom", ...]
clientId    "随机 UUID，用于管理自己的服务器上传"
```

- 旧词库、旧页面快照可以直接沿用；旧快照第一次使用时，会按原有 `textId` 自动生成 `textIdMap`；
- 词库文件格式仍是 `maurice-dict` / `1.0`；
- `custom` 词库继续自动创建并启用。

### 编号稳定机制

旧版每次提取都从 1 重新编号，隐藏内容后来出现时，后面的文本会整体后移，导致不同文本拿到同一个旧编号。

现在改为：

- 按“文本类型 + 原文 + 同文出现序号”生成稳定键；
- 第一次见到该文本时分配编号，写入 `textIdMap`；
- 再次提取时，已有文本复用原编号，**只有新出现的文本才分配新号**；
- 隐藏项后来打开、DOM 顺序变化，都不会让旧编号被别的文本占用；
- 旧页面快照没有 `textIdMap` 时，会从现有 `texts` 的 `textId` 迁移；
- 如果旧快照里已经存在重复编号，迁移时会给后出现的重复项分配新号，自动修复已有的冲突。

> 注意：如果页面在修复前已经被反复覆盖提取，旧快照里只保留了最后一次的编号，修复后只能基于这份快照继续稳定；更早丢失的编号无法凭空恢复。
>
> 翻译是按“原文”存在词库里的，不依赖编号；所以迁移时个别文本换号不会让已有译文丢失。
>
> 隐藏内容如果还没被页面渲染出来，仍然需要先打开对应区域才能被提取；本机制保证的是“后来打开时，不会让已有文本换号或与别人的编号冲突”。

## 5. 安装与使用

### 一键启动（推荐）

双击目录里的 **`启动西西弗汉化.bat`**：

1. 把扩展复制到 `%LOCALAPPDATA%\MauriceAnnotator\extension`；
2. **优先使用 Edge**（自动加载最可靠），配置目录为 `edge-profile-v2`；
3. 如果没装 Edge，用 `detect-browser.ps1` 读取 Windows 默认浏览器：
   - Chromium 内核浏览器：用 `--load-extension` 尝试加载，配置目录为 `browser-profile-v2`；
   - Firefox / IE / Safari：无法用命令行加载 Chrome 扩展，会打开网站并提示手动安装；
   - Google Chrome 137+ 品牌版：官方已移除命令行加载扩展，也会走手动提示。

Edge 156 会把 `--load-extension` 加载的未打包扩展判成“未开启开发者模式”并自动禁用，所以脚本额外带了：

```text
--disable-features=DisableLoadExtensionCommandLineSwitch,ExtensionDisableUnsupportedDeveloper
```

首次使用 Edge 的 v2 配置目录时，脚本会把旧 `edge-profile` 里的扩展存储（词库、clientId）复制到 v2；旧目录保留作备份。

> **结论**：不是“必须有 Edge”才能运行插件，但**要全自动加载，Edge 目前最可靠**。如果默认浏览器是 Chrome 137+ 或 Firefox，只能手动在扩展页加载一次；扩展本身仍然可用。

如果面板打不开：

1. 关闭脚本打开的那个浏览器窗口（独立配置，不影响日常浏览器）；
2. 再双击一次 `启动西西弗汉化.bat`；
3. 打开 `edge://extensions` / `chrome://extensions`，确认 “Maurice 标注 / 汉化” 没有被禁用；如果显示“开发者模式扩展已停用”，把该扩展启用即可。

### 手动安装

1. 打开 `chrome://extensions`；
2. 打开右上角“开发者模式”；
3. 点“加载已解压的扩展程序”，选择本目录（含 `manifest.json` 的那一层）；
4. 打开 `https://lell1203.github.io/maurice_simul/`；
5. 按 **Alt+M** 或点扩展图标打开面板（F1 可能被浏览器帮助页占用）。

> Chrome 137+ 已移除命令行 `--load-extension`，但“加载已解压的扩展程序”不受影响。

主要操作：

- **提取并保存**：扫描当前页含韩文 / 英文的文本，生成 `P?-??` 编号并画出徽标（隐藏文本也会记录，但不画）；
- **显示标注 / 取消标注**：控制徽标；
- **应用翻译**：把已启用词库写回当前页面；
- **清除译文**：把页面上已经应用的译文恢复成原文；词库保留，之后可以重新“应用翻译”；
- **查找**：输入 `P1-42` 定位；或先在页面选中文本（左键拖动或右键拖动都可以），保持输入框留空，点“查找”：
  - 选区落在 1 条标注里：显示所属编号，并高亮**完整本段**文本；
  - 选区覆盖 2 条标注：高亮这 2 段完整文本，并列出两个编号；
  - 选区覆盖超过 2 条标注：只高亮**选中的那部分**，并列出涉及的编号；
- **存全局 / 存当前页**：写进 `custom` 词库；
- **词库列表的“加载”**：只启用这一个词库并立即应用，其他词库会暂时取消勾选；
- **导入文件 / 导出**：可导入词库 JSON 或可编辑对照表；可导出全部对照表、已翻译文本、JSON 备份。

### 可编辑文本对照表

点“导出全部（可编辑）”得到 `文本对照表.tsv`，列固定为：

| 原文 | 编号 | 译文 |
| --- | --- | --- |
| 파일 | P1-1 | 文件 |
| 편집 | P1-2 | 暂无 |

- 未翻译的译文列写 **`暂无`**；
- 代码区条目不进入对照表（翻译器不会替换代码区，导出它们会误导）；
- 直接编辑“译文”列，原样保存后点“导入对照表”导回（TSV，UTF-8 / UTF-16 带 BOM 都可读）；
- 导入后译文写入独立词库 **`导入对照表`**，并放到启用列表最后（最高优先级）；
- 页面会**原地更新**，不需要刷新；
- 把某行改成 `暂无` 或清空译文，会移除对照表里的这条译文；
- 原文、编号两列请勿改动。

“导出已翻译”会生成 `已翻译文本.tsv`，只包含当前已有译文的行，格式相同。

导出的词库文件同样使用中文名，可直接再次导入：

- `待翻译词库.json`
- `合并词库.json`
- `词库_<词库名>.json`（`custom` 导出为 `词库_自定义.json`）

`maurice_texts.json` 是旧版 JSON 备份，不是可导入对照表；面板里的“导出 JSON（备份）”仅用于留档。

### 共享词库

服务器：`http://47.80.59.80/maurice-api.php`（由后台 service worker 代理请求）。

- 打开面板时会自动下载 **001（人工初始）** 和 **002（AI 初始）**，但默认**不勾选**；勾选后才参与翻译；
- 001 / 002 行有 **查询进度** 按钮，显示作者声明的已翻译条数 / 总条数 / 备注；
- 每个本地词库行有 **上传** 按钮，上传成功后服务器分配编号；
- “共享词库”卡片可以输入编号下载，也可以“刷新我的上传”查看并删除自己的文件；
- 普通编号从 **010** 开始，最多 5 位（99999），每人最多上传 **4** 个；
- 001 / 002 为保留编号，只能由作者通过服务器管理员命令更新。

> 当前 001 仍是占位空词库；002 已上传初始机翻（`文本对照表16_中文.tsv`，625 个唯一原文，进度标注 52%）。

## 6. 测试

### 纯逻辑测试

```bat
node tests\run-tests.mjs
```

覆盖：文本清洗、HTML 转义、动态数字规则、词库优先级、页号分配、稳定编号 / 旧快照迁移、翻译查找、编号查词、选区查词（1 段 / 2 段 / 多段 / 无匹配）、可编辑对照表（导出 / 解析 / 导入 / 更新 / 暂无清理）、单独加载词库、服务器编号规范化 / 服务器词库默认不启用、JSON/TSV/未翻译/合并导出、中文词库文件名，以及“面板不再含分页控件、manifest 文件齐全”。

### 端到端冒烟测试

```bat
set CHROME_PATH=D:\path\to\chrome-for-testing\chrome.exe
node tests\smoke.mjs
```

脚本会用临时 profile 启动 headless Chrome，加载扩展并：

1. 按 Alt+M 打开面板，确认没有“新页号 / 抓取过的页面”；
2. 确认 001 / 002 自动下载且默认不勾选，查询 002 进度（52%）；
3. 手动下载 001 号文件；
4. 点“提取并保存”，确认有徽标；
5. 选中一段文本的一部分，点“查找”，确认返回编号并高亮完整段落；
6. 用右键拖动选中测试文本，确认同样能定位；
7. 选中 3 段文本，确认只高亮选中的部分并列出 3 个编号；
8. 在测试文本前插入新文本并重新提取，确认旧文本编号不变、新文本拿到独立新号；
9. 导入一个 JSON 测试词库，确认页面出现译文；
10. 导入一个修改过译文的 TSV 对照表，确认页面**原地更新**；
11. 点“清除译文”，确认页面恢复原文；再点“应用翻译”，确认译文回来；
12. 点词库行的“加载”，确认只启用该词库、页面切换成它的译文；
13. 点“导出全部（可编辑）”和“导出已翻译”，确认文件名与结果提示；
14. 上传测试词库到共享服务器，确认分配编号，查看“我的上传”，下载并删除；
15. 截图到 `tests/screenshots/smoke.png`。

由于 Chrome 137+ 的品牌版移除了 `--load-extension`，冒烟测试需要 **Chrome for Testing** 或 Chromium；本机 **Microsoft Edge 156** 仍接受该参数，实测同样可以跑。验证结果：一次提取约 770 条文本、180+ 个徽标；001/002 自动下载且不勾选；进度查询显示作者声明数据；部分选中定位到编号并高亮完整段落；右键拖动选中 `BetaTwo` 定位到对应编号；选中 3 段文本时只高亮选区并列出 3 个编号；在旧文本前插入新文本后，旧编号保持不变、新文本拿到独立新号；导入词库后成功替换页面文本；导入修改过译文的对照表后页面原地更新；清除译文能恢复原文，单独加载词库、导出全部/已翻译均正常；上传/查看/下载/删除共享词库均通过。

## 7. 与旧版的行为差异

除分页界面和新增的选区查找外，基本保持原逻辑，额外修正/增强了几个点：

1. **徽标定位**：覆盖层是 `position: fixed`，坐标改用视口坐标，滚动后不会偏移（旧版会叠加 `scrollY`）；
2. **页号防撞**：分配新页号前会扫描已有的 `P?`，避免 `pageCounter` 落后时生成重复编号；
3. **动态规则优先级**：同样长度的正则，本页规则优先于全局规则（旧版排序不稳定）；
4. **补注入**：`background.js` 改为从 `chrome.runtime.getManifest()` 读取模块清单，不再维护第二份文件列表；
5. **选区查找**：新增 `selection.js`，支持左右键选区、1～2 段高亮整段、超过 2 段只高亮选中部分；
6. **译文可原地更新**：翻译器改为记录每个节点的原文/已应用译文，导入新译文后直接更新，不再需要刷新页面；翻译后重新提取也仍能拿到原文；
7. **对照表闭环**：新增 `text-table.js`，支持导出全部/已翻译、修改后导入、`暂无` 清理；
8. **清除与单独加载**：清除页面译文后可恢复原文；词库行的“加载”可以只启用一个词库；
9. **编号稳定**：新增持久化 `textIdMap`，重新提取时旧文本复用原编号，新出现的隐藏文本只分配新号，不再出现两段不同文本共用一个编号；
10. **共享词库**：新增 `server-api.js` 和服务器接口，001/002 自动下载、进度查询、上传/下载/管理自己的文件；
11. **一键启动**：新增 `启动西西弗汉化.bat`，优先 Edge；没有 Edge 时读取默认 Chromium 浏览器并尝试自动加载，不支持的浏览器走手动提示。

## 8. 扩展指南

- **加面板按钮**：改 `panel-template.js` 加 `data-act`，在 `panel.js` 的 `switch` 里调用 `app` 方法；
- **加业务动作**：在 `app.js` 里实现并返回一段提示文字，面板会自动显示；
- **加词库字段**：改 `dictionary.js` 与 `export-builders.js`；
- **加导出格式**：在 `export-builders.js` / `text-table.js` 加纯函数，在 `exporters.js` 里下载；
- **改对照表列名 / 暂无占位**：改 `constants.js` 的 `TABLE_HEADER`、`TABLE_EMPTY`；
- **加提取规则**：改 `constants.js` 的正则或 `dom-utils.js` 的判断；
- **改选区高亮阈值**：改 `constants.js` 的 `SELECTION_FULL_HIGHLIGHT_MAX`（默认 2）；
- **改共享服务器地址 / 上传上限**：改 `constants.js` 的 `SERVER_API_BASE`、`SERVER_MAX_UPLOADS`，以及 `background.js` 里的 `SERVER_API_BASE`；
- **加新模块**：新建 `src/xxx.js` 注册工厂 → 加进 `manifest.json` 的 `js` 数组（顺序即加载顺序）→ 在 `content.js` 装配；测试会自动检查 `src/` 下所有文件都已登记。
