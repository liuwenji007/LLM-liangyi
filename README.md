# 两仪

中文世界有出处的大模型翻车史，配上同一时期的发布作对照。

线上地址：[https://llmliangyi.com](https://llmliangyi.com)

一条时间线，两面。明史记发布与节点，暗史记翻车与事后。在明史里，暗史缩成时间轴上的暗点；在暗史里，明史缩成亮点。靠近一个点会露出一张小纸条，想看全貌就翻过去。点太极整体切换。

## 地址参数

```text
https://llmliangyi.com/?side=dark&vendor=OpenAI#gpt-4o-sycophancy-2025
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

## AI 审查

```bash
cp .env.example .env    # 填上 DEEPSEEK_API_KEY
pnpm review             # 对照来源核查全部事件，报告在 reports/review/
```

PR 改动事件时会自动审查并在评论里贴报告。细节见 [CONTRIBUTING.md](CONTRIBUTING.md#ai-审查)。

候选太多时先过一遍预审台（本地模型跑，不动 `verified`），见下面「维护者操作」。

## 维护者操作

候选和草稿是两回事，处理方式不一样。

**候选 Issue**（`候选/编年` 标签）

```bash
pnpm queue                  # 预审台：开放候选压成一张单子，页面在 reports/precheck/index.html
pnpm queue --draft 124      # 按预审结果写草稿并开 PR，verified 仍是 false
```

在 Issue 里评论（只有仓库维护者有效）：`/收` 起草，面待定时写 `/收 明` 或 `/收 暗`，`/丢` 关闭。

**草稿 PR**

| 情况 | 怎么做 |
|---|---|
| 该收 | 改 YAML 字段 → **在本 PR 评论 `/核实`** → 合并 → 本机 `pnpm deploy:server` |
| 不该收 | 关 PR，**并且关掉它对应的 Issue**；只关 PR 的话链接还在队列里，下次采集还会撞上它 |
| 字段全是「待补充」 | 先用 `pnpm queue --draft <issue 号> --force` 重写这份草稿，再按第一行走 |

`/核实` 只在 PR 上有效，而且**必须在合并之前**。合并后的 PR 不能再走这个通道，`verified` 会一直是 `false`，条目不会出现在时间线上。

改摘要不用另外开 PR，写在 `/核实` 下面就行，会先改再核：

```text
/核实
摘要: Google 发布 Gemini 4 Carbon，称其在网络安全与长程任务上最强，Artificial Analysis 得分 59 排名第一，本周起先向网络安全防御者开放，定价与 Argon 相同。
标题: Gemini 4 Carbon 发布，先向网络安全防御者开放
```

认 `摘要`、`标题`、`厂商`、`型号`、`严重程度`（1–5），只写要改的那几行。

顺序记成一条线：

```text
候选 Issue → 草稿 PR → /核实（翻 verified）→ 合并 → pnpm deploy:server
```

少了 `/核实` 那一步，前面全做了也看不见。细节见 [CONTRIBUTING.md](CONTRIBUTING.md#每周处理)。

## 投稿

规则在 [CONTRIBUTING.md](CONTRIBUTING.md)。仓库里有三个 Issue 模板：投稿事件、投稿梗图、勘误与申诉。网站页脚的链接会直接打开对应表单。

## 部署

本站部署在腾讯云，域名 `llmliangyi.com`。本地发布：

```bash
# 在 .deploy.env 里写好 DEPLOY_HOST 和 DEPLOY_PATH（已被 git 忽略）
pnpm deploy:server
```

构建产物在 `dist/`。分享卡片的图片是 `public/og.png`，绝对地址由 `astro.config.mjs` 里的 `site` 拼出。

也可用 Cloudflare Pages 或 Vercel：构建命令 `pnpm build`，输出目录 `dist`，Node 22。

## 免责声明

本站整理公开报道，不代表对任何公司或个人的法律评价。每条事件都附来源；「事后」只写厂商、监管方或法院做了什么。梗图是社区二创，不是证据。内容有误或需要补充回应，请提交「勘误与申诉」。

## 许可

代码 MIT，事件内容 CC BY-NC 4.0，梗图版权归各自作者。详见 [LICENSE](LICENSE)。
