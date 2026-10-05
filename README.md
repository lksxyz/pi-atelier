# 🧩 Pi Atelier

[![npm scope](https://img.shields.io/badge/npm-@lukisxyz-blue)](https://www.npmjs.com/~lukisxyz)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Minimalist [Pi Coding Agent](https://github.com/earendil-works/pi) extensions. One package, one problem. No
config surfaces, minimal context footprint. Independently installable, published separately under the
`@lukisxyz` npm scope.

Pi Atelier is an independently maintained fork of [arhen/pi-extensions](https://github.com/arhen/pi-extensions).
It retains the upstream MIT license and copyright notices. This repository is the single source of truth for this fork.

## Layout

```
packages/
├── core/        → essential extensions (installed by the toolset)
│   ├── pi-core-ask/
│   ├── pi-core-skill-tool/
│   ├── pi-core-subagent/
│   ├── pi-core-todo/
│   ├── pi-core-tps-stats/
│   └── pi-core-vision/
├── add/         → optional/extra extensions (opt in)
│   ├── pi-add-9router/
│   ├── pi-add-code-diagnostic/
│   ├── pi-add-commandcode/
│   ├── pi-add-vantis/
│   ├── pi-add-wafer/
│   └── pi-senja/
└── pi-toolset/  → installer: manage the installed set
```

## 🚀 Install

The easiest way to get the whole **core set** at once is the toolset:

```bash
npm i -g @lukisxyz/pi-toolset
pi-toolset install          # installs all @lukisxyz/pi-core-* packages
```

Or install individual extensions permanently:

```bash
pi install npm:@lukisxyz/pi-core-subagent
```

Try one without adding it permanently:

```bash
pi -e npm:@lukisxyz/pi-core-vision
```

> [!IMPORTANT]
> Pi extensions run with your full user permissions. Review an extension before installing it from any
> third party.

## 📦 Core extensions

| Package | Use it for |
| --- | --- |
| [`@lukisxyz/pi-core-ask`](packages/core/pi-core-ask) | Structured up-to-4-question questionnaire tool |
| [`@lukisxyz/pi-core-skill-tool`](packages/core/pi-core-skill-tool) | Skills catalog, lazy `skill` tool |
| [`@lukisxyz/pi-core-subagent`](packages/core/pi-core-subagent) | Fast in-process subagents, dependency scheduler |
| [`@lukisxyz/pi-core-todo`](packages/core/pi-core-todo) | Flat/nested todos, direct-child progress, bounded tree UI + blockedBy |
| [`@lukisxyz/pi-core-tps-stats`](packages/core/pi-core-tps-stats) | Live tokens-per-second stats |
| [`@lukisxyz/pi-core-vision`](packages/core/pi-core-vision) | Vision fallback for text-only models |

## 🧩 Add-on extensions

| Package | Purpose for |
| --- | --- |
| [`@lukisxyz/pi-add-9router`](packages/add/pi-add-9router) | 9router provider registration + model discovery |
| [`@lukisxyz/pi-add-code-diagnostic`](packages/add/pi-add-code-diagnostic) | Repo-scoped typecheck/lint diagnostics |
| [`@lukisxyz/pi-add-commandcode`](packages/add/pi-add-commandcode) | Command Code Provider API: 58 models, dual-endpoint routing, ZDR |
| [`@lukisxyz/pi-add-mode`](packages/add/pi-add-mode) | Named modes: instructions + tools + model + subagent model, `/mode` and `ctrl+tab` |
| [`@lukisxyz/pi-add-vantis`](packages/add/pi-add-vantis) | Vantis integration |
| [`@lukisxyz/pi-add-wafer`](packages/add/pi-add-wafer) | Wafer integration |
| [`@lukisxyz/pi-senja`](packages/add/pi-senja) | Haiku-style header/footer with the Gruvbox Material Senja palette |

## 🔧 Manage the set

The [toolset](packages/pi-toolset) manages the installed extension set.

```bash
pi-toolset install   # install core set
pi-toolset add <pkg> # add an extra extension
pi-toolset update    # update installed
pi-toolset remove    # remove an extension
```

## 🛠 Development

```bash
npm install                 # hoist all workspaces
npm run check               # typecheck every package
```

Publish a package from its workspace directory (published to the `@lukisxyz` scope):

```bash
cd packages/core/pi-core-subagent && npm version patch && npm publish
```

To release a new extension: add the package under `packages/core/` or `packages/add/` and list it in the
relevant table above.

## License

MIT. Each package carries its own `LICENSE` and may include fork attribution.