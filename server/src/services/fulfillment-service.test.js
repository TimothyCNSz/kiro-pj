import { describe, it, expect, beforeEach } from 'vitest';
import { FulfillmentService, buildFakeTrackingTimeline, TRACKING_REQUIRED_MESSAGE, ORDER_TYPE_MISMATCH_MESSAGE, } from './fulfillment-service';
import { OrderStatus, OrderType } from '../lib/domain';
import { ErrorCode } from '../lib/errors';
import { HttpError } from '../middleware/http-error';
/** Sentinel handle used to assert the tx flows through to the log recorder. */
const TX_HANDLE = { __tx: true };
class FakeFulfillmentRepository {
    orders;
    txRuns = 0;
    constructor(orders) {
        this.orders = orders;
    }
    async transaction(fn) {
        this.txRuns += 1;
        return fn(TX_HANDLE);
    }
    async getOrder(orderId, _handle) {
        const o = this.orders.get(orderId);
        if (!o)
            return null;
        return { id: o.id, type: o.type, status: o.status };
    }
    async markPhysicalShipped(orderId, trackingNo, _handle) {
        const o = this.orders.get(orderId);
        if (!o)
            throw new Error('order missing');
        o.trackingNo = trackingNo;
        o.status = OrderStatus.Shipped;
    }
    async markVirtualShipped(orderId, _handle) {
        const o = this.orders.get(orderId);
        if (!o)
            throw new Error('order missing');
        o.status = OrderStatus.Shipped;
        o.cdkDelivered = true;
        return [...o.cdks].sort();
    }
}
class FakeLogRecorder {
    calls = [];
    async recordLog(entry, handle) {
        this.calls.push({ entry, handle });
    }
}
function buildHarness(seed) {
    const orders = new Map(seed.map((o) => [o.id, o]));
    const repo = new FakeFulfillmentRepository(orders);
    const logger = new FakeLogRecorder();
    const service = new FulfillmentService({ repository: repo, logService: logger });
    return { service, repo, logger, orders };
}
const physicalOrder = (over = {}) => ({
    id: 'phys-1',
    type: OrderType.Physical,
    status: OrderStatus.PendingShipment,
    trackingNo: null,
    cdks: [],
    cdkDelivered: false,
    ...over,
});
const virtualOrder = (over = {}) => ({
    id: 'virt-1',
    type: OrderType.Virtual,
    status: OrderStatus.PendingShipment,
    trackingNo: null,
    cdks: ['CDK-B', 'CDK-A'],
    cdkDelivered: false,
    ...over,
});
// ---------------------------------------------------------------------------
// shipPhysical
// ---------------------------------------------------------------------------
describe('FulfillmentService.shipPhysical (需求 8.2, 8.3, 14.1, 14.3, 14.4)', () => {
    let h;
    beforeEach(() => {
        h = buildHarness([physicalOrder()]);
    });
    it('records tracking number and sets order shipped (需求 8.2, 14.1)', async () => {
        const result = await h.service.shipPhysical('admin-1', 'phys-1', 'SF123456');
        expect(result).not.toBeNull();
        expect(result.status).toBe(OrderStatus.Shipped);
        expect(result.trackingNo).toBe('SF123456');
        expect(h.orders.get('phys-1').status).toBe(OrderStatus.Shipped);
        expect(h.orders.get('phys-1').trackingNo).toBe('SF123456');
    });
    it('returns fake logistics tracking detail once shipped (需求 8.3)', async () => {
        const result = await h.service.shipPhysical('admin-1', 'phys-1', ' SF123456 ');
        // trimmed tracking number is used
        expect(result.trackingNo).toBe('SF123456');
        expect(result.tracking.trackingNo).toBe('SF123456');
        expect(result.tracking.nodes.length).toBeGreaterThan(0);
    });
    it('records exactly one ship_physical operation log within the tx (需求 14.4)', async () => {
        await h.service.shipPhysical('admin-1', 'phys-1', 'SF123456');
        expect(h.logger.calls).toHaveLength(1);
        const { entry, handle } = h.logger.calls[0];
        expect(entry).toEqual({
            actorId: 'admin-1',
            action: 'ship_physical',
            targetType: 'order',
            targetId: 'phys-1',
        });
        // log write reuses the fulfillment transaction handle (同成败)
        expect(handle).toBe(TX_HANDLE);
        expect(h.repo.txRuns).toBe(1);
    });
    it('rejects empty tracking number with TRACKING_REQUIRED and does not ship (需求 14.3)', async () => {
        await expect(h.service.shipPhysical('admin-1', 'phys-1', '')).rejects.toMatchObject({
            errorCode: ErrorCode.TrackingRequired,
        });
        expect(h.orders.get('phys-1').status).toBe(OrderStatus.PendingShipment);
        expect(h.logger.calls).toHaveLength(0);
    });
    it('rejects whitespace-only tracking number with TRACKING_REQUIRED (需求 14.3)', async () => {
        const err = await h.service.shipPhysical('admin-1', 'phys-1', '   ').catch((e) => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err.errorCode).toBe(ErrorCode.TrackingRequired);
        expect(err.message).toBe(TRACKING_REQUIRED_MESSAGE);
        // no transaction opened for empty tracking (validated before any write)
        expect(h.repo.txRuns).toBe(0);
    });
    it('rejects non-string tracking number with TRACKING_REQUIRED (需求 14.3)', async () => {
        await expect(h.service.shipPhysical('admin-1', 'phys-1', undefined)).rejects.toMatchObject({ errorCode: ErrorCode.TrackingRequired });
        expect(h.orders.get('phys-1').status).toBe(OrderStatus.PendingShipment);
    });
    it('returns null (→404) when the order does not exist', async () => {
        const result = await h.service.shipPhysical('admin-1', 'missing', 'SF1');
        expect(result).toBeNull();
        expect(h.logger.calls).toHaveLength(0);
    });
    it('rejects shipping a virtual order via the physical path (type mismatch)', async () => {
        const hv = buildHarness([virtualOrder()]);
        const err = await hv.service.shipPhysical('admin-1', 'virt-1', 'SF1').catch((e) => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err.errorCode).toBe(ErrorCode.Validation);
        expect(err.message).toBe(ORDER_TYPE_MISMATCH_MESSAGE);
        expect(hv.orders.get('virt-1').status).toBe(OrderStatus.PendingShipment);
        expect(hv.logger.calls).toHaveLength(0);
    });
});
// ---------------------------------------------------------------------------
// shipVirtual
// ---------------------------------------------------------------------------
describe('FulfillmentService.shipVirtual (需求 9.3, 9.4, 14.2, 14.4)', () => {
    let h;
    beforeEach(() => {
        h = buildHarness([virtualOrder()]);
    });
    it('associates/delivers CDKs and sets order shipped (需求 9.4, 14.2)', async () => {
        const result = await h.service.shipVirtual('admin-1', 'virt-1');
        expect(result).not.toBeNull();
        expect(result.status).toBe(OrderStatus.Shipped);
        // delivered CDK codes are returned (stable sorted) for display (需求 9.4)
        expect(result.cdks).toEqual(['CDK-A', 'CDK-B']);
        expect(h.orders.get('virt-1').status).toBe(OrderStatus.Shipped);
        expect(h.orders.get('virt-1').cdkDelivered).toBe(true);
    });
    it('records exactly one ship_virtual operation log within the tx (需求 14.4)', async () => {
        await h.service.shipVirtual('admin-1', 'virt-1');
        expect(h.logger.calls).toHaveLength(1);
        const { entry, handle } = h.logger.calls[0];
        expect(entry).toEqual({
            actorId: 'admin-1',
            action: 'ship_virtual',
            targetType: 'order',
            targetId: 'virt-1',
        });
        expect(handle).toBe(TX_HANDLE);
        expect(h.repo.txRuns).toBe(1);
    });
    it('returns null (→404) when the order does not exist', async () => {
        const result = await h.service.shipVirtual('admin-1', 'missing');
        expect(result).toBeNull();
        expect(h.logger.calls).toHaveLength(0);
    });
    it('rejects shipping a physical order via the virtual path (type mismatch)', async () => {
        const hp = buildHarness([physicalOrder()]);
        const err = await hp.service.shipVirtual('admin-1', 'phys-1').catch((e) => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err.errorCode).toBe(ErrorCode.Validation);
        expect(hp.orders.get('phys-1').status).toBe(OrderStatus.PendingShipment);
        expect(hp.logger.calls).toHaveLength(0);
    });
});
// ---------------------------------------------------------------------------
// buildFakeTrackingTimeline (pure helper, 需求 8.3)
// ---------------------------------------------------------------------------
describe('buildFakeTrackingTimeline (需求 8.3)', () => {
    it('embeds the tracking number and yields a non-empty timeline', () => {
        const timeline = buildFakeTrackingTimeline('SF999');
        expect(timeline.trackingNo).toBe('SF999');
        expect(timeline.carrier).toBeTruthy();
        expect(timeline.nodes.length).toBeGreaterThan(0);
        expect(timeline.nodes.some((n) => n.description.includes('SF999'))).toBe(true);
    });
});
