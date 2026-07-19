# 📁 项目结构重构指南

## 🎯 **理想的项目结构**

```
memos-cloudflare/
├── backend/                # 🔧 Cloudflare Workers 后端
│   ├── src/
│   │   ├── routes/
│   │   ├── middleware/
│   │   ├── types/
│   │   └── index.ts
│   ├── wrangler.toml
│   ├── package.json
│   └── tsconfig.json
├── frontend/               # 🎨 前端代码（仅 web 部分）
│   ├── src/
│   ├── public/
│   ├── dist/
│   ├── package.json
│   ├── vite.config.mts
│   └── _routes.json
├── .github/workflows/      # 🚀 CI/CD 配置
├── README.md
└── docs/                   # 📚 项目文档
```

## 🚀 **重构步骤**

### 1. 创建新的目录结构

```bash
# 在项目根目录创建新结构
mkdir backend frontend docs

# 移动后端代码
mv src backend/
mv wrangler.toml backend/
mv package.json backend/
mv tsconfig.json backend/
mv package-lock.json backend/

# 复制前端代码（仅需要的部分）
cp -r memos-main/web/* frontend/

# 移动部署配置
mv memos-main/web/_routes.json frontend/
```

### 2. 更新 GitHub Actions 配置

更新 `.github/workflows/deploy.yml`：

```yaml
name: Deploy to Cloudflare

on:
  push:
    branches: [main]

jobs:
  deploy-backend:
    name: Deploy Backend (Workers)
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'
          cache-dependency-path: backend/package-lock.json
          
      - name: Install backend dependencies
        run: npm ci
        working-directory: backend
        
      - name: Deploy Workers
        run: npx wrangler deploy
        working-directory: backend
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          
  deploy-frontend:
    name: Deploy Frontend (Pages)
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - uses: pnpm/action-setup@v2
        with:
          version: latest
          
      - name: Install frontend dependencies
        run: pnpm install
        working-directory: frontend
        
      - name: Build frontend
        run: pnpm build
        working-directory: frontend
        env:
          VITE_API_BASE_URL: ${{ vars.VITE_API_BASE_URL }}
          
      - name: Deploy to Pages
        uses: cloudflare/pages-action@v1
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          projectName: memos-frontend
          directory: frontend/dist
```

### 3. 更新 Cloudflare Pages 配置

新的构建设置：
```
Build command: pnpm install && pnpm build
Build output directory: dist
Root directory: frontend
```

### 4. 清理不需要的文件

```bash
# 删除原始的大型目录
rm -rf memos-main

# 删除调试文件
rm -rf debug-*.js test-*.js *.sh

# 更新 .gitignore
```

## 📋 **具体执行脚本**

### 自动重构脚本

```bash
#!/bin/bash

echo "🔧 开始项目重构..."

# 创建新目录
mkdir -p backend frontend docs

# 移动后端文件
echo "📦 移动后端文件..."
mv src backend/
mv wrangler.toml backend/
mv package.json backend/
mv tsconfig.json backend/
mv package-lock.json backend/

# 复制前端文件
echo "🎨 复制前端文件..."
cp -r memos-main/web/* frontend/

# 移动文档
echo "📚 整理文档..."
mv *.md docs/
mv docs/README.md ./

# 清理不需要的文件
echo "🧹 清理文件..."
rm -rf memos-main
rm -rf debug-*.js test-*.js manual-*.js comprehensive-*.js
rm -rf *.sh

echo "✅ 重构完成!"
echo ""
echo "新的项目结构："
tree -I 'node_modules|.git' -L 3
```

## 🎯 **重构后的优势**

1. **清晰分离**: 前端和后端代码完全分离
2. **体积减小**: 移除不需要的 Go 代码，减少仓库大小
3. **易于维护**: 每个部分都有独立的配置
4. **构建优化**: 分别优化前端和后端的构建流程
5. **团队协作**: 前端和后端开发者可以专注各自领域

## 📝 **需要更新的配置**

### Backend (backend/wrangler.toml)
```toml
name = "memos-cloudflare-backend"
main = "src/index.ts"
```

### Frontend (frontend/package.json)
```json
{
  "name": "memos-frontend",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }
}
```

## 🚀 **执行重构**

1. 运行重构脚本
2. 更新 GitHub Actions 配置
3. 更新 Pages 构建设置
4. 重新提交和推送
5. 测试部署流程

**准备好开始重构了吗？** 🎯 