import { Hono } from 'hono';
import type { Env, Variables } from '../types';

const tagRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// 获取用户的标签列表
tagRoutes.get('/', async (c) => {
  try {
    const userPayload = c.get('user');
    if (!userPayload) {
      return c.json({ message: 'Unauthorized' }, 401);
    }

    // 获取用户ID
    const user = await c.env.DB.prepare(
      'SELECT id FROM user WHERE uid = ?'
    ).bind(userPayload.sub).first();

    if (!user) {
      return c.json({ message: 'User not found' }, 404);
    }

    const tags = await c.env.DB.prepare(`
      SELECT t.*, COUNT(mt.memo_id) as memo_count
      FROM tag t
      LEFT JOIN memo_tag mt ON t.id = mt.tag_id
      WHERE t.creator_id = ?
      GROUP BY t.id, t.name, t.created_ts, t.creator_id
      ORDER BY t.name ASC
    `).bind(user.id).all();

    return c.json(tags.results || []);

  } catch (error) {
    console.error('Get tags error:', error);
    return c.json({ message: 'Internal server error' }, 500);
  }
});

// 创建标签
tagRoutes.post('/', async (c) => {
  try {
    const userPayload = c.get('user');
    if (!userPayload) {
      return c.json({ message: 'Unauthorized' }, 401);
    }

    const { name } = await c.req.json();
    
    if (!name || !name.trim()) {
      return c.json({ message: 'Tag name is required' }, 400);
    }

    // 获取用户ID
    const user = await c.env.DB.prepare(
      'SELECT id FROM user WHERE uid = ?'
    ).bind(userPayload.sub).first();

    if (!user) {
      return c.json({ message: 'User not found' }, 404);
    }

    // 检查标签是否已存在
    const existingTag = await c.env.DB.prepare(
      'SELECT id FROM tag WHERE creator_id = ? AND name = ?'
    ).bind(user.id, name.trim()).first();

    if (existingTag) {
      return c.json({ message: 'Tag already exists' }, 409);
    }

    const now = Math.floor(Date.now() / 1000);

    // 创建标签
    const result = await c.env.DB.prepare(`
      INSERT INTO tag (creator_id, name, created_ts)
      VALUES (?, ?, ?)
    `).bind(user.id, name.trim(), now).run();

    if (!result.success) {
      throw new Error('Failed to create tag');
    }

    // 返回创建的标签
    const newTag = await c.env.DB.prepare(
      'SELECT * FROM tag WHERE id = ?'
    ).bind(result.meta.last_row_id).first();

    if (!newTag) {
      throw new Error('Failed to load created tag');
    }

    return c.json({
      id: newTag.id,
      name: newTag.name,
      createdTs: newTag.created_ts
    });

  } catch (error) {
    console.error('Create tag error:', error);
    return c.json({ message: 'Internal server error' }, 500);
  }
});

// 删除标签
tagRoutes.delete('/:id', async (c) => {
  try {
    const tagId = parseInt(c.req.param('id'));
    const userPayload = c.get('user');
    
    if (!userPayload) {
      return c.json({ message: 'Unauthorized' }, 401);
    }

    // 获取用户ID
    const user = await c.env.DB.prepare(
      'SELECT id FROM user WHERE uid = ?'
    ).bind(userPayload.sub).first();

    if (!user) {
      return c.json({ message: 'User not found' }, 404);
    }

    // 检查标签是否存在且属于当前用户
    const tag = await c.env.DB.prepare(
      'SELECT * FROM tag WHERE id = ? AND creator_id = ?'
    ).bind(tagId, user.id).first();

    if (!tag) {
      return c.json({ message: 'Tag not found' }, 404);
    }

    // 删除标签相关的关联
    await c.env.DB.prepare(
      'DELETE FROM memo_tag WHERE tag_id = ?'
    ).bind(tagId).run();

    // 删除标签
    await c.env.DB.prepare(
      'DELETE FROM tag WHERE id = ?'
    ).bind(tagId).run();

    return c.json({ message: 'Tag deleted successfully' });

  } catch (error) {
    console.error('Delete tag error:', error);
    return c.json({ message: 'Internal server error' }, 500);
  }
});

export { tagRoutes }; 