import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';

import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/user';
import { memoRoutes } from './routes/memo';
import { tagRoutes } from './routes/tag';
import { resourceRoutes } from './routes/resource';
import { workspaceRoutes } from './routes/workspace';
import { webhookRoutes } from './routes/webhook';
import { authMiddleware } from './middleware/auth';
import { mountConnectRoutes } from './v2/router';
import { mountFileServer } from './v2/fileserver';
import './v2/services';

// 导入环境类型
import { Env } from './types';

// 创建 Hono 应用实例
const app = new Hono<{ Bindings: Env }>();

// 全局中间件
app.use('*', cors({
  origin: (origin, c) => {
    // 开发环境允许的域名
    const allowedOrigins = [
      'http://localhost:3001',
      'http://localhost:3000',
      'https://your-frontend-name.pages.dev'
    ];
    
    // 从环境变量获取允许的域名
    const envOrigins = c.env.ALLOWED_ORIGINS ? c.env.ALLOWED_ORIGINS.split(',') : [];
    const allAllowed = [...allowedOrigins, ...envOrigins];
    
    // 如果origin在允许列表中，或者是localhost，则允许
    if (!origin || allAllowed.includes(origin) || origin.includes('localhost')) {
      return origin;
    }
    
    // 如果是以 *.pages.dev 结尾的域名，也允许（Cloudflare Pages）
    if (origin && origin.includes('.pages.dev')) {
      return origin;
    }
    
    // 默认允许第一个环境变量域名，或者直接返回origin（更宽松的策略）
    return origin || envOrigins[0] || allowedOrigins[0];
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Connect-Protocol-Version / Connect-Timeout-Ms 为 @connectrpc/connect-web 必发头，
  // X-Retry 为前端 401 重试标记——缺一个都会导致浏览器 CORS 预检失败
  allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Connect-Protocol-Version', 'Connect-Timeout-Ms', 'X-Retry'],
  exposeHeaders: ['X-Request-Id'],
  credentials: true,
  maxAge: 86400
}));

app.use('*', logger());
app.use('/api/*', prettyJSON());

// 健康检查端点
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'memos-cloudflare',
    version: '0.2.0'
  });
});

// ===== v2: Connect JSON API（对齐上游 Memos v0.29，前端 v0.29.1 使用） =====
mountConnectRoutes(app);
mountFileServer(app);

// ===== v1 legacy REST 路由（对应旧版 v0.24 前端，过渡期保留） =====
// 先注册公开的路由
app.route('/api/auth', authRoutes);

// workspace 路由 - /profile 和 /setting GET 端点是公开的
app.route('/api/workspace', workspaceRoutes);

// 需要认证的路由
app.use('/api/user/*', authMiddleware);
app.use('/api/tag/*', authMiddleware);
app.use('/api/resource/*', authMiddleware);
app.use('/api/webhook/*', authMiddleware);

// memo 路由需要部分认证
app.use('/api/memo', authMiddleware);
app.post('/api/memo/*', authMiddleware);
app.patch('/api/memo/*', authMiddleware);
app.delete('/api/memo/*', authMiddleware);

app.route('/api/user', userRoutes);
app.route('/api/memo', memoRoutes);
app.route('/api/tag', tagRoutes);
app.route('/api/resource', resourceRoutes);
app.route('/api/webhook', webhookRoutes);

// 文件下载路由 (不在 /api 下)
app.get('/o/r/:uid/:filename', async (c) => {
  try {
    const { uid, filename } = c.req.param();
    
    // 查询资源信息
    const resource = await c.env.DB.prepare(
      'SELECT * FROM resource WHERE uid = ?'
    ).bind(uid).first();

    if (!resource) {
      return c.json({ message: 'Resource not found' }, 404);
    }

    // 检查 R2 绑定是否存在
    if (!c.env.R2) {
      return c.json({ message: 'R2 bucket not configured' }, 500);
    }

    // 从 R2 获取文件
    const r2Key = `${uid}/${filename}`;
    const object = await c.env.R2.get(r2Key);

    if (!object) {
      return c.json({ message: 'File not found in storage' }, 404);
    }

    // 返回文件内容
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Length': object.size.toString(),
        'Cache-Control': 'public, max-age=31536000',
      },
    });
  } catch (error: any) {
    console.error('File download error:', error);
    return c.json({ message: 'Internal server error' }, 500);
  }
});

// 404 处理
app.notFound((c) => {
  return c.json({ message: 'Not Found' }, 404);
});

// 错误处理
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ 
    message: 'Internal Server Error',
    ...(c.env.LOG_LEVEL === 'debug' && { error: err.message })
  }, 500);
});



export default app; 