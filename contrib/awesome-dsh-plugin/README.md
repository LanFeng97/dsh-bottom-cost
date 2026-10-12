# awesome-dsh-plugin 投稿材料

这里放的是给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的**条目文件**。
这份清单是 DSH 插件市场的目录数据源——我在本机 dshmarket 里查到 `regions.js:63` 的
`CATALOG_OFFICIAL = 'https://awesome-dsh-plugin.com/plugins.json'`，即：

```
清单仓库的 data/plugins/*.yml
  → 生成两个 README + 发布 plugins.json
  → dshmarket 的官方目录
  → 用户在市场里搜到并一键安装
```

所以收录与否直接决定「别人能不能一键装到」。

## 一条会拦住的规则

**仓库创建满 1 天**（由 CI 自动检查）。本插件仓库建于 `2026-10-12T18:48:36Z`
（北京时间 2026-10-13 02:48:36），因此**门槛时刻是北京时间 2026-10-14 02:48:36**。
提前提交会被 CI 拒——拒了不影响重新提交，但没必要。

其余自查（均已满足）：`package.json` 声明了 `dsh.bundle` 且根目录有 `cordis.patch.yml`；
仓库有真实代码与自测；已加 `dsh-plugin` topic；描述不带营销词、与代码相符。

分类选 `usage`：清单的 `category` 取值里 `usage` 就是从 `tools` 拆出来的那一类，
本插件算的是 token 花费与用量，正落在它里面。

## 投稿方式一：常规 git 路线（人在本地时用）

```sh
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
cp <本目录>/LanFeng97__dsh-bottom-cost.yml data/plugins/
git checkout -b add-dsh-bottom-cost
git add data/plugins/LanFeng97__dsh-bottom-cost.yml
git commit -m "Add dsh-bottom-cost"
git push -u origin add-dsh-bottom-cost
gh pr create --title "Add dsh-bottom-cost" --body "Cost chip for the DSH composer stats row."
```

**只加一个文件**：清单的两个 README 由 `data/plugins/*.yml` 生成，手工编辑会被 CI 拦；
一个插件一个文件也正是 PR 之间不会互相冲突的原因。

## 投稿方式二：纯 gh api 路线（本仓库的定时任务用的就是它）

为什么不用方式一：在本机的 DSH 沙箱里 `git push` 会因为
`schannel: AcquireCredentialsHandle failed` 拿不到 TLS 凭据而失败（`gh api` 走 Go 自带 TLS，正常）。
所以无人值守时全程走 GitHub API，不碰 git：

```sh
# 0) fork（只需一次；已建过就跳过）
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false

# 1) 取默认分支 HEAD 的 sha
gh api repos/LanFeng97/awesome-dsh-plugin/git/ref/heads/main --jq '.object.sha'

# 2) 建分支（**必须先建**：Contents API 不会自动建分支，直接 PUT 会报
#    "Branch ... not found"——这一条是实测踩出来的）
#    POST /repos/LanFeng97/awesome-dsh-plugin/git/refs
#    body: { "ref": "refs/heads/add-dsh-bottom-cost", "sha": "<上一步的 sha>" }

# 3) 在分支上落文件（content 是 base64）
#    PUT /repos/LanFeng97/awesome-dsh-plugin/contents/data/plugins/LanFeng97__dsh-bottom-cost.yml
#    body: { "message": "Add dsh-bottom-cost", "content": "<base64>", "branch": "add-dsh-bottom-cost" }

# 4) 从 fork 的分支向上游 main 开 PR
#    POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls
#    body: { "title": "Add dsh-bottom-cost", "head": "LanFeng97:add-dsh-bottom-cost", "base": "main", "body": "..." }
```

`gh api --method <M> --input <payload.json> <path>` 可以把请求体放进文件，
避免在 shell 里拼 JSON 与 base64 的引号。

## 合并之后

CI 是前置条件、不是结论；维护者会实际读一遍仓库再合并。合并后
`plugins.json` 会在 `main` 上重新生成，市场上即可搜到。

本插件的条目信息若日后需要更新（例如换了分类、改了描述），**只改自己那一条**：
编辑 `data/plugins/LanFeng97__dsh-bottom-cost.yml` 再开一个 PR，不要手工动 README。
