import { Hono } from "hono";
import type { Env } from "../types";
import { authenticate } from "./auth";

// 对齐上游 server/router/fileserver：GET /file/attachments/{uid}/{filename}
// - PUBLIC 可见性的 memo 附件无需认证
// - 其余需要 Bearer access token 且校验归属/可见性
// - ?thumbnail=true 暂回退为原图（缩略图生成列入 roadmap）
export function mountFileServer(app: Hono<{ Bindings: Env }>) {
  app.get("/file/attachments/:uid/:filename", async (c) => {
    const uid = c.req.param("uid");

    const row = await c.env.DB.prepare(
      `SELECT a.id, a.uid, a.filename, a.type, a.size, a.storage_type, a.reference, a.creator_id, m.visibility
       FROM attachment a LEFT JOIN memo m ON a.memo_id = m.id
       WHERE a.uid = ?`,
    )
      .bind(uid)
      .first<{
        id: number;
        uid: string;
        filename: string;
        type: string;
        size: number;
        storage_type: string;
        reference: string;
        creator_id: number;
        visibility: string | null;
      }>();

    if (!row) return c.text("attachment not found", 404);

    if (row.visibility !== "PUBLIC") {
      const auth = await authenticate(c.req.raw, c.env);
      if (!auth) return c.text("unauthenticated", 401);
      if (auth.userId !== row.creator_id && row.visibility !== "PROTECTED") {
        return c.text("permission denied", 403);
      }
    }

    if (row.storage_type === "EXTERNAL" && row.reference) {
      return c.redirect(row.reference, 302);
    }
    if (!row.reference || !c.env.R2) return c.text("file blob not available", 404);
    const object = await c.env.R2.get(row.reference);
    if (!object) return c.text("file blob not found", 404);

    return new Response(object.body, {
      headers: {
        "Content-Type": row.type || "application/octet-stream",
        "Content-Length": String(row.size || object.size),
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `inline; filename="${encodeURIComponent(row.filename)}"`,
      },
    });
  });
}
