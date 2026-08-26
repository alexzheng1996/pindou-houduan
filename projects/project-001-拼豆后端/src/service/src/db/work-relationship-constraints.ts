// 文件开头说明：Payload 3.88 对单关系字段统一推导为 ON DELETE SET NULL，
// 但 M1 私密作品的归属关系必须受限删除，避免用户、作品或历史快照被意外断开。
// 此钩子只修正 Payload 已声明关系生成的数据库模型；实际变更仍只由显式迁移执行。
import type { PostgresAdapterArgs } from '@payloadcms/db-postgres'

type DeleteAction = 'restrict' | 'set null'

type RawColumn = {
  reference?: {
    onDelete: DeleteAction
  }
}

type RawTable = {
  columns: Record<string, RawColumn>
}

type AdapterWithRawTables = {
  rawTables?: Record<string, RawTable>
}

const relationshipDeleteActions: ReadonlyArray<readonly [string, string, DeleteAction]> = [
  ['sessions', 'user', 'restrict'],
  ['accounts', 'user', 'restrict'],
  ['works', 'owner', 'restrict'],
  ['works', 'currentDocument', 'set null'],
  ['work_documents', 'owner', 'restrict'],
  ['work_documents', 'work', 'restrict'],
  ['work_assets', 'owner', 'restrict'],
  ['work_assets', 'work', 'restrict'],
  ['api_idempotency_records', 'actor', 'restrict'],
  ['article_media', 'uploader', 'restrict'],
]

// Raw tables are deliberately used here because Payload's public relationship
// field type does not expose foreign-key delete behavior. The adapter constructs
// them immediately before this documented extension hook runs.
const applyRelationshipDeleteActions = (adapter: AdapterWithRawTables): void => {
  for (const [tableName, columnName, onDelete] of relationshipDeleteActions) {
    const column = adapter.rawTables?.[tableName]?.columns[columnName]

    if (!column?.reference) {
      throw new Error(`未找到 M1 关系字段 ${tableName}.${columnName}，无法安全生成数据库模型。`)
    }

    column.reference.onDelete = onDelete
  }
}

export const preserveM1RelationshipDeleteActions = ((args: unknown) => {
  const context = args as {
    adapter: AdapterWithRawTables
    schema: unknown
  }

  applyRelationshipDeleteActions(context.adapter)
  return context.schema
}) as NonNullable<PostgresAdapterArgs['beforeSchemaInit']>[number]
