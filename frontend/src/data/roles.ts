// 岗位与数据归属：
// 每个业务模块有「归属岗位」，只有归属岗位能改本模块的数据；
// 归属之外的岗位越权改动一律拒绝，其余人员只能查看。
export type RoleKey = 'admin' | 'operations' | 'crew' | 'spare' | 'viewer'

export type RoleOption = {
  key: RoleKey
  label: string
  desc: string
}

export const ROLE_OPTIONS: RoleOption[] = [
  { key: 'admin', label: '值班管理员', desc: '各模块归属岗位，可执行全部登记与流转' },
  { key: 'operations', label: '运行值班员', desc: '负责运行类模块，导轴承检测登记与批量标记偏高' },
  { key: 'crew', label: '检修班组', desc: '负责导轴承检修确认与检修人员台账，可看待检修待办' },
  { key: 'spare', label: '备件管理员', desc: '负责备品备件台账，可看待检修待办并备料' },
  { key: 'viewer', label: '其他人员', desc: '只读账号，只能查看不能改' },
]

// 各模块的归属岗位：命中其中之一才允许写。
const MODULE_OWNERS: Record<string, RoleKey[]> = {
  station: ['admin'],
  unit: ['admin', 'operations'],
  governor: ['admin', 'operations'],
  excitation: ['admin', 'operations'],
  transformer: ['admin', 'operations'],
  gate: ['admin', 'operations'],
  seepage: ['admin', 'operations'],
  displacement: ['admin', 'operations'],
  trashrack: ['admin', 'operations'],
  overhaul: ['admin', 'crew'],
  bearing: ['admin', 'operations', 'crew'],
  cooling: ['admin', 'operations'],
  hydrology: ['admin', 'operations'],
  flood: ['admin', 'operations'],
  generation: ['admin', 'operations'],
  protection: ['admin', 'operations'],
  defect: ['admin', 'operations', 'crew'],
  crew: ['admin', 'crew'],
  spare: ['admin', 'spare'],
}

// 动作级细化：同一个模块里不同岗位能动的动作不同。
// 没列到的动作按模块归属放行；列到了就只允许名单里的岗位。
const ACTION_ROLES: Record<string, RoleKey[]> = {
  'bearing:确认检修': ['admin', 'crew'],
  'bearing:标记偏高': ['admin', 'operations'],
  'bearing:提交检测': ['admin', 'operations'],
}

export function canWriteModule(role: RoleKey, moduleKey: string): boolean {
  if (role === 'viewer') {
    return false
  }
  return (MODULE_OWNERS[moduleKey] ?? ['admin']).includes(role)
}

export function canRunAction(role: RoleKey, moduleKey: string, action: string): boolean {
  if (role === 'viewer') {
    return false
  }
  const scoped = ACTION_ROLES[`${moduleKey}:${action}`]
  if (scoped) {
    return scoped.includes(role)
  }
  return canWriteModule(role, moduleKey)
}

export function roleLabel(key: RoleKey): string {
  return ROLE_OPTIONS.find((item) => item.key === key)?.label ?? key
}
