/**
 * 纯逻辑测试：用 Node 的 vm 按 manifest 顺序加载模块，不依赖浏览器。
 *
 * 运行：<node> tests/run-tests.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

/* ------------------------------------------------------------------ */
/* 测试环境                                                            */
/* ------------------------------------------------------------------ */

const sandbox = {
    console,
    setTimeout,
    clearTimeout
};
vm.createContext(sandbox);

const moduleFiles = manifest.content_scripts[0].js.filter((file) => file !== 'content.js');
for (const file of moduleFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    vm.runInContext(source, sandbox, { filename: file });
}

const M = sandbox.Maurice;
const { constants } = M;

/** 跨 realm 的普通对象转成本 realm 的普通对象，方便 deepEqual */
const plain = (value) => JSON.parse(JSON.stringify(value));

function createFakeStorage(initial = {}) {
    let data = JSON.parse(JSON.stringify(initial));
    return {
        async get(keys) {
            const result = {};
            for (const key of keys) {
                if (key in data) result[key] = JSON.parse(JSON.stringify(data[key]));
            }
            return result;
        },
        async set(patch) {
            for (const [key, value] of Object.entries(patch)) {
                data[key] = JSON.parse(JSON.stringify(value));
            }
        },
        dump() {
            return JSON.parse(JSON.stringify(data));
        }
    };
}

async function createHarness(initial) {
    const storage = createFakeStorage(initial);
    const store = M.createStore({ constants, storageArea: storage });
    await store.load();
    return { storage, store };
}

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed++;
        failures.push({ name, error });
        console.log(`  ✗ ${name}`);
        console.log(`    ${error.message}`);
    }
}

/* ------------------------------------------------------------------ */
/* 1. 文本与转义                                                       */
/* ------------------------------------------------------------------ */

console.log('\n[1] 文本工具');

const domUtils = M.createDomUtils({ constants });

await test('cleanText 去掉零宽字符并 trim', () => {
    assert.equal(domUtils.cleanText('\u200b  Hello \ufeff\u00ad'), 'Hello');
});

await test('html.escapeHtml 转义特殊字符', () => {
    const { escapeHtml, escapeAttr } = M.html;
    assert.equal(escapeHtml(`<a href="x">Tom & Jerry's</a>`),
        '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
    assert.equal(escapeAttr('<b>'), '&lt;b&gt;');
});

/* ------------------------------------------------------------------ */
/* 2. 动态数字规则                                                     */
/* ------------------------------------------------------------------ */

console.log('\n[2] 动态数字规则');

const engine = M.createPatternEngine();

await test('显式 {d} 规则', () => {
    const rule = engine.compileRule('{d}일차', '第{d}天');
    assert.ok(rule);
    const match = rule.regex.exec('7일차');
    assert.ok(match);
    assert.equal(engine.expand(rule, match), '第7天');
});

await test('原文含数字时自动生成捕获组', () => {
    const rule = engine.compileRule('Day 3', '第3天');
    assert.ok(rule);
    const match = rule.regex.exec('Day 42');
    assert.ok(match);
    assert.equal(engine.expand(rule, match), '第42天');
});

await test('静态词条不生成规则', () => {
    assert.equal(engine.compileRule('Hello', '你好'), null);
});

await test('本页规则优先于全局规则', () => {
    const dicts = {
        demo: {
            global: { '{d}일차': '全局{d}' },
            perPage: { P1: { '{d}일차': '本页{d}' } }
        }
    };
    const rules = engine.compile({ dicts, activeDicts: ['demo'], pageId: 'P1' });
    assert.equal(rules.length, 2);
    assert.equal(rules[0].priority, 1);
    const match = rules[0].regex.exec('3일차');
    assert.equal(engine.expand(rules[0], match), '本页3');
});

await test('正则越长越优先', () => {
    const dicts = {
        demo: {
            global: { '{d}일': '短{d}', '{d}일차': '长{d}' },
            perPage: {}
        }
    };
    const rules = engine.compile({ dicts, activeDicts: ['demo'], pageId: 'P1' });
    assert.equal(rules[0].template, '长$1');
});

/* ------------------------------------------------------------------ */
/* 3. 词库                                                             */
/* ------------------------------------------------------------------ */

console.log('\n[3] 词库');

await test('初始化会创建并启用 custom 词库', async () => {
    const { store } = await createHarness();
    const dicts = M.createDictionary({ store, constants });
    await dicts.init();
    assert.deepEqual(plain(dicts.activeNames()), ['custom']);
    assert.equal(dicts.get('custom').name, 'custom');
    assert.equal(store.state.dicts.custom.description, '面板里随手存的翻译');
});

await test('精确匹配：本页 > 全局，后启用的词库优先', async () => {
    const { store } = await createHarness();
    const dicts = M.createDictionary({ store, constants });
    await dicts.init();

    await dicts.saveTranslation('Hello', '你好', 'global', 'P1');
    assert.equal(dicts.lookupExact('Hello', 'P1'), '你好');

    await dicts.saveTranslation('Hello', '本页你好', 'page', 'P1');
    assert.equal(dicts.lookupExact('Hello', 'P1'), '本页你好');
    assert.equal(dicts.lookupExact('Hello', 'P2'), '你好');
});

await test('删除译文后回落到全局值', async () => {
    const { store } = await createHarness();
    const dicts = M.createDictionary({ store, constants });
    await dicts.init();
    await dicts.saveTranslation('Hello', '你好', 'global', 'P1');
    await dicts.saveTranslation('Hello', '本页你好', 'page', 'P1');
    await dicts.saveTranslation('Hello', '', 'page', 'P1');
    assert.equal(dicts.lookupExact('Hello', 'P1'), '你好');
});

await test('导入词库：校验、启用、覆盖标记、持久化', async () => {
    const { store, storage } = await createHarness();
    const dicts = M.createDictionary({ store, constants });
    await dicts.init();

    const first = await dicts.importData({
        name: 'demo',
        description: '测试',
        global: { A: '甲' },
        perPage: { P1: { B: '乙' } }
    });
    assert.equal(first.key, 'demo');
    assert.equal(first.isOverwrite, false);
    assert.ok(dicts.activeNames().includes('demo'));
    assert.equal(dicts.lookupExact('A', 'P1'), '甲');
    assert.equal(dicts.lookupExact('B', 'P1'), '乙');

    const second = await dicts.importData({ name: 'demo', global: { A: '甲2' } });
    assert.equal(second.isOverwrite, true);

    // 重新读存储，确认落盘
    const reloaded = M.createStore({ constants, storageArea: storage });
    await reloaded.load();
    assert.equal(reloaded.state.dicts.demo.global.A, '甲2');
    assert.ok(reloaded.state.activeDicts.includes('demo'));

    await assert.rejects(() => dicts.importData({ description: '没有名字' }), /name/);
});

await test('custom 词库不可删除，普通词库可删除', async () => {
    const { store } = await createHarness();
    const dicts = M.createDictionary({ store, constants });
    await dicts.init();
    await dicts.importData({ name: 'demo', global: {} });

    assert.equal(await dicts.remove('custom'), false);
    assert.equal(await dicts.remove('demo'), true);
    assert.equal(dicts.get('demo'), null);
    assert.ok(!dicts.activeNames().includes('demo'));
});

await test('导出为合法词库 payload', async () => {
    const { store } = await createHarness();
    const dicts = M.createDictionary({ store, constants });
    await dicts.init();
    await dicts.saveTranslation('Hello', '你好', 'global', 'P1');

    const payload = dicts.toPayload('custom');
    assert.equal(payload.format, 'maurice-dict');
    assert.equal(payload.name, 'custom');
    assert.equal(payload.global.Hello, '你好');
});

/* ------------------------------------------------------------------ */
/* 4. 页号（仅内部）                                                   */
/* ------------------------------------------------------------------ */

console.log('\n[4] 页号');

await test('同一 URL 页号稳定，不同 URL 分配新号', async () => {
    const { store } = await createHarness();
    let key = '/a';
    const registry = M.createPageRegistry({
        store,
        constants,
        getUrlKey: () => key
    });

    assert.equal(await registry.resolvePageId(), 'P1');
    key = '/b';
    assert.equal(await registry.resolvePageId(), 'P2');
    key = '/a';
    assert.equal(await registry.resolvePageId(), 'P1');
    assert.equal(await registry.resolvePageId(), 'P1');
});

await test('pageCounter 落后时不会撞号', async () => {
    const { store } = await createHarness({
        pageIdMap: { '/old': 'P5' },
        pageCounter: 0
    });
    const registry = M.createPageRegistry({
        store,
        constants,
        getUrlKey: () => '/new'
    });
    assert.equal(await registry.resolvePageId(), 'P6');
});

await test('保存快照后可按页读取，且不必展示给用户', async () => {
    const { store } = await createHarness();
    const registry = M.createPageRegistry({
        store,
        constants,
        getUrlKey: () => '/a'
    });
    const pageId = await registry.resolvePageId();
    await registry.recordPage(pageId, {
        url: 'https://example.test/a',
        title: '标题',
        texts: [{ id: 'P1-1', pageId: 'P1', textId: 1, type: 'ui', text: 'Hello' }]
    });

    assert.deepEqual(plain(registry.listPageIds()), ['P1']);
    assert.equal(registry.getPage('P1').texts.length, 1);
    assert.equal(registry.getPage('P1').url, 'https://example.test/a');
});

/* ------------------------------------------------------------------ */
/* 5. 翻译器                                                           */
/* ------------------------------------------------------------------ */

console.log('\n[5] 翻译器');

await test('精确匹配优先，其次动态规则', async () => {
    const { store } = await createHarness();
    const dicts = M.createDictionary({ store, constants });
    await dicts.init();
    await dicts.saveTranslation('Hello', '你好', 'global', 'P1');
    await dicts.saveTranslation('{d}일차', '第{d}天', 'global', 'P1');

    const translator = M.createTranslator({
        dictionary: dicts,
        patternEngine: engine,
        domUtils,
        getPageId: () => 'P1'
    });
    translator.rebuild('P1');

    assert.equal(translator.lookup('Hello', 'P1'), '你好');
    assert.equal(translator.lookup('7일차', 'P1'), '第7天');
    assert.equal(translator.lookup('没有译文', 'P1'), null);
    assert.ok(translator.getRuleCount() > 0);
});

/* ------------------------------------------------------------------ */
/* 6. 查词                                                             */
/* ------------------------------------------------------------------ */

console.log('\n[6] 查词');

await test('编号解析（大小写、非法格式）', () => {
    const finder = M.createFinder({
        store: null,
        constants,
        badges: { highlight: () => true }
    });
    assert.deepEqual(plain(finder.parse('p12-3')), { pageId: 'P12', textId: 3 });
    assert.equal(finder.parse('P12'), null);
    assert.equal(finder.parse('abc'), null);
});

await test('当前页命中 / 隐藏文本 / 跨页记录', async () => {
    const { store } = await createHarness();
    const registry = M.createPageRegistry({ store, constants, getUrlKey: () => '/a' });
    const pageId = await registry.resolvePageId();
    await registry.recordPage('P2', {
        url: 'https://example.test/b',
        title: '另一个页面',
        texts: [{ id: 'P2-1', pageId: 'P2', textId: 1, type: 'ui', text: 'World' }]
    });

    let highlightResult = true;
    const badges = { highlight: () => highlightResult };
    const finder = M.createFinder({ store, constants, badges });

    const annotations = [
        { id: 'P1-1', pageId, textId: 1, type: 'ui', text: 'Hello', node: {} }
    ];
    const current = await finder.find('P1-1', {
        pageId,
        getAnnotations: () => annotations
    });
    assert.equal(current.ok, true);
    assert.equal(current.type, 'current');

    highlightResult = false;
    const hidden = await finder.find('P1-1', {
        pageId,
        getAnnotations: () => annotations
    });
    assert.equal(hidden.type, 'hidden');
    assert.match(hidden.message, /隐藏/);

    const other = await finder.find('P2-1', {
        pageId,
        getAnnotations: () => annotations
    });
    assert.equal(other.ok, true);
    assert.equal(other.type, 'other');
    assert.match(other.message, /World/);

    const missing = await finder.find('P9-9', {
        pageId,
        getAnnotations: () => annotations
    });
    assert.equal(missing.ok, false);
});

/* ------------------------------------------------------------------ */
/* 7. 导出构建（纯函数）                                               */
/* ------------------------------------------------------------------ */

console.log('\n[7] 导出');

const builders = M.createExportBuilders({ constants });

const samplePages = {
    P1: {
        texts: [
            { id: 'P1-1', pageId: 'P1', textId: 1, type: 'ui', text: 'Hello' },
            { id: 'P1-2', pageId: 'P1', textId: 2, type: 'ui', text: 'Goodbye' },
            { id: 'P1-3', pageId: 'P1', textId: 3, type: 'code', text: 'console.log(1)' }
        ]
    },
    P2: {
        texts: [
            { id: 'P2-1', pageId: 'P2', textId: 1, type: 'ui', text: 'World' }
        ]
    }
};

const sampleLookup = (text) => (text === 'Hello' ? '你好' : null);

await test('文本 JSON：带 id / type / 译文', () => {
    const data = JSON.parse(builders.buildTextsJson({ pages: samplePages, lookup: sampleLookup }));
    assert.equal(data.length, 4);
    assert.deepEqual(
        plain(data[0]),
        { id: 'P1-1', pageId: 'P1', textId: 1, type: 'ui', text: 'Hello', translation: '你好' }
    );
    assert.equal(data[1].translation, '');
});

await test('文本 TSV：表头与行数', () => {
    const tsv = builders.buildTextsTsv({ pages: samplePages, lookup: sampleLookup });
    const lines = tsv.split('\n');
    assert.equal(lines[0], 'id\ttype\ttext\ttranslation');
    assert.equal(lines.length, 5);
    assert.match(tsv, /P1-1\tui\tHello\t你好/);
});

await test('未翻译列表：跳过代码区与已翻译条目', () => {
    const payload = builders.buildPendingPayload({
        pages: samplePages,
        lookup: sampleLookup
    });
    assert.equal(payload.format, 'maurice-dict');
    assert.deepEqual(Object.keys(payload.global).sort(), ['Goodbye', 'World']);
    assert.equal(payload.global.Hello, undefined);
    assert.equal(payload.global['console.log(1)'], undefined);
    assert.deepEqual(plain(payload._sourceIds.World), ['P2-1']);
});

await test('合并词库：后启用的覆盖先启用的', () => {
    const payload = builders.buildMergedPayload({
        dicts: {
            a: { global: { A: '1' }, perPage: { P1: { B: '2' } } },
            b: { global: { A: '3' } }
        },
        activeNames: ['a', 'b']
    });
    assert.equal(payload.global.A, '3');
    assert.equal(payload.perPage.P1.B, '2');
    assert.equal(payload.name, 'merged_all');
    assert.equal(payload.description, '合并了 2 个词库');
});

/* ------------------------------------------------------------------ */
/* 8. 分页移除 / 文件清单                                              */
/* ------------------------------------------------------------------ */

console.log('\n[8] 分页移除与打包完整性');

await test('面板不再包含页号、新页号、页面列表', () => {
    const markup = M.panelTemplate({ constants });
    assert.ok(!markup.includes('新页号'));
    assert.ok(!markup.includes('抓取过的页面'));
    assert.ok(!markup.includes('data-el="pid"'));
    assert.ok(!markup.includes('data-el="pages"'));
    assert.ok(!markup.includes('data-act="refresh"'));
    assert.ok(markup.includes('提取并保存'));
    assert.ok(markup.includes('P1-42'), '编号格式提示应保留');
});

await test('manifest 中列出的文件都存在，且模块全部登记', () => {
    for (const file of manifest.content_scripts[0].js) {
        assert.ok(fs.existsSync(path.join(root, file)), `缺少 ${file}`);
    }
    const srcFiles = fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js'));
    const listed = new Set(manifest.content_scripts[0].js);
    for (const file of srcFiles) {
        assert.ok(listed.has(`src/${file}`), `src/${file} 未登记到 manifest`);
    }
});

await test('background 从 manifest 读取脚本清单，不重复硬编码', () => {
    const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
    assert.match(source, /chrome\.runtime\.getManifest\(\)/);
    assert.match(source, /files:\s*getContentScriptFiles\(\)/);
    assert.ok(!source.includes("'src/"), 'background 不应再抄一份模块路径');
});

await test('代码里引用的 constants.* 都真实存在', () => {
    const defined = new Set(Object.keys(constants));
    const missing = new Set();
    for (const file of fs.readdirSync(path.join(root, 'src'))) {
        if (!file.endsWith('.js')) continue;
        const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
        for (const match of source.matchAll(/constants\.([A-Z][A-Z0-9_]*)/g)) {
            if (!defined.has(match[1])) missing.add(`${match[1]} (${file})`);
        }
    }
    assert.deepEqual([...missing], []);
});

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) {
    for (const failure of failures) {
        console.error(`\n[${failure.name}]`);
        console.error(failure.error.stack);
    }
    process.exitCode = 1;
}
