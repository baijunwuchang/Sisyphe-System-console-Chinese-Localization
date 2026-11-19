/**
 * 动态数字规则引擎（纯函数，不碰 DOM / 存储）。
 *
 * 词库里可以写：
 *   "{d}일차": "第{d}天"      —— 显式占位符
 *   "Day 3": "第3天"          —— 自动把原文里的数字抓成占位符
 *
 * 输出一组 { regex, template, priority }，由翻译器按“正则越长越优先、
 * 同长度时按页规则优先于全局规则”的顺序匹配。
 */
(function registerPatternEngine(global) {
    'use strict';

    function createPatternEngine() {
        const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

        function escapeRegExp(text) {
            return text.replace(REGEX_SPECIALS, '\\$&');
        }

        /**
         * 把一条词条编译成正则。不需要动态数字的返回 null。
         * @param {string} original
         * @param {string} translation
         * @returns {{regex:RegExp, template:string}|null}
         */
        function compileRule(original, translation) {
            const orig = String(original);
            const trans = String(translation);

            if (!orig.includes('{d}') && !/\d/.test(orig)) return null;

            // 方式一：原文显式写了 {d}
            if (orig.includes('{d}')) {
                let regexSource = escapeRegExp(orig).replace(/\\\{d\\\}/g, '(\\d+)');
                regexSource = '^' + regexSource + '$';

                let count = 1;
                const template = trans.replace(/\{d\}/g, () => '$' + count++);

                try {
                    return { regex: new RegExp(regexSource), template };
                } catch (_) {
                    return null;
                }
            }

            // 方式二：原文没写 {d}，自动把每个数字变成捕获组
            const numbers = orig.match(/\d+/g);
            if (!numbers) return null;

            const parts = orig.split(/(\d+)/);
            let regexSource = '^';
            for (const part of parts) {
                if (/^\d+$/.test(part)) {
                    regexSource += '(\\d+)';
                } else {
                    regexSource += escapeRegExp(part);
                }
            }
            regexSource += '$';

            let template = trans;
            for (let i = 0; i < numbers.length; i++) {
                template = template.replace(numbers[i], '$' + (i + 1));
            }

            try {
                return { regex: new RegExp(regexSource), template };
            } catch (_) {
                return null;
            }
        }

        /**
         * 编译所有启用词库里的动态规则。
         * @param {object} options
         * @param {Record<string, object>} options.dicts
         * @param {string[]} options.activeDicts
         * @param {string} options.pageId
         */
        function compile({ dicts, activeDicts, pageId }) {
            const rules = [];

            const add = (original, translation, priority) => {
                const rule = compileRule(original, translation);
                if (rule) rules.push({ ...rule, priority });
            };

            for (const name of activeDicts) {
                const dict = dicts[name];
                if (!dict) continue;

                for (const [original, translation] of Object.entries(dict.global || {})) {
                    add(original, translation, 0);
                }

                const pageEntries = dict.perPage && dict.perPage[pageId];
                if (pageEntries) {
                    for (const [original, translation] of Object.entries(pageEntries)) {
                        add(original, translation, 1);
                    }
                }
            }

            // 正则越长越具体；同样长时“本页”规则压过全局规则
            rules.sort(
                (a, b) =>
                    b.regex.source.length - a.regex.source.length ||
                    b.priority - a.priority
            );
            return rules;
        }

        /**
         * 用匹配结果填充模板里的 $1、$2……
         * 用 split/join 而不是 replace，避免译文里的 $& 之类被二次解释。
         */
        function expand(rule, match) {
            let result = rule.template;
            for (let i = 1; i < match.length; i++) {
                result = result.split('$' + i).join(match[i]);
            }
            return result;
        }

        return { compile, compileRule, expand, escapeRegExp };
    }

    global.Maurice = global.Maurice || {};
    global.Maurice.createPatternEngine = createPatternEngine;
})(globalThis);
