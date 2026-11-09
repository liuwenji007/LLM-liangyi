# 投稿

两仪只收能核对的事。维护者把 Issue 收成 PR，构建通过后才会出现在时间线上。

## 收什么

- 有公开来源。官方博客、论文、监管文件、署名报道都可以。聊天截图单独不能作为来源。
- 有明确日期。写事件发生的那天。
- 说的是模型或它的公开发布，不是公司人事八卦。
- 暗史要尽量写上事后：厂商、监管方或法院做了什么。没有就写「没有就此发表公开说明」。

## 收录规则

| 情况 | 处理 |
|---|---|
| 用户误用模型造成的事（律师用 ChatGPT 编判例、员工把代码贴进 ChatGPT） | 可以收，`category` 里加 `误用`，严重程度最多 3，卡片上显示「误用」 |
| 厂商主动披露的测试结果（系统卡里的红队实验） | 可以收，`category` 加 `自披露`，严重程度最多 2，卡片上显示「厂商自披露」 |
| 厂商博客、发布页、系统卡，没有第三方核验 | 可以直接收。`basis: official`，卡片显示「官方宣布」。`/收` 时写 `依据: 官方`。明史未写时默认就是这个 |
| 署名媒体、监管或法院原文核过的说法 | `basis: independent`，卡片显示「第三方证实」。`/收` 时写 `依据: 第三方`。暗史未写时默认这个 |
| 平台方的问题（GitHub 误标某个组织） | 不收进暗史 |
| `response` 字段 | 只写厂商、监管方或法院做了什么，编者评论不进这个字段 |

误用和自披露的上限由构建检查，超过会失败。

## 不收什么

- 来源之间互相矛盾、又无法判断的说法。
- 伪造的对话截图，或把梗图当成证据。
- 针对某个员工、研究者或用户个人的攻击。模型和公司可以写，人不可以拿来开涮。
- 人事八卦、梗图、纯舆论不进编年主轴。它们可以成为乐子候选，但 `verified` 仍由维护者决定，脚本不会自动上线。

## 严重程度

只用于暗史，必填。明史不填。

| 等级 | 含义 | 例子 |
|---|---|---|
| 1 | 公开争议，没有明确事故 | GPT-2 暂不公开完整模型 |
| 2 | 小范围的错误或尴尬，厂商自披露的测试 | Claude Opus 4 系统卡的勒索实验 |
| 3 | 明确的产品事故，或用户误用造成的后果 | R1 自称 ChatGPT；三星员工泄露代码 |
| 4 | 大范围事故，伴随回滚、下线或股价、商誉上的明显损失 | Bard 发布广告答错；Gemini 生图暂停 |
| 5 | 隐私暴露、人身相关伤害，或被监管紧急限制 | ChatGPT 3 月 20 日故障；意大利限制 ChatGPT 和 DeepSeek |

暗点的大小跟着严重程度变。

## 关联到发布

暗史可以用 `related` 指向一条明史的编号（YAML 文件名），表示「这次翻车出在哪次发布之后」。

```yaml
side: dark
related: gpt-4o-2024
```

- 只有暗史填 `related`，只能指向明史。
- 暗史日期不能早于被指向的明史。
- 编号不存在、指向的不是明史、日期倒置时，构建失败。厂商不同只打印警告（例如必应用的是 OpenAI 模型）。
- 卡片上会显示「GPT-4o 发布后第 7 天」，明史卡片上反查出「之后：N 次翻车」。
- 对应不到某一次发布的（例如针对训练数据的诉讼），不填。

## 事件怎么入库

1. 用 Issue 模板「投稿事件」，或在本地执行 `pnpm draft <链接>`。
2. 草稿的 `verified` 保持 `false`。这种文件可以先进仓库，页面上不会显示。
3. 维护者改写摘要、补上真实存在的存档链接，确认无误后把 `verified` 改成 `true`。没有可用的存档快照就不填 `archive`，不要按日期拼地址。
4. 打开 PR。缺来源、字段类型不对或违反上面的规则时，构建会失败。

## 主动收集与排队

当前阶段先做「发现 → 排队 → 人工点头」，副轴 UI 和 `fun` 数据目录暂缓。

`pnpm collect` 扫描已审核信源：AIHOT 公开 API，以及 `src/data/sources.yaml` 里写了 `feed` 的 RSS。已在事件里出现过的链接会去掉。结果在 `reports/collect/candidates.md`，只是线索。

`pnpm triage` 用模型把线索分成编年、乐子、丢弃。编年每次最多开 2 个 Issue。乐子只写入 `reports/collect/triage.md`，不开 Issue。丢弃的同样只留在报告里。`collect` / `triage` / `draft` 不会把 `verified` 改成 `true`。维护者评论 `/收` 才会开草稿 PR。

标签（脚本会补建）：`候选/编年`。`候选/乐子` 只留给以后的副轴，现在不再使用。

```bash
pnpm collect                 # 默认最近 7 天
pnpm collect --window 24h
pnpm triage                  # 读 candidates.json，粗分并开 Issue
```

没有 `feed` 的信源不会自动扫。要加入巡视，在该条上补 RSS/Atom 地址。Actions「主动收集」每周一 UTC 01:00（北京时间约 9 点）跑最近 8 天，也可以手动触发。编年每次仍只新开 2 条；没开成 Issue、且还在窗口里的，下次会再排队。

### 采集节奏

日更管道服务不了一个一年只发几十条的产品：每天 5 条候选会在两周内堆出一百多条没人处理的队列。所以采集按周跑，`triage` 每次只开 2 条，剩下的靠 `pnpm queue` 在本地筛。要提高产量就加高质量条目，不要加采集频率。需要仓库 Secret `DEEPSEEK_API_KEY`。

### 规则前置过滤

`src/data/prefilter.yaml` 在 `collect` 与 `triage` 之间砍掉一眼不该进编年的线索：客户案例、教育公益资助、数据中心投资、人事与并购、月度汇总。命中的不进 `triage`、不占每次的 2 条限额，明细写在 `reports/collect/candidates.md` 的「规则丢弃」一节。

`action: drop` 直接丢；`action: hold` 留在报告里但不开 Issue，用来观察一条规则是不是砍得太狠。

`keep` 只豁免与它同类的那一半：写 `title` 的 keep 只压住标题类规则，URL 规则照旧生效（否则「Introducing Gemini for Education」会从教育栏目那条 URL 规则底下逃出去）；写 `url` 的 keep 才是全部豁免。改规则前先看被丢的清单，不要为了追求干净把真事件砍掉。

`--window` 认任意 `Nd` 或 `Nh`，`pnpm collect --window 8d` 就真的是八天。

### 预审台

候选 Issue 堆起来之后，逐个打开判断「要不要」比核对本身更花时间。`pnpm queue` 把开放候选压成一张单子：

> 脚本名不能叫 `precheck`：pnpm 会为每个脚本跑 `pre<名字>` 钩子，`pnpm check` 就会连带执行它，CI 会直接跑挂。

```bash
pnpm queue                             # 读开放候选 Issue（需要 GITHUB_TOKEN）
pnpm queue --limit 20                  # 只看最新的 20 条
pnpm queue --from issues.json          # 离线：喂一份 issue 列表 JSON
pnpm queue --render-only               # 只重画页面，不重新调用模型
pnpm queue --draft 124                 # 用预审结果写草稿并开 PR（不开 /收 也能走）
pnpm queue --draft 124 --force         # 覆盖已存在的 draft/issue-124 分支
```

它对每条候选做三件事：抓原文（站点返回 403 时改用它自己的 RSS 导语，openai.com 就是这种情况）、按 `prefilter.yaml` 判一次规则、再让模型给出「收 / 不收 / 待定 + 明暗 + 中文标题摘要 + 查重」。结果在 `reports/precheck/index.html`：按建议收排序，每条一屏，带「复制 /收」和「复制 /丢」按钮。

默认走本机模型，不产生 API 费用：

```bash
PRECHECK_BASE_URL=http://127.0.0.1:8000/v1 \
PRECHECK_MODEL=rapid-mlx/Qwen3.8-27B-4bit-MTP-MLX \
pnpm queue
```

`--draft` 直接拿预审字段写 `verified: false` 的 YAML 并开 PR，省掉手工补厂商型号摘要那一遍。它在开 PR 前会做四件事：原文 URL 已在库里就拒绝（不让同一事件出现两份）、`related` 必须指向库里的明史且不晚于本条、暗史缺 `response` 时提醒你在 PR 里补一句、信源是厂商就给 `basis: official`。

五个约束写在脚本里，别绕过：只有 RSS 导语时不给出「高」把握；暗史缺 `severity` 的一律降成「待定」；`dup_of` 命中已入库条目的不给 `/收`；原文已在库的不给开第二份；`verified` 任何情况下都不动。

每次预审会在 `reports/precheck/runs/` 留一份快照（只留最近 30 次）。`queue.json` 会被下一次覆盖，想查「当时为什么判不收」翻 `runs/`。

### 每周处理

1. `pnpm queue`，打开 `reports/precheck/index.html`，先点「只看建议收」，处理那几条。
2. 要收：在候选 Issue 下评论 `/收`（仅维护者）。建议面是「待定」时必须写 `/收 明` 或 `/收 暗`，不会默认按暗史起草。Actions 抓原文、写 `verified: false` 的 YAML、开 PR，并在同一轮对照来源、跑 `pnpm check`。
3. 采集页只有摘要、或官网拒抓时，在 `/收` 下面写 `来源: https://真站`（也可单独贴一行 URL），再贴标题和摘要。只要评论里有正文或改了来源，就不会去抓页面。卡片用你写的正文，Issue 的 `source:` 会改成真站。只写 `/收`、不贴正文时才会抓 Issue 里的原链接。
4. 链接已入库，或抓不到页面且评论里没有手写摘要时，只留言，不开第二份。`/丢` 关掉的链接不会再开出来。已经有草稿时，新发一条 `/收` 会在原分支上更新标题、摘要和链接，并留下你补过的厂商、模型和严重程度。只编辑旧评论不会更新。
5. 草稿 PR 会跑 CI。暗史必须补 `severity`。厂商、模型、标题、摘要还是「待补充」时，`/核实` 会拒绝。一次只核实一份事件。通过后才把 `verified` 改成 `true`，不合并不部署。然后你合并。PR 写了 `Closes #编号`，合并后 Issue 会关上。
6. 合并不等于上线。拉下 `main` 后在本机执行 `pnpm deploy:server`。`verified: false` 的条目即使部署也不会出现在时间线上。
7. 不要收：在候选 Issue 评论 `/丢`。普通投稿/勘误帖上的 `/丢` 无效。旧的 `候选/乐子` 上 `/收` 会被拒绝，新的收集不再开这类 Issue。
8. 本机仍可用 `pnpm draft <链接>`。勘误 Issue 只处理已经上线的条目。

## AI 审查

维护者核对前，先让 DeepSeek 对照来源原文过一遍：日期是否一致、摘要里哪些句子在来源里找不到依据、严重程度是否符合标尺、`related` 对不对、有没有违反收录规则。结论分通过、存疑、不通过三档，维护者重点看后两档。

AI 结论只作参考，`verified` 仍由维护者决定。

- **PR**：改动 `src/data/events/` 的 PR 会自动审查，报告贴在 PR 评论里。需要在仓库 Settings → Secrets 里加 `DEEPSEEK_API_KEY`。
- **全量**：在 Actions 页面手动运行「AI 审查」，可以填事件编号，留空审查全部。报告在运行摘要里，建议修改在 artifact 里。
- **本地**：

```bash
cp .env.example .env          # 填上 DEEPSEEK_API_KEY
pnpm review                   # 审查全部，报告在 reports/review/report.md
pnpm review sky-voice-2024    # 只审查指定的几条
pnpm review:apply sky-voice-2024   # 确认后把建议写进 YAML
```

国内网络抓不到 Google、BBC、Reuters 等来源，本地运行时走代理：

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 pnpm review
```

直连失败时，脚本会依次尝试 `archive` 存档和 r.jina.ai 阅读服务（设 `REVIEW_READER=off` 可关闭）。仍然抓不到的来源会标成「无法核对」，这一条至少是存疑。

## 梗图怎么入库

1. 用 Issue 模板「投稿梗图」，把图片拖进正文。
2. 维护者把图转成 WebP，放到 `public/memes/<事件编号>/`。
3. 在该事件的 YAML 里加上作者、标题和文件名。文件不存在时构建失败。
4. 提交 PR。合并后静态站自动更新。

梗图区域固定标着「二创」和「梗图不是证据」。

## 勘误与申诉

发现错误，或者你是条目涉及的厂商、当事人，想补充回应，用 Issue 模板「勘误与申诉」。核实后直接更正条目，在提交记录里写明改了什么。
