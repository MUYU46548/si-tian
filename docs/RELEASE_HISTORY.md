# 司天 · 发布版次对账（2026-10-25）

> 用途：回答“中间是不是有一些版本被我忘了发 / 被删了”。
> 判据只有三样：**`package.json` 的版本历史**（git log）、**本地 tag**、**GitHub 上现存的 release**。
> 时间口径：本机时区 Asia/Shanghai。

## 一、结论（先说答案）

**是“忘了发”，不是“被删了”。**

- GitHub 上现存 **3 个 release**：`v0.4.0`（2026-10-25）、`v0.1.3`（2026-08-29）、`v0.1.1`（2026-08-23）。
- 本地 tag 5 个：`v0.1.1` / `v0.1.3` / `v0.3.0` / `v0.4.0` / `archive/review-a3-online`。
- `package.json` 里**真正存在过**的版本（按 git 历史）：
  `0.1.0 → 0.1.1 → 0.1.3 → 0.1.5 → 0.1.6 → 0.1.7 → 0.1.8 → 0.1.9 → 0.2.4 → 0.2.5 → 0.2.6 → 0.2.7 → 0.2.8 → 0.2.9 → 0.3.0 → 0.4.0`

也就是说：

| 版本区间 | 打过 tag？ | 发过 release？ | 判定 |
|---|---|---|---|
| 0.1.0 | 否 | 否 | 首个内部版本，未公开 |
| 0.1.1 / 0.1.3 | 是 | **是** | 正常 |
| 0.1.5 – 0.2.9（共 10 个） | **否** | 否 | 只 bump 了版本号，**从未发过**（连 tag 都没有） |
| 0.3.0 | **是**（今天 12:02 打的） | **否** | tag 在，release 没建 |
| 0.4.0 | 是 | **是** | 正常 |

- `0.1.4` 与 `0.2.0`–`0.2.3` **从未在 `package.json` 里出现**（不是漏发，是当时压根没这几个版本号）。
- **删 release 不会删 tag**：`v0.3.0` 的 tag 还在，说明“没发”而不是“发过又被删”。
  （真要判断"删过"，只能看 GitHub 的审计日志——那需要仓库 owner 在网页上查，命令行看不到。）

## 二、现存缺陷：v0.4.0 的自动更新资产名对不上

`latest.yml`（v0.4.0）里写的是：

```yaml
version: 0.4.0
files:
  - url: sitian-setup-0.4.0.exe
    sha512: bPncVA0MhLcBaLbY9N69e23S3yjVqFLM+jTHW8Dwpn8gvxxWxt3s3Z5v26ChhJ+DsY/BlZCDYGU+vvh4cZWh16w==
    size: 79745507
path: sitian-setup-0.4.0.exe
```

而 release 上实际上传的资产叫 **`Setup.0.4.0.exe`**（sha256 与本地 `司天 Setup 0.4.0.exe` 一致，
说明包本身没坏，只是**名字**不一致）。

→ `electron-updater` 会去下载 `…/v0.4.0/sitian-setup-0.4.0.exe` → **404**，自动更新必然失败。
（0.4.0 的发布说明里已经写了"自动更新不可靠，建议手动装"，所以影响被这句话掩盖了，但缺陷仍在。）

**修法（二选一，都不用重传 80MB）：**

1. GitHub release 页面 → 资产右侧铅笔 → 把 `Setup.0.4.0.exe` 改名为 `sitian-setup-0.4.0.exe`
   （`latest.yml` 不用动）；`.blockmap` 同样改成 `sitian-setup-0.4.0.exe.blockmap`。
2. 或者用 `gh release upload v0.4.0 <文件> --clobber` 重新上传一份 ASCII 名资产。

> 纪律（下次发布前自查）：**`latest.yml` 里的 `path/url` 必须与 release 资产名逐字符一致**，
> 且资产名只用 ASCII。0.1.3 那次是对的（`SiTian-Setup-0.1.3.exe`）。

## 三、以后的发布纪律（建议）

1. **一个版本 = 一个 tag + 一个 release**：`npm run bump:minor` 之后立刻
   `git tag vX.Y.Z && git push origin main --tags`，再 `npx electron-builder --publish always`
   （让 electron-builder 自己按 `latest.yml` 的名字上传，不要手工取名）。
2. 发布说明落 `docs/RELEASE_NOTES_x.y.z.md`，release 用 `--notes-file` 引用同一份（单一事实源）。
3. 发完在 release 页核对三件事：`latest.yml` 在、exe 名与 `latest.yml` 一致、size 与本地一致。
4. 版本号 **不要跳号**（0.1.3 → 0.1.5 这种跳号会让"到底少了哪些版本"永远说不清）。

## 四、v0.5.2（2026-11-05）—— 第一次按纪律走完

| 项 | 值 |
|---|---|
| tag | `v0.5.2`（`f9e5669`，与 `main` 同步推送） |
| release | <https://github.com/MUYU46548/si-tian/releases/tag/v0.5.2>（**已发布，非 draft**） |
| 资产 | `sitian-setup-0.5.2.exe` 79,102,647 B（sha512 `CMLfti…`）、`sitian-setup-0.5.2.exe.blockmap` 83,515 B、`latest.yml` 340 B |
| 本地 ↔ 远端 | 发布后对资产做 HEAD：`Content-Length: 79102647`，与本地一致；`latest.yml` 里的 sha512 与本地文件逐位相同 |

做法上有两点是冲 0.4.0 那两个坑去的：

1. **资产名在源头钉死**：`build.nsis.artifactName = "sitian-setup-${version}.${ext}"` ——
   本地产出的文件名就是 `latest.yml` 里写的名字，不靠上传时改名
   （0.4.0 就是上传后变成 `Setup.0.4.0.exe`，与 `latest.yml` 对不上 → 自动更新 404）。
2. **发布前三道闸**：`node scripts/privacy-scan.mjs`（三作用域 0 命中）/
   `python scripts/tests/drill_diag_package.py` / `npm run test:packaged`（22 条：asar 内容、
   安装包内 `app.asar` 与本地构建 sha256 一致、打包版真机开示例 → 存盘 → 导诊断包）。

判定：`package.json` 版本 = 本地 tag = 远端 release tag = `latest.yml` 版本 = **0.5.2**，四处一致。
`0.5.0` / `0.5.1` 只 bump 过版本号，从未打 tag、从未发布（内部构建）。

已知遗留：**0.4.0 → 0.5.2 不能自动更新**（0.4.0 的资产名不匹配），需手动装一次；
0.5.2 之后链路是对的。
