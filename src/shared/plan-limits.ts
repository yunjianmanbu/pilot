// 计划条目上限的单一来源。
//
// 工具层（agent/tools/plan.ts 的 update_plan）与落库层（store-schema.ts 的
// sanitizePlan）各自截断一份计划，两处写死同一个 12 时，改一处就会留下
// 「工具接受 12 项、落库静默丢到 12 项以外」的白盒差异。截断本身是静默的，
// 所以两份实现必须取同一个常量，并用 tests/plan-limits.test.ts 钉住。
//
// 注意 12 不是给模型的建议值：建议值是 update_plan 描述里的「Keep 2-8 items」，
// 12 是防跑飞的阀门——计划全文每一步都会注入上下文，条目无限增长直接吃 token。

/** 一次计划最多保留的条目数（工具层与落库层共用）。 */
export const PLAN_ITEM_LIMIT = 12
