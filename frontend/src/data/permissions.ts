import type { RoleKey } from '@/data/types'

/** 岗位名册：页面顶栏可切换，服务层写接口强制按归属校验。 */
export const ROLES: { key: RoleKey; label: string; ownerModules: string[]; scope: string }[] = [
  {
    key: 'operator',
    label: '运行值班员',
    ownerModules: ['bearing'],
    scope: '导轴承检测登记、批量标记偏高',
  },
  {
    key: 'maintenance',
    label: '检修班组',
    ownerModules: ['overhaul'],
    scope: '接收待检修轴承、办理完工',
  },
  {
    key: 'warehouse',
    label: '仓库管理员',
    ownerModules: ['spare'],
    scope: '备品备件验收、领用、补充',
  },
  {
    key: 'readonly',
    label: '其他岗位（只读）',
    ownerModules: [],
    scope: '全平台仅可查看，不能改任何记录',
  },
]

const ROLE_BY_KEY = new Map(ROLES.map((item) => [item.key, item]))

export function roleLabel(key: RoleKey): string {
  return ROLE_BY_KEY.get(key)?.label ?? '未知岗位'
}

export function roleScope(key: RoleKey): string {
  return ROLE_BY_KEY.get(key)?.scope ?? ''
}

/** 归属之外的岗位越权改动一律拒绝；只读岗位对所有模块只读。 */
export function canWrite(moduleKey: string, role: RoleKey): boolean {
  const meta = ROLE_BY_KEY.get(role)
  return Boolean(meta && meta.ownerModules.includes(moduleKey))
}

export function denyReason(moduleName: string, role: RoleKey): string {
  const actor = roleLabel(role)
  return `越权拦截：${actor}不归属「${moduleName}」，只能查看，不能修改。如需改动请联系对应责任岗位`
}
