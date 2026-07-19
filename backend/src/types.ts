/// <reference types="@cloudflare/workers-types" />

// 环境变量类型定义
export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  ALLOWED_ORIGINS?: string;  // 逗号分隔的允许域名列表
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2?: R2Bucket;
  /** Workers 静态资源绑定（单 Worker 同源部署：Worker 同时托管前端与 API） */
  ASSETS?: Fetcher;
  BASE_URL: string;
  LOG_LEVEL?: string;
}

// 用户JWT载荷类型
export interface UserPayload {
  sub: string;
  username: string;
  role: string;
  iat: number;
  exp: number;
}

// Hono Variables类型
export interface Variables {
  user?: UserPayload;
}

// 用户角色枚举
export enum UserRole {
  HOST = 'HOST',
  USER = 'USER'
}

// 行状态枚举
export enum RowStatus {
  NORMAL = 'NORMAL',
  ARCHIVED = 'ARCHIVED'
}

// 笔记可见性枚举
export enum MemoVisibility {
  PRIVATE = 'PRIVATE',
  PROTECTED = 'PROTECTED',
  PUBLIC = 'PUBLIC'
}

// 用户模型
export interface User {
  id: number;
  uid: string;
  username: string;
  role: UserRole;
  email?: string;
  avatarUrl?: string;
  passwordHash?: string; // 仅内部使用
  rowStatus: RowStatus;
  createdTs: number;
  updatedTs: number;
}

// 用户公开信息（API 返回）
export interface UserPublic {
  id: number;
  uid: string;
  username: string;
  role: UserRole;
  email?: string;
  avatarUrl?: string;
  createdTs: number;
  updatedTs: number;
}

// 笔记模型
export interface Memo {
  id: number;
  uid: string;
  creatorId: number;
  content: string;
  visibility: MemoVisibility;
  rowStatus: RowStatus;
  createdTs: number;
  updatedTs: number;
  resourceIdList?: number[];
  tags?: string[];
}

// 标签模型
export interface Tag {
  id: number;
  creatorId: number;
  name: string;
  createdTs: number;
}

// 资源模型
export interface Resource {
  id: number;
  uid: string;
  creatorId: number;
  filename: string;
  mimeType: string;
  size: number;
  externalUri: string;
  createdTs: number;
}

// 活动记录模型
export interface Activity {
  id: number;
  creatorId: number;
  type: string;
  level: string;
  payload?: string; // JSON 字符串
  createdTs: number;
}

// API 请求/响应类型
export interface AuthSignInRequest {
  username: string;
  password: string;
}

export interface AuthSignUpRequest extends AuthSignInRequest {
  email?: string;
}

export interface AuthResponse {
  accessToken: string;
  user: UserPublic;
}

export interface MemoCreateRequest {
  content: string;
  visibility?: MemoVisibility;
  resourceIdList?: number[];
}

export interface MemoUpdateRequest {
  content?: string;
  visibility?: MemoVisibility;
  resourceIdList?: number[];
}

export interface UserUpdateRequest {
  email?: string;
  avatarUrl?: string;
}

export interface TagCreateRequest {
  name: string;
}

export interface MemoStats {
  total: number;
  dailyHistogram: Array<{
    ts: number;
    count: number;
  }>;
}

// JWT Payload
export interface JWTPayload {
  sub: string; // user uid
  username: string;
  role: UserRole;
  iat: number;
  exp: number;
}

// API 错误响应
export interface ApiError {
  message: string;
  code?: string;
}

// 分页参数
export interface PaginationParams {
  limit?: number;
  offset?: number;
}

// 查询过滤器
export interface MemoQueryFilter extends PaginationParams {
  rowStatus?: RowStatus;
  creatorId?: number;
  tag?: string;
  visibility?: MemoVisibility;
}

export interface UserQueryFilter extends PaginationParams {
  rowStatus?: RowStatus;
} 