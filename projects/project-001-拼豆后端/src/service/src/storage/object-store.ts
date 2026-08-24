// 文件开头说明：私有对象存储的最小业务端口。业务层只依赖条件写入、读取、存在检查
// 和删除，不接触 R2 客户端、桶名或永久 URL；local、R2 和测试替身都实现这一组语义。

export interface ObjectStore {
  putIfAbsent(storageKey: string, content: Buffer): Promise<void>
  read(storageKey: string): Promise<Buffer>
  exists(storageKey: string): Promise<boolean>
  delete(storageKey: string): Promise<void>
}

export const createObjectStorageKey = (ownerId: number, workId: string, assetId: string): string =>
  `objects/${String(ownerId)}/${workId}/${assetId}`

export const assertObjectStorageKey = (storageKey: string): void => {
  if (
    typeof storageKey !== 'string' ||
    storageKey.length < 1 ||
    storageKey.length > 1024 ||
    storageKey.includes('\0') ||
    storageKey.startsWith('/') ||
    storageKey.split('/').some((part) => part === '..')
  ) {
    throw new ObjectStoreInvalidKeyError()
  }
}

export class ObjectStoreInvalidKeyError extends Error {
  readonly code = 'OBJECT_KEY_INVALID'

  constructor() {
    super('对象标识无效。')
    this.name = 'ObjectStoreInvalidKeyError'
  }
}

export class ObjectStoreConflictError extends Error {
  readonly code = 'OBJECT_ALREADY_EXISTS'

  constructor() {
    super('对象已存在。')
    this.name = 'ObjectStoreConflictError'
  }
}

export class ObjectStoreNotFoundError extends Error {
  readonly code = 'OBJECT_NOT_FOUND'

  constructor() {
    super('对象不存在。')
    this.name = 'ObjectStoreNotFoundError'
  }
}

export class ObjectStoreUnavailableError extends Error {
  readonly code = 'OBJECT_STORAGE_UNAVAILABLE'

  constructor() {
    super('对象存储暂时不可用。')
    this.name = 'ObjectStoreUnavailableError'
  }
}

// 只用于自动化测试和本机业务单测，不由运行时配置选中。
export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Buffer>()

  constructor(private readonly hooks: {
    beforePut?: (storageKey: string, content: Buffer) => void | Promise<void>
    beforeRead?: (storageKey: string) => void | Promise<void>
    beforeExists?: (storageKey: string) => void | Promise<void>
    beforeDelete?: (storageKey: string) => void | Promise<void>
  } = {}) {}

  async putIfAbsent(storageKey: string, content: Buffer): Promise<void> {
    assertObjectStorageKey(storageKey)
    await this.hooks.beforePut?.(storageKey, Buffer.from(content))
    if (this.objects.has(storageKey)) throw new ObjectStoreConflictError()
    this.objects.set(storageKey, Buffer.from(content))
  }

  async read(storageKey: string): Promise<Buffer> {
    assertObjectStorageKey(storageKey)
    await this.hooks.beforeRead?.(storageKey)
    const content = this.objects.get(storageKey)
    if (!content) throw new ObjectStoreNotFoundError()
    return Buffer.from(content)
  }

  async exists(storageKey: string): Promise<boolean> {
    assertObjectStorageKey(storageKey)
    await this.hooks.beforeExists?.(storageKey)
    return this.objects.has(storageKey)
  }

  async delete(storageKey: string): Promise<void> {
    assertObjectStorageKey(storageKey)
    await this.hooks.beforeDelete?.(storageKey)
    this.objects.delete(storageKey)
  }

  clear(): void {
    this.objects.clear()
  }
}
