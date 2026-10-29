# 第三方组件许可声明（`vendor/mermaid.min.js`）

本包在 `vendor/mermaid.min.js` 内嵌 **mermaid 11.4.1** 的官方浏览器构建产物（`dist/mermaid.min.js`，与 npm 发布件 sha256 一致）。

## mermaid

- 版本：11.4.1 ｜ 许可：MIT ｜ 出处：`mermaid@11.4.1` npm 包的 `LICENSE`

## 该构建产物自带的第三方声明（逐字转录）

> 来源：`vendor/mermaid.min.js` 中 `Bundled license information:` 段落原文。

```
Bundled license information:

dompurify/dist/purify.es.mjs:
  (*! @license DOMPurify 3.2.1 | (c) Cure53 and other contributors | Released under the Apache license 2.0 and Mozilla Public License 2.0 | github.com/cure53/DOMPurify/blob/3.2.1/LICENSE *)

js-yaml/dist/js-yaml.mjs:
  (*! js-yaml 4.1.0 https://github.com/nodeca/js-yaml @license MIT *)

lodash-es/lodash.js:
  (**
   * @license
   * Lodash (Custom Build) <https://lodash.com/>
   * Build: `lodash modularize exports="es" -o ./`
   * Copyright OpenJS Foundation and other contributors <https://openjsf.org/>
   * Released under MIT license <https://lodash.com/license>
   * Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
   * Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
   *)

cytoscape/dist/cytoscape.esm.mjs:
  (*!
  Embeddable Minimum Strictly-Compliant Promises/A+ 1.1.1 Thenable
  Copyright (c) 2013-2014 Ralf S. Engelschall (http://engelschall.com)
  Licensed under The MIT License (http://opensource.org/licenses/MIT)
  *)
  (*!
  Event object based on jQuery events, MIT license
  
  https://jquery.org/license/
  https://tldrlegal.com/license/mit-license
  https://github.com/jquery/jquery/blob/master/src/event.js
  *)
  (*! Bezier curve function generator. Copyright Gaetan Renaudeau. MIT License: http://en.wikipedia.org/wiki/MIT_License *)
  (*! Runge-Kutta spring physics function generator. Adapted from Framer.js, copyright Koen Bok. MIT License: http://en.wikipedia.org/wiki/MIT_License *)
*/
```

## mermaid 声明的依赖（会被打入上述构建产物）

许可类型逐项取自各组件上游包（`npm view <pkg> license`；`khroma` 以其包内 `license` 文件为准）。
完整许可正文以各组件上游发布包内的许可文件为准。

| 组件 | 声明范围 | 许可 |
| --- | --- | --- |
| `@braintree/sanitize-url` | `^7.0.1` | MIT |
| `@iconify/utils` | `^2.1.32` | MIT |
| `@mermaid-js/parser` | `^0.3.0` | MIT |
| `cytoscape` | `^3.29.2` | MIT |
| `cytoscape-cose-bilkent` | `^4.1.0` | MIT |
| `cytoscape-fcose` | `^2.2.0` | MIT |
| `d3` | `^7.9.0` | ISC |
| `d3-sankey` | `^0.12.3` | BSD-3-Clause |
| `dagre-d3-es` | `7.0.11` | MIT |
| `dayjs` | `^1.11.10` | MIT |
| `dompurify` | `^3.2.1` | MPL-2.0 OR Apache-2.0 |
| `katex` | `^0.16.9` | MIT |
| `khroma` | `^2.1.0` | MIT（以其包内 license 文件为准） |
| `lodash-es` | `^4.17.21` | MIT |
| `marked` | `^13.0.2` | MIT |
| `roughjs` | `^4.6.6` | MIT |
| `stylis` | `^4.3.1` | MIT |
| `ts-dedent` | `^2.2.0` | MIT |
| `uuid` | `^9.0.1` | MIT |

另：产物内还可检出 `langium`、`chevrotain`、`cose-base`、`layout-base`、`js-yaml` 等间接依赖，其许可分别为 `langium` MIT、`chevrotain` Apache-2.0、`cose-base` MIT、`layout-base` MIT、`js-yaml` MIT。

## 说明与边界

- 浏览器包经压缩打包，其自述段落只覆盖部分组件；上表的许可类型逐项取自各组件上游包，未依据产物字符串推断。
- 除 mermaid 外，各组件均未被本包声明为运行时依赖；包内不含 `node_modules/mermaid`（由 `npm run test:package` 断言）。
