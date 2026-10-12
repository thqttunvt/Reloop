import { buildApp, loadConfig } from './app';

/** Entry point Lambda sau API Gateway HTTP API (payload v2). Khởi tạo 1 lần mỗi container. */
export const handler = buildApp(loadConfig()).handler;
