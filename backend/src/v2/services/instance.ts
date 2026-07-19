// InstanceService — 对齐上游 memos v0.29(规格书 §2.3 / §4.5)。
// GetInstanceProfile / GetInstanceSetting / BatchGetInstanceSettings /
// UpdateInstanceSetting / GetInstanceStats。TestInstanceEmailSetting 不注册(自动 unimplemented)。
import type { Env } from "../../types";
import { rpc } from "../router";
import { invalidArgument, permissionDenied } from "../connect";
import type { AuthContext } from "../auth";
import { parseName, safeParse, userToApi, type UserRow } from "../store";

// ---------- setting key / oneof 字段映射 ----------

const SETTING_KEYS = ["GENERAL", "STORAGE", "MEMO_RELATED", "TAGS", "NOTIFICATION", "AI"] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

const ONEOF_FIELD: Record<SettingKey, string> = {
  GENERAL: "generalSetting",
  STORAGE: "storageSetting",
  MEMO_RELATED: "memoRelatedSetting",
  TAGS: "tagsSetting",
  NOTIFICATION: "notificationSetting",
  AI: "aiSetting",
};

/** 仅 ADMIN 可读的 key */
const ADMIN_ONLY_KEYS: SettingKey[] = ["STORAGE", "NOTIFICATION"];

const isSettingKey = (key: string): key is SettingKey => (SETTING_KEYS as readonly string[]).includes(key);

const parseSettingKey = (name: string | undefined): SettingKey | null => {
  const key = parseName(name ?? "", "instance/settings");
  return key && isSettingKey(key) ? key : null;
};

// ---------- 默认值(无记录时返回,对齐上游 store 层填充)----------

const defaultSettingValue = (key: SettingKey): Record<string, any> => {
  switch (key) {
    case "GENERAL":
      return {
        disallowUserRegistration: false,
        disallowPasswordAuth: false,
        additionalScript: "",
        additionalStyle: "",
        customProfile: { title: "Memos", description: "", logoUrl: "" },
        weekStartDayOffset: 0,
        disallowChangeUsername: false,
        disallowChangeNickname: false,
      };
    case "MEMO_RELATED":
      return {
        contentLengthLimit: 8192,
        enableDoubleClickEdit: true,
        reactions: ["👍", "👎", "❤️", "🎉", "😄", "😢", "😮", "🙏"],
      };
    default:
      return {};
  }
};

const loadSettingValue = async (env: Env, key: SettingKey): Promise<Record<string, any>> => {
  const row = await env.DB.prepare("SELECT value FROM system_setting WHERE name = ?").bind(key).first<{ value: string }>();
  return row ? safeParse(row.value) : defaultSettingValue(key);
};

const settingToApi = (key: SettingKey, value: Record<string, any>): Record<string, unknown> => ({
  name: `instance/settings/${key}`,
  [ONEOF_FIELD[key]]: value,
});

const isAdmin = (auth: AuthContext | null): boolean => auth?.role === "ADMIN";

/** AI setting 对非 ADMIN 脱敏:只保留 transcription.providerId */
const redactAiSetting = (value: Record<string, any>): Record<string, any> => ({
  transcription: { providerId: value?.transcription?.providerId ?? "" },
});

// ---------- GetInstanceProfile ----------

rpc("InstanceService", "GetInstanceProfile", "optional", async (_request, ctx) => {
  const admin = await ctx.env.DB.prepare("SELECT * FROM user WHERE role = 'ADMIN' ORDER BY id ASC LIMIT 1").first<UserRow>();
  return {
    version: "0.29.1",
    demo: false,
    instanceUrl: ctx.env.BASE_URL || new URL(ctx.req.url).origin,
    // admin 缺失时省略字段,前端据此跳转初始化建号页
    ...(admin ? { admin: userToApi(admin, { includeSensitive: false }) } : {}),
    commit: "",
  };
});

// ---------- GetInstanceSetting / BatchGetInstanceSettings ----------

rpc("InstanceService", "GetInstanceSetting", "optional", async (request, ctx) => {
  const key = parseSettingKey(request?.name);
  if (!key) throw invalidArgument(`invalid setting name: ${request?.name ?? ""}`);

  const admin = isAdmin(ctx.auth);
  if (ADMIN_ONLY_KEYS.includes(key) && !admin) throw permissionDenied();

  let value = await loadSettingValue(ctx.env, key);
  if (key === "AI" && !admin) value = redactAiSetting(value);
  return settingToApi(key, value);
});

rpc("InstanceService", "BatchGetInstanceSettings", "optional", async (request, ctx) => {
  const names: string[] = Array.isArray(request?.names) ? request.names : [];
  const admin = isAdmin(ctx.auth);
  const settings: Record<string, unknown>[] = [];
  for (const name of names) {
    const key = parseSettingKey(name);
    if (!key) continue; // 非法 name 静默跳过
    if (ADMIN_ONLY_KEYS.includes(key) && !admin) continue; // 非 ADMIN 静默跳过
    let value = await loadSettingValue(ctx.env, key);
    if (key === "AI" && !admin) value = redactAiSetting(value);
    settings.push(settingToApi(key, value));
  }
  return { settings };
});

// ---------- UpdateInstanceSetting ----------

/** INPUT_ONLY 字段(smtpPassword/apiKey/accessKeySecret)传空时保留旧存储值 */
const preserveInputOnlyFields = (key: SettingKey, next: Record<string, any>, old: Record<string, any>): void => {
  if (key === "NOTIFICATION") {
    if (next.email && !next.email.smtpPassword && old.email?.smtpPassword) {
      next.email.smtpPassword = old.email.smtpPassword;
    }
    return;
  }
  if (key === "STORAGE") {
    if (next.s3Config && !next.s3Config.accessKeySecret && old.s3Config?.accessKeySecret) {
      next.s3Config.accessKeySecret = old.s3Config.accessKeySecret;
    }
    return;
  }
  if (key === "AI" && Array.isArray(next.providers)) {
    const oldById = new Map<unknown, Record<string, any>>(
      (Array.isArray(old.providers) ? old.providers : []).map((p: Record<string, any>) => [p.id, p]),
    );
    for (const provider of next.providers) {
      if (provider && !provider.apiKey) {
        const oldProvider = oldById.get(provider.id);
        if (oldProvider?.apiKey) provider.apiKey = oldProvider.apiKey;
      }
    }
  }
};

rpc("InstanceService", "UpdateInstanceSetting", "required", async (request, ctx) => {
  if (!isAdmin(ctx.auth)) throw permissionDenied();

  const setting = request?.setting;
  const key = parseSettingKey(setting?.name);
  if (!key) throw invalidArgument(`invalid setting name: ${setting?.name ?? ""}`);

  const next: Record<string, any> = setting?.[ONEOF_FIELD[key]] ?? {};
  const oldRow = await ctx.env.DB.prepare("SELECT value FROM system_setting WHERE name = ?")
    .bind(key)
    .first<{ value: string }>();
  const old = oldRow ? safeParse(oldRow.value) : {};
  preserveInputOnlyFields(key, next, old);

  await ctx.env.DB.prepare("INSERT OR REPLACE INTO system_setting (name, value) VALUES (?, ?)")
    .bind(key, JSON.stringify(next))
    .run();

  return settingToApi(key, next);
});

// ---------- GetInstanceStats ----------

rpc("InstanceService", "GetInstanceStats", "required", async (_request, ctx) => {
  if (!isAdmin(ctx.auth)) throw permissionDenied();
  return {
    database: { driver: "sqlite", sizeBytes: "-1" },
    localStorageBytes: "0",
    generatedTime: new Date().toISOString(),
  };
});
