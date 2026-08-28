// 文件开头说明：M2.1-A 只提供官方英文文章的后台草稿容器。它不是公开内容 API、
// 不是 SEO 发布器，也不存放原始媒体；第一版任何途径均不能把文章改为 published。
import { randomUUID } from 'crypto'

import type { CollectionConfig, PayloadRequest, Validate } from 'payload'
import { APIError } from 'payload'

import { isStaffOrAdmin } from '@/collections/Users'
import { recordPayloadRequestAuditEvent } from '@/security/audit'

const articleSections = ['guides', 'blog']
const articleTypes = ['tool_guide', 'faq', 'creative', 'product_tutorial', 'case_study', 'announcement']
const articleStatuses = ['draft']
const authorTypes = ['staff', 'codex_assisted']
const factCheckStatuses = ['not_started', 'needs_review', 'checked']
const twitterCards = ['summary', 'summary_large_image']

type ContentRequest = PayloadRequest & {
  context?: Record<string, unknown>
  user?: { id?: number | string; role?: string | string[] | null } | null
}

type ContentArticle = {
  publicId?: unknown
  status?: unknown
  version?: unknown
}

const contentAdminAccess = ({ req }: { req: ContentRequest }): boolean => isStaffOrAdmin({ req })

const isContentServiceRequest = (req: ContentRequest): boolean => req.context?.contentService === true

const validateSlug: Validate = (value) => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  ? true
  : 'Slug 必须是 3–120 位的小写英文、数字和连字符。'

const validateHttpsUrl: Validate = (value) => {
  if (typeof value !== 'string') return '来源链接必须是 HTTPS URL。'
  try {
    return new URL(value).protocol === 'https:' ? true : '来源链接必须是 HTTPS URL。'
  } catch {
    return '来源链接必须是 HTTPS URL。'
  }
}

const isDraft = (value: unknown): boolean => value === 'draft'

const createPublicId = (data: ContentArticle, operation: 'create' | 'update'): ContentArticle => {
  if (operation !== 'create' || typeof data.publicId === 'string') return data

  // Payload Admin marks this field read-only, so its browser form cannot be
  // asked to supply an internal public identifier. API callers may still set
  // one, but the database unique index remains the final collision boundary.
  return { ...data, publicId: `article_${randomUUID().replaceAll('-', '')}` }
}

const assertDraftOnly = (data: ContentArticle, originalDoc?: ContentArticle): ContentArticle => {
  if (!isDraft(data.status ?? originalDoc?.status ?? 'draft')) {
    throw new APIError('M2.1-A 仅允许保存 draft，发布和审核将在后续阶段启用。', 403)
  }

  return { ...data, status: 'draft' }
}

const beforeChangeDraftOnly = ({ data, operation, originalDoc, req }: {
  data: ContentArticle
  operation: 'create' | 'update'
  originalDoc?: ContentArticle
  req: ContentRequest
}): ContentArticle => {
  // All direct collection writes, including the Payload Admin form, pass this
  // boundary. `contentService` is reserved for the versioned draft API and
  // does not relax the state rule.
  void req
  const draft = assertDraftOnly(createPublicId(data, operation), originalDoc)
  const previousVersion = typeof originalDoc?.version === 'number' && Number.isSafeInteger(originalDoc.version)
    ? originalDoc.version
    : 0

  return { ...draft, version: operation === 'create' ? 1 : previousVersion + 1 }
}

const afterChangeAudit = async ({ doc, operation, req }: {
  doc: ContentArticle
  operation: 'create' | 'update'
  req: ContentRequest
}): Promise<ContentArticle> => {
  if (!isContentServiceRequest(req)) {
    await recordPayloadRequestAuditEvent(req.payload, req, {
      action: operation === 'create' ? 'content.draft_created' : 'content.draft_updated',
      outcome: 'allowed',
      resourcePublicId: typeof doc.publicId === 'string' ? doc.publicId : undefined,
      resourceType: 'content',
      route: 'Payload Admin articles',
    })
  }

  return doc
}

export const Articles: CollectionConfig = {
  slug: 'articles',
  admin: {
    group: 'Content',
    useAsTitle: 'title',
    defaultColumns: ['title', 'section', 'articleType', 'authorDisplayName', 'updatedAt'],
  },
  access: {
    admin: contentAdminAccess,
    create: contentAdminAccess,
    delete: () => false,
    read: contentAdminAccess,
    update: contentAdminAccess,
  },
  endpoints: false,
  hooks: {
    beforeChange: [beforeChangeDraftOnly],
    afterChange: [afterChangeAudit],
  },
  indexes: [
    { fields: ['publicId'], unique: true },
    { fields: ['slug'], unique: true },
    { fields: ['section', 'status', 'updatedAt'] },
  ],
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Article',
          fields: [
            {
              type: 'row',
              fields: [
                { name: 'publicId', type: 'text', required: true, admin: { readOnly: true, width: '50%' } },
                { name: 'section', type: 'select', required: true, options: articleSections, admin: { width: '50%' } },
              ],
            },
            {
              type: 'row',
              fields: [
                { name: 'slug', type: 'text', required: true, minLength: 3, maxLength: 120, validate: validateSlug, admin: { width: '50%' } },
                { name: 'articleType', type: 'select', required: true, options: articleTypes, admin: { width: '50%' } },
              ],
            },
            { name: 'title', type: 'text', required: true, minLength: 3, maxLength: 160 },
            { name: 'excerpt', type: 'textarea', required: true, minLength: 20, maxLength: 320 },
            { name: 'body', type: 'richText', required: true },
            {
              type: 'row',
              fields: [
                { name: 'authorType', type: 'select', required: true, defaultValue: 'staff', options: authorTypes, admin: { width: '50%' } },
                { name: 'authorDisplayName', type: 'text', required: true, minLength: 1, maxLength: 120, admin: { width: '50%' } },
              ],
            },
          ],
        },
        {
          label: 'Sources & quality',
          fields: [
            {
              type: 'collapsible',
              label: 'Source list',
              admin: { initCollapsed: false },
              fields: [{
                name: 'sourceList', type: 'array', minRows: 1, maxRows: 20,
                labels: { plural: 'Sources', singular: 'Source' },
                fields: [
                  { name: 'label', type: 'text', required: true, maxLength: 160 },
                  { name: 'url', type: 'text', required: true, maxLength: 2_000, validate: validateHttpsUrl },
                ],
              }],
            },
            {
              type: 'collapsible',
              label: 'Content quality',
              admin: { initCollapsed: true },
              fields: [{
                name: 'contentQuality', type: 'group', fields: [
                  {
                    type: 'row', fields: [
                      { name: 'topicIntent', type: 'text', maxLength: 240, admin: { width: '50%' } },
                      { name: 'factCheckStatus', type: 'select', required: true, defaultValue: 'not_started', options: factCheckStatuses, admin: { width: '50%' } },
                    ],
                  },
                  { name: 'editorNotes', type: 'textarea', maxLength: 2_000 },
                ],
              }],
            },
          ],
        },
        {
          label: 'SEO suggestions',
          fields: [{
            type: 'collapsible', label: 'SEO suggestions', admin: { initCollapsed: true }, fields: [{
              name: 'seoSuggestions', type: 'group', fields: [
                {
                  type: 'row', fields: [
                    { name: 'seoTitle', type: 'text', maxLength: 160, admin: { width: '50%' } },
                    { name: 'primaryTopic', type: 'text', maxLength: 160, admin: { width: '50%' } },
                  ],
                },
                { name: 'metaDescription', type: 'textarea', maxLength: 320 },
                { name: 'twitterCard', type: 'select', defaultValue: 'summary_large_image', options: twitterCards, admin: { width: '50%' } },
              ],
            }],
          }],
        },
        {
          label: 'System',
          fields: [{
            type: 'row', fields: [
              { name: 'status', type: 'select', required: true, defaultValue: 'draft', options: articleStatuses, admin: { readOnly: true, width: '50%' } },
              { name: 'version', type: 'number', required: true, min: 1, defaultValue: 1, admin: { readOnly: true, width: '50%' } },
            ],
          }],
        },
      ],
    },
  ],
}

// Article media is intentionally metadata-only in M2.1-A. The upload and
// controlled-read flow is a later task; keeping a separate collection now
// prevents operational images from being mixed with private Work assets or
// community uploads.
export const ArticleMedia: CollectionConfig = {
  slug: 'article-media',
  admin: {
    group: 'Content',
    useAsTitle: 'publicId',
    defaultColumns: ['publicId', 'mimeType', 'status', 'createdAt'],
  },
  access: {
    admin: contentAdminAccess,
    create: () => false,
    delete: () => false,
    read: contentAdminAccess,
    update: () => false,
  },
  endpoints: false,
  indexes: [
    { fields: ['publicId'], unique: true },
    { fields: ['article', 'status'] },
    { fields: ['uploader', 'status'] },
    { fields: ['storageKey'], unique: true },
  ],
  fields: [
    { name: 'publicId', type: 'text', required: true },
    { name: 'article', type: 'relationship', relationTo: 'articles', index: true },
    { name: 'uploader', type: 'relationship', relationTo: 'users', required: true, index: true },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'upload_pending',
      options: ['upload_pending', 'ready', 'validation_failed', 'orphaned', 'deleted'],
    },
    { name: 'mimeType', type: 'text', required: true, maxLength: 100 },
    { name: 'sizeBytes', type: 'number', required: true, min: 0 },
    { name: 'sha256', type: 'text', required: true, minLength: 64, maxLength: 64 },
    {
      name: 'storageKey',
      type: 'text',
      required: true,
      access: { read: ({ req }) => isContentServiceRequest(req as ContentRequest) },
    },
    { name: 'altText', type: 'text', required: true, minLength: 1, maxLength: 240 },
  ],
}
