# SiTian 发布流程

## 省流版

### 1. 开发调试

npm run dev:watch

### 2. 准备发布前 — 本地生产验证

npm run dist:dir
# 手动运行 release/win-unpacked/SiTian.exe 检查

### 3. 正式发布

npm run bump:patch        # 版本号 +1
npm run dist:publish      # 构建 + 上传 Release（需 GH_TOKEN）

---

## 安全可控的发布步骤

### 1. 版本 Bump

```bash
# 补丁版本 (0.1.0 → 0.1.1)
npm run bump:patch

# 次要版本 (0.1.0 → 0.2.0)
npm run bump:minor
```

### 2. 构建 + 本地验证

```bash
# 构建前端
npm run build

# 运行测试（17/17 全绿才可发布）
npm run test

# 生成本解包目录（不打包安装程序，快速验证）
npm run dist:dir
```

### 3. 发布到 GitHub Release

```bash
# 需要 GH_TOKEN 环境变量（GitHub Personal Access Token）
# 权限范围: repo (完整仓库访问)
GH_TOKEN=ghp_xxxx npm run dist:publish
```

### 4. GitHub Release 自动创建

electron-builder 自动：
1. 创建 draft release（基于 package.json version）
2. 上传 `SiTian Setup x.x.x.exe` + `latest.yml` + `SiTian Setup x.x.x.exe.blockmap`
3. 如果 draft 已存在，追加资产

### 5. 手动发布 Release

1. 访问 https://github.com/MUYU46548/si-tian/releases
2. 编辑 draft release，确认更新说明
3. 点击 "Publish release"

### 6. 客户端自动更新

用户启动应用后：
- electron-updater 从 GitHub Release 拉取 `latest.yml`
- 检测到新版本 → 弹出更新通知
- 用户确认 → 下载 → 退出安装

## 环境变量

| 变量 | 说明 | 获取方式 |
|------|------|----------|
| `GH_TOKEN` | GitHub Personal Access Token | GitHub Settings → Developer settings → Personal access tokens |

## 安全注意事项

1. **GH_TOKEN 不可嵌入代码**：仅在发布时通过环境变量传入
2. **仓库已公开**：客户端无需 token 即可下载 Release 资产
3. **Release 为 draft**：发布前可审核，避免误发
4. **blockmap 增量更新**：用户只下载变更块，节省带宽

## 版本号规范

遵循 [Semantic Versioning](https://semver.org/)：
- `MAJOR.MINOR.PATCH`
- MAJOR: 不兼容的 API 变更
- MINOR: 向后兼容的功能新增
- PATCH: 向后兼容的 Bug 修复
