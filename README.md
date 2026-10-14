# 两仪

中文世界有出处的大模型翻车史，配上同一时期的发布作对照。

一条时间线，两面。明史记发布与节点，暗史记翻车与事后。在明史里，暗史缩成时间轴上的暗点；在暗史里，明史缩成亮点。靠近一个点会露出一张小纸条，想看全貌就翻过去。点太极整体切换。

## 地址

```text
/?side=dark&vendor=OpenAI#gpt-4o-sycophancy-2025
```

- `side=dark` 打开暗史，省略为明史。
- `vendor` 是厂商筛选，不是现有厂商时忽略。
- `#id` 定位到某一条，id 就是 YAML 文件名。只有 `#id` 时按这条所在的那一面打开；被筛选挡住时忽略筛选。

卡片上的「复制链接」给出的就是这种地址。

## 本地

需要 Node.js 22 和 pnpm 9。

```bash
pnpm install
pnpm dev
pnpm check
pnpm build
```

事件放在 `src/data/events/`，一条一个 YAML。页面只显示 `verified: true` 的条目。缺来源、`related` 指向不对、梗图文件不存在时构建失败。

从一篇报道起草稿：

```bash
pnpm draft https://example.com/story
```

脚本抓取标题和日期，向 archive.org 请求存档，并写出 `verified: false` 的 YAML。日期、厂商、摘要和严重程度都要人工再看一遍。

## 投稿

规则在 [CONTRIBUTING.md](CONTRIBUTING.md)。仓库里有三个 Issue 模板：投稿事件、投稿梗图、勘误与申诉。

把 `src/config.ts` 里的 `repositoryUrl` 改成实际仓库地址后，页面上的链接会打开对应模板。

## 部署

构建产物在 `dist/`。分享卡片的图片是 `public/og.png`，地址按 `astro.config.mjs` 里的 `site` 拼成绝对地址，换域名时一起改。

Cloudflare Pages：连接这个仓库，构建命令 `pnpm build`，输出目录 `dist`，Node 22。合并到主分支后自动发布。

Vercel：导入仓库即可。`vercel.json` 写了同样的构建命令和输出目录，框架选 Astro。

## 免责声明

本站整理公开报道，不代表对任何公司或个人的法律评价。每条事件都附来源；「事后」只写厂商、监管方或法院做了什么。梗图是社区二创，不是证据。内容有误或需要补充回应，请提交「勘误与申诉」。

## 许可

代码 MIT，事件内容 CC BY-NC 4.0，梗图版权归各自作者。详见 [LICENSE](LICENSE)。
