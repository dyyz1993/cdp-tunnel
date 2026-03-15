# 发布到 npm 指南

## 自动发布（推荐）

本项目已配置 GitHub Actions，支持自动发布到 npm。

### 配置步骤

1. **获取 npm Token**
   - 登录 [npmjs.com](https://www.npmjs.com/)
   - 进入 Account → Access Tokens
   - 生成新的 **Automation** token
   - 复制 token（以 `npm_` 开头）

2. **添加到 GitHub Secrets**
   - 打开 GitHub 仓库 → Settings → Secrets and variables → Actions
   - 点击 "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: 刚才复制的 npm token
   - 点击 "Add secret"

3. **发布新版本**
   - 在 GitHub 上创建新的 Release
   - 设置版本号（如 v1.0.1）
   - 填写发布说明
   - 点击 "Publish release"
   - GitHub Actions 会自动发布到 npm

### 手动触发

也可以在 GitHub Actions 页面手动触发发布：
- 进入 Actions → Publish to npm
- 点击 "Run workflow"

## 手动发布

如果不想使用 GitHub Actions，也可以手动发布：

```bash
# 1. 登录 npm
npm login

# 2. 更新版本号
npm version patch  # 或 minor / major

# 3. 发布
npm publish --access public
```

## 版本号规则

- `patch`: 修复 bug（1.0.0 → 1.0.1）
- `minor`: 新增功能（1.0.0 → 1.1.0）
- `major`: 重大更新（1.0.0 → 2.0.0）

## 验证发布

发布后可以在 npm 上查看：
https://www.npmjs.com/package/cdp-tunnel

安装测试：
```bash
npm install -g cdp-tunnel
cdp-tunnel --version
```
