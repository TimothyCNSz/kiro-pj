// FulfillmentService — 发货管理：实物发货 / 虚拟发货（需求 8.1–8.4, 9.3, 9.4, 14.1, 14.2, 14.3, 14.4）。
//
// 职责（见设计「后端 API 契约 · 管理-发货」「关键服务接口 · FulfillmentService」
// + Correctness Property 21/22/23）：
//   - shipPhysical：为某实物订单上传物流编号。物流编号去空白后**必须非空**，否则拒绝
//     将订单标记为已发货并以 `TRACKING_REQUIRED` 上抛（需求 14.3、8.2）；校验通过则记录
//     物流编号并将订单状态置为「已发货」（shipped，需求 8.2、14.1）。未发货的实物订单
//     状态显示为「待发货」（pending_shipment，需求 8.4，由读取路径体现）。已发货后可展示
//     物流跟踪明细——本阶段以假数据呈现（需求 8.3；见 {@link buildFakeTrackingTimeline}）。
//     仅适用于实物订单。
//   - shipVirtual：为某虚拟订单完成虚拟发货。发货前该虚拟订单状态为「待发货」且不展示
//     CDK（需求 9.3，由订单详情读取路径 task 11.7 门控）；发货时将该订单已关联的 CDK
//     置为 delivered（关联/交付，需求 9.4、14.2）并把订单状态置为「已发货」。发货后订单
//     详情读取路径即展示对应 CDK（需求 9.4）。仅适用于虚拟订单。
//
// 事务边界（关键）：每个发货操作在**单个数据库事务内**完成「订单状态变更 + 操作日志」，
// 使二者同成败（需求 14.4：任一发货操作完成即记录一条操作日志）。为此本服务：
//   - 通过可注入的 {@link FulfillmentRepository.transaction} 运行整段发货逻辑；
//   - 在事务内把事务句柄透传给仓储写入方法与 {@link OperationLogRecorder.recordLog}，
//     让日志写入复用同一事务（与 LogService/AlertService 一致的接缝）。
//
// 设计接缝（依赖可注入，测试用内存替身、不触达真实数据库）：
//   - FulfillmentRepository：订单读取 + 实物/虚拟发货状态迁移的数据访问抽象（默认 Drizzle）。
//   - OperationLogRecorder：操作日志记录抽象（默认 {@link LogService}），在事务内被调用。
//
// Requirements: 8.1, 8.2, 8.3, 8.4, 9.3, 9.4, 14.1, 14.2, 14.4.

import { eq } from 'drizzle-orm'

import { db as defaultDb, type Database } from '../db/client'
import { cdks, orders } from '../db/schema'
import { OrderStatus, OrderType } from '../lib/domain'
import { ErrorCode } from '../lib/errors'
import { HttpError } from '../middleware/http-error'
import { LogService, type LogEntry } from './log-service'

/**
 * 数据库或事务句柄：既可传入模块作用域的 {@link Database}，也可传入
 * `db.transaction(async (tx) => ...)` 回调中的事务对象 `tx`。二者查询接口一致，
 * 使写入既能独立执行、也能参与调用方（发货）事务。
 */
type TransactionHandle = Parameters<Parameters<Database['transaction']>[0]>[0]
export type DbOrTx = Database | TransactionHandle

/** 空物流编号的统一提示（需求 14.3、8.2）。 */
export const TRACKING_REQUIRED_MESSAGE = '物流编号不能为空，请补充物流编号后再发货'
/** 订单类型不匹配的统一提示（对实物端点提交虚拟订单，或反之）。 */
export const ORDER_TYPE_MISMATCH_MESSAGE = '订单类型与发货方式不匹配'

/** 发货操作可能读取到的订单最小信息（类型 + 状态，用于门控与迁移）。 */
export interface OrderShipInfo {
  /** 订单 id。 */
  id: string
  /** 订单类型：实物 / 虚拟（需求 7.9）。 */
  type: OrderType
  /** 当前订单状态：待发货 / 已发货（需求 8.4, 9.3）。 */
  status: OrderStatus
}

/** 实物发货结果（供路由回显；含假数据物流明细，需求 8.2, 8.3, 14.1）。 */
export interface ShipPhysicalResult {
  /** 订单 id。 */
  orderId: string
  /** 迁移后的订单状态（恒为 shipped）。 */
  status: OrderStatus
  /** 记录的物流编号（需求 8.2, 14.1）。 */
  trackingNo: string
  /** 假数据物流跟踪明细（本阶段占位，需求 8.3）。 */
  tracking: FakeTrackingTimeline
}

/** 虚拟发货结果（供路由回显；含已交付 CDK，需求 9.4, 14.2）。 */
export interface ShipVirtualResult {
  /** 订单 id。 */
  orderId: string
  /** 迁移后的订单状态（恒为 shipped）。 */
  status: OrderStatus
  /** 本次发货交付（关联并展示）的 CDK 兑换码（需求 9.4）。 */
  cdks: string[]
}

/** 假数据物流明细的一条节点（需求 8.3：本阶段物流跟踪明细可使用假数据呈现）。 */
export interface FakeTrackingNode {
  /** 节点状态文案。 */
  status: string
  /** 节点描述。 */
  description: string
}

/** 假数据物流跟踪时间线（需求 8.3）。 */
export interface FakeTrackingTimeline {
  /** 物流编号。 */
  trackingNo: string
  /** 承运商（占位）。 */
  carrier: string
  /** 物流跟踪节点（占位，从新到旧）。 */
  nodes: FakeTrackingNode[]
}

/**
 * 生成假数据物流跟踪明细（需求 8.3）。纯函数、可确定性测试；本阶段仅用于演示，
 * 不对接真实物流查询。
 */
export function buildFakeTrackingTimeline(trackingNo: string): FakeTrackingTimeline {
  return {
    trackingNo,
    carrier: 'AWSome 物流（演示）',
    nodes: [
      { status: '运输中', description: '快件已从仓库发出，正在运往目的地' },
      { status: '已揽收', description: `承运商已揽收快件（物流编号 ${trackingNo}）` },
    ],
  }
}

/**
 * 操作日志记录接缝：在发货事务内被调用以记录一条日志（需求 14.4）。
 * 以 `unknown` 松耦合事务句柄类型，默认由 {@link LogService} 实现。
 */
export interface OperationLogRecorder {
  recordLog(entry: LogEntry, handle?: unknown): Promise<void>
}

/**
 * 发货持久化接缝：事务运行 + 订单读取 + 实物/虚拟发货状态迁移。
 * 默认实现基于 Drizzle（见 {@link DrizzleFulfillmentRepository}），测试可注入内存替身。
 */
export interface FulfillmentRepository {
  /** 以单个数据库事务运行 `fn`，`fn` 抛错即整体回滚（发货 + 日志同成败，需求 14.4）。 */
  transaction<T>(fn: (tx: DbOrTx) => Promise<T>): Promise<T>
  /** 读取订单的类型与状态；不存在返回 null。 */
  getOrder(orderId: string, handle: DbOrTx): Promise<OrderShipInfo | null>
  /** 记录物流编号并将实物订单置为已发货（需求 8.2, 14.1）。 */
  markPhysicalShipped(orderId: string, trackingNo: string, handle: DbOrTx): Promise<void>
  /**
   * 将虚拟订单置为已发货，并把该订单已关联的 CDK 置为 delivered（需求 9.4, 14.2）；
   * 返回本次交付的 CDK 兑换码（稳定排序）。
   */
  markVirtualShipped(orderId: string, handle: DbOrTx): Promise<string[]>
}

/** 基于 Drizzle 的默认发货仓储实现。 */
export class DrizzleFulfillmentRepository implements FulfillmentRepository {
  constructor(private readonly db: Database = defaultDb) {}

  async transaction<T>(fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(tx))
  }

  async getOrder(orderId: string, handle: DbOrTx): Promise<OrderShipInfo | null> {
    const exec = handle as Database
    const rows = await exec
      .select({ id: orders.id, type: orders.type, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return { id: row.id, type: row.type as OrderType, status: row.status as OrderStatus }
  }

  async markPhysicalShipped(
    orderId: string,
    trackingNo: string,
    handle: DbOrTx,
  ): Promise<void> {
    const exec = handle as Database
    await exec
      .update(orders)
      .set({ trackingNo, status: OrderStatus.Shipped })
      .where(eq(orders.id, orderId))
  }

  async markVirtualShipped(orderId: string, handle: DbOrTx): Promise<string[]> {
    const exec = handle as Database
    await exec
      .update(orders)
      .set({ status: OrderStatus.Shipped })
      .where(eq(orders.id, orderId))
    // 关联并交付该订单的 CDK（兑换时已消耗并绑定 orderId，此处置为 delivered，需求 9.4）。
    const delivered = await exec
      .update(cdks)
      .set({ status: 'delivered' })
      .where(eq(cdks.orderId, orderId))
      .returning({ code: cdks.code })
    return delivered.map((r) => r.code).sort()
  }
}

/** `FulfillmentService` 构造依赖（全部可注入以支持无副作用测试）。 */
export interface FulfillmentServiceOptions {
  /** 发货仓储（缺省 Drizzle）。 */
  repository?: FulfillmentRepository
  /** 操作日志记录器（缺省 {@link LogService}）。 */
  logService?: OperationLogRecorder
}

/**
 * FulfillmentService：实物 / 虚拟发货（需求 8, 9.3, 9.4, 14）。
 * 每个发货操作在单事务内完成「状态迁移 + 操作日志」，二者同成败（需求 14.4）。
 */
export class FulfillmentService {
  private readonly repository: FulfillmentRepository
  private readonly logService: OperationLogRecorder

  constructor(options: FulfillmentServiceOptions = {}) {
    this.repository = options.repository ?? new DrizzleFulfillmentRepository()
    this.logService = options.logService ?? new LogService()
  }

  /**
   * 实物发货：校验非空物流编号 → 记录编号并置「已发货」→ 记操作日志（需求 8.2, 14.1, 14.3, 14.4）。
   *
   * @throws HttpError(TRACKING_REQUIRED) 物流编号去空白后为空（需求 14.3、8.2）。
   * @throws HttpError(VALIDATION) 目标订单不是实物订单。
   * @returns 迁移结果（含假数据物流明细，需求 8.3）；订单不存在返回 null（路由转 404）。
   */
  async shipPhysical(
    adminId: string,
    orderId: string,
    trackingNo: unknown,
  ): Promise<ShipPhysicalResult | null> {
    // 物流编号非空校验先于任何写入（需求 14.3）：仅接受去空白后非空的字符串。
    const normalized = typeof trackingNo === 'string' ? trackingNo.trim() : ''
    if (normalized.length === 0) {
      throw new HttpError(ErrorCode.TrackingRequired, TRACKING_REQUIRED_MESSAGE)
    }

    return this.repository.transaction(async (tx) => {
      const order = await this.repository.getOrder(orderId, tx)
      if (order === null) return null
      if (order.type !== OrderType.Physical) {
        throw new HttpError(ErrorCode.Validation, ORDER_TYPE_MISMATCH_MESSAGE)
      }

      await this.repository.markPhysicalShipped(orderId, normalized, tx)
      // 事务内记录操作日志：发货 + 日志同成败（需求 14.4）。
      await this.logService.recordLog(
        { actorId: adminId, action: 'ship_physical', targetType: 'order', targetId: orderId },
        tx,
      )

      return {
        orderId,
        status: OrderStatus.Shipped,
        trackingNo: normalized,
        tracking: buildFakeTrackingTimeline(normalized),
      }
    })
  }

  /**
   * 虚拟发货：关联并交付订单 CDK → 置「已发货」→ 记操作日志（需求 9.3, 9.4, 14.2, 14.4）。
   *
   * 发货前该虚拟订单状态为「待发货」且不展示 CDK（需求 9.3，由订单详情读取路径门控）；
   * 发货后订单详情即展示对应 CDK（需求 9.4）。
   *
   * @throws HttpError(VALIDATION) 目标订单不是虚拟订单。
   * @returns 迁移结果（含交付的 CDK）；订单不存在返回 null（路由转 404）。
   */
  async shipVirtual(adminId: string, orderId: string): Promise<ShipVirtualResult | null> {
    return this.repository.transaction(async (tx) => {
      const order = await this.repository.getOrder(orderId, tx)
      if (order === null) return null
      if (order.type !== OrderType.Virtual) {
        throw new HttpError(ErrorCode.Validation, ORDER_TYPE_MISMATCH_MESSAGE)
      }

      const deliveredCdks = await this.repository.markVirtualShipped(orderId, tx)
      // 事务内记录操作日志：发货 + 日志同成败（需求 14.4）。
      await this.logService.recordLog(
        { actorId: adminId, action: 'ship_virtual', targetType: 'order', targetId: orderId },
        tx,
      )

      return { orderId, status: OrderStatus.Shipped, cdks: deliveredCdks }
    })
  }
}
