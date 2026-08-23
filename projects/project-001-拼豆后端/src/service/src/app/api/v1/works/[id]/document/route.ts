// 文件开头说明：作品文档更新的规范 v1 路径。业务契约从一开始就约定为
// PATCH /api/v1/works/:id/document；此文件复用已验证的处理器，避免前端按
// 契约调用时落到不存在的路由。旧的 PATCH /api/v1/works/:id 暂保留兼容。
export { OPTIONS, PATCH } from '../route'
