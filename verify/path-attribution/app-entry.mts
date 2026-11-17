/** 验证用统一入口：把领域层、存储层、服务层打进同一个模块实例，共享缓存与台账。 */
export * from '/workspace/frontend/src/domain/path-attribution.ts'
export { listRows, saveRows } from '/workspace/frontend/src/data/local-store.ts'
export { SEED_ROWS } from '/workspace/frontend/src/data/seed.ts'
export * as service from '/workspace/frontend/src/api/local-service.ts'
